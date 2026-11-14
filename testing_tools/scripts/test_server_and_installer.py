import http.client
import io
import json
import os
import shlex
import struct
import subprocess
import sys
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from base_test import BaseTestCase

import playlist_server
from installer_src import installer_logic
from utils import security


class TestServerAndInstaller(BaseTestCase):
    """Regression tests for playlist_server, native_host outbound guard, installer_logic, and docs-vs-code invariants."""

    # --- playlist_server.py ---

    def _start_test_server(self, token="test-secret-token"):
        m3u_path = os.path.join(self.test_dir, "test_playlist.m3u")
        with open(m3u_path, "w", encoding="utf-8") as f:
            f.write("#EXTM3U\n#EXTINF:-1,Sample\nhttps://example.com/video.mp4\n")

        self._orig_token = os.environ.get("MPV_PLAYLIST_TOKEN")
        if token is None:
            os.environ.pop("MPV_PLAYLIST_TOKEN", None)
        else:
            os.environ["MPV_PLAYLIST_TOKEN"] = token

        with patch("sys.stdout", new_callable=io.StringIO):
            httpd, thread, port = playlist_server.start_playlist_server(
                start_port=0,
                m3u_file_to_serve=m3u_path,
            )
        self.assertIsNotNone(httpd)
        self.assertIsNotNone(port)
        self.assertGreater(port, 0)
        return httpd, port

    def _stop_test_server(self, httpd):
        if httpd is not None:
            playlist_server.stop_playlist_server(httpd)
        if hasattr(self, "_orig_token"):
            if self._orig_token is None:
                os.environ.pop("MPV_PLAYLIST_TOKEN", None)
            else:
                os.environ["MPV_PLAYLIST_TOKEN"] = self._orig_token

    def test_playlist_server_dynamic_port_and_valid_request(self):
        """Dynamic port 0 allocates an ephemeral port and serves 200 OK with valid Host and token."""
        token = "valid-token-123"
        httpd, port = self._start_test_server(token=token)
        try:
            self.assertEqual(httpd.server_address[0], "127.0.0.1")
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            conn.request("GET", f"/playlist.m3u?token={token}", headers={"Host": f"127.0.0.1:{port}"})
            resp = conn.getresponse()
            body = resp.read().decode("utf-8")
            conn.close()
            self.assertEqual(resp.status, 200)
            self.assertIn("#EXTM3U", body)
        finally:
            self._stop_test_server(httpd)

    def test_playlist_server_missing_token_returns_403(self):
        """Missing or wrong token fails closed with 403 Forbidden."""
        httpd, port = self._start_test_server(token="expected-secret")
        try:
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            conn.request("GET", "/playlist.m3u", headers={"Host": f"127.0.0.1:{port}"})
            resp = conn.getresponse()
            resp.read()
            conn.close()
            self.assertEqual(resp.status, 403)
        finally:
            self._stop_test_server(httpd)

    def test_playlist_server_invalid_host_returns_400(self):
        """Invalid Host header is rejected with 400 Bad Request."""
        token = "valid-token-123"
        httpd, port = self._start_test_server(token=token)
        try:
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            conn.request("GET", f"/playlist.m3u?token={token}", headers={"Host": "evil.example.com:80"})
            resp = conn.getresponse()
            resp.read()
            conn.close()
            self.assertEqual(resp.status, 400)
        finally:
            self._stop_test_server(httpd)

    def test_playlist_server_head_request_rejected(self):
        """HEAD requests are rejected (501/403) rather than exposing SimpleHTTPRequestHandler directory listings."""
        token = "valid-token-123"
        httpd, port = self._start_test_server(token=token)
        try:
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            conn.request("HEAD", f"/playlist.m3u?token={token}", headers={"Host": f"127.0.0.1:{port}"})
            resp = conn.getresponse()
            resp.read()
            conn.close()
            self.assertIn(resp.status, (403, 501))
        finally:
            self._stop_test_server(httpd)

    # --- native_host.py ---

    def test_send_message_binary_suppresses_oversized_payload_preserving_request_id_zero(self):
        """send_message_binary suppresses >900 KB payloads and sends a structured failure preserving request_id=0."""
        script = (
            "import native_host; "
            "native_host.send_message_binary({'action': 'test_large_reply', 'request_id': 0, 'data': 'A' * (950 * 1024)})"
        )
        env = os.environ.copy()
        env["XDG_DATA_HOME"] = self.test_dir
        env["HOME"] = self.test_dir
        res = subprocess.run(
            [sys.executable, "-c", script],
            cwd=os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
            env=env,
            capture_output=True,
            timeout=15,
        )
        self.assertEqual(res.returncode, 0, msg=res.stderr.decode("utf-8", errors="replace"))

        raw = res.stdout
        self.assertGreater(len(raw), 4, "Expected structured error response frame on stdout")
        msg_len = struct.unpack("@I", raw[:4])[0]
        frame_bytes = raw[4:]
        self.assertEqual(len(frame_bytes), msg_len)
        self.assertLessEqual(msg_len, 900 * 1024)

        parsed = json.loads(frame_bytes.decode("utf-8"))
        self.assertFalse(parsed.get("success", True))
        self.assertEqual(parsed.get("request_id"), 0)
        self.assertIn("exceeds maximum allowed size", parsed.get("error", ""))

    # --- installer_src/installer_logic.py ---

    def test_validate_extension_id_accepts_valid_and_rejects_invalid(self):
        """validate_extension_id accepts 32-char [a-p] IDs and rejects malformed IDs."""
        valid_id = "abcdefghijklmnopabcdefghijklmnop"
        self.assertEqual(installer_logic.validate_extension_id(valid_id), valid_id)
        self.assertEqual(installer_logic.validate_extension_id(f"  {valid_id}  "), valid_id)

        invalid_ids = [
            "",
            None,
            12345,
            "a" * 31,
            "a" * 33,
            "A" * 32,
            "abcdefghijklmnopabcdefghijklmnoq",  # 'q' is outside [a-p]
            "abcdefghijklmnopabcdefghijklmno1",  # digit not allowed
            "../evil/path/abcdefghijklmnopabcd",
        ]
        for bad_id in invalid_ids:
            with self.assertRaises(ValueError, msg=f"Should reject {bad_id!r}"):
                installer_logic.validate_extension_id(bad_id)

    def test_shell_wrapper_quotes_paths_with_shlex(self):
        """UnixLogic.install_cli safely quotes interpreter and script paths containing spaces/metacharacters."""
        fake_py = "/tmp/my python's dir/bin/python3"
        expected_script = os.path.join(self.test_dir, installer_logic.SCRIPT_NAME)
        with open(expected_script, "w", encoding="utf-8") as f:
            f.write("#!/usr/bin/env python3\n")

        logic = installer_logic.LinuxLogic(lambda _msg: None)
        with patch.object(installer_logic, "INSTALL_DIR", self.test_dir), \
             patch.object(sys, "executable", fake_py):
            logic.install_cli()

        wrapper_path = os.path.join(self.test_dir, "mpv-cli")
        self.assertTrue(os.path.exists(wrapper_path))
        with open(wrapper_path, "r", encoding="utf-8") as f:
            content = f.read()

        self.assertIn(shlex.quote(fake_py), content)
        self.assertIn(shlex.quote(expected_script), content)

    def test_unix_add_to_path_returns_and_logs_quoted_commands(self):
        """UnixLogic.add_to_path returns structured manual instructions with safely quoted commands and logs them."""
        special_dir = "/tmp/mpv's playlist dir/bin"
        logs = []
        logic = installer_logic.LinuxLogic(logs.append)
        with patch.object(installer_logic, "INSTALL_DIR", special_dir), \
             patch.dict(os.environ, {"SHELL": "/bin/zsh"}):
            result = logic.add_to_path()

        self.assertIsInstance(result, dict)
        self.assertEqual(result["status"], "manual")
        self.assertEqual(result["directory"], special_dir)
        self.assertEqual(result["shell_rc"], "~/.zshrc")
        expected_session = f'export PATH="$PATH:"{shlex.quote(special_dir)}'
        self.assertEqual(result["session_command"], expected_session)
        self.assertIn(shlex.quote(expected_session), result["persist_command"])
        self.assertTrue(result["persist_command"].endswith(">> ~/.zshrc"))
        self.assertTrue(any(expected_session in line for line in logs))
        self.assertTrue(any("~/.zshrc" in line for line in logs))

    def test_run_diagnostics_emits_step_by_step_progress_logs(self):
        """InstallerLogic.run_diagnostics logs each dependency check and browser cookie test stage in real time."""
        logs = []
        logic = installer_logic.LinuxLogic(logs.append)
        fake_status = {
            "ytdlp": {"found": True, "path": "/usr/bin/yt-dlp", "version": "2026.01.01"},
            "mpv": {"found": True, "path": "/usr/bin/mpv"},
            "ffmpeg": {"found": True, "path": "/usr/bin/ffmpeg", "version": "7.0"},
            "node": {"found": False, "path": None, "error": "not found"},
        }
        fake_proc = MagicMock(returncode=0, stderr="", stdout="")

        with patch.object(installer_logic.services, "check_mpv_and_ytdlp_status", return_value=fake_status), \
             patch.object(installer_logic.subprocess, "run", return_value=fake_proc):
            report, has_err = logic.run_diagnostics("brave")

        self.assertFalse(has_err)
        self.assertIn("yt-dlp found: 2026.01.01", report)
        self.assertIn("Cookie access successful for brave", report)
        joined_logs = "\n".join(logs)
        self.assertIn("Checking yt-dlp...", joined_logs)
        self.assertIn("Checking mpv...", joined_logs)
        self.assertIn("Checking FFmpeg...", joined_logs)
        self.assertIn("Checking Node.js...", joined_logs)
        self.assertIn("Testing browser cookie extraction for 'brave'...", joined_logs)
        self.assertIn("Diagnostics complete.", joined_logs)

    # --- Docs-vs-code drift checks ---

    def test_ytdlp_settings_only_flags_rejected_from_untrusted_item_payloads(self):
        """All YTDLP_SETTINGS_ONLY_FLAGS are stripped when allow_settings_flags=False and kept when True."""
        self.assertTrue(len(security.YTDLP_SETTINGS_ONLY_FLAGS) > 0)
        for flag in security.YTDLP_SETTINGS_ONLY_FLAGS:
            option_str = f"{flag}=testval,format=best"
            sanitized_item = security.sanitize_ytdlp_options(option_str, allow_settings_flags=False)
            self.assertNotIn(
                flag,
                sanitized_item,
                f"Settings-only flag '{flag}' leaked into untrusted item payload: {sanitized_item}",
            )
            self.assertIn("format=best", sanitized_item)

            sanitized_settings = security.sanitize_ytdlp_options(option_str, allow_settings_flags=True)
            self.assertIn(f"{flag}=testval", sanitized_settings)

    def test_max_outbound_message_size_under_chrome_1mib_limit(self):
        """MAX_OUTBOUND_MESSAGE_SIZE must remain strictly <= 1048576 (Chrome 1 MiB limit)."""
        # Verify MAX_OUTBOUND_MESSAGE_SIZE <= Chrome's 1 MiB limit without importing native_host at module level
        nh_path = os.path.join(
            os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
            "native_host.py",
        )
        with open(nh_path, "r", encoding="utf-8") as f:
            nh_src = f.read()
        self.assertIn("MAX_OUTBOUND_MESSAGE_SIZE = 900 * 1024", nh_src)


if __name__ == "__main__":
    unittest.main()
