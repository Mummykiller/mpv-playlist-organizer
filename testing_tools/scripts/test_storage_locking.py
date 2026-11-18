import json
import multiprocessing
import os
import platform
import stat
import sys
import threading
import unittest
from unittest.mock import MagicMock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from base_test import BaseTestCase

import file_io
from mpv_session import MpvSessionManager


def _process_hold_lock(target_file, ready_event, release_event):
    """Helper run in a child process to hold FileLock until signaled."""
    with file_io.FileLock(target_file, timeout=5.0):
        ready_event.set()
        release_event.wait(timeout=5.0)


class TestStorageLocking(BaseTestCase):
    """Verifies PY-M7, PY-L1, PY-L2, PY-L11, and PY-H2."""

    def setUp(self):
        super().setUp()
        self.orig_data_dir = file_io.DATA_DIR
        file_io.initialize_paths(self.test_dir)

    def tearDown(self):
        file_io.initialize_paths(self.orig_data_dir)
        super().tearDown()

    # --- PY-M7: OS-level FileLock ---

    def test_filelock_reentrant_and_permissions(self):
        """FileLock supports same-thread recursion and creates lockfile with 0o600 permissions on POSIX."""
        target = os.path.join(self.test_dir, "reentrant.json")
        with file_io.FileLock(target, timeout=1.0) as outer:
            self.assertTrue(outer.is_file_locked)
            if platform.system() != "Windows":
                mode = stat.S_IMODE(os.stat(outer.lockfile).st_mode)
                self.assertEqual(mode, 0o600)
            with file_io.FileLock(target, timeout=1.0) as inner:
                self.assertTrue(os.path.exists(inner.lockfile))
            # Outer lock should still be held after inner exits
            self.assertTrue(os.path.exists(outer.lockfile))
        self.assertFalse(outer.is_file_locked)
        if platform.system() == "Windows":
            self.assertFalse(os.path.exists(f"{target}.lock"))
        else:
            self.assertTrue(os.path.exists(f"{target}.lock"))

    def test_filelock_thread_contention_and_timeout(self):
        """FileLock serializes threads and raises RuntimeError on timeout."""
        target = os.path.join(self.test_dir, "thread_contend.json")
        acquired = threading.Event()
        release = threading.Event()
        errors = []

        def holder():
            try:
                with file_io.FileLock(target, timeout=2.0):
                    acquired.set()
                    release.wait(timeout=2.0)
            except Exception as exc:
                errors.append(exc)

        t = threading.Thread(target=holder)
        t.start()
        self.assertTrue(acquired.wait(timeout=2.0))

        with self.assertRaises(RuntimeError):
            with file_io.FileLock(target, timeout=0.15, delay=0.02):
                pass

        release.set()
        t.join(timeout=2.0)
        self.assertEqual(errors, [])

        # Lock should now be acquirable
        with file_io.FileLock(target, timeout=1.0) as lock:
            self.assertTrue(lock.is_file_locked)

    def test_filelock_process_contention_and_timeout(self):
        """FileLock enforces mutual exclusion across processes and times out when held by another process."""
        target = os.path.join(self.test_dir, "proc_contend.json")
        ctx = multiprocessing.get_context("spawn")
        ready_event = ctx.Event()
        release_event = ctx.Event()
        proc = ctx.Process(target=_process_hold_lock, args=(target, ready_event, release_event))
        proc.start()
        try:
            self.assertTrue(ready_event.wait(timeout=5.0))

            with self.assertRaises(RuntimeError):
                with file_io.FileLock(target, timeout=0.2, delay=0.02):
                    pass
        finally:
            release_event.set()
            proc.join(timeout=5.0)
            if proc.is_alive():
                proc.terminate()
                proc.join(timeout=2.0)

        # After child exits, parent can acquire cleanly
        with file_io.FileLock(target, timeout=1.0) as lock:
            self.assertTrue(lock.is_file_locked)

    # --- PY-L2: _atomic_json_dump backup validation ---

    def test_atomic_json_dump_preserves_bak_when_target_corrupt(self):
        """_atomic_json_dump must not overwrite a valid .bak with a corrupted primary file."""
        target = os.path.join(self.test_dir, "data.json")
        bak_file = f"{target}.bak"

        good_backup = {"version": 1, "items": ["a", "b"]}
        with open(bak_file, "w", encoding="utf-8") as f:
            json.dump(good_backup, f)

        # Corrupt the primary file
        with open(target, "w", encoding="utf-8") as f:
            f.write("{corrupt json...")

        new_data = {"version": 2, "items": ["c"]}
        self.assertTrue(file_io._atomic_json_dump(new_data, target))

        # Primary has new_data, while .bak still holds good_backup
        with open(target, "r", encoding="utf-8") as f:
            self.assertEqual(json.load(f), new_data)
        with open(bak_file, "r", encoding="utf-8") as f:
            self.assertEqual(json.load(f), good_backup)

    def test_atomic_json_dump_updates_bak_when_target_valid(self):
        """_atomic_json_dump backs up a valid primary file to .bak before replacing."""
        target = os.path.join(self.test_dir, "valid_data.json")
        bak_file = f"{target}.bak"

        initial_data = {"version": 1}
        self.assertTrue(file_io._atomic_json_dump(initial_data, target))

        updated_data = {"version": 2}
        self.assertTrue(file_io._atomic_json_dump(updated_data, target))

        with open(target, "r", encoding="utf-8") as f:
            self.assertEqual(json.load(f), updated_data)
        with open(bak_file, "r", encoding="utf-8") as f:
            self.assertEqual(json.load(f), initial_data)

    # --- PY-L1: save_library_batch prune guards & trash/ ---

    def test_save_library_batch_refuses_empty_wipe(self):
        """save_library_batch refuses to prune shards when incoming payload is empty and index is non-empty."""
        initial = {
            "folder_a": {
                "title": "Folder A",
                "playlist": [{"id": "1", "url": "https://example.com/1", "title": "One"}],
            }
        }
        self.assertTrue(file_io.save_library_batch(initial, is_incremental=False))
        shard_a = file_io._get_safe_shard_path("folder_a")
        self.assertTrue(os.path.exists(shard_a))

        # Empty payload with is_incremental=False must not wipe existing shards or index
        self.assertTrue(file_io.save_library_batch({}, is_incremental=False))
        self.assertTrue(os.path.exists(shard_a))
        index = file_io._safe_json_load(file_io.INDEX_FILE)
        self.assertIn("folder_a", index)

    def test_save_library_batch_moves_pruned_orphans_to_trash(self):
        """Pruned orphan shards are moved to PLAYLISTS_DIR/trash with a timestamp suffix."""
        initial = {
            "keep_me": {
                "title": "Keep",
                "playlist": [{"id": "1", "url": "https://example.com/1", "title": "One"}],
            },
            "drop_me": {
                "title": "Drop",
                "playlist": [{"id": "2", "url": "https://example.com/2", "title": "Two"}],
            },
        }
        self.assertTrue(file_io.save_library_batch(initial, is_incremental=False))
        drop_shard = file_io._get_safe_shard_path("drop_me")
        self.assertTrue(os.path.exists(drop_shard))

        # Save without drop_me
        updated = {
            "keep_me": initial["keep_me"],
        }
        self.assertTrue(file_io.save_library_batch(updated, is_incremental=False))
        self.assertFalse(os.path.exists(drop_shard))

        trash_dir = os.path.join(file_io.PLAYLISTS_DIR, "trash")
        self.assertTrue(os.path.isdir(trash_dir))
        trashed = os.listdir(trash_dir)
        drop_basename = os.path.basename(drop_shard)
        self.assertTrue(
            any(name.startswith(f"{drop_basename}.") for name in trashed),
            f"Expected {drop_basename}.<timestamp> in {trashed}",
        )

    # --- PY-L11: persist_session atomic 0o600 write ---

    def test_persist_session_atomic_0600(self):
        """persist_session writes session JSON atomically with 0o600 permissions on POSIX."""
        session_file = os.path.join(self.test_dir, "mpv_session.json")
        deps = {
            "get_all_folders_from_file": MagicMock(return_value={}),
            "get_mpv_executable": MagicMock(return_value="mpv"),
            "log_stream": MagicMock(),
            "send_message": MagicMock(),
            "SCRIPT_DIR": self.test_dir,
            "TEMP_PLAYLISTS_DIR": os.path.join(self.test_dir, "temp_playlists"),
            "metadata_cache": MagicMock(),
            "task_manager": MagicMock(),
        }
        mgr = MpvSessionManager(session_file, deps)
        mgr.pid = 12345
        mgr.ipc_path = "/tmp/mpv-test.sock"
        mgr.owner_folder_id = "folder_a"
        mgr.current_token = "tok_123"
        mgr.create_time = 1700000000.0
        mgr.session_generation = 2

        mgr.persist_session()
        self.assertTrue(os.path.exists(mgr.session_file))
        if platform.system() != "Windows":
            mode = stat.S_IMODE(os.stat(mgr.session_file).st_mode)
            self.assertEqual(mode, 0o600)
        with open(mgr.session_file, "r", encoding="utf-8") as f:
            data = json.load(f)
        self.assertEqual(data["pid"], 12345)
        self.assertEqual(data["owner_folder_id"], "folder_a")
        self.assertEqual(data["token"], "tok_123")

    # --- PY-H2: Oversized reply trimming ---

    def test_trim_oversized_reply(self):
        """_trim_oversized_reply drops large preview fields over ~800 KB and sets payload_truncated."""
        big_m3u = "#EXTM3U\n" + ("#EXTINF:-1,Item\nhttps://example.com/video.mp4\n" * 20000)
        reply = {
            "success": True,
            "folder_id": "big_folder",
            "last_played_id": "item_1",
            "token": "tok_abc",
            "is_paused": False,
            "enriched_m3u_content": big_m3u,
        }
        trimmed = MpvSessionManager._trim_oversized_reply(dict(reply))
        self.assertTrue(trimmed.get("payload_truncated"))
        self.assertNotIn("enriched_m3u_content", trimmed)
        self.assertEqual(trimmed["folder_id"], "big_folder")
        self.assertEqual(trimmed["token"], "tok_abc")
        self.assertLessEqual(len(json.dumps(trimmed).encode("utf-8")), 800 * 1024)

    def test_filelock_reexport_identity(self):
        """utils.file_lock.FileLock is the canonical class re-exported as file_io.FileLock."""
        from utils.file_lock import FileLock
        self.assertIs(file_io.FileLock, FileLock)


if __name__ == "__main__":
    unittest.main()
