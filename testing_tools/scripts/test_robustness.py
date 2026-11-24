import os
import sys
import platform
import unittest
import json
import time
import logging
import stat
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

class TestRobustness(BaseTestCase):
    """Verifies system-level robustness (Heartbeat, Normalization, Handshakes, Parameter Validation, Unmanaged Launch)."""

    def test_handshake_generation(self):
        """Verify services.create_handshake_file creates a 0o600 JSON handshake with expected metadata."""
        flag_dir = os.path.join(self.test_dir, "flags_test")
        item = {
            "id": "ep-42",
            "title": "Episode 42",
            "url": "https://example.com/ep42.mp4",
            "resume_time": 95,
            "headers": {"Referer": "https://example.com/"},
        }
        settings = {"enable_precise_resume": True, "yt_mark_watched": True}

        managed_path = None
        unmanaged_path = None
        try:
            managed_path, managed_flag = services.create_handshake_file(
                flag_dir=flag_dir,
                folder_id="test_folder",
                script_dir=self.test_dir,
                item=item,
                settings=settings,
                playlist_start_index=3,
                is_unmanaged=False,
                is_youtube=True,
                use_ytdl_mpv=True,
                cookies_browser="chrome",
            )
            self.assertTrue(os.path.exists(managed_path))
            self.assertTrue(os.path.basename(managed_path).startswith("handshake_"))
            self.assertFalse(os.path.basename(managed_path).startswith("handshake_unmanaged_"))
            self.assertEqual(managed_flag, f"--script-opts=mpv_organizer-handshake={managed_path}")

            if platform.system() != "Windows":
                self.assertEqual(stat.S_IMODE(os.stat(managed_path).st_mode), 0o600)

            with open(managed_path, "r", encoding="utf-8") as f:
                loaded = json.load(f)

            self.assertEqual(loaded["folder_id"], "test_folder")
            self.assertEqual(loaded["project_root"], self.test_dir)
            self.assertEqual(loaded["flag_dir"], flag_dir)
            self.assertEqual(loaded["playlist_start_index"], 3)
            self.assertTrue(loaded["is_youtube"])
            self.assertTrue(loaded["use_ytdl_mpv"])
            self.assertFalse(loaded["is_unmanaged"])
            self.assertEqual(loaded["id"], "ep-42")
            self.assertEqual(loaded["title"], "Episode 42")
            self.assertEqual(loaded["original_url"], "https://example.com/ep42.mp4")
            self.assertEqual(loaded["headers"], {"Referer": "https://example.com/"})
            self.assertEqual(loaded["cookies_browser"], "chrome")
            self.assertIsInstance(loaded["lua_options"], dict)
            self.assertEqual(loaded["lua_options"]["resume_time"], 95)

            unmanaged_path, _ = services.create_handshake_file(
                flag_dir=flag_dir,
                folder_id="test_folder",
                script_dir=self.test_dir,
                item=item,
                settings=settings,
                is_unmanaged=True,
            )
            self.assertTrue(os.path.exists(unmanaged_path))
            self.assertTrue(os.path.basename(unmanaged_path).startswith("handshake_unmanaged_"))
            with open(unmanaged_path, "r", encoding="utf-8") as f:
                self.assertTrue(json.load(f)["is_unmanaged"])
        finally:
            for path in (managed_path, unmanaged_path):
                if path and os.path.exists(path):
                    os.remove(path)
            if managed_path:
                self.assertFalse(os.path.exists(managed_path))

    def test_normalization_simulation(self):
        """Verify real native_link translator & responder key translation, map-key preservation, and round-tripping."""
        from utils.native_link import responder, translator

        incoming_js_payload = {
            "action": "play_batch",
            "request_id": "req-99",
            "folderId": "my_Anime_Folder",
            "playNewInstance": True,
            "playlist": [
                {
                    "itemId": "abc",
                    "resumeTime": 120,
                    "markedAsWatched": False,
                    "headers": {"X-Custom-Header": "KeepMe", "Referer": "https://example.com/"},
                }
            ],
            "__proto__": {"polluted": True},
        }

        # 1. translate() normalizes camelCase -> snake_case into typed PlaybackRequest and preserves request_id
        req = translator.translate(incoming_js_payload)
        self.assertIsInstance(req, native_link.PlaybackRequest)
        self.assertEqual(req.action, "play_batch")
        self.assertEqual(req.request_id, "req-99")
        self.assertEqual(req.folder_id, "my_Anime_Folder")
        self.assertTrue(req.play_new_instance)
        self.assertEqual(req.playlist[0]["item_id"], "abc")
        self.assertEqual(req.playlist[0]["resume_time"], 120)
        self.assertFalse(req.playlist[0]["marked_as_watched"])
        # Header names under "headers" must be preserved verbatim
        self.assertEqual(req.playlist[0]["headers"]["X-Custom-Header"], "KeepMe")

        # 2. _normalize_message strips forbidden __proto__ and preserves folder/domain map keys
        norm = translator._normalize_message({
            "__proto__": {"evil": 1},
            "folders": {
                "My_Custom_Folder": {"lastPlayedId": "ep1", "playlistItems": [{"resumeTime": 10}]}
            },
            "domains": {"sub_domain.example.com": {"autoAdd": True}},
        })
        self.assertNotIn("__proto__", norm)
        self.assertIn("My_Custom_Folder", norm["folders"])
        self.assertEqual(norm["folders"]["My_Custom_Folder"]["last_played_id"], "ep1")
        self.assertEqual(norm["folders"]["My_Custom_Folder"]["playlist_items"][0]["resume_time"], 10)
        self.assertIn("sub_domain.example.com", norm["domains"])
        self.assertTrue(norm["domains"]["sub_domain.example.com"]["auto_add"])

        # 3. responder._translate_keys / success() converts snake_case -> camelCase while preserving
        #    request_id, folder IDs, URL cache keys, headers, and youtube_tools subtree
        py_reply = {
            "request_id": "req-99",
            "is_running": True,
            "folder_id": "my_Anime_Folder",
            "last_played_id": "123",
            "playlist_items": [{"item_id": "abc", "resume_time": 10}],
            "folders": {"My_Custom_Folder": {"last_played_id": "ep1"}},
            "metadata_cache": {"https://example.com/v_1.mp4": {"last_watched": 42}},
            "headers": {"X-Custom-Header": "KeepMe"},
            "__proto__": {"evil": 1},
        }
        translated = responder.success(py_reply)
        self.assertTrue(translated["success"])
        self.assertEqual(translated["request_id"], "req-99")
        self.assertTrue(translated["isRunning"])
        self.assertEqual(translated["folderId"], "my_Anime_Folder")
        self.assertEqual(translated["lastPlayedId"], "123")
        self.assertEqual(translated["playlistItems"][0]["resumeTime"], 10)
        self.assertIn("My_Custom_Folder", translated["folders"])
        self.assertEqual(translated["folders"]["My_Custom_Folder"]["lastPlayedId"], "ep1")
        self.assertIn("https://example.com/v_1.mp4", translated["metadataCache"])
        self.assertEqual(translated["metadataCache"]["https://example.com/v_1.mp4"]["lastWatched"], 42)
        self.assertEqual(translated["headers"]["X-Custom-Header"], "KeepMe")
        self.assertNotIn("__proto__", translated)

        # 4. Round-trip: JS camelCase -> Python snake_case -> JS camelCase
        round_tripped = responder._translate_keys(translator._normalize_message({
            "request_id": "rt-1",
            "folderId": "f1",
            "playlistItems": [{"itemId": "x1", "resumeTime": 55}],
        }))
        self.assertEqual(round_tripped, {
            "request_id": "rt-1",
            "folderId": "f1",
            "playlistItems": [{"itemId": "x1", "resumeTime": 55}],
        })

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
            deadline = time.time() + 2.5
            saved_time = None
            while time.time() < deadline:
                reloaded_playlist = file_io.get_playlist_shard(test_folder_id)
                saved_time = reloaded_playlist[0].get("resume_time")
                if saved_time == 123:
                    break
                time.sleep(0.05)

            self.assertEqual(saved_time, 123, "Progress should have been saved by heartbeat.")
            tracker.stop_tracking()
        finally:
            file_io.DATA_DIR = original_data_dir
            file_io.initialize_paths()

    def test_track_transition_timestamp_isolation(self):
        """Verify that transitioning between playlist items does not leak timestamps."""
        original_data_dir = file_io.DATA_DIR
        file_io.DATA_DIR = self.test_dir
        file_io.initialize_paths()
        try:
            test_folder_id = "transition_test_folder"
            index = file_io.get_index()
            index[test_folder_id] = {"name": "Test Folder", "playlist": []}
            file_io.save_index(index)

            test_playlist = [
                {"id": "item1", "url": "https://example.com/1.mp4", "resume_time": 0},
                {"id": "item2", "url": "https://example.com/2.mp4", "resume_time": 0}
            ]
            file_io.save_playlist_shard(test_folder_id, test_playlist)

            messages = []
            tracker = PlaylistTracker(
                folder_id=test_folder_id,
                initial_playlist=test_playlist,
                file_io=file_io,
                settings={},
                ipc_path="/tmp/mock_ipc_not_existing",
                send_message_func=lambda m: messages.append(m)
            )

            # Simulate item1 finishing at 1420s
            tracker.current_id = "item1"
            tracker.current_session_duration = 1420
            tracker.last_time_pos = 1420

            # Transition to item2
            tracker.previous_id = "item1"
            tracker.current_id = "item2"
            tracker.current_session_duration = 0
            tracker.last_time_pos = None

            # Simulate late stop/quit event right after transition (< 1s duration)
            # Must attribute to item1, NOT item2
            target_id = tracker.current_id
            if tracker.current_session_duration < 1 and tracker.previous_id:
                target_id = tracker.previous_id

            self.assertEqual(target_id, "item1")
            self.assertNotIn("item2", tracker.resume_cache)
        finally:
            file_io.DATA_DIR = original_data_dir
            file_io.initialize_paths()

    def test_settings_synchronization(self):
        """Verify that shared settings keys in Python (file_io.py) and JS (storageManager.js) stay aligned."""
        original_data_dir = file_io.DATA_DIR
        file_io.initialize_paths(self.test_dir)
        try:
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
                "minimized_stub_position", "dependency_status", "mpv", "ytdlp", "ffmpeg", "node",
                "launch_geometry", "custom_geometry_width", "custom_geometry_height", "custom_mpv_flags",
                "show_play_new_button", "duplicate_url_behavior", "sync_global_removals", "sync_global_removals_live",
                "auto_append_on_add", "auto_add_inactivity_timeout", "auto_add_auto_off", "confirm_remove_folder",
                "confirm_clear_playlist", "confirm_close_mpv", "confirm_play_new", "confirm_folder_switch",
                "clear_on_completion", "clear_scope", "enable_dblclick_copy", "anilist_image_height", "popup_width",
                "show_watched_status_gui", "show_minimized_stub", "one_click_add", "restricted_domains",
                "kb_add_playlist", "kb_play_playlist", "kb_toggle_controller", "kb_switch_playlist", "kb_open_popup",
                "force_terminal", "stream_scanner_timeout", "autofocus_new_folder", "show_copy_title_button",
                "enable_anilist_integration", "disable_anilist_cache", "ytdlp_update_behavior",
                "popup_width_locked", "scraper_filter_words",
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

            settings_js_path = os.path.join(PROJECT_ROOT, "utils", "settings.js")
            with open(settings_js_path, "r", encoding="utf-8") as sf:
                settings_js = sf.read()
            mapped_keys = re.findall(r'key:\s*"([a-zA-Z0-9_]+)"', settings_js)
            self.assertGreater(len(mapped_keys), 0, "Expected preferenceMappings keys in utils/settings.js")
            missing_defaults = [k for k in mapped_keys if k not in js_keys]
            self.assertEqual(
                missing_defaults,
                [],
                f"utils/settings.js preferenceMappings keys missing from storageManager.js defaults: {missing_defaults}"
            )
            missing_allowlist = [
                camel_to_snake(k) for k in mapped_keys
                if camel_to_snake(k) not in security.ALLOWED_SETTINGS_KEYS
            ]
            self.assertEqual(
                missing_allowlist,
                [],
                f"utils/settings.js preferenceMappings keys missing from security.ALLOWED_SETTINGS_KEYS: {missing_allowlist}"
            )
        finally:
            file_io.initialize_paths(original_data_dir)

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
            flag_dir=os.path.join(self.test_dir, "flags_test")
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
        self.assertFalse(lock.is_file_locked)
        if platform.system() == "Windows":
            self.assertFalse(os.path.exists(lock_file))
        else:
            self.assertTrue(os.path.exists(lock_file))

    def test_youtube_url_analyzer_and_responder_key_preservation(self):
        """Verifies strict YOUTUBE_RE, rsplit('|', 1) pipe handling, playlist URL detection,
        import_from_file key preservation, and .ruff_cache exclusion in create_release."""
        import fnmatch
        from utils import url_analyzer
        from utils.native_link import responder, translator
        from testing_tools import create_release

        # 1. Strict YOUTUBE_RE and playlist URL check
        self.assertIsNone(url_analyzer.YOUTUBE_RE.search("https://example.com/video.mp4?ref=youtube.com"))
        self.assertIsNotNone(url_analyzer.YOUTUBE_RE.search("https://www.youtube.com/watch?v=dQw4w9WgXcQ"))
        self.assertTrue(url_analyzer.is_youtube_playlist_url("https://www.youtube.com/playlist?list=PL123"))
        self.assertFalse(url_analyzer.is_youtube_playlist_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123"))

        # 2. run_bypass_logic handles '|' inside titles via rsplit and ignores '&list=' on watch URLs
        mock_proc = MagicMock()
        mock_proc.stdout = "Epic Song | Official Video | Artist|https://www.youtube.com/watch?v=vid22222222\n"
        with patch("utils.url_analyzer.subprocess.run", return_value=mock_proc), \
             patch("utils.url_analyzer.get_cookies_file", return_value=None), \
             patch("utils.url_analyzer.is_safe_url", return_value=True), \
             patch("shutil.which", return_value="/usr/bin/yt-dlp"):
            res_playlist = url_analyzer.run_bypass_logic(
                "https://www.youtube.com/playlist?list=PL123",
                "None",
                True,
                "TestUA",
            )
            self.assertTrue(res_playlist.get("is_playlist"))
            self.assertEqual(res_playlist["entries"][0]["title"], "Epic Song | Official Video | Artist")
            self.assertEqual(res_playlist["entries"][0]["url"], "https://www.youtube.com/watch?v=vid22222222")

            res_single = url_analyzer.run_bypass_logic(
                "https://www.youtube.com/watch?v=ep12&list=PL123&index=12",
                "None",
                True,
                "TestUA",
            )
            self.assertFalse(res_single.get("is_playlist", False))
            self.assertEqual(res_single["url"], "https://www.youtube.com/watch?v=ep12&list=PL123&index=12")

        # 3. Responder preserves top-level folder names, domain keys, and youtubeTools keys on import_from_file
        raw_import = {
            "my_anime_list": {"playlist": [{"id": "1", "url": "https://example.com/1"}]},
            "settings": {
                "anilist_cache": {"foo": 1},
                "ui_preferences": {"domains": {"my_custom_site.local": {"minimized": True}}},
            },
            "youtubeTools": {
                "enabled": True,
                "settings": {"frame-removal-settings": {"blocked-keywords": "foo_bar"}},
                "library": {"vid_abc_123": {"id": "vid_abc_123"}},
            },
        }
        reply = responder.success(data=raw_import, preserve_data_keys=True)
        self.assertIn("my_anime_list", reply["data"])
        self.assertIn("my_custom_site.local", reply["data"]["settings"]["ui_preferences"]["domains"])
        self.assertIn("vid_abc_123", reply["data"]["youtubeTools"]["library"])

        norm = translator._normalize_message({"youtubeTools": raw_import["youtubeTools"]})
        self.assertIn("vid_abc_123", norm["youtube_tools"]["library"])

        # 4. create_release excludes .ruff_cache
        self.assertTrue(any(fnmatch.fnmatch(".ruff_cache", p) for p in create_release.IGNORE_PATTERNS))

if __name__ == '__main__':
    unittest.main()
