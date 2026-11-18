import os
import sys
import unittest
import threading
import logging
import time

# Ensure base_test can be imported
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from base_test import BaseTestCase

from utils import logger, security
from utils.logger import SecurityFormatter

class TestLoggingSystem(BaseTestCase):
    """Verifies the core Python logging architecture (Zero Latency, Correlation, Masking, Thread Safety)."""

    def test_basic_logging_and_masking(self):
        """Verifies that logs are written and paths are masked."""
        secret_path = os.path.join(self.test_dir, "secret.txt")
        logger.info(f"Accessing file at {secret_path}")
        self.wait_for_async()

        with open(self.main_log, 'r', encoding='utf-8') as f:
            content = f.read()
            self.assertIn("Accessing file at <DATA_DIR>/secret.txt", content)
            self.assertNotIn(self.test_dir, content)

    def test_request_correlation(self):
        """Verifies that request_id is correctly associated with logs."""
        token = logger.request_id_var.set("REQ-123")
        try:
            logger.info("Starting task")
            self.wait_for_async()

            with open(self.main_log, 'r', encoding='utf-8') as f:
                content = f.read()
                self.assertIn("[Req: REQ-123] Starting task", content)
        finally:
            logger.request_id_var.reset(token)

    def test_ui_notifications(self):
        """Verifies that ui_notify=True sends messages to the bridge."""
        logger.error("Database connection failed", ui_notify=True)
        self.wait_for_async()

        # Check UI message
        self.assertTrue(any(m.get('log', {}).get('text') == "Database connection failed" for m in self.sent_messages))

        # Check file log
        with open(self.main_log, 'r', encoding='utf-8') as f:
            content = f.read()
            self.assertIn("Database connection failed", content)

    def test_ipc_routing(self):
        """Verifies that 'ipc_events' logs go to the dedicated file."""
        ipc = logging.getLogger("ipc_events")
        ipc.info("MPV_EVENT: time-pos=10.5")
        logger.info("MAIN_EVENT: user-action")
        self.wait_for_async()

        with open(self.ipc_log, 'r', encoding='utf-8') as f:
            ipc_content = f.read()
            self.assertIn("MPV_EVENT: time-pos=10.5", ipc_content)
            self.assertNotIn("MAIN_EVENT", ipc_content)

        with open(self.main_log, 'r', encoding='utf-8') as f:
            main_content = f.read()
            self.assertIn("MAIN_EVENT: user-action", main_content)
            self.assertNotIn("MPV_EVENT", main_content)

    def test_browser_error_routing(self):
        """Verifies that 'browser_errors' logs go to the dedicated file and remain separate."""
        browser_log = logging.getLogger("browser_errors")
        browser_log.error("[Popup] Uncaught TypeError: test error")
        logger.info("MAIN_EVENT: should not be in browser errors")
        self.wait_for_async()

        self.assertTrue(os.path.exists(self.browser_error_log))
        with open(self.browser_error_log, 'r', encoding='utf-8') as f:
            browser_content = f.read()
            self.assertIn("[Popup] Uncaught TypeError: test error", browser_content)
            self.assertNotIn("MAIN_EVENT", browser_content)

        with open(self.main_log, 'r', encoding='utf-8') as f:
            main_content = f.read()
            self.assertIn("MAIN_EVENT: should not be in browser errors", main_content)
            self.assertNotIn("[Popup] Uncaught TypeError", main_content)

    def test_decorators(self):
        """Verifies @trace and @catch decorators."""
        @logger.trace(name="MyTask")
        def slow_func():
            return "done"

        @logger.catch(ui_alert=True)
        def crashing_func():
            raise ValueError("Borked!")

        slow_func()
        crashing_func()
        self.wait_for_async()

        with open(self.main_log, 'r', encoding='utf-8') as f:
            content = f.read()
            self.assertIn("[TRACE] ENTERING MyTask", content)
            self.assertIn("[TRACE] EXITING MyTask", content)
            self.assertIn("Crashed in crashing_func: Borked!", content)

        # Check UI alert for crash
        self.assertTrue(any("Fatal Error in crashing_func: Borked!" in m.get('log', {}).get('text', '') for m in self.sent_messages))

    def test_observe_stream_ytdlp_failure(self):
        """Verifies that yt-dlp failures are detected and reported."""
        class MockPipe:
            def __init__(self, lines):
                self.lines = lines
                self.index = 0

            def readline(self, *args):
                if self.index < len(self.lines):
                    line = self.lines[self.index]
                    self.index += 1
                    return line
                return b''

            def __enter__(self): return self
            def __exit__(self, *args): pass
            def close(self): pass

        mock_output = [
            b"DEBUG: Initializing\n",
            b"ERROR: [youtube] 12345: YouTube said: Unable to extract video data\n",
            b"HTTP Error 410: Gone\n"
        ]

        observer_factory = logger.observe_stream(tag="YTDL-TEST", folder_id="folder-99", send_message_func=self.mock_send)

        pipe = MockPipe(mock_output)
        t = threading.Thread(target=observer_factory, args=(pipe,))
        t.start()
        t.join()
        self.wait_for_async()

        self.assertTrue(any(m.get('action') == "ytdlp_update_check" for m in self.sent_messages))
        self.assertTrue(any("folder-99" == m.get('folder_id') for m in self.sent_messages))

    def test_path_masking_none_and_edge_types(self):
        """Verifies that mask_path safely handles NoneType, empty, and non-string inputs."""
        # None and empty text
        self.assertIsNone(security.mask_path(None, "/data", "/app", "/home"))
        self.assertEqual(security.mask_path("", "/data", "/app", "/home"), "")

        # Non-string text
        self.assertEqual(security.mask_path(12345, "/data", "/app", "/home"), 12345)
        self.assertEqual(security.mask_path(["/home/user"], "/data", "/app", "/home"), ["/home/user"])
        self.assertEqual(security.mask_path({"path": "/home/user"}, "/data", "/app", "/home"), {"path": "/home/user"})

        # NoneType directory parameters
        result_none_dirs = security.mask_path("Path: /custom/path/file.txt", None, None, home_dir="")
        self.assertEqual(result_none_dirs, "Path: /custom/path/file.txt")

        # Fallback to home when data_dir and script_dir are None
        result_home_only = security.mask_path("Home: /home/testuser/doc.txt", None, None, home_dir="/home/testuser")
        self.assertEqual(result_home_only, "Home: <HOME>/doc.txt")

        # Specific directory replacements when others are None
        self.assertEqual(
            security.mask_path("Data: /var/data/app.db", "/var/data", None, home_dir=""),
            "Data: <DATA_DIR>/app.db"
        )
        self.assertEqual(
            security.mask_path("App: /opt/my_app/bin", None, "/opt/my_app", home_dir=""),
            "App: <APP_DIR>/bin"
        )

    def test_path_masking_nested_subdirectories(self):
        """
        Verifies that mask_path replaces the longest matching path first so that nested
        subdirectories (data inside app inside home) resolve to the most specific token.
        """
        home = "/home/developer"
        app = "/home/developer/projects/mpv-playlist-organizer"
        data = "/home/developer/projects/mpv-playlist-organizer/app_data"

        # 1. Path deep inside data_dir: must become <DATA_DIR>, NOT <APP_DIR> or <HOME>
        data_path = f"{data}/playlists/favorites.json"
        masked_data = security.mask_path(data_path, data, app, home)
        self.assertEqual(masked_data, "<DATA_DIR>/playlists/favorites.json")
        self.assertNotIn(home, masked_data)
        self.assertNotIn(app, masked_data)

        # 2. Path inside app_dir (outside data_dir): must become <APP_DIR>, NOT <HOME>
        app_path = f"{app}/utils/logger.py"
        masked_app = security.mask_path(app_path, data, app, home)
        self.assertEqual(masked_app, "<APP_DIR>/utils/logger.py")
        self.assertNotIn(home, masked_app)

        # 3. Path inside home_dir (outside app and data): must become <HOME>
        home_path = f"{home}/.config/mpv/mpv.conf"
        masked_home = security.mask_path(home_path, data, app, home)
        self.assertEqual(masked_home, "<HOME>/.config/mpv/mpv.conf")

        # 4. Exact directory matches
        self.assertEqual(security.mask_path(data, data, app, home), "<DATA_DIR>")
        self.assertEqual(security.mask_path(app, data, app, home), "<APP_DIR>")
        self.assertEqual(security.mask_path(home, data, app, home), "<HOME>")

        # 5. External path outside all registered directories remains untouched
        self.assertEqual(security.mask_path("/var/log/syslog", data, app, home), "/var/log/syslog")

        # 6. Alternative system hierarchy: app in /opt, data in ~/.local/share
        alt_home = "/home/user"
        alt_app = "/opt/mpv-organizer"
        alt_data = "/home/user/.local/share/mpv-organizer"

        self.assertEqual(
            security.mask_path(f"{alt_data}/cache.db", alt_data, alt_app, alt_home),
            "<DATA_DIR>/cache.db"
        )
        self.assertEqual(
            security.mask_path(f"{alt_app}/native_host.py", alt_data, alt_app, alt_home),
            "<APP_DIR>/native_host.py"
        )
        self.assertEqual(
            security.mask_path(f"{alt_home}/video.mp4", alt_data, alt_app, alt_home),
            "<HOME>/video.mp4"
        )

    def test_path_masking_multiple_tokens_and_occurrences(self):
        """Verifies that multiple occurrences and combinations of paths in a single string are all masked."""
        home = "/home/developer"
        app = "/opt/mpv-organizer"
        data = "/var/lib/mpv-organizer"

        # Multiple distinct tokens in one log message
        multi_msg = (
            f"Copying config from {app}/defaults/config.json to {data}/config.json "
            f"for user profile at {home}/.profile (backup saved to {data}/backups/config.bak)"
        )
        expected_multi = (
            "Copying config from <APP_DIR>/defaults/config.json to <DATA_DIR>/config.json "
            "for user profile at <HOME>/.profile (backup saved to <DATA_DIR>/backups/config.bak)"
        )
        self.assertEqual(security.mask_path(multi_msg, data, app, home), expected_multi)

        # Multiple occurrences of the same token
        repeated_msg = f"Syncing {data}/file_a.txt against {data}/file_b.txt inside {data}/store"
        expected_repeated = "Syncing <DATA_DIR>/file_a.txt against <DATA_DIR>/file_b.txt inside <DATA_DIR>/store"
        self.assertEqual(security.mask_path(repeated_msg, data, app, home), expected_repeated)

        # Tokens in command line flags
        flags_msg = f"--data-dir={data} --script-dir={app} --user-home={home}"
        expected_flags = "--data-dir=<DATA_DIR> --script-dir=<APP_DIR> --user-home=<HOME>"
        self.assertEqual(security.mask_path(flags_msg, data, app, home), expected_flags)

    def test_security_formatter_resilience(self):
        """Verifies SecurityFormatter handling of non-string messages, missing attrs, and restoration."""
        formatter = SecurityFormatter('%(message)s')
        formatter.data_dir = "/custom/data"
        formatter.script_dir = "/custom/app"

        # 1. Non-string record.msg: int
        rec_int = logging.LogRecord('test', logging.INFO, 'path', 1, 404, (), None)
        self.assertEqual(formatter.format(rec_int), "404")
        self.assertEqual(rec_int.msg, 404, "SecurityFormatter must restore original message")

        # 2. None record.msg
        rec_none = logging.LogRecord('test', logging.INFO, 'path', 1, None, (), None)
        self.assertEqual(formatter.format(rec_none), "None")
        self.assertIsNone(rec_none.msg)

        # 3. Dict record.msg
        rec_dict = logging.LogRecord('test', logging.INFO, 'path', 1, {"status": "ok"}, (), None)
        self.assertEqual(formatter.format(rec_dict), "{'status': 'ok'}")
        self.assertEqual(rec_dict.msg, {"status": "ok"})

        # 4. Formatter without data_dir or script_dir
        f_bare = SecurityFormatter('%(message)s')
        rec_bare = logging.LogRecord('test', logging.INFO, 'path', 1, "/custom/data/file.txt", (), None)
        self.assertIn("/custom/data/file.txt", f_bare.format(rec_bare))

        # 5. Formatter with request_id injection
        rec_req = logging.LogRecord('test', logging.INFO, 'path', 1, "Executing query", (), None)
        rec_req.request_id = "CORR-777"
        self.assertEqual(formatter.format(rec_req), "[Req: CORR-777] Executing query")
        self.assertEqual(rec_req.msg, "Executing query")

        # 6. Live logger test with non-string and None messages through QueueListener
        logger.info(12345)
        logger.info(None)
        self.wait_for_async()

        with open(self.main_log, 'r', encoding='utf-8') as f:
            content = f.read()
            self.assertIn("12345", content)
            self.assertIn("None", content)

    def test_multithreaded_concurrent_logging_safety(self):
        """
        Verifies thread safety, non-blocking queue performance, and strict stream isolation
        under high concurrent write pressure across native_host.log, ipc_events.log, and browser_errors.log.
        """
        threads_per_stream = 4
        logs_per_thread = 25
        total_threads = threads_per_stream * 3
        barrier = threading.Barrier(total_threads)

        def main_worker(thread_idx):
            token = logger.request_id_var.set(f"MAIN-T{thread_idx}")
            barrier.wait()
            for seq in range(logs_per_thread):
                logger.info(f"MAIN_CONCURRENT thread={thread_idx} seq={seq}")
            logger.request_id_var.reset(token)

        def ipc_worker(thread_idx):
            ipc_logger = logging.getLogger("ipc_events")
            token = logger.request_id_var.set(f"IPC-T{thread_idx}")
            barrier.wait()
            for seq in range(logs_per_thread):
                ipc_logger.info(f"IPC_CONCURRENT thread={thread_idx} seq={seq}")
            logger.request_id_var.reset(token)

        def browser_worker(thread_idx):
            brw_logger = logging.getLogger("browser_errors")
            token = logger.request_id_var.set(f"BRW-T{thread_idx}")
            barrier.wait()
            for seq in range(logs_per_thread):
                brw_logger.error(f"BRW_CONCURRENT thread={thread_idx} seq={seq}")
            logger.request_id_var.reset(token)

        threads = []
        for i in range(threads_per_stream):
            threads.append(threading.Thread(target=main_worker, args=(i,)))
            threads.append(threading.Thread(target=ipc_worker, args=(i,)))
            threads.append(threading.Thread(target=browser_worker, args=(i,)))

        start_time = time.time()
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        # Flush queue completely
        logger.shutdown()
        elapsed = time.time() - start_time
        self.assertLess(elapsed, 5.0, "Concurrent logging exceeded acceptable execution threshold")

        # 1. Verify file contents and message counts
        with open(self.main_log, 'r', encoding='utf-8') as f:
            main_lines = [line.strip() for line in f if "MAIN_CONCURRENT" in line]
            f.seek(0)
            main_full = f.read()

        with open(self.ipc_log, 'r', encoding='utf-8') as f:
            ipc_lines = [line.strip() for line in f if "IPC_CONCURRENT" in line]
            f.seek(0)
            ipc_full = f.read()

        with open(self.browser_error_log, 'r', encoding='utf-8') as f:
            brw_lines = [line.strip() for line in f if "BRW_CONCURRENT" in line]
            f.seek(0)
            brw_full = f.read()

        expected_count = threads_per_stream * logs_per_thread
        self.assertEqual(len(main_lines), expected_count, f"Expected {expected_count} main logs, got {len(main_lines)}")
        self.assertEqual(len(ipc_lines), expected_count, f"Expected {expected_count} ipc logs, got {len(ipc_lines)}")
        self.assertEqual(len(brw_lines), expected_count, f"Expected {expected_count} browser logs, got {len(brw_lines)}")

        # 2. Strict stream isolation: verify no cross-log bleed
        self.assertNotIn("IPC_CONCURRENT", main_full, "IPC logs leaked into native_host.log")
        self.assertNotIn("BRW_CONCURRENT", main_full, "Browser logs leaked into native_host.log")

        self.assertNotIn("MAIN_CONCURRENT", ipc_full, "Main logs leaked into ipc_events.log")
        self.assertNotIn("BRW_CONCURRENT", ipc_full, "Browser logs leaked into ipc_events.log")

        self.assertNotIn("MAIN_CONCURRENT", brw_full, "Main logs leaked into browser_errors.log")
        self.assertNotIn("IPC_CONCURRENT", brw_full, "IPC logs leaked into browser_errors.log")

        # 3. ContextVar correlation verification: each thread's request ID must match its records
        for line in main_lines:
            # Extract thread ID from thread=X
            tid_part = line.split("thread=")[1].split(" ")[0]
            expected_req = f"[Req: MAIN-T{tid_part}]"
            self.assertIn(expected_req, line, f"Mismatched request ID correlation in line: {line}")

        # 4. Line integrity: verify all lines are properly terminated and contain standard log structure
        for log_lines, name in [(main_lines, "native_host"), (ipc_lines, "ipc_events"), (brw_lines, "browser_errors")]:
            for line in log_lines:
                self.assertIn(" - ", line, f"Corrupted unformatted line in {name}: {line}")
                self.assertFalse(line.startswith(" "), f"Interleaved line start in {name}: {line}")

if __name__ == '__main__':
    unittest.main()
