import os
import sys
import unittest
import time
from unittest.mock import patch

# Ensure base_test can be imported
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from base_test import BaseTestCase

from utils import logger
from utils.handlers.data_handler import DataHandler
from utils.native_link.models import LogRequest, DataSyncRequest, LogBrowserErrorRequest
from utils.native_link import translator

class MockMpv:
    def restore(self): return {}

class MockDiagnosticCollector:
    def __init__(self):
        self.errors = []

    def add_error(self, context, error):
        self.errors.append({"context": context, "error": str(error)})

    def get_errors(self):
        return list(self.errors)

class MockContext:
    def __init__(self, test_dir, mock_send):
        self.data_dir = test_dir
        self.script_dir = test_dir
        self.sender = mock_send
        self.mpv = MockMpv()
        self.io = None
        self.services = None
        self.ipc = None
        self.diagnostic_collector = MockDiagnosticCollector()

class TestLoggingPipeline(BaseTestCase):
    """
    Tests the full pipeline from JS LogRequest and LogBrowserErrorRequest through the
    Python Handler to the disk and back through the Unified Diagnostic report.
    """
    def setUp(self):
        super().setUp()
        self.ctx = MockContext(self.test_dir, self.mock_send)
        self.handler = DataHandler(self.ctx)

    def test_js_to_python_mapping(self):
        """Verifies that JS log levels map accurately to Python log levels and preserve metadata."""
        levels_to_test = [
            ("FATAL", "CRITICAL"),
            ("ERROR", "ERROR"),
            ("WARN", "WARNING"),
            ("WARNING", "WARNING"),
            ("INFO", "INFO"),
            ("DEBUG", "DEBUG"),
        ]

        for js_level, py_level in levels_to_test:
            req = LogRequest(
                action="log_event",
                request_id=f"REQ-{js_level}",
                level=js_level,
                message=f"Status at {js_level}",
                context=f"CTX_{js_level}"
            )
            token = logger.request_id_var.set(f"REQ-{js_level}")
            try:
                self.handler.handle_log_event(req)
                self.wait_for_async()
            finally:
                logger.request_id_var.reset(token)

            with open(self.main_log, 'r') as f:
                content = f.read()
                self.assertIn(py_level, content, f"Expected {py_level} in log for JS {js_level}")
                self.assertIn(f"[JS-CTX_{js_level}]", content)
                self.assertIn(f"[Req: REQ-{js_level}]", content)
                self.assertIn(f"Status at {js_level}", content)

    def test_browser_error_end_to_end_wire_to_disk_and_diagnostics(self):
        """
        Tests end-to-end log_browser_error handling from raw wire dictionary translation
        to browser_errors.log disk formatting and retrieval via get_unified_diagnostics.
        """
        raw_wire_msg = {
            "action": "log_browser_error",
            "requestId": "REQ-BRW-404",
            "context": "POPUP_UI",
            "message": "Uncaught TypeError: Cannot read property 'play' of undefined",
            "stack": (
                "TypeError: Cannot read property 'play' of undefined\n"
                "    at HTMLButtonElement.onClick (chrome-extension://xyz/popup.js:2478:15)\n"
                "    at ZoneDelegate.invokeTask (chrome-extension://xyz/zone.js:406:31)\n"
                "    at HTMLButtonElement.dispatch (chrome-extension://xyz/jquery.js:5429:27)"
            )
        }

        # 1. Translate from wire JSON to model
        translated_req = translator.translate(raw_wire_msg)
        self.assertIsInstance(translated_req, LogBrowserErrorRequest)
        self.assertEqual(translated_req.context, "POPUP_UI")
        self.assertEqual(translated_req.message, "Uncaught TypeError: Cannot read property 'play' of undefined")
        self.assertIn("at HTMLButtonElement.onClick", translated_req.stack)

        # 2. Handle request
        result = self.handler.handle_log_browser_error(translated_req)
        self.assertTrue(result['success'])
        self.wait_for_async()

        # 3. Verify clean writing to browser_errors.log
        self.assertTrue(os.path.exists(self.browser_error_log))
        with open(self.browser_error_log, 'r', encoding='utf-8') as f:
            browser_content = f.read()
            # Context and message on the primary error line
            self.assertIn("[POPUP_UI] Uncaught TypeError: Cannot read property 'play' of undefined", browser_content)
            # Indented stack prefix
            self.assertIn("\n  Stack: TypeError: Cannot read property 'play' of undefined", browser_content)
            # Preserved multiline frames
            self.assertIn("at HTMLButtonElement.onClick (chrome-extension://xyz/popup.js:2478:15)", browser_content)
            self.assertIn("at ZoneDelegate.invokeTask (chrome-extension://xyz/zone.js:406:31)", browser_content)
            self.assertIn("at HTMLButtonElement.dispatch (chrome-extension://xyz/jquery.js:5429:27)", browser_content)

        # 4. Strict isolation: browser errors must not appear in native_host.log or ipc_events.log
        with open(self.main_log, 'r', encoding='utf-8') as f:
            main_content = f.read()
            self.assertNotIn("Cannot read property 'play' of undefined", main_content)
            self.assertNotIn("at HTMLButtonElement.onClick", main_content)

        with open(self.ipc_log, 'r', encoding='utf-8') as f:
            ipc_content = f.read()
            self.assertNotIn("Cannot read property 'play' of undefined", ipc_content)

        # 5. Verify inclusion in unified diagnostics
        diag_req = DataSyncRequest(action="get_unified_diagnostics")
        diag_resp = self.handler.handle_get_unified_diagnostics(diag_req)
        self.assertTrue(diag_resp['success'])
        self.assertIn("browserLog", diag_resp)

        diag_browser_log = diag_resp['browserLog']
        self.assertIn("[POPUP_UI] Uncaught TypeError: Cannot read property 'play' of undefined", diag_browser_log)
        self.assertIn("at HTMLButtonElement.onClick", diag_browser_log)
        self.assertIn("at ZoneDelegate.invokeTask", diag_browser_log)

    def test_browser_error_with_error_key_fallback(self):
        """Verifies translator fallback when JS passes 'error' instead of 'message'."""
        raw_msg = {
            "action": "log_browser_error",
            "context": "STORAGE_MANAGER",
            "error": "QuotaExceededError: LocalStorage limit reached",
            "stack": "QuotaExceededError\n    at setItem (storage.js:15:10)"
        }
        req = translator.translate(raw_msg)
        self.assertIsInstance(req, LogBrowserErrorRequest)
        self.assertEqual(req.message, "QuotaExceededError: LocalStorage limit reached")

        self.handler.handle_log_browser_error(req)
        self.wait_for_async()

        with open(self.browser_error_log, 'r', encoding='utf-8') as f:
            content = f.read()
            self.assertIn("[STORAGE_MANAGER] QuotaExceededError: LocalStorage limit reached", content)
            self.assertIn("at setItem (storage.js:15:10)", content)

    def test_log_event_dual_routing_for_errors_and_isolation_for_info(self):
        """
        Verifies that handle_log_event routes ERROR/FATAL to both browser_errors.log
        and native_host.log, whereas INFO/DEBUG are isolated to native_host.log.
        """
        err_req = LogRequest(
            action="log_event",
            level="ERROR",
            context="BACKGROUND",
            message="Failed to connect to MPV socket",
            stack="Error: Socket ECONNREFUSED\n    at background.js:88:12"
        )
        info_req = LogRequest(
            action="log_event",
            level="INFO",
            context="BACKGROUND",
            message="Heartbeat tick processed normally"
        )

        self.handler.handle_log_event(err_req)
        self.handler.handle_log_event(info_req)
        self.wait_for_async()

        # Check browser_errors.log: only the error should be present
        with open(self.browser_error_log, 'r', encoding='utf-8') as f:
            browser_content = f.read()
            self.assertIn("[BACKGROUND] Failed to connect to MPV socket", browser_content)
            self.assertIn("Socket ECONNREFUSED", browser_content)
            self.assertNotIn("Heartbeat tick processed normally", browser_content)

        # Check native_host.log: both events should be present
        with open(self.main_log, 'r', encoding='utf-8') as f:
            main_content = f.read()
            self.assertIn("[JS-BACKGROUND] Failed to connect to MPV socket", main_content)
            self.assertIn("[JS-BACKGROUND] Heartbeat tick processed normally", main_content)

        # Verify unified diagnostics reflects both logs accurately
        diag_resp = self.handler.handle_get_unified_diagnostics(DataSyncRequest(action="get_unified_diagnostics"))
        self.assertTrue(diag_resp['success'])
        self.assertIn("Failed to connect to MPV socket", diag_resp['browserLog'])
        self.assertNotIn("Heartbeat tick processed normally", diag_resp['browserLog'])
        self.assertIn("Failed to connect to MPV socket", diag_resp['nativeLog'])
        self.assertIn("Heartbeat tick processed normally", diag_resp['nativeLog'])

    def test_unified_diagnostics_corrupted_utf8_log(self):
        """Verifies that invalid/corrupted UTF-8 bytes in log files are handled without crashing."""
        # Inject corrupted binary data into browser_errors.log
        with open(self.browser_error_log, 'wb') as f:
            f.write(b"[Browser] Valid log head before corruption\n")
            f.write(b"\xff\xfe\x80\xbf\xfaMalformed non-utf8 binary junk\xed\xa0\x80\n")
            f.write(b"[Browser] Valid log tail after corruption\n")

        # Inject corrupted binary into native_host.log as well
        with open(self.main_log, 'wb') as f:
            f.write(b"Native host head\n\x80\x81\x82Corrupt\nNative host tail\n")

        diag_req = DataSyncRequest(action="get_unified_diagnostics")
        response = self.handler.handle_get_unified_diagnostics(diag_req)

        self.assertTrue(response['success'])
        browser_log = response['browserLog']
        native_log = response['nativeLog']

        # Valid text preserved
        self.assertIn("Valid log head before corruption", browser_log)
        self.assertIn("Valid log tail after corruption", browser_log)
        self.assertIn("Native host head", native_log)
        self.assertIn("Native host tail", native_log)

        # Replacement character used for corrupted bytes
        self.assertIn("\ufffd", browser_log)
        self.assertIn("\ufffd", native_log)

    def test_unified_diagnostics_oversized_log_truncation(self):
        """Verifies that oversized log files (>100KB) are truncated to the tail cleanly."""
        # 250KB of content written to native_host.log
        oversized_path = self.main_log
        with open(oversized_path, 'wb') as f:
            f.write(b"EARLIEST_RECORD_TRUNCATED_OFFSET_0\n")
            # 250KB padding
            for i in range(2500):
                f.write(f"PADDING_LINE_{i:05d}: filler log message for size limit testing\n".encode('utf-8'))
            f.write(b"LATEST_RECORD_PRESERVED_TAIL_AT_EOF\n")

        size_on_disk = os.path.getsize(oversized_path)
        self.assertGreater(size_on_disk, 100 * 1024)

        diag_req = DataSyncRequest(action="get_unified_diagnostics")
        response = self.handler.handle_get_unified_diagnostics(diag_req)

        self.assertTrue(response['success'])
        native_log = response['nativeLog']

        # Head of oversized file should be skipped
        self.assertNotIn("EARLIEST_RECORD_TRUNCATED_OFFSET_0", native_log)
        # Tail of oversized file must be retained
        self.assertIn("LATEST_RECORD_PRESERVED_TAIL_AT_EOF", native_log)
        # Size returned should not exceed the 100KB read_tail limit (allowing for re-init log line)
        self.assertLessEqual(len(native_log.encode('utf-8')), 100 * 1024 + 1024)

    def test_unified_diagnostics_mid_character_multibyte_utf8_split(self):
        """
        Verifies that if read_tail seeks into the middle of a 4-byte UTF-8 sequence
        at the 100KB boundary, decoding gracefully replaces the split byte without crashing.
        """
        # Exactly 102,500 bytes in browser_errors.log
        # Seeking -102400 from EOF lands at offset 100.
        # We put a 4-byte UTF-8 emoji across bytes 98, 99, 100, 101.
        prefix = b'A' * 98
        emoji = '🚀'.encode('utf-8')  # 4 bytes: \xf0\x9f\x9a\x80
        total_target = 102500
        suffix = b'Z' * (total_target - 98 - len(emoji))
        payload = prefix + emoji + suffix
        self.assertEqual(len(payload), total_target)

        with open(self.browser_error_log, 'wb') as f:
            f.write(payload)

        diag_req = DataSyncRequest(action="get_unified_diagnostics")
        response = self.handler.handle_get_unified_diagnostics(diag_req)

        self.assertTrue(response['success'])
        browser_log = response['browserLog']
        self.assertIn("\ufffd", browser_log)
        self.assertTrue(browser_log.endswith("Z" * 100))

    def test_unified_diagnostics_missing_and_unreadable_logs(self):
        """Verifies resilience when log files are missing or unreadable due to I/O permissions."""
        # 1. Missing log file simulation
        orig_exists = os.path.exists
        def mock_exists(p):
            if str(p).endswith("ipc_events.log"):
                return False
            return orig_exists(p)

        with patch("os.path.exists", side_effect=mock_exists):
            response = self.handler.handle_get_unified_diagnostics(DataSyncRequest(action="get_unified_diagnostics"))
            self.assertTrue(response['success'])
            self.assertEqual(response['ipcLog'], "[File not found: ipc_events.log]")

        # 2. Unreadable log file simulation (e.g. PermissionError)
        orig_open = open
        def mock_open_func(file, *args, **kwargs):
            if "browser_errors.log" in str(file) and "rb" in args:
                raise PermissionError("Access denied")
            return orig_open(file, *args, **kwargs)

        with patch("builtins.open", side_effect=mock_open_func):
            response = self.handler.handle_get_unified_diagnostics(DataSyncRequest(action="get_unified_diagnostics"))
            self.assertTrue(response['success'])
            self.assertIn("[Error reading browser_errors.log: Access denied]", response['browserLog'])

    def test_unified_diagnostics_generation(self):
        """Verifies that the unified report correctly merges JS, Python, and collector data."""
        # 1. Generate local logs
        logger.info("Local Python event for test")
        self.wait_for_async()

        # 2. Add native collector error
        self.ctx.diagnostic_collector.add_error("IPC_CHANNEL", "Broken pipe on socket /tmp/mpv.sock")

        # 3. Simulate incoming JS diagnostics
        js_diag_data = {
            "errors": [{"error": "JS Script Error", "timestamp": "2026-03-01T00:00:00Z"}],
            "userAgent": "Mozilla/5.0 (Mock)",
            "breadcrumbs": [{"msg": "Clicked Play"}]
        }

        req = DataSyncRequest(
            action="get_unified_diagnostics",
            data=js_diag_data
        )

        response = self.handler.handle_get_unified_diagnostics(req)

        # 4. Validate complete report
        self.assertTrue(response['success'])
        self.assertIn("jsDiagnostics", response)
        self.assertEqual(response['jsDiagnostics']['userAgent'], "Mozilla/5.0 (Mock)")
        self.assertIn("nativeDiagnostics", response)
        self.assertTrue(any(e.get("context") == "IPC_CHANNEL" for e in response['nativeDiagnostics']))
        self.assertIn("nativeLog", response)
        self.assertIn("Local Python event for test", response['nativeLog'])
        self.assertIn("systemInfo", response)
        self.assertIn("pythonVersion", response['systemInfo'])
        self.assertIn("browserLog", response)
        self.assertIn("ipcLog", response)

    def test_rate_limit_resilience(self):
        """Simulates a burst of logs to ensure the non-blocking queue doesn't choke."""
        start_time = time.time()
        for i in range(50):
            req = LogRequest(
                action="log_event",
                level="INFO",
                message=f"Spam message {i}",
                context="STRESS_TEST"
            )
            self.handler.handle_log_event(req)

        duration = time.time() - start_time
        self.assertLess(duration, 1.0, "Queue submission took longer than expected for 50 records")

        # Shutdown should flush them all to disk
        logger.shutdown()

        with open(self.main_log, 'r') as f:
            lines = f.readlines()
            self.assertGreaterEqual(len(lines), 50)

if __name__ == '__main__':
    unittest.main()
