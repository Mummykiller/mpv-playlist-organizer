import os
import sys
import unittest
import json
import struct
import time
from typing import Any, Dict

# Ensure base_test and shared native host harness can be imported
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from base_test import BaseTestCase
from native_host_harness import (
    pack_native_message,
    read_native_message,
    read_native_response,
    send_native_message,
    spawn_native_host,
    terminate_native_host,
)

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from utils import security
import services

class TestNativeHostBoot(BaseTestCase):
    """
    Integration and protocol verification tests for the Native Messaging Host.
    Verifies stdio framing, header packing/unpacking, and handshake mechanisms.
    """

    def setUp(self):
        super().setUp()
        self.procs = []

    def tearDown(self):
        for proc in self.procs:
            terminate_native_host(proc, wait_timeout=1.0)
        super().tearDown()

    def spawn_host(self, working_dir: str):
        """Spawns the native host process and tracks it for clean shutdown."""
        proc = spawn_native_host(working_dir, project_root=PROJECT_ROOT)
        self.procs.append(proc)
        return proc

    def send_msg(self, proc, msg: Dict[str, Any]):
        """Sends a Native Messaging formatted message (4-byte length prefix + UTF-8 JSON)."""
        send_native_message(proc, msg)

    def read_msg(self, proc, timeout=5.0) -> Dict[str, Any]:
        """Reads a single Native Messaging framed message with explicit timeout and length prefix checking."""
        return read_native_message(proc, timeout=timeout)

    def read_response(self, proc, request_id: str, timeout=5.0) -> Dict[str, Any]:
        """Reads messages from the process until the one with request_id is found."""
        return read_native_response(proc, request_id=request_id, timeout=timeout)

    def test_read_msg_respects_timeout(self):
        """Verifies read_msg enforces its timeout instead of blocking indefinitely on idle stdout."""
        proc = self.spawn_host(self.test_dir)
        t0 = time.monotonic()
        msg = self.read_msg(proc, timeout=0.2)
        elapsed = time.monotonic() - t0
        self.assertIsNone(msg, "Idle host without requests must return None on timeout")
        self.assertLess(elapsed, 1.0, f"read_msg blocked too long ({elapsed:.2f}s)")

    # =========================================================================
    # Stdio Framing & Header Packing/Unpacking Tests
    # =========================================================================

    def test_stdio_framing_header_packing_unpacking(self):
        """Verifies exact 4-byte native framing (@I) round-trip with multibyte UTF-8 characters."""
        # Test ASCII and multibyte characters (emojis, unicode)
        test_payloads = [
            {"action": "ping"},
            {"action": "play", "title": "Video with Emojis 🎬 🍿 and Accents éàü"},
            {"action": "batch", "items": [{"id": f"item_{i}", "val": "x" * 100} for i in range(50)]}
        ]

        for payload in test_payloads:
            frame = pack_native_message(payload)
            header = frame[:4]
            body = frame[4:]
            self.assertEqual(len(header), 4, "Framing header must be exactly 4 bytes")

            unpacked_len = struct.unpack('@I', header)[0]
            self.assertEqual(unpacked_len, len(body), "Unpacked length must match UTF-8 byte length")
            decoded = json.loads(body.decode('utf-8'))
            self.assertEqual(decoded, payload)

            # Verify UTF-8 byte length > char count for multibyte text
            if "Emojis" in payload.get("title", ""):
                self.assertGreater(len(body), len(body.decode('utf-8')))

    def test_host_clean_exit_on_stdin_eof(self):
        """Verifies host process detects stdin EOF cleanly and exits with code 0."""
        proc = self.spawn_host(self.test_dir)
        self.assertTrue(os.path.isdir(os.path.join(self.test_dir, "tmp")), "spawn_native_host must create isolated tmp subdir")

        # Close stdin to trigger EOF in get_message
        proc.stdin.close()

        exit_code = proc.wait(timeout=3.0)
        self.assertEqual(exit_code, 0, "Host should exit with code 0 when stdin is closed")

    def test_host_oversized_message_rejection(self):
        """Verifies host rejects messages exceeding MAX_IPC_MESSAGE_SIZE and exits safely."""
        proc = self.spawn_host(self.test_dir)

        # Send 4-byte length prefix exceeding 5MB limit
        oversized_len = security.SECURITY_LIMITS['MAX_IPC_MESSAGE_SIZE'] + 1024
        proc.stdin.write(struct.pack('@I', oversized_len))
        proc.stdin.flush()

        # Host should detect oversized header and exit with code 1
        exit_code = proc.wait(timeout=3.0)
        self.assertEqual(exit_code, 1, "Host must exit with code 1 when message exceeds security limit")

    def test_host_truncated_header_resilience(self):
        """Verifies host does not crash or hang when receiving a truncated header (< 4 bytes) followed by EOF."""
        proc = self.spawn_host(self.test_dir)

        # Send only 2 bytes instead of 4, then close pipe
        proc.stdin.write(b"\x01\x00")
        proc.stdin.close()

        exit_code = proc.wait(timeout=3.0)
        stderr = proc.stderr.read().decode('utf-8', errors='replace')
        self.assertIsNotNone(exit_code, "Host must terminate on truncated header EOF")
        self.assertGreaterEqual(exit_code, 0, f"Host crashed with signal {-exit_code}: {stderr}")
        self.assertNotIn("Traceback", stderr, f"Unexpected Python traceback on truncated header: {stderr}")

    def test_host_handles_invalid_json(self):
        """Verifies that malformed JSON is caught by the host loop and subsequent valid requests still succeed."""
        proc = self.spawn_host(self.test_dir)

        # Send malformed JSON frame followed immediately by a valid ping
        proc.stdin.write(struct.pack('@I', 10))
        proc.stdin.write(b"not-json!!")
        proc.stdin.flush()

        req_id = "recovery-ping"
        self.send_msg(proc, {"action": "ping", "request_id": req_id})
        resp = self.read_response(proc, req_id, timeout=5.0)
        self.assertIsNotNone(resp, "Host should recover from malformed JSON and answer subsequent ping")
        self.assertTrue(resp.get("success"))

    # =========================================================================
    # Handshake Verification Tests
    # =========================================================================

    def test_native_messaging_boot_handshake(self):
        """Verifies the initial ping/status handshake with the native host."""
        proc = self.spawn_host(self.test_dir)

        req_id = "handshake-ping-1"
        ping_msg = {
            "action": "ping",
            "request_id": req_id
        }
        self.send_msg(proc, ping_msg)

        response = self.read_response(proc, req_id)
        self.assertIsNotNone(response, "Timed out waiting for ping response")
        self.assertTrue(response.get('success'), f"Ping failed: {response}")
        self.assertEqual(response.get('status'), "online")
        self.assertIn('pythonVersion', response)
        self.assertIn('platform', response)
        self.assertEqual(response.get('requestId') or response.get('request_id'), req_id)

    def test_native_messaging_restore_session_handshake(self):
        """Verifies the session restoration handshake handler."""
        proc = self.spawn_host(self.test_dir)

        req_id = "handshake-restore-1"
        restore_msg = {
            "action": "restore_session",
            "request_id": req_id
        }
        self.send_msg(proc, restore_msg)

        response = self.read_response(proc, req_id)
        self.assertIsNotNone(response, "Timed out waiting for restore_session response")
        self.assertTrue(response.get('success'))
        self.assertIn('logLevel', response)

    def test_mpv_metadata_handshake_file_verification(self):
        """Verifies MPV metadata handshake file structure, serialization, and flag options."""
        flag_dir = os.path.join(self.test_dir, "flags_verification")
        folder_id = "handshake_folder_123"
        item = {
            "id": "item-abc-123",
            "title": "Test Title [1080p]",
            "url": "https://example.com/stream.m3u8",
            "original_url": "https://example.com/watch?v=abc",
            "resume_time": 120,
            "headers": {"User-Agent": "Custom-Test-UA", "Referer": "https://example.com/"},
            "cookies_browser": "chrome"
        }
        settings = {
            "enable_precise_resume": True,
            "yt_mark_watched": True,
            "http_persistence": "auto"
        }

        # 1. Test Managed Handshake
        handshake_path, handshake_flag = services.create_handshake_file(
            flag_dir=flag_dir,
            folder_id=folder_id,
            script_dir=PROJECT_ROOT,
            item=item,
            settings=settings,
            playlist_start_index=0,
            is_unmanaged=False,
            is_youtube=False,
            use_ytdl_mpv=False,
            headers=item["headers"],
            cookies_browser=item["cookies_browser"]
        )

        self.assertTrue(os.path.exists(handshake_path), "Handshake file must exist on disk")
        self.assertTrue(os.path.basename(handshake_path).startswith("handshake_"))
        self.assertFalse(os.path.basename(handshake_path).startswith("handshake_unmanaged_"))
        self.assertTrue(handshake_flag.startswith("--script-opts=mpv_organizer-handshake="))

        with open(handshake_path, 'r', encoding='utf-8') as f:
            data = json.load(f)

        self.assertEqual(data["folder_id"], folder_id)
        self.assertEqual(data["id"], "item-abc-123")
        self.assertEqual(data["title"], "Test Title [1080p]")
        self.assertEqual(data["headers"]["User-Agent"], "Custom-Test-UA")
        self.assertEqual(data["cookies_browser"], "chrome")
        self.assertFalse(data["is_unmanaged"])
        self.assertIn("lua_options", data)
        self.assertEqual(data["lua_options"]["resume_time"], 120)

        # 2. Test Unmanaged Handshake
        unm_path, unm_flag = services.create_handshake_file(
            flag_dir=flag_dir,
            folder_id="unmanaged_folder",
            script_dir=PROJECT_ROOT,
            item=item,
            settings=settings,
            is_unmanaged=True
        )

        self.assertTrue(os.path.exists(unm_path))
        self.assertTrue(os.path.basename(unm_path).startswith("handshake_unmanaged_"))
        with open(unm_path, 'r', encoding='utf-8') as f:
            unm_data = json.load(f)
        self.assertTrue(unm_data["is_unmanaged"])

    def test_play_m3u_registration(self):
        """Verifies that play_m3u is registered and doesn't return 'Unknown command'."""
        proc = self.spawn_host(self.test_dir)

        req_id = "test-play-m3u"
        msg = {
            "action": "play_m3u",
            "request_id": req_id,
            "folder_id": "test-folder",
            "url_item": {"url": "http://example.com/test.mp4", "title": "Test"}
        }
        self.send_msg(proc, msg)

        response = self.read_response(proc, req_id)
        self.assertIsNotNone(response, "Host crashed or timed out on play_m3u")

        error = response.get('error', '')
        self.assertNotIn("Unknown command", error)

    def test_importable_build_handler_registry_dispatch(self):
        """Verifies native_host can be imported and build_handler_registry dispatches ping without main()."""
        if PROJECT_ROOT not in sys.path:
            sys.path.insert(0, PROJECT_ROOT)
        import native_host
        from utils import native_link

        registry = native_host.build_handler_registry()
        ping_handler = registry.get_handler("ping")
        self.assertIsNotNone(ping_handler, "ping handler must be registered by build_handler_registry()")
        assert ping_handler is not None

        req = native_link.translate({"action": "ping", "request_id": "unit-ping-1"})
        resp = ping_handler(req)
        self.assertTrue(resp.get("success"))
        self.assertEqual(resp.get("status"), "online")
        self.assertEqual(resp.get("version"), native_host.HOST_VERSION)
        self.assertIn("pythonVersion", resp)
        self.assertIn("platform", resp)

    def test_control_actions_routing_and_executors(self):
        """Verifies CONTROL_ACTIONS routing and dedicated control_executor / worker_executor."""
        import inspect
        if PROJECT_ROOT not in sys.path:
            sys.path.insert(0, PROJECT_ROOT)
        import native_host

        expected_control = {
            "ping",
            "close_mpv",
            "restore_session",
            "get_playback_status",
            "is_mpv_running",
            "log_event",
            "log_browser_error",
        }
        self.assertTrue(expected_control.issubset(native_host.CONTROL_ACTIONS))

        ctrl_sentinel = object()
        work_sentinel = object()
        for action in expected_control:
            self.assertIs(
                native_host.select_executor(action, ctrl_sentinel, work_sentinel),
                ctrl_sentinel,
                f"Action '{action}' should route to control_executor",
            )
        for heavy_action in ("play", "start", "import_from_file", "ytdlp", None):
            self.assertIs(
                native_host.select_executor(heavy_action, ctrl_sentinel, work_sentinel),
                work_sentinel,
                f"Action '{heavy_action}' should route to worker_executor",
            )

        main_src = inspect.getsource(native_host.main)
        self.assertIn("control_executor", main_src)
        self.assertIn("worker_executor", main_src)
        self.assertIn("NHControl", main_src)
        self.assertIn("NHWorker", main_src)

if __name__ == '__main__':
    unittest.main()
