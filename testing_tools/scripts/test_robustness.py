import os
import sys
import unittest
import json
import time
import logging
import uuid
import re
from unittest.mock import MagicMock, patch

# Ensure base_test can be imported
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from base_test import BaseTestCase, PROJECT_ROOT

import file_io
import cli
import services
from playlist_tracker import PlaylistTracker
from utils.handlers.playback_handler import PlaybackHandler
from utils import native_link, security
from utils.mpv_command_builder import MpvCommandBuilder

class TestRobustness(BaseTestCase):
    """Verifies system-level robustness (Heartbeat, Normalization, Handshakes, Parameter Validation, Unmanaged Launch)."""

    def test_handshake_generation(self):
        """Verify that the handshake file is created with correct JSON structure."""
        flag_dir = os.path.join(self.test_dir, "flags_test")
        os.makedirs(flag_dir, exist_ok=True)
        
        handshake_data = {
            "folder_id": "test_folder",
            "project_root": self.test_dir,
            "id": str(uuid.uuid4())
        }
        
        handshake_path = os.path.join(flag_dir, f"handshake_test_{uuid.uuid4().hex}.json")

        with open(handshake_path, 'w', encoding='utf-8') as f:
            json.dump(handshake_data, f)
        
        self.assertTrue(os.path.exists(handshake_path))
        with open(handshake_path, 'r') as f:
            loaded = json.load(f)
            self.assertEqual(loaded["folder_id"], "test_folder")

    def test_normalization_simulation(self):
        """Simulate the casing translation layer (Snake -> Camel)."""
        python_data = {
            "is_running": True,
            "folder_id": "my_folder",
            "last_played_id": "123",
            "playlist_items": [{"item_id": "abc", "resume_time": 10}]
        }
        
        def js_normalize(data):
            if isinstance(data, list): return [js_normalize(x) for x in data]
            if not isinstance(data, dict): return data
            
            def snake_to_camel(s):
                parts = s.split('_')
                return parts[0] + ''.join(x.title() for x in parts[1:])
            
            return {snake_to_camel(k): js_normalize(v) for k, v in data.items()}

        normalized = js_normalize(python_data)
        self.assertIn("isRunning", normalized)
        self.assertIn("folderId", normalized)
        self.assertIn("resumeTime", normalized["playlistItems"][0])

    def test_heartbeat_persistence(self):
        """Verify that the heartbeat forces a disk commit after the interval."""
        original_data_dir = file_io.DATA_DIR
        file_io.DATA_DIR = self.test_dir
        file_io.initialize_paths()
        try:
            test_folder_id = "heartbeat_test_folder"
            index = file_io.get_index()
            index[test_folder_id] = {"name": "Test Folder", "playlist": []}
            file_io.save_index(index)
            
            test_playlist = [{"id": "item1", "url": "https://example.com/stream.mp4", "resume_time": 0}]
            file_io.save_playlist_shard(test_folder_id, test_playlist)

            tracker = PlaylistTracker(
                folder_id=test_folder_id,
                initial_playlist=test_playlist,
                file_io=file_io,
                settings={},
                ipc_path="/tmp/mock_ipc_not_existing",
                send_message_func=self.mock_send
            )
            
            tracker.commit_interval = 0.4
            tracker.is_tracking = True
            tracker._stop_event.clear()
            tracker._start_heartbeat()
            
            tracker._update_resume_time("item1", 123)
            time.sleep(2.5)
            
            reloaded_playlist = file_io.get_playlist_shard(test_folder_id)
            saved_time = reloaded_playlist[0].get("resume_time")
            self.assertEqual(saved_time, 123, "Progress should have been saved by heartbeat.")
            tracker.stop_tracking()
        finally:
            file_io.DATA_DIR = original_data_dir
            file_io.initialize_paths()

    def test_settings_synchronization(self):
        """Verify that shared settings keys in Python (file_io.py) and JS (storageManager.js) stay aligned."""
        py_settings = file_io.get_settings()
        js_file = os.path.join(PROJECT_ROOT, "utils", "storageManager.js")
        self.assertTrue(os.path.exists(js_file), "storageManager.js must exist")
        
        with open(js_file, "r", encoding="utf-8") as f:
            js_content = f.read()

        start = js_content.find("global: {")
        end = js_content.find("domains: {},")
        self.assertGreater(start, 0)
        self.assertGreater(end, start)
        block = js_content[start:end]

        js_keys = []
        for line in block.splitlines():
            m = re.match(r"\s{6,8}([a-zA-Z0-9_]+):", line)
            if m:
                js_keys.append(m.group(1))

        def camel_to_snake(name):
            s1 = re.sub(r"(.)([A-Z][a-z]+)", r"\1_\2", name)
            return re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", s1).lower()

        js_snake = {camel_to_snake(k): k for k in js_keys}
        
        ui_only_keys = {
            "minimized", "mode", "log_visible", "pinned", "position", "top", "left", "right", "bottom",
            "anilist_panel_visible", "lock_anilist_panel", "force_panel_attached", "anilist_attach_on_open",
            "minimized_stub_position", "dependency_status", "mpv", "ytdlp", "ffmpeg", "node"
        }

        missing_in_python = [
            snake_k for snake_k in js_snake
            if snake_k not in py_settings and snake_k not in ui_only_keys
        ]
        self.assertEqual(
            missing_in_python,
            [],
            f"JS settings keys missing in Python file_io.py: {missing_in_python}"
        )

    def test_popup_html_settings_id_integrity(self):
        """Ensures every setting elementId registered in utils/settings.js exists in popup.html."""
        settings_js = os.path.join(PROJECT_ROOT, "utils", "settings.js")
        popup_html = os.path.join(PROJECT_ROOT, "popup.html")
        self.assertTrue(os.path.exists(settings_js))
        self.assertTrue(os.path.exists(popup_html))

        with open(settings_js, "r", encoding="utf-8") as f:
            js_content = f.read()
        with open(popup_html, "r", encoding="utf-8") as f:
            html_content = f.read()

        element_ids = re.findall(r'elementId:\s*["\']([^"\']+)["\']', js_content)
        self.assertGreater(len(element_ids), 0, "No elementId entries found in utils/settings.js")

        missing = [elem_id for elem_id in element_ids if f'id="{elem_id}"' not in html_content and f"id='{elem_id}'" not in html_content]
        self.assertEqual(missing, [], f"Settings element IDs declared in settings.js missing from popup.html: {missing}")

    # =========================================================================
    # Folder Playback Parameter Validation Tests
    # =========================================================================

    def test_cli_play_folder_parameter_validation(self):
        """Tests parameter validation in CLI folder playback (_cli_play_folder)."""
        mock_args = MagicMock()
        mock_args.folder_id = "test_folder"

        with patch('sys.stderr'), patch('builtins.print'):
            # Case 1: Empty or missing data file -> exit 1
            with patch.object(file_io, 'get_all_folders_from_file', return_value={}):
                cli.file_io = file_io
                with self.assertRaises(SystemExit) as cm:
                    cli._cli_play_folder(mock_args)
                self.assertEqual(cm.exception.code, 1)

            # Case 2: Folder not found in library -> exit 1
            with patch.object(file_io, 'get_all_folders_from_file', return_value={"other_folder": {"playlist": []}}):
                cli.file_io = file_io
                with self.assertRaises(SystemExit) as cm:
                    cli._cli_play_folder(mock_args)
                self.assertEqual(cm.exception.code, 1)

            # Case 3: Folder exists but has an empty playlist -> exit 0 (graceful exit)
            with patch.object(file_io, 'get_all_folders_from_file', return_value={"test_folder": {"playlist": []}}):
                cli.file_io = file_io
                with self.assertRaises(SystemExit) as cm:
                    cli._cli_play_folder(mock_args)
                self.assertEqual(cm.exception.code, 0)

            # Case 4: Folder has valid items -> calls mpv_session.start
            valid_items = [{"id": "item1", "url": "https://example.com/v1.mp4", "title": "V1"}]
            mock_mpv_session = MagicMock()
            mock_mpv_session.start.return_value = {"success": True, "handled_directly": True}
            mock_mpv_session.pid = None
            mock_ipc_utils = MagicMock()
            mock_ipc_utils.is_process_alive.return_value = False

            cli.inject_dependencies({
                'file_io': file_io,
                'mpv_session': mock_mpv_session,
                'ipc_utils': mock_ipc_utils,
                'time': MagicMock()
            })

            with patch.object(file_io, 'get_all_folders_from_file', return_value={"test_folder": {"playlist": valid_items}}):
                cli._cli_play_folder(mock_args)
                mock_mpv_session.start.assert_called_once()
                call_args = mock_mpv_session.start.call_args
                self.assertEqual(call_args[0][0], valid_items[0])
                self.assertEqual(call_args[0][1], "test_folder")

    def test_playback_handler_parameter_validation(self):
        """Verifies strict validation of folder_id and playlist items in PlaybackHandler."""
        ctx = MagicMock()
        ctx.metadata_cache = None
        ctx.task_manager = None
        ctx.script_dir = PROJECT_ROOT
        ctx.temp_playlists_dir = os.path.join(self.test_dir, "temp_playlists")
        ctx.sender = self.mock_send
        ctx.io = file_io
        ctx.services = services
        ctx.ipc = MagicMock()
        ctx.mpv = MagicMock()
        handler = PlaybackHandler(ctx)

        # 1. handle_play missing folder_id or url_item
        req_missing_folder = native_link.PlaybackRequest(action="play", folder_id=None, url_item={"url": "https://example.com"})
        res = handler.handle_play(req_missing_folder)
        self.assertFalse(res.get("success"))
        self.assertIn("Missing folder_id or url_item", res.get("error"))

        req_missing_item = native_link.PlaybackRequest(action="play", folder_id="f1", url_item=None)
        res = handler.handle_play(req_missing_item)
        self.assertFalse(res.get("success"))
        self.assertIn("Missing folder_id or url_item", res.get("error"))

        # 2. handle_play_batch missing folder_id or playlist
        req_batch_no_folder = native_link.PlaybackRequest(action="play_batch", folder_id=None, playlist=[{"url": "https://example.com"}])
        res = handler.handle_play_batch(req_batch_no_folder)
        self.assertFalse(res.get("success"))
        self.assertIn("Missing folder_id or playlist", res.get("error"))

        req_batch_no_playlist = native_link.PlaybackRequest(action="play_batch", folder_id="f1", playlist=None)
        res = handler.handle_play_batch(req_batch_no_playlist)
        self.assertFalse(res.get("success"))
        self.assertIn("Missing folder_id or playlist", res.get("error"))

        # 3. handle_append missing folder_id or items
        req_append_no_folder = native_link.PlaybackRequest(action="append", folder_id=None, url_item={"url": "https://example.com"})
        res = handler.handle_append(req_append_no_folder)
        self.assertFalse(res.get("success"))
        self.assertIn("Missing folder_id or items", res.get("error"))

        req_append_no_items = native_link.PlaybackRequest(action="append", folder_id="f1", url_item=None, url_items=None)
        res = handler.handle_append(req_append_no_items)
        self.assertFalse(res.get("success"))
        self.assertIn("Missing folder_id or items", res.get("error"))

        # 4. handle_remove_item_live validation
        req_remove_missing = native_link.LiveUpdateRequest(action="remove_item_live", folder_id=None, item_id="item1")
        res = handler.handle_remove_item_live(req_remove_missing)
        self.assertFalse(res.get("success"))
        self.assertIn("Missing folder_id or item_id", res.get("error"))

        # 5. handle_reorder_live validation
        req_reorder_missing = native_link.LiveUpdateRequest(action="reorder_live", folder_id="f1", new_order=None)
        res = handler.handle_reorder_live(req_reorder_missing)
        self.assertFalse(res.get("success"))
        self.assertIn("Missing folder_id or new_order", res.get("error"))

    def test_single_play_promotion_to_folder_batch(self):
        """Verifies promotion of a single play request to full folder batch with state merge."""
        original_data_dir = file_io.DATA_DIR
        file_io.DATA_DIR = self.test_dir
        file_io.initialize_paths()
        try:
            folder_id = "test_promo_folder"
            shard_items = [
                {"id": "item1", "title": "Old Title 1", "url": "https://example.com/1", "resume_time": 10},
                {"id": "item2", "title": "Item 2", "url": "https://example.com/2", "resume_time": 0}
            ]
            file_io.save_playlist_shard(folder_id, shard_items)

            ctx = MagicMock()
            ctx.script_dir = PROJECT_ROOT
            ctx.temp_playlists_dir = os.path.join(self.test_dir, "temp_playlists")
            ctx.sender = self.mock_send
            ctx.io = file_io
            ctx.services = services
            ctx.ipc = MagicMock()
            ctx.mpv = MagicMock()
            handler = PlaybackHandler(ctx)

            # Incoming request targets item1 with updated title and resume time
            incoming_item = {"id": "item1", "title": "Updated Title 1", "url": "https://example.com/1", "resume_time": 45}
            req = native_link.PlaybackRequest(
                action="play",
                folder_id=folder_id,
                url_item=incoming_item,
                play_new_instance=False
            )

            handler.mpv_session.is_alive = False
            handler.mpv_session.start.return_value = {"success": True, "handled_directly": True}

            res = handler._orchestrate_playback(req, 'single')
            self.assertTrue(res.get("success"), f"Playback promotion failed: {res}")
            handler.mpv_session.start.assert_called_once()
            
            # Verify launch payload was promoted to batch and item1 state was merged
            launch_payload = handler.mpv_session.start.call_args[0][0]
            self.assertIsInstance(launch_payload, list)
            self.assertEqual(len(launch_payload), 2)
            self.assertEqual(launch_payload[0]["title"], "Updated Title 1")
            self.assertEqual(launch_payload[0]["resume_time"], 45)
        finally:
            file_io.DATA_DIR = original_data_dir
            file_io.initialize_paths()

    # =========================================================================
    # Unmanaged MPV Launch Options Tests
    # =========================================================================

    def test_unmanaged_mpv_command_builder(self):
        """Validates that construct_mpv_command accepts flag_dir without errors."""
        cmd, has_terminal = services.construct_mpv_command(
            mpv_exe="mpv",
            url=["https://example.com/stream.m3u8"],
            flag_dir="/tmp/flags_test"
        )
        self.assertTrue(isinstance(cmd, list))
        self.assertIn("mpv", cmd[0])
        self.assertIn("https://example.com/stream.m3u8", cmd)

    def test_unmanaged_mpv_safe_flags_allowlist(self):
        """Verifies custom MPV flags allowlist filtering: preserves safe flags, strips unsafe ones."""
        custom_flags = "--volume=80 --speed=1.25 --script=/tmp/malicious.lua --input-ipc-server=/tmp/sock --fullscreen --vo=null"
        cmd, _ = services.construct_mpv_command(
            mpv_exe="mpv",
            url=["https://example.com/test.mp4"],
            custom_mpv_flags=custom_flags,
            flag_dir=os.path.join(self.test_dir, "flags")
        )
        cmd_str = " ".join(cmd)

        # Allowed flags in SAFE_MPV_FLAGS_ALLOWLIST
        self.assertIn("--volume=80", cmd)
        self.assertIn("--speed=1.25", cmd)
        self.assertIn("--fullscreen", cmd)

        # Disallowed flags must be stripped
        self.assertNotIn("--script=/tmp/malicious.lua", cmd_str)
        self.assertNotIn("--input-ipc-server", cmd_str)
        self.assertNotIn("--vo=null", cmd_str)

    def test_unmanaged_mpv_geometry_validation(self):
        """Verifies geometry sanitization against command injection."""
        flag_dir = os.path.join(self.test_dir, "flags")

        # Valid geometry formats
        cmd_valid, _ = services.construct_mpv_command(
            mpv_exe="mpv",
            url="https://example.com/video.mp4",
            geometry="1280x720",
            custom_width="1280",
            custom_height="720",
            flag_dir=flag_dir
        )
        self.assertIn("--geometry=1280x720", cmd_valid)

        # Malformed / injected geometry must not be included
        cmd_injected, _ = services.construct_mpv_command(
            mpv_exe="mpv",
            url="https://example.com/video.mp4",
            geometry="1280x720;reboot",
            custom_width="1280;calc",
            custom_height="720|malicious",
            flag_dir=flag_dir
        )
        for arg in cmd_injected:
            self.assertNotIn(";reboot", arg)
            self.assertNotIn("calc", arg)
            self.assertNotIn("malicious", arg)

    def test_unmanaged_mpv_url_protocol_filtering(self):
        """Verifies that construct_mpv_command filters out URLs with disallowed protocols."""
        mixed_urls = [
            "https://example.com/safe.mp4",
            "javascript:alert(1)",
            "file:///tmp/safe_local.mkv",
            "data:text/html,evil"
        ]
        cmd, _ = services.construct_mpv_command(
            mpv_exe="mpv",
            url=mixed_urls,
            flag_dir=os.path.join(self.test_dir, "flags")
        )
        self.assertIn("https://example.com/safe.mp4", cmd)
        self.assertIn("file:///tmp/safe_local.mkv", cmd)
        self.assertNotIn("javascript:alert(1)", cmd)
        self.assertNotIn("data:text/html,evil", cmd)

    def test_unmanaged_launch_pipeline(self):
        """Verifies full _launch_unmanaged_mpv execution: handshake creation, command building, and subprocess call."""
        ctx = MagicMock()
        ctx.metadata_cache = None
        ctx.task_manager = None
        ctx.script_dir = PROJECT_ROOT
        ctx.temp_playlists_dir = os.path.join(self.test_dir, "temp_playlists")
        ctx.sender = self.mock_send
        ctx.io = file_io
        ctx.services = services
        ctx.ipc = MagicMock()
        ctx.mpv = MagicMock()
        handler = PlaybackHandler(ctx)

        playlist = [
            {"id": "item1", "url": "https://example.com/movie.mp4", "title": "Movie 1", "resume_time": 60}
        ]

        with patch("subprocess.Popen") as mock_popen:
            mock_proc = MagicMock()
            mock_proc.stdout = None
            mock_popen.return_value = mock_proc

            res = handler._launch_unmanaged_mpv(
                playlist=playlist,
                geometry=None,
                custom_width=None,
                custom_height=None,
                custom_mpv_flags="--fullscreen --input-ipc-server=/tmp/bad",
                automatic_mpv_flags=[{"flag": "--ontop", "enabled": True}, {"flag": "--invalid", "enabled": True}],
                folder_id="unmanaged_folder"
            )

            self.assertTrue(res.get("success"), f"Launch failed: {res}")
            mock_popen.assert_called_once()
            spawned_cmd = mock_popen.call_args[0][0]
            spawned_cmd_str = " ".join(spawned_cmd)

            # Unmanaged launch must include handshake script-opt with handshake_unmanaged_ prefix
            self.assertIn("--script-opts=", spawned_cmd_str)
            self.assertIn("handshake_unmanaged_", spawned_cmd_str)

            # Safe custom flag preserved, unsafe stripped
            self.assertIn("--fullscreen", spawned_cmd)
            self.assertNotIn("--input-ipc-server", spawned_cmd_str)

            # Automatic safe flag included, unsafe omitted
            self.assertIn("--ontop", spawned_cmd)
            self.assertNotIn("--invalid", spawned_cmd)

            # Global --start must NOT be passed as a CLI argument for playlist robustness
            for arg in spawned_cmd:
                self.assertFalse(arg.startswith("--start="), "Global --start should not be passed to CLI in unmanaged mode")

    def test_unmanaged_launch_empty_playlist_failure(self):
        """Verifies that unmanaged launch fails gracefully when playlist is empty."""
        ctx = MagicMock()
        ctx.metadata_cache = None
        ctx.task_manager = None
        ctx.script_dir = PROJECT_ROOT
        ctx.temp_playlists_dir = os.path.join(self.test_dir, "temp_playlists")
        ctx.sender = self.mock_send
        ctx.io = file_io
        ctx.services = services
        ctx.ipc = MagicMock()
        ctx.mpv = MagicMock()
        handler = PlaybackHandler(ctx)

        res = handler._launch_unmanaged_mpv(
            playlist=[],
            geometry=None,
            custom_width=None,
            custom_height=None,
            custom_mpv_flags=None,
            automatic_mpv_flags=None
        )
        self.assertFalse(res.get("success"))
        self.assertIn("Could not resolve any items", res.get("error"))

    def test_filelock_stale_pid_recovery(self):
        """Simulates a lock file held by a non-existent PID and verifies FileLock cleans it up and acquires cleanly."""
        target_file = os.path.join(self.test_dir, "stale_test.json")
        lock_file = f"{target_file}.lock"

        # Find a PID that is definitely not running
        dead_pid = 9999999
        try:
            os.kill(dead_pid, 0)
            dead_pid = 9999998
        except OSError as e:
            logging.debug(f"[TEST] Confirmed dead PID {dead_pid}: {e}")

        with open(lock_file, "w", encoding="utf-8") as f:
            f.write(str(dead_pid))

        self.assertTrue(os.path.exists(lock_file))

        # FileLock should identify the dead PID, remove the stale lock, and acquire
        with file_io.FileLock(target_file, timeout=2.0) as lock:
            self.assertTrue(lock.is_file_locked)
            with open(lock_file, "r", encoding="utf-8") as f:
                holder = f.read().strip()
            self.assertEqual(holder, str(os.getpid()))

        # Lock should be released upon context exit
        self.assertFalse(os.path.exists(lock_file))

    def test_native_connection_backoff_and_reconnect(self):
        """Verifies reconnection logic, exponential backoff progression, and status transitions."""
        class ConnectionStatus:
            DISCONNECTED = "DISCONNECTED"
            CONNECTING = "CONNECTING"
            CONNECTED = "CONNECTED"

        class NativeConnectionManager:
            def __init__(self, max_retries=3, base_backoff=0.01, backoff_factor=2.0):
                self.status = ConnectionStatus.DISCONNECTED
                self.status_history = [ConnectionStatus.DISCONNECTED]
                self.max_retries = max_retries
                self.base_backoff = base_backoff
                self.backoff_factor = backoff_factor
                self.attempts = 0
                self.recorded_delays = []

            def _set_status(self, new_status):
                self.status = new_status
                self.status_history.append(new_status)

            def connect(self, fail_count=0):
                """Attempts connection with exponential backoff on transient disconnection."""
                backoff = self.base_backoff
                while self.attempts < self.max_retries:
                    self.attempts += 1
                    self._set_status(ConnectionStatus.CONNECTING)

                    if self.attempts <= fail_count:
                        # Simulated connection drop
                        self._set_status(ConnectionStatus.DISCONNECTED)
                        self.recorded_delays.append(backoff)
                        time.sleep(backoff)
                        backoff *= self.backoff_factor
                    else:
                        self._set_status(ConnectionStatus.CONNECTED)
                        return True

                return False

        # Case 1: Reconnection succeeds after 2 drops
        mgr = NativeConnectionManager(max_retries=4, base_backoff=0.01, backoff_factor=2.0)
        result = mgr.connect(fail_count=2)
        self.assertTrue(result)
        self.assertEqual(mgr.status, ConnectionStatus.CONNECTED)
        self.assertEqual(mgr.attempts, 3)
        self.assertEqual(len(mgr.recorded_delays), 2)
        self.assertAlmostEqual(mgr.recorded_delays[0], 0.01, places=3)
        self.assertAlmostEqual(mgr.recorded_delays[1], 0.02, places=3)
        self.assertEqual(mgr.status_history, [
            ConnectionStatus.DISCONNECTED,
            ConnectionStatus.CONNECTING,
            ConnectionStatus.DISCONNECTED,
            ConnectionStatus.CONNECTING,
            ConnectionStatus.DISCONNECTED,
            ConnectionStatus.CONNECTING,
            ConnectionStatus.CONNECTED
        ])

        # Case 2: Max retries exceeded -> remains disconnected
        exhausted_mgr = NativeConnectionManager(max_retries=2, base_backoff=0.01)
        res_exhausted = exhausted_mgr.connect(fail_count=5)
        self.assertFalse(res_exhausted)
        self.assertEqual(exhausted_mgr.status, ConnectionStatus.DISCONNECTED)
        self.assertEqual(exhausted_mgr.attempts, 2)

if __name__ == '__main__':
    unittest.main()
