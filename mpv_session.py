import logging
import os
import sys
import threading
import time
import platform
from utils import ipc_utils, session_health, session_ipc_ops
from utils.session_services import EnrichmentService, LauncherService
import services
import file_io

# Prevent __pycache__ generation
sys.dont_write_bytecode = True
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'

# Constants for file patterns (used by utils/janitor.py)
DELTA_PREFIX = "delta_"
DELTA_EXT = ".m3u"
NATURAL_COMPLETION_FLAG = "mpv_natural_completion_"
ID_MATCH_RE = session_ipc_ops.ID_MATCH_RE


class MpvSessionManager:
    def __init__(self, session_file_path, dependencies):
        self.process = None
        self.ipc_path = None
        self.playlist = []
        self.pid = None
        self.owner_folder_id = None
        self.session_file = session_file_path
        self.sync_lock = threading.RLock()
        self.is_alive = False
        self.session_generation = 0  # Monotonic token for session lifecycle races (PY-M4)
        self.create_time = None
        self.dispatched_exit_generations = set()
        self.ipc_manager = None
        self.playlist_tracker = None
        self.manual_quit = False
        self.session_cookies = set()
        self.launch_cancelled = False
        self.is_closing = False
        self.last_played_id_cache = None
        self.handshake_path = None
        self.health = "ok"
        self.health_watcher_thread = None
        self.metadata_cache = dependencies.get('metadata_cache')
        self.task_manager = dependencies.get('task_manager')

        # --- Injected Dependencies ---
        self.get_all_folders_from_file = dependencies['get_all_folders_from_file']
        self.get_mpv_executable = dependencies['get_mpv_executable']
        self.log_stream = dependencies['log_stream']
        self.send_message = dependencies['send_message']
        self.SCRIPT_DIR = dependencies['SCRIPT_DIR']
        self.TEMP_PLAYLISTS_DIR = dependencies['TEMP_PLAYLISTS_DIR']
        self.FLAG_DIR = os.path.join(os.path.dirname(self.TEMP_PLAYLISTS_DIR), "flags")

        # --- Specialized Services ---
        self.enricher = EnrichmentService(
            services, self.send_message, file_io,
            metadata_cache=self.metadata_cache, task_manager=self.task_manager
        )
        self.launcher = LauncherService(self)

        try:
            os.makedirs(self.FLAG_DIR, exist_ok=True)
        except Exception as e:
            logging.warning(f"Could not create flag directory {self.FLAG_DIR}: {e}")

    def register_ipc_callbacks(self):
        if self.ipc_manager:
            self.ipc_manager.register_script_message_handler("ytdl_error_detected", self._handle_ytdl_error)

    def _start_health_watcher(self):
        """Starts a background thread to poll MPV health via IPC."""
        session_health.start_health_watcher(self)

    def _handle_ytdl_error(self, args):
        error_msg = args[0] if args else "Unknown error"
        logging.warning(f"[PY][IPC] YTDL Failure signaled from Lua: {error_msg}")

        self.send_message({
            "action": "ytdlp_update_check",
            "folder_id": self.owner_folder_id,
            "log": {
                "text": f"[Native Host]: YTDL Failure detected ({error_msg}). Checking for updates...",
                "type": "error"
            }
        })

        if any(x in error_msg for x in ["Sign in", "cookies", "403", "unavailable", "Private video"]):
            logging.info(f"Attempting cookie fallback for: {error_msg}")
            threading.Thread(target=self._perform_cookie_fallback, daemon=True).start()

    def _perform_cookie_fallback(self):
        session_ipc_ops.perform_cookie_fallback(self)

    def persist_session(self):
        """Saves current session metadata to disk atomically with 0o600 permissions."""
        session_health.persist_session_atomic(self)

    @staticmethod
    def _trim_oversized_reply(payload, max_bytes=800 * 1024):
        """Omits optional large preview fields if serialized payload exceeds max_bytes."""
        return session_health.trim_oversized_reply(payload, max_bytes=max_bytes)

    def clear(self, mpv_return_code=None, session_generation=None):
        """Clears the session state and removes the session file."""
        stats = {}
        tracker_to_stop = None
        ipc_to_close = None
        handshake_to_remove = None
        cookies_to_remove = []
        session_file_to_remove = None
        orphaned_exit = False

        with self.sync_lock:
            if session_generation is not None and session_generation != self.session_generation:
                logging.info(f"[PY][Session] Stale clear() ignored: caller generation {session_generation} != current {self.session_generation}")
                return {}

            if mpv_return_code is None and self.pid and ipc_utils.verify_mpv_process(self.pid, ipc_path=self.ipc_path):
                logging.info(f"[PY][Session] Native Host exit detected. Preserving session state for verified PID {self.pid}.")
                if self.playlist_tracker:
                    tracker_to_stop = self.playlist_tracker
                    self.playlist_tracker = None
                if self.ipc_manager:
                    ipc_to_close = self.ipc_manager
                    self.ipc_manager = None
                self.is_alive = False
                orphaned_exit = True
            else:
                self.is_alive = False
                self.is_closing = False
                self.health = "ok"
                pid_to_clear = self.pid
                self.pid = None

                if pid_to_clear:
                    logging.info(f"Clearing session state for PID: {pid_to_clear}")

                if self.playlist_tracker:
                    tracker_to_stop = self.playlist_tracker
                    self.playlist_tracker = None

                if self.ipc_manager:
                    ipc_to_close = self.ipc_manager
                    self.ipc_manager = None

                self.process = None
                self.ipc_path = None
                self.playlist = []
                self.owner_folder_id = None
                self.last_played_id_cache = None

                if self.handshake_path and os.path.exists(self.handshake_path):
                    handshake_to_remove = self.handshake_path
                self.handshake_path = None

                if self.session_cookies:
                    cookies_to_remove = list(self.session_cookies)
                    self.session_cookies.clear()

                if os.path.exists(self.session_file):
                    session_file_to_remove = self.session_file

        if tracker_to_stop:
            logging.info("[PY][Session] Stopping playlist tracker (background)...")
            stats = tracker_to_stop.stop_tracking(mpv_return_code=mpv_return_code)

        if ipc_to_close:
            logging.info("[PY][Session] Closing IPC manager (background)...")
            ipc_to_close.close()

        if orphaned_exit:
            return {}

        if handshake_to_remove:
            try:
                os.remove(handshake_to_remove)
                logging.info(f"Cleaned up handshake file: {handshake_to_remove}")
            except Exception as e:
                logging.warning(f"Failed to remove handshake file: {e}")

        if cookies_to_remove:
            logging.info(f"Cleaning up {len(cookies_to_remove)} session cookies.")
            for cookie_path in cookies_to_remove:
                try:
                    if os.path.exists(cookie_path):
                        os.remove(cookie_path)
                except Exception as e:
                    logging.warning(f"Failed to remove session cookie {cookie_path}: {e}")

        try:
            from utils.url_analyzer import VolatileCookieManager
            VolatileCookieManager.cleanup_volatile_dir()
        except Exception as e:
            logging.warning(f"Failed to cleanup volatile directory: {e}")

        if session_file_to_remove:
            try:
                os.remove(session_file_to_remove)
                logging.info(f"Cleaned up session file: {session_file_to_remove}")
            except OSError as e:
                logging.warning(f"Failed to remove session file during cleanup: {e}")

        return stats

    def get_pause_state(self):
        """Queries the current pause state from MPV via IPC."""
        with self.sync_lock:
            if not self.is_alive or not self.ipc_manager:
                return None
            return self.ipc_manager.get_property("pause", timeout=0.5)

    def get_idle_state(self):
        """Queries the current idle state from MPV via IPC."""
        with self.sync_lock:
            if not self.is_alive or not self.ipc_manager:
                return None
            return self.ipc_manager.get_property("idle-active", timeout=0.5)

    def restore(self):
        """Checks for a persisted session file and restores state if the process is still alive."""
        return session_health.restore_session(self)

    def _remote_log(self, message):
        """Sends a message to MPV to be printed in its terminal."""
        if self.ipc_manager:
            self.ipc_manager.log_to_mpv(message)

    def _sync_playlist_from_mpv(self):
        """Forces a real-time synchronization of the internal playlist from MPV reality."""
        return session_ipc_ops.sync_playlist_from_mpv(self)

    def append_batch(self, items, mode="append", folder_id=None, quiet=False):
        """Appends (or prepends) multiple items with mandatory real-time sync."""
        if not items:
            return {"success": True}
        with self.sync_lock:
            return self._append_batch_internal(items, mode, folder_id, quiet=quiet)

    def _append_batch_internal(self, items, mode="append", folder_id=None, quiet=False):
        """Internal append logic with strict MPV-state filtering."""
        return session_ipc_ops.append_batch_internal(self, items, mode=mode, folder_id=folder_id, quiet=quiet)

    def remove(self, item_id, folder_id):
        """Removes an item from the active MPV playlist by ID with resilient recovery."""
        return session_ipc_ops.remove_item(self, item_id, folder_id)

    def reorder(self, folder_id, new_order_ids):
        """Reorders the live MPV playlist to match the new order of IDs."""
        return session_ipc_ops.reorder_playlist(self, folder_id, new_order_ids)

    def clear_live(self, folder_id):
        """Clears all items from the active MPV playlist."""
        return session_ipc_ops.clear_live_playlist(self, folder_id)

    def update_item_watch_status(self, item_id, folder_id, marked_as_watched=None, watched=None):
        """Updates the watch status of an item in the active tracker."""
        with self.sync_lock:
            if self.playlist_tracker and self.owner_folder_id and self.owner_folder_id.lower() == folder_id.lower():
                self.playlist_tracker._update_marked_as_watched(
                    item_id,
                    marked_status=marked_as_watched,
                    watched_status=watched
                )
                return {"success": True}
            return {"success": True, "tracker_active": False}

    def _generate_m3u_content(self, items):
        """Generates M3U content from a list of items."""
        return session_ipc_ops.generate_m3u_content(items)

    def start(self, url_items_or_m3u, folder_id, settings, file_io_mod, **kwargs):
        """Starts a new mpv process with a playlist of URLs or an M3U."""
        logging.info(f"[PY][Session] start() called for folder '{folder_id}'")
        launch_result = {"success": False, "error": "Initialization failed"}

        logging.info("[PY][Session] Resolving input items for start...")
        _url_items_list, input_was_raw = self.enricher.resolve_input_items(
            url_items_or_m3u, kwargs.get('enriched_items_list'), kwargs.get('headers')
        )

        if not _url_items_list:
            logging.warning("[PY][Session] No URL items resolved.")
            return {"success": False, "error": "No URL items provided or parsed."}

        logging.info(f"[PY][Session] Resolved {len(_url_items_list)} items.")
        playlist_start_index = 0
        if settings.get("enable_smart_resume", True):
            target_id = kwargs.get('playlist_start_id')
            if not target_id:
                candidate_items = [item for item in _url_items_list if item.get('currently_playing')]
                if candidate_items:
                    candidate_items.sort(key=lambda x: x.get('last_modified', 0), reverse=True)
                    target_id = candidate_items[0].get('id')
            if not target_id:
                target_id = file_io_mod.get_index().get(folder_id, {}).get("last_played_id")
            if target_id:
                for idx, item in enumerate(_url_items_list):
                    if item.get('id') == target_id:
                        playlist_start_index = idx
                        break
            logging.info(f"[PY][Session] Smart Resume: folder='{folder_id}', target_id='{target_id}', found_at_index={playlist_start_index}")

        if input_was_raw:
            logging.info("[PY][Session] Input was raw. Checking for M3U flow or start-item enrichment.")
            is_m3u_flow = isinstance(url_items_or_m3u, str) and "youtube.com" not in url_items_or_m3u
            if is_m3u_flow:
                msg = f"Preparing {len(_url_items_list)} items for folder '{folder_id}'..."
                self.send_message({"action": "log_from_native_host", "log": {"text": msg, "type": "info"}})
                logging.info(f"[PY][Session] M3U flow detected. {msg}")
                from concurrent.futures import ThreadPoolExecutor
                with ThreadPoolExecutor(max_workers=10) as executor:
                    results = list(executor.map(
                        lambda x: self.enricher.enrich_single_item(
                            x, folder_id, self.session_cookies, self.sync_lock,
                            settings=settings, session=self, quiet=True
                        ),
                        _url_items_list
                    ))
                _url_items_list = [i for r in results for i in r]
                logging.info(f"[PY][Session] Parallel enrichment complete. {len(_url_items_list)} items total.")
                return {
                    "success": True,
                    "enriched_url_items": _url_items_list,
                    "enriched_m3u_content": self._generate_m3u_content(_url_items_list),
                    "message": "Enriched content generated."
                }

            logging.info(f"[PY][Session] Standard flow. Enriching start item at index {playlist_start_index} for immediate launch.")
            start_item_enriched = self.enricher.enrich_single_item(
                _url_items_list[playlist_start_index], folder_id, self.session_cookies,
                self.sync_lock, settings=settings, session=self
            )
            if start_item_enriched:
                _url_items_list[playlist_start_index] = start_item_enriched[0]
                logging.info(f"[PY][Session] Start item enriched: {start_item_enriched[0].get('title')}")

        action_needed = None
        with self.sync_lock:
            logging.info("[PY][Session] start() - Entered sync_lock.")
            is_final_pass = kwargs.get('enriched_items_list') is not None
            if getattr(self, 'launch_cancelled', False):
                logging.info(f"[PY][Session] Launch for folder '{folder_id}' aborted due to cancellation.")
                return {"success": False, "error": "Launch cancelled."}

            if is_final_pass and kwargs.get('had_active_session') and not self.is_alive and not self.pid:
                logging.info("[PY][Session] Pass 2 detected dead session. Aborting to prevent ghost relaunch.")
                return {"success": True, "message": "Playback ended by user between passes."}

            launch_item = _url_items_list[playlist_start_index]
            logging.info(f"[PY][Session] Final launch item resolved: {launch_item.get('title')} (ID: {launch_item.get('id')})")

            if self.pid:
                logging.info(f"[PY][Session] Active PID {self.pid} found. Checking if it belongs to the same folder.")
                currently_alive = self.is_alive
                if currently_alive:
                    if self.ipc_manager and self.ipc_manager.is_connected():
                        logging.info("[PY][Session] start() - Sending verification ping to MPV.")
                        if self.ipc_manager.get_property("pid", timeout=2.0) is None:
                            logging.info("[PY][Session] start() - Ping failed, checking PID existence.")
                            if not ipc_utils.is_pid_running(self.pid):
                                currently_alive = False
                            else:
                                logging.warning(f"Session PID {self.pid} is unresponsive but still running. Keeping alive.")
                    else:
                        logging.info("[PY][Session] start() - IPC not connected, checking process/socket alive.")
                        currently_alive = ipc_utils.is_process_alive(self.pid, self.ipc_path)

                if not currently_alive:
                    logging.info(f"Session for PID {self.pid} is confirmed dead. Clearing.")
                    action_needed = "clear"
                elif folder_id and self.owner_folder_id and folder_id.lower() == self.owner_folder_id.lower():
                    launch_result = session_ipc_ops.hot_swap_item(
                        self, launch_item, folder_id, settings, _url_items_list
                    )
                else:
                    logging.info(f"[PY][Session] Folder mismatch (Current: {self.owner_folder_id}, Target: {folder_id}). Closing old session.")
                    if ipc_utils.is_pid_running(self.pid):
                        action_needed = "close"
                    else:
                        action_needed = "clear"

        if action_needed == "close":
            self.close()
        elif action_needed == "clear":
            self.clear(mpv_return_code=0)

        with self.sync_lock:
            if getattr(self, 'launch_cancelled', False):
                logging.info(f"[PY][Session] Launch for folder '{folder_id}' aborted due to cancellation.")
                return {"success": False, "error": "Launch cancelled."}

            if not launch_result.get("already_active"):
                if self.pid:
                    logging.warning(f"[PY][Session] Active PID {self.pid} still present after cleanup; aborting duplicate launch.")
                    return {"success": False, "error": "Another session is already active."}

                self.session_generation += 1
                self.manual_quit = False
                self.dispatched_exit_generations.discard(self.session_generation)
                logging.info("[PY][Session] No active session. Calling launcher.launch()...")
                launch_result = self.launcher.launch(
                    launch_item, folder_id, settings, file_io_mod,
                    full_playlist=_url_items_list if len(_url_items_list) > 1 else [_url_items_list[playlist_start_index]],
                    playlist_start_index=playlist_start_index,
                    **kwargs
                )
                logging.info(f"[PY][Session] launcher.launch() result: {launch_result.get('success')}")

                if launch_result.get("success"):
                    self.create_time = time.time()
                    logging.info("[PY][Session] start() - Post-launch initialization.")
                    if self.ipc_path and os.path.exists(self.ipc_path) and platform.system() != "Windows":
                        try:
                            os.chmod(self.ipc_path, 0o600)
                        except OSError as e:
                            logging.debug(f"[PY][Session] Could not set permissions on IPC socket {self.ipc_path}: {e}")

                    self.register_ipc_callbacks()
                    self._start_health_watcher()

        if launch_result.get("success") and len(_url_items_list) > 1:
            if not launch_result.get("handled_directly") or launch_result.get("already_active"):
                logging.info("[PY][Session] Triggering background enrichment flow.")
                self.enricher.handle_standard_flow_launch(self, _url_items_list, playlist_start_index, folder_id, settings, file_io_mod)

        if launch_result.get("success") and input_was_raw and not launch_result.get("already_active"):
            launch_result["handled_directly"] = True
            launch_result["enriched_url_items"] = _url_items_list
            launch_result["enriched_m3u_content"] = self._generate_m3u_content(_url_items_list)

        logging.info(f"[PY][Session] start() finished for folder '{folder_id}'. Success: {launch_result.get('success')}")
        return self._trim_oversized_reply(launch_result)

    def close(self):
        """Closes the current mpv session gracefully via IPC, then forcefully if needed."""
        return self.launcher.close()
