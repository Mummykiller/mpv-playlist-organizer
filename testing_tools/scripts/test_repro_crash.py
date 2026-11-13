import os
import sys
import unittest
import threading
import time
import logging
import traceback
import json
from unittest.mock import MagicMock, patch

# Ensure base_test can be imported
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from base_test import BaseTestCase

# Add project root to path for handler imports
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, PROJECT_ROOT)

from mpv_session import MpvSessionManager
from utils.handlers.playback_handler import PlaybackHandler
from utils import native_link, ipc_utils, security
import file_io

class TestReproCrash(BaseTestCase):
    """
    Reproduction and resilience tests for race conditions, malformed JSON packets,
    broken pipes, and unexpected disconnections.
    """

    def setUp(self):
        super().setUp()
        
        # 1. Mock Dependencies for MpvSessionManager
        self.deps = {
            'get_all_folders_from_file': MagicMock(),
            'get_mpv_executable': MagicMock(return_value="mpv"),
            'log_stream': MagicMock(),
            'send_message': self.mock_send,
            'SCRIPT_DIR': PROJECT_ROOT,
            'TEMP_PLAYLISTS_DIR': os.path.join(self.test_dir, "temp_playlists"),
            'metadata_cache': None,
            'task_manager': None
        }
        
        # 2. Instantiate Real Session Manager
        session_file = os.path.join(self.test_dir, "session.json")
        self.mpv_session = MpvSessionManager(session_file, self.deps)
        
        # 3. Create Context for Handler
        self.ctx = MagicMock()
        self.ctx.data_dir = self.test_dir
        self.ctx.script_dir = PROJECT_ROOT
        self.ctx.temp_playlists_dir = self.deps['TEMP_PLAYLISTS_DIR']
        self.ctx.sender = self.mock_send
        self.ctx.mpv = self.mpv_session
        self.ctx.io = MagicMock()
        self.ctx.ipc = MagicMock()
        self.ctx.services = MagicMock()
        self.ctx.metadata_cache = None
        self.ctx.task_manager = None
        
        self.handler = PlaybackHandler(self.ctx)

    def tearDown(self):
        if hasattr(self, "mpv_session") and self.mpv_session is not None:
            self.mpv_session.is_alive = False
        super().tearDown()

    def test_concurrent_launch_and_status(self):
        """Stress test with multiple threads to catch unhandled exceptions."""
        stop_event = threading.Event()
        errors = []

        def poller():
            while not stop_event.is_set():
                try:
                    req = native_link.LiveUpdateRequest(action="get_playback_status")
                    self.handler.handle_get_playback_status(req)
                except Exception as e:
                    errors.append(f"Poller error: {e}\n{traceback.format_exc()}")
                time.sleep(0.001)

        def launcher():
            while not stop_event.is_set():
                try:
                    with self.mpv_session.sync_lock:
                        self.mpv_session.pid = 9999
                        self.mpv_session.is_alive = True
                    
                    time.sleep(0.01)
                    
                    with self.mpv_session.sync_lock:
                        self.mpv_session.pid = 9999
                except Exception as e:
                    errors.append(f"Launcher error: {e}")
                time.sleep(0.02)

        t1 = threading.Thread(target=poller)
        t2 = threading.Thread(target=launcher)
        
        t1.start()
        t2.start()
        
        time.sleep(0.5)
        
        stop_event.set()
        t1.join()
        t2.join()
        
        self.assertEqual(len(errors), 0, f"Caught concurrency errors: {errors}")

    def test_active_session_append_vs_toggle(self):
        """Verify that playing an active playlist appends unqueued items, or toggles pause if none."""
        self.mpv_session.is_alive = True
        self.mpv_session.pid = 9999
        self.mpv_session.owner_folder_id = "default"
        self.mpv_session.playlist = [{"id": "item-1", "url": "https://example.com/1"}]
        self.mpv_session.ipc_manager = MagicMock()
        self.mpv_session.ipc_manager.is_connected.return_value = True
        self.mpv_session._sync_playlist_from_mpv = MagicMock()
        
        mock_append_result = native_link.success(message="Added 1 items.")
        self.handler.handle_append = MagicMock(return_value=mock_append_result)

        # Case A: Playlist contains item-1 and new item-2 -> should call handle_append with item-2
        req_with_new_item = native_link.PlaybackRequest(
            action="play_m3u",
            folder_id="Default",
            m3u_data={"type": "items", "value": [
                {"id": "item-1", "url": "https://example.com/1"},
                {"id": "item-2", "url": "https://example.com/2"}
            ]}
        )
        res = self.handler._orchestrate_playback(req_with_new_item, "m3u")
        self.assertTrue(res.get("success"))
        self.handler.handle_append.assert_called_once()
        append_call_req = self.handler.handle_append.call_args[0][0]
        self.assertEqual(len(append_call_req.url_items), 1)
        self.assertEqual(append_call_req.url_items[0]["id"], "item-2")

        # Case B: All items already in MPV session -> should toggle pause
        self.handler.handle_append.reset_mock()
        req_all_queued = native_link.PlaybackRequest(
            action="play_m3u",
            folder_id="Default",
            m3u_data={"type": "items", "value": [
                {"id": "item-1", "url": "https://example.com/1"}
            ]}
        )
        res_pause = self.handler._orchestrate_playback(req_all_queued, "m3u")
        self.assertTrue(res_pause.get("success"))
        self.assertTrue(res_pause.get("alreadyActive") or res_pause.get("already_active"))
        self.handler.handle_append.assert_not_called()
        self.mpv_session.ipc_manager.send.assert_called_with({"command": ["cycle", "pause"]})

    # =========================================================================
    # Malformed JSON Packet Resilience
    # =========================================================================

    def test_ipc_reader_malformed_json_resilience(self):
        """Verifies that IPCSocketManager reader skips corrupted JSON without crashing."""
        ipc_mgr = ipc_utils.IPCSocketManager()
        
        # Mock stream feeding: corrupted line, empty line, followed by valid JSON
        lines = [
            b"{ malformed json missing closing brace\n",
            b"\n",
            b"{\"event\": \"property-change\", \"name\": \"pause\", \"data\": true}\n",
            b"" # EOF
        ]
        
        mock_file = MagicMock()
        mock_file.readline.side_effect = lines
        
        ipc_mgr._sock_file = mock_file
        ipc_mgr._sock = MagicMock()
        ipc_mgr._event_reader_running = True
        
        with patch.object(ipc_utils.platform, 'system', return_value="Linux"):
            with patch("select.select", return_value=([ipc_mgr._sock], [], [])):
                ipc_mgr._event_reader_loop()
        
        # Verify reader didn't crash and captured the valid event
        self.assertEqual(len(ipc_mgr._event_buffer), 1)
        event = ipc_mgr._event_buffer[0]
        self.assertEqual(event.get("event"), "property-change")
        self.assertEqual(event.get("name"), "pause")

    def test_corrupted_json_file_recovery(self):
        """Verifies file_io._safe_json_load recovers from corrupted JSON via .bak or returns default."""
        test_file = os.path.join(self.test_dir, "corrupted_test.json")
        bak_file = test_file + ".bak"
        
        # 1. Valid backup exists
        with open(test_file, 'w') as f:
            f.write("{ not valid json !!")
        with open(bak_file, 'w') as f:
            json.dump({"recovered": True}, f)
            
        data = file_io._safe_json_load(test_file, default_factory=dict)
        self.assertTrue(data.get("recovered"), "Should recover from .bak when primary is corrupt")
        
        # 2. Both primary and backup corrupted -> returns default_factory without raising exception
        with open(test_file, 'w') as f:
            f.write("corrupted primary as well")
        with open(bak_file, 'w') as f:
            f.write("corrupted backup as well")
            
        data_default = file_io._safe_json_load(test_file, default_factory=lambda: {"fallback": 123})
        self.assertEqual(data_default, {"fallback": 123})

    def test_ipc_payload_validation_rejects_malformed_packets(self):
        """Verifies security.validate_payload rejects invalid types and oversized messages without crashing."""
        # Non-dict types
        for invalid_payload in [None, "invalid", 12345, [1, 2, 3]]:
            is_valid, err = security.validate_payload(invalid_payload)
            self.assertFalse(is_valid)
            self.assertIn("Invalid payload type", err)

        # Missing or non-string action
        for bad_action_payload in [{}, {"action": 123}, {"action": None}]:
            is_valid, err = security.validate_payload(bad_action_payload)
            self.assertFalse(is_valid)
            self.assertIn("Missing action", err)

        # Oversized payload
        oversized = {"action": "play", "data": "A" * (security.SECURITY_LIMITS['MAX_STRING_LENGTH'] + 10)}
        is_valid, err = security.validate_payload(oversized)
        self.assertFalse(is_valid)
        self.assertIn("exceeds security limits", err)

    # =========================================================================
    # Broken Pipe Resilience
    # =========================================================================

    def test_ipc_socket_broken_pipe_handling(self):
        """Verifies IPCSocketManager.send catches BrokenPipeError and cleans up gracefully."""
        ipc_mgr = ipc_utils.IPCSocketManager()
        mock_sock = MagicMock()
        mock_sock.sendall.side_effect = BrokenPipeError("Broken pipe to MPV")
        
        ipc_mgr._sock = mock_sock
        ipc_mgr._sock_file = MagicMock()
        ipc_mgr._system = "Linux"
        
        with patch.object(ipc_mgr, 'close') as mock_close:
            result = ipc_mgr.send({"command": ["get_property", "pause"]})
            self.assertIsNone(result, "send() must return None on BrokenPipeError")
            mock_close.assert_called_once()

    def test_native_host_send_message_broken_pipe(self):
        """Verifies native_host.send_message_binary handles BrokenPipeError when browser disconnects."""
        import native_host

        mock_stdout = MagicMock()
        mock_stdout.buffer.write.side_effect = BrokenPipeError("[Errno 32] Broken pipe")

        with patch.object(native_host.sys, "stdout", mock_stdout):
            with self.assertLogs(level="INFO") as cm:
                native_host.send_message_binary({"action": "log", "text": "test"})

        mock_stdout.buffer.write.assert_called_once()
        self.assertTrue(any("Broken Pipe" in msg for msg in cm.output), "BrokenPipeError should be cleanly caught and logged")

    # =========================================================================
    # Unexpected Disconnection Resilience
    # =========================================================================

    def test_unexpected_disconnection_status_polling(self):
        """Verifies status polling cleans up when MPV process dies unexpectedly."""
        self.mpv_session.is_alive = True
        self.mpv_session.pid = 88888
        self.mpv_session.owner_folder_id = "test_dead_folder"
        
        self.handler.ipc_utils.is_pid_running.return_value = False

        status_res = self.handler.handle_get_playback_status(native_link.LiveUpdateRequest(action="get_playback_status"))
        self.assertTrue(status_res.get("success"))
        self.assertFalse(status_res.get("isRunning") or status_res.get("is_running", False))
        self.assertFalse(self.mpv_session.is_alive, "Session should be marked dead after dead PID detection")

    def test_unexpected_disconnection_is_running_check(self):
        """Verifies handle_is_mpv_running clears session when PID disappears."""
        self.mpv_session.is_alive = True
        self.mpv_session.pid = 77777
        self.mpv_session.owner_folder_id = "test_vanished_folder"

        self.handler.ipc_utils.is_pid_running.return_value = False

        res = self.handler.handle_is_mpv_running(native_link.LiveUpdateRequest(action="is_mpv_running"))
        self.assertTrue(res.get("success"))
        self.assertFalse(res.get("isRunning") or res.get("is_running", False))
        self.assertFalse(self.mpv_session.is_alive)
        self.assertIsNone(self.mpv_session.pid)

    def test_health_watcher_unexpected_disconnection(self):
        """Verifies health watcher detects IPC disconnection and transitions health state."""
        self.mpv_session.is_alive = True
        self.mpv_session.pid = 66666
        self.mpv_session.owner_folder_id = "health_folder"
        
        # Mock IPC manager that always fails ping
        mock_ipc = MagicMock()
        mock_ipc.get_property.return_value = None
        self.mpv_session.ipc_manager = mock_ipc

        with patch("utils.ipc_utils.is_pid_running", return_value=False):
            try:
                self.mpv_session._start_health_watcher()
                
                # Poll until watcher thread transitions session to dead (500ms intervals)
                deadline = time.time() + 2.0
                while time.time() < deadline:
                    health_states = [m.get("health") for m in self.sent_messages if m.get("action") == "playback_health_changed"]
                    if not self.mpv_session.is_alive and "dead" in health_states:
                        break
                    time.sleep(0.05)
                
                # Session should be cleared when PID is dead
                self.assertFalse(self.mpv_session.is_alive)
                self.assertIsNone(self.mpv_session.pid)

                # Check that health change messages were emitted
                health_states = [m.get("health") for m in self.sent_messages if m.get("action") == "playback_health_changed"]
                self.assertIn("stale", health_states)
                self.assertIn("dead", health_states)
            finally:
                self.mpv_session.is_alive = False

    def test_mid_launch_cancellation_resilience(self):
        """Verifies that user cancelling an in-flight launch aborts cleanly without unhandled exceptions."""
        req = native_link.PlaybackRequest(
            action="play",
            folder_id="cancel_folder",
            url_item={"id": "i1", "url": "https://example.com/test.mp4", "title": "Test Video"}
        )

        # Mock item_processor to return valid resolved items so it advances to pass 1
        self.handler.item_processor.resolve_input_items = MagicMock(
            return_value=([{"id": "i1", "url": "https://example.com/test.mp4", "title": "Test Video"}], False)
        )

        # Mock first pass returning success, but simulate user cancelling during pass 1
        def mock_start_pass1(*args, **kwargs):
            self.mpv_session.launch_cancelled = True
            return {
                "success": True,
                "handled_directly": False,
                "enriched_url_items": [{"id": "i1", "url": "https://example.com/test.mp4"}]
            }

        self.mpv_session.start = MagicMock(side_effect=mock_start_pass1)

        res = self.handler._orchestrate_playback(req, 'single')
        self.assertFalse(res.get("success"))
        self.assertIn("cancelled", res.get("error", "").lower())

if __name__ == '__main__':
    unittest.main()
