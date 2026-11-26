import os
import sys
import unittest
import json
import socket
import threading
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from base_test import BaseTestCase

import file_io
from utils import ipc_utils, session_services, url_analyzer
from mpv_session import MpvSessionManager
from playlist_tracker import PlaylistTracker

class TestPlaybackIPCConcurrency(BaseTestCase):
    """Verifies PY-H3, PY-M1, PY-M2, PY-M3, PY-M4, PY-M5, PY-M6, PY-M8, PY-M10, PY-M11, PY-M12, PY-M13, PY-M14."""

    def setUp(self):
        super().setUp()
        self.orig_data_dir = file_io.DATA_DIR
        file_io.initialize_paths(self.test_dir)

    def tearDown(self):
        file_io.initialize_paths(self.orig_data_dir)
        super().tearDown()

    def test_verify_mpv_process_rejects_unrelated_pid(self):
        """Fix PY-H3: verify_mpv_process should reject non-mpv running PIDs (like python itself)."""
        my_pid = os.getpid()
        # My process is python, not mpv
        self.assertFalse(ipc_utils.verify_mpv_process(my_pid))
        self.assertFalse(ipc_utils.verify_mpv_process(-1))
        self.assertFalse(ipc_utils.verify_mpv_process(99999999))

    def test_verify_mpv_process_with_matching_ipc(self):
        """Fix PY-H3: verify_mpv_process succeeds if IPC returns matching pid."""
        with patch.object(ipc_utils.IPCSocketManager, 'connect', return_value=True), \
             patch.object(ipc_utils.IPCSocketManager, 'get_property', return_value=1234), \
             patch.object(ipc_utils.IPCSocketManager, 'close', return_value=None), \
             patch.object(ipc_utils, 'is_pid_running', return_value=True):
            self.assertTrue(ipc_utils.verify_mpv_process(1234, ipc_path="/tmp/fake_socket"))
            self.assertFalse(ipc_utils.verify_mpv_process(5678, ipc_path="/tmp/fake_socket"))

    def test_launcher_service_close_refuses_unverified_pid(self):
        """Fix PY-H3: LauncherService.close() must never send signals to unverified PIDs."""
        session_mock = MagicMock()
        session_mock.is_alive = True
        session_mock.pid = 98765
        session_mock.ipc_path = "/tmp/fake.sock"
        session_mock.ipc_manager = None
        session_mock.process = None
        session_mock.manual_quit = False
        session_mock.is_closing = False
        session_mock.sync_lock = MagicMock()
        session_mock.sync_lock.__enter__ = MagicMock(return_value=session_mock)
        session_mock.sync_lock.__exit__ = MagicMock(return_value=None)

        launcher = session_services.LauncherService(session_mock)
        with patch.object(ipc_utils, 'verify_mpv_process', return_value=False), \
             patch('os.kill') as mock_kill, \
             patch('subprocess.run') as mock_subproc:
            res = launcher.close()
            self.assertTrue(res.get("success"))
            mock_kill.assert_not_called()
            mock_subproc.assert_not_called()

    def test_is_socket_stale_handles_timeout_as_busy(self):
        """Fix PY-M1: _is_socket_stale treats timeouts as busy (False), not stale (True)."""
        with patch('socket.socket') as mock_sock_cls:
            mock_sock = MagicMock()
            mock_sock.connect.side_effect = socket.timeout()
            mock_sock_cls.return_value = mock_sock
            with patch('os.path.exists', return_value=True), patch('platform.system', return_value='Linux'):
                self.assertFalse(ipc_utils.IPCSocketManager._is_socket_stale("/tmp/fake_sock"))

        with patch('socket.socket') as mock_sock_cls:
            mock_sock = MagicMock()
            mock_sock.connect.side_effect = ConnectionRefusedError()
            mock_sock_cls.return_value = mock_sock
            with patch('os.path.exists', return_value=True), patch('platform.system', return_value='Linux'):
                self.assertTrue(ipc_utils.IPCSocketManager._is_socket_stale("/tmp/fake_sock"))

    def test_cleanup_stale_sockets_scoped_to_ipc_dir(self):
        """Fix PY-M1: cleanup_stale_sockets only cleans inside IPC_DIR_LINUX, not /tmp or /dev/shm."""
        fake_ipc_dir = os.path.join(self.test_dir, "test_ipc")
        os.makedirs(fake_ipc_dir, exist_ok=True)
        stale_sock = os.path.join(fake_ipc_dir, "mpv-socket-1111")
        with open(stale_sock, 'w') as f:
            f.write("")

        with patch.object(ipc_utils, 'IPC_DIR_LINUX', fake_ipc_dir), \
             patch.object(ipc_utils.IPCSocketManager, '_is_socket_stale', return_value=True), \
             patch('stat.S_ISSOCK', return_value=True), \
             patch('platform.system', return_value='Linux'):
            ipc_utils.IPCSocketManager.cleanup_stale_sockets()
            self.assertFalse(os.path.exists(stale_sock))

    def test_volatile_cookie_manager_per_process_isolation(self):
        """Fix PY-M2: VolatileCookieManager uses mkdtemp and cleans only its own directory."""
        v_dir = url_analyzer.VolatileCookieManager.get_volatile_dir()
        try:
            self.assertTrue(os.path.isdir(v_dir))
            self.assertIn(str(os.getpid()), v_dir)
            if os.name != 'nt':
                st = os.stat(v_dir)
                self.assertEqual(st.st_mode & 0o777, 0o700)
        finally:
            url_analyzer.VolatileCookieManager.cleanup_volatile_dir()
        self.assertFalse(os.path.exists(v_dir))

    def test_flag_file_safe_reading(self):
        """Fix PY-M3: Flag files read safely with length cap and remove."""
        flag_dir = os.path.join(self.test_dir, "flags_safe")
        os.makedirs(flag_dir, exist_ok=True)
        flag_file = os.path.join(flag_dir, "mpv_natural_completion_12345.flag")
        with open(flag_file, 'w', encoding='utf-8') as f:
            f.write("natural_completion_test\n")

        content = session_services._safe_read_flag_file(flag_file)
        self.assertEqual(content, "natural_completion_test")
        self.assertFalse(os.path.exists(flag_file))

    def test_session_generation_stale_waiter_clear_ignored(self):
        """Fix PY-M4: clear() with mismatched session_generation is ignored."""
        deps = {
            'get_all_folders_from_file': lambda: {},
            'get_mpv_executable': lambda: 'mpv',
            'log_stream': MagicMock(),
            'send_message': MagicMock(),
            'SCRIPT_DIR': self.test_dir,
            'TEMP_PLAYLISTS_DIR': os.path.join(self.test_dir, 'temp_playlists'),
            'metadata_cache': None,
            'task_manager': None
        }
        session_file = os.path.join(self.test_dir, "session.json")
        mgr = MpvSessionManager(session_file, deps)
        mgr.session_generation = 5
        mgr.is_alive = True
        mgr.pid = 4321

        # Clear with old generation token 4 should be ignored
        res = mgr.clear(mpv_return_code=0, session_generation=4)
        self.assertEqual(res, {})
        self.assertTrue(mgr.is_alive)
        self.assertEqual(mgr.pid, 4321)

        # Clear with current generation 5 should succeed
        mgr.clear(mpv_return_code=0, session_generation=5)
        self.assertFalse(mgr.is_alive)
        self.assertIsNone(mgr.pid)

    def test_file_io_update_shard(self):
        """Fix PY-M5: update_shard performs atomic read-modify-write under lock."""
        folder_id = "test_shard_folder"
        initial_items = [{"id": "item1", "title": "Test 1"}]
        file_io.save_index({folder_id: {"name": folder_id, "item_count": 1, "last_played_id": "item1"}})
        file_io.save_playlist_shard(folder_id, initial_items, update_index=True)

        def modifier(playlist, index_entry):
            playlist.append({"id": "item2", "title": "Test 2"})
            if index_entry is not None:
                index_entry["last_played_id"] = "item2"
            return True

        success = file_io.update_shard(folder_id, modifier, update_index=True)
        self.assertTrue(success)

        updated_items = file_io.get_playlist_shard(folder_id)
        self.assertEqual(len(updated_items), 2)
        self.assertEqual(updated_items[1]["id"], "item2")

        index = file_io.get_index()
        self.assertEqual(index[folder_id]["last_played_id"], "item2")
        self.assertEqual(index[folder_id]["item_count"], 2)

    def test_file_io_get_settings_preserves_corrupt_file(self):
        """Fix PY-M8: get_settings() does not overwrite corrupt config.json with defaults."""
        config_path = file_io.CONFIG_FILE
        # Write invalid/corrupt JSON to config_path
        with open(config_path, 'w', encoding='utf-8') as f:
            f.write("INVALID JSON CONTENT {{{")

        # Invalidate cache
        with file_io._settings_lock:
            file_io._settings_cache = None
            file_io._settings_mtime = None

        settings = file_io.get_settings()
        self.assertIsInstance(settings, dict)
        self.assertTrue(settings.get("enable_smart_resume"))

        # Verify the file on disk was NOT overwritten by defaults!
        with open(config_path, 'r', encoding='utf-8') as f:
            disk_content = f.read()
        self.assertEqual(disk_content, "INVALID JSON CONTENT {{{")

    def test_tracker_snapshot_recovery_on_commit_failure(self):
        """Fix PY-M6: PlaylistTracker restores snapshot if _commit_to_disk fails."""
        mock_file_io = MagicMock()
        mock_file_io.update_shard.return_value = False # Commit fails!

        tracker = PlaylistTracker("folder_1", [], mock_file_io, {}, "/tmp/fake.sock", MagicMock())
        tracker.resume_cache["item_10"] = 120
        tracker.watched_status_cache["item_10"] = True
        tracker.watched_cache["item_10"] = True
        tracker.dirty_last_played_id = "item_10"

        tracker._commit_to_disk()

        # Check that snapshots were merged back into caches
        self.assertEqual(tracker.resume_cache.get("item_10"), 120)
        self.assertEqual(tracker.watched_status_cache.get("item_10"), True)
        self.assertEqual(tracker.watched_cache.get("item_10"), True)
        self.assertEqual(tracker.dirty_last_played_id, "item_10")

    def test_mpv_session_restore_clean_state_on_failure(self):
        """Fix PY-M10: restore() cleans state if persistent IPC connect fails."""
        deps = {
            'get_all_folders_from_file': lambda: {},
            'get_mpv_executable': lambda: 'mpv',
            'log_stream': MagicMock(),
            'send_message': MagicMock(),
            'SCRIPT_DIR': self.test_dir,
            'TEMP_PLAYLISTS_DIR': os.path.join(self.test_dir, 'temp_playlists'),
            'metadata_cache': None,
            'task_manager': None
        }
        session_file = os.path.join(self.test_dir, "session.json")
        with open(session_file, 'w', encoding='utf-8') as f:
            json.dump({"pid": 99999, "ipc_path": "/tmp/fakesock", "owner_folder_id": "fld1"}, f)

        mgr = MpvSessionManager(session_file, deps)

        with patch.object(ipc_utils, 'verify_mpv_process', return_value=True), \
             patch('file_io.get_folder_data', return_value={"playlist": []}), \
             patch.object(ipc_utils.IPCSocketManager, 'connect', side_effect=[True, False]): # probe connects, persistent fails
            res = mgr.restore()
            self.assertIsNone(res)
            # Ensure internal state was cleanly reset
            self.assertIsNone(mgr.pid)
            self.assertIsNone(mgr.ipc_path)
            self.assertIsNone(mgr.owner_folder_id)
            self.assertFalse(mgr.is_alive)
            self.assertIsNone(mgr.ipc_manager)

    def test_append_batch_prepend_metadata_indices(self):
        """Fix PY-M11: Prepend sends updated set_url_options for all shifted items with expect_response=False."""
        deps = {
            'get_all_folders_from_file': lambda: {},
            'get_mpv_executable': lambda: 'mpv',
            'log_stream': MagicMock(),
            'send_message': MagicMock(),
            'SCRIPT_DIR': self.test_dir,
            'TEMP_PLAYLISTS_DIR': os.path.join(self.test_dir, 'temp_playlists'),
            'metadata_cache': None,
            'task_manager': None
        }
        session_file = os.path.join(self.test_dir, "session.json")
        mgr = MpvSessionManager(session_file, deps)
        mgr.is_alive = True
        mgr.owner_folder_id = "folder1"
        mgr.playlist = [{"id": "item1", "url": "https://example.com/1", "title": "Old 1"}]

        mock_ipc = MagicMock()
        mock_ipc.is_connected.return_value = True
        mock_ipc.send.return_value = {"error": "success"}
        mgr.ipc_manager = mock_ipc

        with patch.object(mgr, '_sync_playlist_from_mpv', return_value=True):
            new_items = [{"id": "item2", "url": "https://example.com/2", "title": "New 2"}]
            mgr.append_batch(new_items, mode="prepend", folder_id="folder1", quiet=True)

        # Check playlist order
        self.assertEqual(len(mgr.playlist), 2)
        self.assertEqual(mgr.playlist[0]["id"], "item2")
        self.assertEqual(mgr.playlist[1]["id"], "item1")

        # Verify set_url_options calls used expect_response=False
        set_url_calls = [
            call for call in mock_ipc.send.call_args_list
            if call[0] and call[0][0].get("command", [])[:2] == ["script-message", "set_url_options"]
        ]
        self.assertTrue(len(set_url_calls) >= 2)
        for call in set_url_calls:
            self.assertEqual(call[1].get("expect_response"), False)

    def test_playlist_tracker_time_pos_throttled_by_bucket(self):
        """Fix PY-M13: time-pos only updates resume time once per 5s integer bucket."""
        mock_file_io = MagicMock()
        tracker = PlaylistTracker("folder_1", [], mock_file_io, {}, "/tmp/fake.sock", MagicMock())
        tracker.current_id = "test_item_1"
        tracker.is_tracking = True
        tracker.last_time_pos = 0.0

        with patch.object(tracker, '_update_resume_time') as mock_update_resume:
            # Feed multiple time-pos updates in the 5s bucket, a non-5s second (6.1), and the 10s bucket
            for t in [5.1, 5.2, 5.8, 6.1, 10.1]:
                tracker._on_time_pos(t)

            # _update_resume_time should only be called ONCE per 5s bucket (at 5.1 and 10.1)
            self.assertEqual(mock_update_resume.call_count, 2)
            mock_update_resume.assert_any_call("test_item_1", 5.1)
            mock_update_resume.assert_any_call("test_item_1", 10.1)

    def test_update_playlist_order_creates_copy(self):
        """Fix PY-M14: update_playlist_order copies list to prevent aliasing."""
        mock_file_io = MagicMock()
        tracker = PlaylistTracker("folder_1", [], mock_file_io, {}, "/tmp/fake.sock", MagicMock())
        external_list = [{"id": "a"}, {"id": "b"}]
        tracker.update_playlist_order(external_list)
        # Modifying external list should not alter tracker.playlist
        external_list.append({"id": "c"})
        self.assertEqual(len(tracker.playlist), 2)

    def test_hot_swap_item_primed_resume_time_only_when_positive(self):
        """hot_swap_item only sets user-data/primed-resume-time when start_time > 0."""
        from utils import session_ipc_ops

        mock_session = MagicMock()
        mock_session.SCRIPT_DIR = "/tmp/mpv_scripts"
        mock_session.ipc_manager.is_connected.return_value = True
        mock_session.ipc_manager.get_property.side_effect = [
            [{"filename": "https://example.com/1"}],  # playlist
            2,  # playlist-count
        ]

        # Case 1: resume_time == 0 -> must NOT send primed-resume-time
        item_zero = {"id": "item2", "url": "https://example.com/2", "title": "Item 2", "resume_time": 0}
        session_ipc_ops.hot_swap_item(
            mock_session,
            item_zero,
            "Anime",
            {"enable_precise_resume": True},
            [item_zero],
        )
        primed_calls = [
            c for c in mock_session.ipc_manager.send.call_args_list
            if c[0] and c[0][0].get("command", [])[:2] == ["set_property", "user-data/primed-resume-time"]
        ]
        self.assertEqual(len(primed_calls), 0)

        # Case 2: resume_time == 42.7 -> must send primed-resume-time "42"
        mock_session.ipc_manager.send.reset_mock()
        mock_session.ipc_manager.get_property.side_effect = [
            [{"filename": "https://example.com/1"}],
            2,
        ]
        item_pos = {"id": "item2", "url": "https://example.com/2", "title": "Item 2", "resume_time": 42.7}
        session_ipc_ops.hot_swap_item(
            mock_session,
            item_pos,
            "Anime",
            {"enable_precise_resume": True},
            [item_pos],
        )
        primed_calls = [
            c for c in mock_session.ipc_manager.send.call_args_list
            if c[0] and c[0][0].get("command", [])[:2] == ["set_property", "user-data/primed-resume-time"]
        ]
        self.assertEqual(len(primed_calls), 1)
        self.assertEqual(primed_calls[0][0][0]["command"][2], "42")

    def test_start_splices_expanded_youtube_playlist_items(self):
        """Regression: MpvSessionManager.start() splices all expanded items from a YouTube /playlist?list= entry."""
        from mpv_session import MpvSessionManager

        expanded = [
            {"id": "ep1", "url": "https://www.youtube.com/watch?v=ep1", "title": "Episode 1"},
            {"id": "ep2", "url": "https://www.youtube.com/watch?v=ep2", "title": "Episode 2"},
            {"id": "ep3", "url": "https://www.youtube.com/watch?v=ep3", "title": "Episode 3"},
        ]

        mock_enricher = MagicMock()
        mock_enricher.resolve_input_items.return_value = (
            [{"id": "pl1", "url": "https://www.youtube.com/playlist?list=PL_TEST", "title": "YT Playlist"}],
            True,
        )
        mock_enricher.enrich_single_item.return_value = expanded

        captured = {}

        def fake_launch(launch_item, folder_id, settings, file_io_mod, full_playlist=None, **kwargs):
            captured["launch_item"] = launch_item
            captured["full_playlist"] = full_playlist
            return {"success": True, "handled_directly": True}

        mock_launcher = MagicMock()
        mock_launcher.launch.side_effect = fake_launch

        deps = {
            'get_all_folders_from_file': lambda: {},
            'get_mpv_executable': lambda: 'mpv',
            'log_stream': MagicMock(),
            'send_message': MagicMock(),
            'SCRIPT_DIR': self.test_dir,
            'TEMP_PLAYLISTS_DIR': os.path.join(self.test_dir, 'temp_playlists'),
            'metadata_cache': None,
            'task_manager': None,
        }
        mgr = MpvSessionManager(os.path.join(self.test_dir, "session.json"), deps)
        mgr.enricher = mock_enricher
        mgr.launcher = mock_launcher
        mgr._start_health_watcher = MagicMock()
        mgr.register_ipc_callbacks = MagicMock()

        res = mgr.start(
            [{"id": "pl1", "url": "https://www.youtube.com/playlist?list=PL_TEST", "title": "YT Playlist"}],
            "WatchLater",
            {"enable_smart_resume": False},
            MagicMock(),
        )
        self.assertTrue(res.get("success"))
        self.assertEqual(len(captured["full_playlist"]), 3)
        self.assertEqual([i["title"] for i in captured["full_playlist"]], ["Episode 1", "Episode 2", "Episode 3"])

    def test_pipe_has_data_windows_returns_false_on_exception(self):
        """Regression: _pipe_has_data_windows must return False on unexpected exceptions to avoid blocking readline."""
        bad_handle = MagicMock()
        bad_handle.fileno.side_effect = RuntimeError("broken pipe handle")
        with patch("platform.system", return_value="Windows"):
            self.assertFalse(ipc_utils._pipe_has_data_windows(bad_handle))

    def test_persist_session_atomic_uses_atomic_json_dump_0600_no_bak(self):
        """Regression: persist_session_atomic writes 0o600 session.json via file_io._atomic_json_dump without .bak."""
        from utils import session_health

        session_file = os.path.join(self.test_dir, "session.json")
        fake_session = MagicMock()
        fake_session.session_file = session_file
        fake_session.pid = 12345
        fake_session.ipc_path = "/tmp/fake.sock"
        fake_session.owner_folder_id = "Anime"
        fake_session.current_token = "tok"
        fake_session.create_time = 1000.0
        fake_session.session_generation = 2

        session_health.persist_session_atomic(fake_session)
        self.assertTrue(os.path.exists(session_file))
        self.assertFalse(os.path.exists(f"{session_file}.bak"))
        if os.name != "nt":
            self.assertEqual(os.stat(session_file).st_mode & 0o777, 0o600)
        with open(session_file, "r", encoding="utf-8") as f:
            saved = json.load(f)
        self.assertEqual(saved["pid"], 12345)
        self.assertEqual(saved["session_generation"], 2)

    def test_unified_diagnostics_does_not_restart_logger(self):
        """Regression: handle_get_unified_diagnostics flushes handlers without calling logger.shutdown/initialize."""
        from utils.handlers.data_handler import DataHandler
        from utils import logger as logger_module

        ctx = MagicMock()
        ctx.data_dir = self.test_dir
        ctx.script_dir = self.test_dir
        ctx.diagnostic_collector = None
        handler = DataHandler(ctx)

        req = MagicMock()
        req.data = {}
        fake_handler = MagicMock()
        fake_listener = MagicMock()
        fake_listener.handlers = [fake_handler]

        with patch.object(logger_module, "shutdown") as mock_shutdown, \
             patch.object(logger_module, "initialize") as mock_init, \
             patch.object(logger_module, "_listener", fake_listener), \
             patch.object(logger_module, "_active_data_dir", self.test_dir):
            res = handler.handle_get_unified_diagnostics(req)

        self.assertTrue(res.get("success"))
        mock_shutdown.assert_not_called()
        mock_init.assert_not_called()
        fake_handler.flush.assert_called_once()

    def test_run_update_command_kills_on_timeout(self):
        """Regression: _run_update_command terminates hung subprocesses when timeout expires."""
        from utils import dependency_manager

        msgs = []
        rc = dependency_manager._run_update_command(
            [sys.executable, "-B", "-c", "import time; time.sleep(10)"],
            msgs.append,
            timeout=0.2,
        )
        self.assertEqual(rc, -1)
        self.assertTrue(any("timed out" in (m.get("log", {}).get("text", "").lower()) for m in msgs))

    def test_health_watcher_keeps_watching_after_dead_until_pid_gone(self):
        """Regression: start_health_watcher stays alive across transient wake stalls and clears once MPV PID is gone."""
        from utils import session_health

        clear_called = threading.Event()
        session = MagicMock()
        session.sync_lock = threading.RLock()
        session.is_alive = True
        session.pid = 54321
        session.ipc_path = "/tmp/fake.sock"
        session.owner_folder_id = "Anime"
        session.session_generation = 1
        session.health_watcher_thread = None
        session.ipc_manager = MagicMock()
        session.ipc_manager.get_property.return_value = None

        def on_clear(**_kwargs):
            session.is_alive = False
            clear_called.set()

        session.clear.side_effect = on_clear

        # First "dead" tick: PID still verified alive (transient sleep/wake stall); second tick: PID gone
        verify_results = iter([True, False])

        with patch.object(session_health.ipc_utils, "is_pid_running", return_value=True), \
             patch.object(session_health.ipc_utils, "verify_mpv_process", side_effect=lambda *_a, **_kw: next(verify_results, False)), \
             patch.object(session_health.time, "sleep", return_value=None):
            session_health.start_health_watcher(session)
            self.assertTrue(clear_called.wait(timeout=2.0), "Watcher must stay alive after first dead tick and clear once verify_mpv_process is False")
            session.health_watcher_thread.join(timeout=2.0)

        session.clear.assert_called_once_with(session_generation=1)

    def test_is_mpv_running_clears_zombie_or_reused_pid_when_ipc_fails(self):
        """Regression: handle_is_mpv_running clears session if IPC ping fails and PID is no longer verified as MPV."""
        from utils.handlers.playback_handler import PlaybackHandler

        ctx = MagicMock()
        ctx.mpv.sync_lock = threading.RLock()
        ctx.mpv.is_alive = True
        ctx.mpv.pid = 99999
        ctx.mpv.ipc_path = "/tmp/stale.sock"
        ctx.mpv.owner_folder_id = "Anime"
        ctx.mpv.ipc_manager.is_connected.return_value = True
        ctx.mpv.ipc_manager.get_property.return_value = None
        ctx.ipc.is_pid_running.return_value = True
        ctx.ipc.verify_mpv_process.return_value = False

        handler = PlaybackHandler(ctx)
        res = handler.handle_is_mpv_running(MagicMock())

        self.assertEqual(res.get("isRunning"), False)
        ctx.mpv.clear.assert_called_once()

    def test_get_playback_status_clears_zombie_or_reused_pid_when_ipc_fails(self):
        """Regression: handle_get_playback_status clears session if IPC ping fails and PID is no longer verified as MPV."""
        from utils.handlers.playback_handler import PlaybackHandler

        ctx = MagicMock()
        ctx.mpv.sync_lock = threading.RLock()
        ctx.mpv.is_alive = True
        ctx.mpv.pid = 99998
        ctx.mpv.ipc_path = "/tmp/stale.sock"
        ctx.mpv.owner_folder_id = "Anime"
        ctx.mpv.playlist = []
        ctx.mpv.playlist_tracker = None
        ctx.mpv.ipc_manager.is_connected.return_value = True
        ctx.mpv.ipc_manager.get_property.return_value = None
        ctx.ipc.is_pid_running.return_value = True
        ctx.ipc.verify_mpv_process.return_value = False

        handler = PlaybackHandler(ctx)
        res = handler.handle_get_playback_status(MagicMock())

        self.assertEqual(res.get("isRunning"), False)
        ctx.mpv.clear.assert_called_once()

    def test_verify_mpv_process_rejects_zombie_process(self):
        """Regression: verify_mpv_process returns False for a zombie mpv process via psutil."""
        fake_psutil = MagicMock()
        fake_psutil.STATUS_ZOMBIE = "zombie"
        fake_proc = MagicMock()
        fake_proc.status.return_value = "zombie"
        fake_proc.name.return_value = "mpv"
        fake_proc.cmdline.return_value = []
        fake_psutil.Process.return_value = fake_proc

        with patch.object(ipc_utils, "is_pid_running", return_value=True), \
             patch.object(ipc_utils.platform, "system", return_value="Darwin"), \
             patch.dict(sys.modules, {"psutil": fake_psutil}):
            self.assertFalse(ipc_utils.verify_mpv_process(42424, ipc_path=None))

    def test_check_session_liveness_does_not_clear_newer_generation_or_none_pid(self):
        """Regression: _check_session_liveness guards clear() by snap_gen and non-None pid."""
        from utils.handlers.playback_handler import PlaybackHandler

        ctx = MagicMock()
        ctx.mpv.sync_lock = threading.RLock()
        ctx.mpv.is_alive = True
        ctx.mpv.pid = 77777
        ctx.mpv.session_generation = 2
        ctx.mpv.ipc_path = "/tmp/stale.sock"
        ctx.mpv.ipc_manager.is_connected.return_value = True

        # Simulate a newer session (gen 3) starting while IPC ping is in flight
        def advance_gen(*_args, **_kwargs):
            ctx.mpv.session_generation = 3
            return None

        ctx.mpv.ipc_manager.get_property.side_effect = advance_gen
        ctx.ipc.is_pid_running.return_value = True
        ctx.ipc.verify_mpv_process.return_value = False

        handler = PlaybackHandler(ctx)
        res = handler.handle_is_mpv_running(MagicMock())
        self.assertEqual(res.get("isRunning"), False)
        ctx.mpv.clear.assert_not_called()

        # When pid is None (idle), _check_session_liveness must not call clear()
        ctx.mpv.pid = None
        ctx.mpv.is_alive = False
        ctx.mpv.session_generation = 3
        handler.handle_is_mpv_running(MagicMock())
        ctx.mpv.clear.assert_not_called()

    def test_launcher_close_passes_captured_generation_to_clear(self):
        """Regression: LauncherService.close passes the generation captured under sync_lock to clear()."""
        session_mock = MagicMock()
        session_mock.is_alive = True
        session_mock.pid = 88888
        session_mock.session_generation = 7
        session_mock.ipc_path = "/tmp/fake.sock"
        session_mock.ipc_manager = None
        session_mock.process = None
        session_mock.manual_quit = False
        session_mock.is_closing = False
        session_mock.sync_lock = threading.RLock()

        def bump_gen(*_args, **_kwargs):
            session_mock.session_generation = 8
            return False

        launcher = session_services.LauncherService(session_mock)
        with patch.object(ipc_utils, "verify_mpv_process", side_effect=bump_gen):
            res = launcher.close()

        self.assertTrue(res.get("success"))
        session_mock.clear.assert_called_once_with(mpv_return_code=0, session_generation=7)

    def test_anilist_cache_concurrent_offsets_preserved(self):
        """Regression: get_anilist_releases_with_cache merges offsets atomically under one FileLock."""
        from utils import anilist_service

        cache_file = os.path.join(self.test_dir, "anilist_cache.json")

        def fake_fetch(_self, is_ping, days=0):
            return {"success": True, "output": json.dumps({"day": days, "raw_schedules_for_cache": []})}

        with patch.object(anilist_service.AniListCache, "_fetch_from_anilist_script", fake_fetch):
            t1 = threading.Thread(
                target=anilist_service.get_anilist_releases_with_cache,
                args=(False, False, False, 0, cache_file, self.test_dir, MagicMock()),
            )
            t2 = threading.Thread(
                target=anilist_service.get_anilist_releases_with_cache,
                args=(False, False, False, 1, cache_file, self.test_dir, MagicMock()),
            )
            t1.start()
            t2.start()
            t1.join(timeout=5.0)
            t2.join(timeout=5.0)

        with open(cache_file, "r", encoding="utf-8") as f:
            saved = json.load(f)
        self.assertIn("0", saved.get("offsets", {}))
        self.assertIn("1", saved.get("offsets", {}))

    def test_open_export_folder_non_blocking_popen_and_gpu_vendor_timeout(self):
        """Regression: handle_open_export_folder uses detached Popen and get_gpu_vendor uses timeout=5."""
        import subprocess
        import services
        from utils.handlers.data_handler import DataHandler

        ctx = MagicMock()
        ctx.io = file_io
        ctx.mpv.current_token = "tok"
        handler = DataHandler(ctx)

        with patch("subprocess.Popen") as mock_popen, \
             patch("subprocess.run") as mock_run, \
             patch.object(file_io, "get_settings", return_value={"os_platform": "Linux"}):
            res = handler.handle_open_export_folder(MagicMock())

        self.assertTrue(res.get("success"))
        mock_run.assert_not_called()
        mock_popen.assert_called_once()
        _, kwargs = mock_popen.call_args
        self.assertEqual(kwargs.get("stdin"), subprocess.DEVNULL)
        self.assertEqual(kwargs.get("stdout"), subprocess.DEVNULL)
        self.assertEqual(kwargs.get("stderr"), subprocess.DEVNULL)
        self.assertTrue(kwargs.get("start_new_session"))

        with patch("platform.system", return_value="Linux"), \
             patch("shutil.which", return_value="/usr/bin/lspci"), \
             patch("subprocess.check_output", return_value="VGA: NVIDIA GeForce") as mock_check:
            vendor = services.get_gpu_vendor()

        self.assertEqual(vendor, "nvidia")
        self.assertEqual(mock_check.call_args[1].get("timeout"), 5)

    def test_ipc_socket_manager_close_from_reader_thread_no_self_join(self):
        """Regression: IPCSocketManager.close() guards against joining the current thread."""
        mgr = ipc_utils.IPCSocketManager()
        errors = []

        def run_on_reader():
            try:
                mgr._event_reader_thread = threading.current_thread()
                mgr._event_reader_running = True
                mgr.close()
            except Exception as exc:
                errors.append(exc)

        t = threading.Thread(target=run_on_reader)
        t.start()
        t.join(timeout=2.0)
        self.assertEqual(errors, [])

    def test_ipc_send_wakes_immediately_on_eof_and_guards_sock_under_lock(self):
        """Regression: IPCSocketManager.send() returns immediately when reader stops (EOF) and handles None _sock."""
        import time

        mgr = ipc_utils.IPCSocketManager()
        mgr._sock = MagicMock()
        mgr._event_reader_running = True

        def stop_reader_soon():
            time.sleep(0.05)
            with mgr._buffer_lock:
                mgr._event_reader_running = False
                mgr._buffer_lock.notify_all()

        t = threading.Thread(target=stop_reader_soon)
        t.start()
        start = time.monotonic()
        res = mgr.send({"command": ["get_property", "pid"]}, timeout=5.0, expect_response=True)
        elapsed = time.monotonic() - start
        t.join(timeout=1.0)

        self.assertIsNone(res)
        self.assertLess(elapsed, 1.0)

        # None _sock inside _send_lock returns None cleanly
        mgr._sock = None
        self.assertIsNone(mgr.send({"command": ["get_property", "pid"]}))

    def test_enrichment_service_aborts_on_session_generation_change(self):
        """Regression: EnrichmentService.handle_standard_flow_launch aborts when session_generation advances."""
        enricher = session_services.EnrichmentService(MagicMock(), MagicMock(), file_io)
        session = MagicMock()
        session.session_generation = 1
        session.is_alive = True
        session.launch_cancelled = False
        session.owner_folder_id = "Anime"
        session.sync_lock = threading.RLock()
        session.ipc_manager.is_connected.return_value = True
        session.ipc_manager.get_property.return_value = 1234
        session.playlist = []

        def bump_gen(*_args, **_kwargs):
            session.session_generation = 2
            return [{"id": "2", "url": "https://example.com/2.mp4"}]

        enricher.enrich_single_item = MagicMock(side_effect=bump_gen)
        items = [{"id": "1", "url": "https://example.com/1.mp4"}, {"id": "2", "url": "https://example.com/2.mp4"}]
        enricher.handle_standard_flow_launch(session, items, 0, "Anime", {}, file_io)
        enricher.shutdown(wait=True)

        session.append_batch.assert_not_called()
        self.assertIsNone(enricher._active_sync_generation)

    def test_launcher_launch_failure_rolls_back_session_state(self):
        """Regression: LauncherService.launch stops tracker and clears owner_folder_id/playlist/session_file on error."""
        session_file = os.path.join(self.test_dir, "rollback_session.json")
        with open(session_file, "w", encoding="utf-8") as f:
            f.write("{}")

        session = MagicMock()
        session.FLAG_DIR = os.path.join(self.test_dir, "flags")
        session.SCRIPT_DIR = self.test_dir
        session.session_file = session_file
        session.launch_cancelled = False
        session.get_mpv_executable.return_value = "mpv"
        session.ipc_manager = None
        tracker_mock = MagicMock()
        session.playlist_tracker = tracker_mock

        launcher = session_services.LauncherService(session)
        with patch.object(ipc_utils, "get_ipc_path", return_value=os.path.join(self.test_dir, "mpv.sock")), \
             patch("services.create_handshake_file", side_effect=RuntimeError("boom")):
            res = launcher.launch({"id": "1", "url": "https://example.com/1.mp4"}, "Anime", {}, file_io)

        self.assertFalse(res.get("success"))
        tracker_mock.stop_tracking.assert_called_once()
        self.assertIsNone(session.owner_folder_id)
        self.assertEqual(session.playlist, [])
        self.assertFalse(os.path.exists(session_file))

    def test_handle_append_session_guard_and_cancellation(self):
        """Regression: handle_append checks active session before shard write and aborts cleanly on cancellation."""
        from utils.handlers.playback_handler import PlaybackHandler
        from utils import native_link

        ctx = MagicMock()
        ctx.io = file_io
        ctx.mpv.sync_lock = threading.RLock()
        ctx.mpv.is_alive = False
        ctx.mpv.owner_folder_id = "Anime"
        ctx.mpv.playlist = []
        ctx.script_dir = self.test_dir
        ctx.temp_playlists_dir = os.path.join(self.test_dir, "temp_playlists")
        handler = PlaybackHandler(ctx)

        req = native_link.PlaybackRequest(action="append", folder_id="Anime", url_item={"id": "x1", "url": "https://example.com/x1.mp4"})
        with patch.object(file_io, "update_shard") as mock_update:
            res = handler.handle_append(req)
        self.assertFalse(res.get("success"))
        mock_update.assert_not_called()

        # Cancellation aborts without shard mutation or append_batch
        ctx.mpv.is_alive = True
        ctx.task_manager.create_job.return_value = "job-1"
        ctx.task_manager.is_cancelled.return_value = True
        req_multi = native_link.PlaybackRequest(
            action="append",
            folder_id="Anime",
            url_items=[{"id": "x1", "url": "https://example.com/1.mp4"}, {"id": "x2", "url": "https://example.com/2.mp4"}],
        )
        with patch.object(file_io, "update_shard") as mock_update:
            res_cancel = handler.handle_append(req_multi)
        self.assertFalse(res_cancel.get("success"))
        self.assertIn("cancelled", res_cancel.get("error", "").lower())
        mock_update.assert_not_called()
        ctx.mpv.append_batch.assert_not_called()

    def test_start_releases_sync_lock_during_launcher_launch(self):
        """Regression: MpvSessionManager.start() must not hold sync_lock across blocking launcher.launch()."""
        deps = {
            "get_all_folders_from_file": lambda: {},
            "get_mpv_executable": lambda: "mpv",
            "log_stream": lambda **kw: (lambda s: None),
            "send_message": lambda m: None,
            "SCRIPT_DIR": self.test_dir,
            "TEMP_PLAYLISTS_DIR": os.path.join(self.test_dir, "temp_playlists"),
        }
        mgr = MpvSessionManager(os.path.join(self.test_dir, "session.json"), deps)
        in_launch = threading.Event()
        release_launch = threading.Event()

        def slow_launch(*_args, **_kwargs):
            in_launch.set()
            release_launch.wait(timeout=2.0)
            return {"success": True, "message": "ok"}

        mgr.launcher.launch = MagicMock(side_effect=slow_launch)
        mgr.register_ipc_callbacks = MagicMock()
        mgr._start_health_watcher = MagicMock()

        item = {"id": "item-1", "url": "https://example.com/v.mp4", "title": "V"}
        result_box = {}

        def run_start():
            result_box["res"] = mgr.start(item, "Anime", {}, file_io, enriched_items_list=[item])

        t = threading.Thread(target=run_start, daemon=True)
        t.start()
        self.assertTrue(in_launch.wait(timeout=2.0))

        # Another thread (e.g. CONTROL_ACTIONS) must be able to acquire sync_lock immediately
        acquired = mgr.sync_lock.acquire(blocking=False)
        try:
            self.assertTrue(acquired, "sync_lock must not be held during blocking launcher.launch()")
        finally:
            if acquired:
                mgr.sync_lock.release()
            release_launch.set()

        t.join(timeout=2.0)
        self.assertTrue(result_box.get("res", {}).get("success"))
        self.assertFalse(mgr._is_launching)

if __name__ == '__main__':
    unittest.main()
