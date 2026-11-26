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
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        res = subprocess.run(
            [sys.executable, "-B", "-c", script],
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

    def test_get_message_returns_none_on_mid_frame_eof(self):
        """Regression: native_host.get_message returns None cleanly when stdin hits EOF mid-frame."""
        script = (
            "import io, struct, sys, native_host; "
            "header = struct.pack('@I', 100); "
            "sys.stdin = io.TextIOWrapper(io.BytesIO(header + b'{\"partial\": 1')); "
            "res = native_host.get_message(); "
            "assert res is None, f'Expected None, got {res!r}'"
        )
        env = os.environ.copy()
        env["XDG_DATA_HOME"] = self.test_dir
        env["HOME"] = self.test_dir
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        res = subprocess.run(
            [sys.executable, "-B", "-c", script],
            cwd=os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
            env=env,
            capture_output=True,
            timeout=15,
        )
        self.assertEqual(res.returncode, 0, msg=res.stderr.decode("utf-8", errors="replace"))

    def test_trim_oversized_reply_unified_snake_and_camel_case(self):
        """Regression: session_health.trim_oversized_reply trims both snake_case and camelCase preview fields."""
        from utils import session_health

        snake_payload = {"success": True, "enriched_m3u_content": "X" * 5000, "keep": "ok"}
        session_health.trim_oversized_reply(snake_payload, max_bytes=1024, camel_case=False)
        self.assertNotIn("enriched_m3u_content", snake_payload)
        self.assertTrue(snake_payload.get("payload_truncated"))
        self.assertEqual(snake_payload.get("keep"), "ok")

        camel_payload = {"success": True, "enrichedM3uContent": "Y" * 5000, "keep": "ok"}
        session_health.trim_oversized_reply(camel_payload, max_bytes=1024, camel_case=True)
        self.assertNotIn("enrichedM3uContent", camel_payload)
        self.assertTrue(camel_payload.get("payloadTruncated"))
        self.assertEqual(camel_payload.get("keep"), "ok")

    # --- Tooling & installer regressions ---

    def test_create_release_excludes_agents_and_vulkan_fallback(self):
        """create_release.IGNORE_PATTERNS excludes .agents and vulkan_fallback.lua."""
        import create_release

        self.assertIn(".agents", create_release.IGNORE_PATTERNS)
        self.assertIn("vulkan_fallback.lua", create_release.IGNORE_PATTERNS)

    def test_generate_bridge_contract_writes_atomically_via_os_replace(self):
        """generate_contract writes to a temp file in scripts/ and atomically replaces bridge_contract.js."""
        import generate_bridge_contract

        scripts_dir = os.path.join(self.test_dir, "scripts")
        os.makedirs(scripts_dir, exist_ok=True)
        fake_mod_file = os.path.join(self.test_dir, "generate_bridge_contract.py")
        replace_calls = []
        real_replace = os.replace

        def tracking_replace(src, dst):
            replace_calls.append((src, dst))
            return real_replace(src, dst)

        with patch.object(generate_bridge_contract, "__file__", fake_mod_file), \
             patch.object(generate_bridge_contract.os, "replace", side_effect=tracking_replace), \
             patch("sys.stdout", new_callable=io.StringIO):
            generate_bridge_contract.generate_contract()

        expected_target = os.path.join(scripts_dir, "bridge_contract.js")
        self.assertTrue(os.path.isfile(expected_target))
        self.assertEqual(len(replace_calls), 1)
        src_path, dst_path = replace_calls[0]
        self.assertEqual(dst_path, expected_target)
        self.assertEqual(os.path.dirname(src_path), scripts_dir)
        self.assertNotEqual(src_path, dst_path)

    def test_run_suite_zero_tests_fails_and_worker_timeout_handled(self):
        """run_python_batch fails when 0 tests match and _run_python_worker handles TimeoutExpired."""
        import run_suite

        with patch("sys.stdout", new_callable=io.StringIO):
            ok, passed, total = run_suite.run_python_batch("EmptyBatch", "test_nonexistent_xyz_*.py")
        self.assertFalse(ok)
        self.assertEqual((passed, total), (0, 0))

        with patch.object(
            run_suite.subprocess,
            "run",
            side_effect=subprocess.TimeoutExpired(cmd=["python"], timeout=run_suite.PY_WORKER_TIMEOUT),
        ):
            tf, wok, wpass, wtotal, out, _err = run_suite._run_python_worker("test_dummy.py")
        self.assertEqual(tf, "test_dummy.py")
        self.assertFalse(wok)
        self.assertEqual((wpass, wtotal), (0, 0))
        self.assertIn("TIMED OUT", out)

    def test_run_suite_syncs_contract_before_workers(self):
        """run_all_tests syncs bridge_contract.js before spawning workers and skips re-sync in run_js_batch."""
        import run_suite

        events = []

        def fake_sync():
            events.append("sync")
            return True

        def fake_worker(tf, _verbose=False):
            events.append(f"worker:{tf}")
            return tf, True, 1, 1, "", ""

        def fake_js_batch(verbose=False, sync_contract=True):
            events.append(f"js_batch:sync={sync_contract}")
            return True, 1, 1, 1, 1, 1, 1

        with patch.object(run_suite, "_sync_bridge_contract", side_effect=fake_sync), \
             patch.object(run_suite, "discover_python_test_files", return_value=["test_one.py"]), \
             patch.object(run_suite, "_run_python_worker", side_effect=fake_worker), \
             patch.object(run_suite, "run_js_batch", side_effect=fake_js_batch), \
             patch("sys.stdout", new_callable=io.StringIO):
            ok = run_suite.run_all_tests(verbose=False)

        self.assertTrue(ok)
        self.assertEqual(events[0], "sync")
        self.assertIn("js_batch:sync=False", events)

    def test_generate_js_fails_fast_on_unmapped_imports_and_no_stale_messaging_dep(self):
        """generate_js raises ValueError on unmapped imports and omits stale ../background/messaging.js."""
        import generate_js

        for entry in generate_js.CONFIG:
            self.assertNotIn("../background/messaging.js", entry["dependencies"])

        mod_path = os.path.join(self.test_dir, "sample.module.js")
        with open(mod_path, "w", encoding="utf-8") as f:
            f.write('import { foo } from "./missing.module.js";\nexport const x = foo;\n')
        with self.assertRaises(ValueError) as ctx:
            generate_js.render_module_js(
                {"source": "sample.module.js", "namespace": "MPV_TEST", "dependencies": {}},
                project_root=self.test_dir,
            )
        self.assertIn("Unmapped import in sample.module.js: ./missing.module.js", str(ctx.exception))

        with open(mod_path, "w", encoding="utf-8") as f:
            f.write('import * as Bar from "./missing_star.module.js";\nexport const x = Bar;\n')
        with self.assertRaises(ValueError) as ctx2:
            generate_js.render_module_js(
                {"source": "sample.module.js", "namespace": "MPV_TEST", "dependencies": {}},
                project_root=self.test_dir,
            )
        self.assertIn("Unmapped import in sample.module.js: ./missing_star.module.js", str(ctx2.exception))

    def test_installer_falls_back_to_cli_on_tcl_error(self):
        """installer.main falls back cleanly to CommandLineApp when tk.Tk() raises TclError."""
        import installer

        class FakeTclError(Exception):
            pass

        fake_tk = MagicMock()
        fake_tk.TclError = FakeTclError
        fake_tk.Tk.side_effect = FakeTclError("no display name")
        fake_cli_instance = MagicMock()
        fake_cli_cls = MagicMock(return_value=fake_cli_instance)

        with patch.object(installer, "GUI_AVAILABLE", True), \
             patch.object(installer, "tk", fake_tk, create=True), \
             patch.object(installer, "CommandLineApp", fake_cli_cls), \
             patch.object(sys, "argv", ["installer.py"]), \
             patch("sys.stderr", new_callable=io.StringIO):
            installer.main()

        fake_cli_cls.assert_called_once()
        fake_cli_instance.run.assert_called_once()

    def test_unix_install_handles_per_browser_oserror_and_warns_on_zero_linked(self):
        """UnixLogic.install continues past per-browser OSError and warns when 0 browsers are linked."""
        fake_script = os.path.join(self.test_dir, installer_logic.SCRIPT_NAME)
        with open(fake_script, "w", encoding="utf-8") as f:
            f.write("#!/usr/bin/env python3\n")
        fake_data_dir = os.path.join(self.test_dir, "data")
        os.makedirs(fake_data_dir, exist_ok=True)
        fake_status = {
            "ffmpeg": {"found": False, "path": None},
            "node": {"found": False, "path": None},
        }
        valid_id = "abcdefghijklmnopabcdefghijklmnop"

        # Case 1: 0 browser dirs exist -> logs warning
        logs_zero = []
        logic_zero = installer_logic.LinuxLogic(logs_zero.append)
        with patch.object(installer_logic, "INSTALL_DIR", self.test_dir), \
             patch.object(installer_logic, "DATA_DIR", fake_data_dir), \
             patch.object(installer_logic.file_io, "DATA_DIR", fake_data_dir), \
             patch.object(installer_logic.file_io, "set_settings"), \
             patch.object(installer_logic.services, "get_gpu_vendor", return_value="intel"), \
             patch.object(installer_logic.services, "check_mpv_and_ytdlp_status", return_value=fake_status), \
             patch.object(logic_zero, "get_browser_configs", return_value={
                 "MissingBrowser": os.path.join(self.test_dir, "nonexistent_parent", "NativeMessagingHosts")
             }):
            logic_zero.install(valid_id, False, "brave", False)
        self.assertTrue(any("WARNING" in line and "no browser" in line.lower() for line in logs_zero), logs_zero)

        # Case 2: first browser fails with OSError, second browser succeeds
        parent_a = os.path.join(self.test_dir, "browser_a")
        parent_b = os.path.join(self.test_dir, "browser_b")
        os.makedirs(parent_a, exist_ok=True)
        os.makedirs(parent_b, exist_ok=True)
        path_a = os.path.join(parent_a, "NativeMessagingHosts")
        path_b = os.path.join(parent_b, "NativeMessagingHosts")

        logs_partial = []
        logic_partial = installer_logic.LinuxLogic(logs_partial.append)
        real_symlink = os.symlink

        def flaky_symlink(src, dst):
            if dst.startswith(path_a):
                raise PermissionError("read-only dir")
            return real_symlink(src, dst)

        with patch.object(installer_logic, "INSTALL_DIR", self.test_dir), \
             patch.object(installer_logic, "DATA_DIR", fake_data_dir), \
             patch.object(installer_logic.file_io, "DATA_DIR", fake_data_dir), \
             patch.object(installer_logic.file_io, "set_settings"), \
             patch.object(installer_logic.services, "get_gpu_vendor", return_value="intel"), \
             patch.object(installer_logic.services, "check_mpv_and_ytdlp_status", return_value=fake_status), \
             patch.object(installer_logic.os, "symlink", side_effect=flaky_symlink), \
             patch.object(logic_partial, "get_browser_configs", return_value={
                 "BrowserA": path_a,
                 "BrowserB": path_b,
             }):
            logic_partial.install(valid_id, False, "brave", False)

        self.assertTrue(any("BrowserA" in line and "WARNING" in line for line in logs_partial), logs_partial)
        self.assertTrue(any("Linked manifest for BrowserB" in line for line in logs_partial), logs_partial)
        self.assertTrue(os.path.islink(os.path.join(path_b, f"{installer_logic.HOST_NAME}.json")))

    def test_installer_ui_thread_safe_install_and_browser_selector_enabled(self):
        """HostManagerApp reads Tk vars on main thread for install and keeps browser/diagnostics enabled."""
        from installer_src import installer_ui

        app = installer_ui.HostManagerApp.__new__(installer_ui.HostManagerApp)
        app.extension_id_var = MagicMock()
        app.extension_id_var.get.return_value = "abcdefghijklmnopabcdefghijklmnop"
        app.create_bypass_var = MagicMock()
        app.create_bypass_var.get.return_value = False
        app.browser_var = MagicMock()
        app.browser_var.get.return_value = "chrome"
        app.enable_youtube_bypass_var = MagicMock()
        app.enable_youtube_bypass_var.get.return_value = True
        app.install_button = MagicMock()
        app.browser_combobox = MagicMock()
        app.diagnostics_btn = MagicMock()
        app.browser_label = MagicMock()
        app.yt_bypass_checkbutton = MagicMock()
        app.yt_bypass_label = MagicMock()

        app._toggle_url_analysis_widgets()
        app.browser_combobox.config.assert_called_with(state="readonly")
        app.diagnostics_btn.config.assert_called_with(state=installer_ui.tk.NORMAL)
        app.yt_bypass_checkbutton.config.assert_called_with(state=installer_ui.tk.DISABLED)

        with patch.object(installer_ui.threading, "Thread") as mock_thread:
            app.run_install()
        mock_thread.assert_called_once_with(
            target=app._install_thread,
            args=("abcdefghijklmnopabcdefghijklmnop", False, "chrome", True),
        )
        mock_thread.return_value.start.assert_called_once()


if __name__ == "__main__":
    unittest.main()
