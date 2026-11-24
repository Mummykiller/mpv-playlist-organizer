import json
import logging
import os
import threading
import time
import uuid
import platform
import signal
import subprocess
from concurrent.futures import ThreadPoolExecutor
from utils import ipc_utils, security
import services
from .item_processor import ItemProcessor

class EnrichmentService(ItemProcessor):
    def __init__(self, services, send_message_func, file_io_module, metadata_cache=None, task_manager=None, max_workers=5):
        super().__init__(services, send_message_func, file_io_module, metadata_cache=metadata_cache, task_manager=task_manager)
        self._sync_in_progress = False
        self._active_sync_id = None
        self._active_sync_folder = None
        self._lock = threading.Lock()
        self._max_workers = max_workers
        self._executor = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="enrichment_worker")
        self._is_shutdown = False

    @property
    def executor(self):
        """Returns the active bounded ThreadPoolExecutor, recreating it if previously shut down."""
        with self._lock:
            if self._executor is None or self._is_shutdown:
                self._executor = ThreadPoolExecutor(max_workers=self._max_workers, thread_name_prefix="enrichment_worker")
                self._is_shutdown = False
            return self._executor

    def submit(self, fn, *args, **kwargs):
        """Submits a task to the shared bounded ThreadPoolExecutor."""
        return self.executor.submit(fn, *args, **kwargs)

    def map(self, func, *iterables, timeout=None, chunksize=1):
        """Maps a function over iterables using the bounded ThreadPoolExecutor."""
        return self.executor.map(func, *iterables, timeout=timeout, chunksize=chunksize)

    def shutdown(self, wait=False, cancel_futures=True):
        """Cleanly shuts down the thread pool executor to prevent thread leaks."""
        with self._lock:
            if self._executor and not self._is_shutdown:
                try:
                    import sys
                    if sys.version_info >= (3, 9):
                        self._executor.shutdown(wait=wait, cancel_futures=cancel_futures)
                    else:
                        self._executor.shutdown(wait=wait)
                except Exception as e:
                    logging.debug(f"[EnrichmentService] Error shutting down executor: {e}")
                finally:
                    self._is_shutdown = True
                    self._executor = None

    def handle_standard_flow_launch(self, session, url_items, start_index, folder_id, settings, file_io):
        """Handles the background restoration of playlist order and sequential metadata enrichment."""
        with self._lock:
            if (
                self._sync_in_progress
                and self._active_sync_folder
                and folder_id
                and self._active_sync_folder.lower() == folder_id.lower()
                and session.is_alive
                and session.owner_folder_id
                and session.owner_folder_id.lower() == folder_id.lower()
            ):
                logging.info(f"[PY][Session] Sync already in progress for folder '{folder_id}'. Skipping redundant trigger.")
                return
            sync_id = uuid.uuid4().hex
            self._active_sync_id = sync_id
            self._active_sync_folder = folder_id
            self._sync_in_progress = True

        def is_sync_valid():
            if self._active_sync_id != sync_id:
                return False
            if not session.is_alive or getattr(session, 'launch_cancelled', False):
                return False
            if folder_id and session.owner_folder_id and session.owner_folder_id.lower() != folder_id.lower():
                return False
            return True

        def task():
            try:
                # Poll for readiness instead of hard sleep
                start_wait = time.time()
                while time.time() - start_wait < 10.0:
                    # --- CANCELLATION & FOLDER CHECK ---
                    if not is_sync_valid():
                        logging.info("[PY][Session] Background Flow aborted: Session dead, cancelled, or folder switched.")
                        return
                    if session.ipc_manager and session.ipc_manager.is_connected():
                        # Optional: Ping to ensure responsiveness
                        if session.ipc_manager.get_property("pid", timeout=0.5):
                            break
                    time.sleep(0.2)

                if not is_sync_valid():
                    return

                history_items = url_items[:start_index]
                future_items = url_items[start_index + 1:]

                logging.info(f"[PY][Session] Background Flow: start_index={start_index}, history={len(history_items)}, future={len(future_items)}")

                total_to_process = len(future_items) + len(history_items)
                if total_to_process > 0:
                    self.send_message({"action": "log_from_native_host", "log": {"text": f"Restoring playlist: Processing {total_to_process} items for '{folder_id}'...", "type": "info"}})

                # 1. Enrich and Batch Append Future Items
                if future_items:
                    logging.info(f"[PY][Session] Background: Enriching {len(future_items)} future items sequentially.")
                    enriched_batch = []
                    for item in future_items:
                        if not is_sync_valid():
                            return
                        res = self.enrich_single_item(item, folder_id, session.session_cookies, session.sync_lock, settings=settings, session=session, quiet=True)
                        if res:
                            enriched_batch.extend(res)

                        # BATCH UPDATE: Every 5 items, push to MPV to keep UI alive
                        if len(enriched_batch) >= 5:
                            if not is_sync_valid():
                                return
                            logging.info(f"[PY][Session] Background: Pushing batch of {len(enriched_batch)} future items.")
                            session.append_batch(enriched_batch, mode="append", folder_id=folder_id, quiet=True)
                            enriched_batch = []

                    if enriched_batch and is_sync_valid():
                        logging.info(f"[PY][Session] Background: Pushing final batch of {len(enriched_batch)} future items.")
                        session.append_batch(enriched_batch, mode="append", folder_id=folder_id, quiet=True)

                # 2. Enrich and Batch Append History Items
                if history_items:
                    logging.info(f"[PY][Session] Background: Enriching {len(history_items)} history items sequentially.")
                    enriched_batch = []
                    for item in reversed(history_items): # Process backwards so we can prepend in order
                        if not is_sync_valid():
                            return
                        res = self.enrich_single_item(item, folder_id, session.session_cookies, session.sync_lock, settings=settings, session=session, quiet=True)
                        if res:
                            # Prepend to batch so we maintain original order when prepending to MPV
                            enriched_batch = res + enriched_batch

                        if len(enriched_batch) >= 5:
                            if not is_sync_valid():
                                return
                            logging.info(f"[PY][Session] Background: Pushing batch of {len(enriched_batch)} history items.")
                            session.append_batch(enriched_batch, mode="prepend", folder_id=folder_id, quiet=True)
                            enriched_batch = []

                    if enriched_batch and is_sync_valid():
                        logging.info(f"[PY][Session] Background: Pushing final batch of {len(enriched_batch)} history items.")
                        session.append_batch(enriched_batch, mode="prepend", folder_id=folder_id, quiet=True)

                if not is_sync_valid():
                    return

                if session.playlist_tracker:
                    session.playlist_tracker.update_playlist_order(session.playlist)

                # --- REFRESH LUA INDICES AFTER MOVE ---
                # Since we moved items, we must update Lua's index mapping.
                if session.ipc_manager and session.ipc_manager.is_connected():
                    for idx, item in enumerate(session.playlist):
                        lua_options, item_url = services.construct_lua_options(
                            item, settings, session.SCRIPT_DIR, index=idx
                        )
                        session.ipc_manager.send({"command": ["script-message", "set_url_options", item_url, json.dumps(lua_options), str(idx)]})

                    # Single consolidated OSD message
                    session.ipc_manager.send({"command": ["show-text", "Playlist restored", 2000]})

                logging.info("[PY][Session] Background: Batched restoration complete.")
            except Exception as e:
                logging.error(f"[PY][Session] Background task error: {e}", exc_info=True)
            finally:
                with self._lock:
                    if self._active_sync_id == sync_id:
                        self._sync_in_progress = False
                        self._active_sync_id = None
                        self._active_sync_folder = None

        self.submit(task)

def _safe_read_flag_file(flag_file):
    """Safely reads a natural completion flag file using O_NOFOLLOW and capped length (PY-M3)."""
    if not os.path.exists(flag_file):
        return None
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = -1
    content = None
    try:
        fd = os.open(flag_file, flags)
        with os.fdopen(fd, 'r', encoding='utf-8', errors='replace') as f:
            fd = -1 # fdopen takes ownership of fd
            content = f.read(256).strip()
    except (OSError, UnicodeDecodeError) as e:
        logging.debug(f"Failed to safely read completion flag {flag_file}: {e}")
    finally:
        if fd >= 0:
            try:
                os.close(fd)
            except OSError as ce:
                logging.debug(f"Error closing flag file descriptor: {ce}")
    try:
        if os.path.exists(flag_file):
            os.remove(flag_file)
    except OSError as e:
        logging.debug(f"Failed to remove completion flag {flag_file}: {e}")
    return content

class LauncherService:
    def __init__(self, mpv_session):
        self.session = mpv_session

    def start_restored_process_watcher(self, pid, ipc_path, folder_id, session_generation=None):
        """Starts a background thread to poll for the exit of a restored (orphaned) process."""
        waiter_gen = session_generation if session_generation is not None else getattr(self.session, 'session_generation', 0)

        def watcher():
            logging.info(f"Restored Process Watcher: Monitoring PID {pid} for folder '{folder_id}' (gen {waiter_gen}).")
            while True:
                time.sleep(1.0)
                if not ipc_utils.is_pid_running(pid):
                    logging.info(f"Restored Process Watcher: Detected exit of orphaned MPV process (PID {pid}).")

                    return_code = -1
                    exit_reason = None
                    is_manual = (
                        getattr(self.session, 'manual_quit', False)
                        or getattr(self.session, 'is_closing', False)
                        or waiter_gen != getattr(self.session, 'session_generation', 0)
                    )

                    if not is_manual:
                        flag_file = os.path.join(self.session.FLAG_DIR, f'mpv_natural_completion_{pid}.flag')
                        content = _safe_read_flag_file(flag_file)
                        if content is not None:
                            exit_reason = content or "completed"
                            logging.info(f"Restored Watcher: Natural completion flag FOUND (Reason: {exit_reason}). Overriding return code to 99.")
                            return_code = 99
                    else:
                        logging.info("Restored Watcher: manual_quit is TRUE. Ignoring natural completion flag.")
                        exit_reason = "manual_quit"

                    stats = self.session.clear(mpv_return_code=return_code, session_generation=waiter_gen)

                    with self.session.sync_lock:
                        already_dispatched = waiter_gen in getattr(self.session, 'dispatched_exit_generations', set())
                        if not already_dispatched and waiter_gen == getattr(self.session, 'session_generation', 0):
                            self.session.dispatched_exit_generations.add(waiter_gen)
                            should_send = True
                        else:
                            should_send = False

                    if should_send:
                        self.session.send_message({
                            "action": "mpv_exited",
                            "folder_id": folder_id,
                            "return_code": return_code,
                            "reason": exit_reason,
                            "played_ids": stats.get("played_ids", []),
                            "watched_ids": stats.get("watched_ids", []),
                            "session_ids": stats.get("session_ids", [])
                        })
                    break

                if not self.session.is_alive or self.session.pid != pid:
                    logging.info(f"Restored Process Watcher: Session state changed. Stopping watcher for PID {pid}.")
                    break

        threading.Thread(target=watcher, daemon=True).start()

    def _prepare_launch_env(self, has_terminal_flag):
        """Scrubs environment variables based on centralized security policy."""
        return security.get_scrubbed_env(keep_terminal=has_terminal_flag)

    def _sync_initial_state(self, url_item, folder_id, settings, playlist_start_index, launch_lua_options, launch_url):
        """Sets up IPC properties, lua options, and triggers the initial file load."""
        mgr = self.session.ipc_manager

        # 1. Register the current item's options with its actual global index
        lua_opts, item_url = services.construct_lua_options(
            url_item, settings, self.session.SCRIPT_DIR, index=playlist_start_index
        )
        mgr.send({"command": ["script-message", "set_url_options", item_url, json.dumps(lua_opts), str(playlist_start_index)]})

        # 2. Set Properties for the current item (do NOT set user-data/hot-swap-options here,
        # because the initial item already loaded its options from the handshake file, and leaving
        # hot-swap-options set would hijack Item 2's metadata/ID on track transition)
        orig_url = url_item.get('original_url') or url_item.get('url', '')
        props = {
            "user-data/original-url": services.sanitize_url(orig_url),
            "user-data/id": url_item.get('id', ""),
            "user-data/folder-id": folder_id,
            "user-data/project-root": self.session.SCRIPT_DIR,
            "user-data/cookies-browser": url_item.get('cookies_browser', ""),
            "user-data/is-youtube": "yes" if url_item.get('is_youtube') else "no",
            "ytdl": "yes" if url_item.get('is_youtube') or url_item.get('use_ytdl_mpv') else "no"
        }
        for k, v in props.items():
            mgr.send({"command": ["set_property", k, v]})

        if settings.get('enable_precise_resume', True):
            try:
                # Extract resume time from the already constructed lua_opts
                start_time = int(float(lua_opts.get('resume_time') or 0))
                if start_time > 0:
                    mgr.send({"command": ["set_property", "user-data/primed-resume-time", str(start_time)]})
                    logging.info(f"[PY][Session] Primed initial resume time: {start_time}s")
            except (ValueError, TypeError) as e:
                logging.debug(f"[PY][Session] Resume time could not be parsed: {e}")

        # NOTE: We do NOT send 'loadfile' here because the file is already on the command line.
        # Sending it again via IPC causes a "Double Load" race condition.

    def launch(self, url_item, folder_id, settings, file_io, **kwargs):
        logging.info(f"[PY][Session] Launcher.launch() start for URL: {url_item.get('url')}")
        mpv_exe = self.session.get_mpv_executable()
        ipc_path = ipc_utils.get_ipc_path()
        playlist_start_index = kwargs.get('playlist_start_index', 0)

        # 1. Prepare Metadata & Launch URL
        is_youtube = kwargs.get('is_youtube') if kwargs.get('is_youtube') is not None else url_item.get('is_youtube', False)
        use_ytdl_mpv = kwargs.get('use_ytdl_mpv') if kwargs.get('use_ytdl_mpv') is not None else url_item.get('use_ytdl_mpv', False)
        launch_url = services.sanitize_url(url_item.get('url'))
        if url_item.get('id'):
            launch_url += ("#" if "#" not in launch_url else "&") + f"mpv_organizer_id={url_item['id']}"

        if getattr(self.session, 'launch_cancelled', False):
            logging.info("[PY][Session] Launch cancelled flag detected.")
            return {"success": False, "error": "Launch cancelled by user."}

        process = None
        handshake_path = None
        try:
            # 2. Generate Metadata Handshake File
            logging.info("[PY][Session] Generating handshake file...")
            handshake_path, _ = services.create_handshake_file(
                flag_dir=self.session.FLAG_DIR,
                folder_id=folder_id,
                script_dir=self.session.SCRIPT_DIR,
                item=url_item,
                settings=settings,
                playlist_start_index=playlist_start_index,
                is_unmanaged=kwargs.get('is_unmanaged', False),
                is_youtube=is_youtube,
                use_ytdl_mpv=use_ytdl_mpv,
                headers=kwargs.get('headers') or url_item.get('headers'),
                cookies_browser=kwargs.get('cookies_browser') or url_item.get('cookies_browser')
            )

            # 3. Construct Command
            logging.info("[PY][Session] Constructing mpv command...")
            full_command, has_terminal_flag = services.construct_mpv_command(
                mpv_exe=mpv_exe, ipc_path=ipc_path, url=launch_url, is_youtube=is_youtube,
                ytdl_raw_options=kwargs.get('ytdl_raw_options') or url_item.get('ytdl_raw_options'),
                geometry=kwargs.get('geometry'),
                custom_width=kwargs.get('custom_width'),
                custom_height=kwargs.get('custom_height'), custom_mpv_flags=kwargs.get('custom_mpv_flags'),
                automatic_mpv_flags=kwargs.get('automatic_mpv_flags'),
                headers=kwargs.get('headers') or url_item.get('headers'),
                disable_http_persistent=kwargs.get('disable_http_persistent', False),
                start_paused=kwargs.get('start_paused', False), script_dir=self.session.SCRIPT_DIR,
                load_on_completion_script=True, title=url_item.get('title'),
                use_ytdl_mpv=use_ytdl_mpv, is_youtube_override=use_ytdl_mpv, idle="yes",
                force_terminal=kwargs.get('force_terminal', False), settings=settings,
                flag_dir=self.session.FLAG_DIR, playlist_start_index=0,
                cookies_browser=kwargs.get('cookies_browser') or url_item.get('cookies_browser'),
                handshake_path=handshake_path
            )

            # 4. Spawn Process
            logging.info(f"[PY][Session] Spawning mpv process: {mpv_exe}")
            env = self._prepare_launch_env(has_terminal_flag)
            process = subprocess.Popen(full_command, env=env, **services.get_mpv_popen_kwargs(has_terminal_flag))
            self.session.process, self.session.ipc_path = process, ipc_path
            self.session.handshake_path = handshake_path

            if process.stdout:
                # Use the new non-blocking stream observer with yt-dlp failure detection
                observer = self.session.log_stream(tag="MPV", folder_id=folder_id, send_message_func=self.session.send_message)
                threading.Thread(target=observer, args=(process.stdout,), daemon=True).start()

            # 5. Connect & Sync
            logging.info(f"[PY][Session] Connecting to IPC: {ipc_path}")
            self.session.ipc_manager = ipc_utils.IPCSocketManager()
            if not self.session.ipc_manager.connect(self.session.ipc_path, timeout=5.0):
                logging.error(f"[PY][Session] IPC connection timeout: {ipc_path}")
                raise RuntimeError(f"Failed to connect to MPV IPC at {self.session.ipc_path}")

            mpv_pid = self.session.ipc_manager.get_property("pid", timeout=5.0)
            if mpv_pid:
                self.session.pid = mpv_pid
                logging.info(f"[PY][Session] MPV PID resolved: {self.session.pid}")
            else:
                self.session.pid = process.pid
                logging.warning(f"[PY][Session] Could not resolve MPV PID via IPC, using parent PID: {self.session.pid}")

            self.session.owner_folder_id, self.session.is_alive = folder_id, True
            self.session.playlist = kwargs.get('full_playlist') or [url_item]
            self.session.persist_session()

            launch_lua_options, _ = services.construct_lua_options(url_item, settings, self.session.SCRIPT_DIR)
            self._sync_initial_state(url_item, folder_id, settings, playlist_start_index, launch_lua_options, launch_url)

            from playlist_tracker import PlaylistTracker
            self.session.playlist_tracker = PlaylistTracker(folder_id, self.session.playlist, file_io, settings, self.session.ipc_path, self.session.send_message)
            self.session.playlist_tracker.start_tracking()

            # 6. Exit Watcher
            self._start_exit_watcher(process, folder_id)

            resume_msg = f" at {int(float(launch_lua_options['resume_time']))}s" if launch_lua_options.get('resume_time') else ""
            logging.info(f"[PY][Session] Launcher.launch() successful{resume_msg}")
            return {"success": True, "message": f"MPV playback initiated{resume_msg}."}
        except Exception as e:
            logging.error(f"Launcher Error: {type(e).__name__}: {e}", exc_info=True)
            if process is not None:
                try:
                    if process.poll() is None:
                        process.terminate()
                        try:
                            process.wait(timeout=1.0)
                        except subprocess.TimeoutExpired:
                            process.kill()
                except Exception as proc_err:
                    logging.debug(f"[PY][Session] Failed to terminate process on launch failure: {proc_err}")
                self.session.process = None
            if self.session.ipc_manager is not None:
                try:
                    self.session.ipc_manager.close()
                except Exception as ipc_err:
                    logging.debug(f"[PY][Session] Failed to close IPC manager on launch failure: {ipc_err}")
                self.session.ipc_manager = None
            if handshake_path and os.path.exists(handshake_path):
                try:
                    os.remove(handshake_path)
                except OSError as hs_err:
                    logging.debug(f"[PY][Session] Failed to remove handshake file on launch failure: {hs_err}")
            self.session.handshake_path = None
            self.session.ipc_path = None
            self.session.pid = None
            self.session.is_alive = False
            return {"success": False, "error": f"Error launching mpv: {str(e)}"}

    def _start_exit_watcher(self, process, folder_id):
        """Helper to start the process waiter thread."""
        waiter_gen = getattr(self.session, 'session_generation', 0)

        def process_waiter(proc, f_id):
            initial_pid = proc.pid
            actual_pid = getattr(self.session, 'pid', None)

            if actual_pid and actual_pid != initial_pid:
                while proc.poll() is None:
                    if not ipc_utils.is_pid_running(actual_pid): break
                    time.sleep(0.1)
            else:
                proc.wait()

            return_code = proc.poll() if proc.poll() is not None else 0
            if proc.poll() is None: threading.Thread(target=proc.wait, daemon=True).start()

            exit_reason = None
            actual_pid = getattr(self.session, 'pid', None)
            pids = list(set(filter(None, [initial_pid, actual_pid])))

            if actual_pid and actual_pid != initial_pid and ipc_utils.is_pid_running(actual_pid):
                if waiter_gen == getattr(self.session, 'session_generation', 0):
                    self.start_restored_process_watcher(actual_pid, self.session.ipc_path, f_id, session_generation=waiter_gen)
                return

            is_manual = (
                getattr(self.session, 'manual_quit', False)
                or getattr(self.session, 'is_closing', False)
                or waiter_gen != getattr(self.session, 'session_generation', 0)
            )
            if not is_manual:
                for p in pids:
                    flag_file = os.path.join(self.session.FLAG_DIR, f'mpv_natural_completion_{p}.flag')
                    content = _safe_read_flag_file(flag_file)
                    if content is not None:
                        exit_reason = content or "completed"
                        return_code = 99
                        break
            else:
                logging.info(f"Process waiter: manual_quit is TRUE for PID {initial_pid}. Ignoring completion flag.")
                exit_reason = "manual_quit"

            stats = self.session.clear(mpv_return_code=return_code, session_generation=waiter_gen)

            with self.session.sync_lock:
                already_dispatched = waiter_gen in getattr(self.session, 'dispatched_exit_generations', set())
                if not already_dispatched and waiter_gen == getattr(self.session, 'session_generation', 0):
                    self.session.dispatched_exit_generations.add(waiter_gen)
                    should_send = True
                else:
                    should_send = False

            if should_send:
                self.session.send_message({
                    "action": "mpv_exited", "folder_id": f_id, "return_code": return_code, "reason": exit_reason,
                    "played_ids": stats.get("played_ids", []),
                    "watched_ids": stats.get("watched_ids", []),
                    "session_ids": stats.get("session_ids", [])
                })

        threading.Thread(target=process_waiter, args=(process, folder_id), daemon=True).start()

    def close(self):
        """Closes the current mpv session gracefully via IPC, then forcefully if needed."""
        with self.session.sync_lock:
            if not self.session.is_alive or not self.session.pid:
                return {"success": True, "message": "No active session to close."}

            logging.info(f"Closing MPV session for PID: {self.session.pid}")
            self.session.manual_quit = True
            self.session.is_closing = True

            # Local copies for use outside the lock
            proc = self.session.process
            pid = self.session.pid
            ipc_path = self.session.ipc_path
            ipc_manager = self.session.ipc_manager

        # 1. Try to reconnect if needed to ensure graceful quit (OUTSIDE LOCK)
        if ipc_path:
            if not ipc_manager:
                with self.session.sync_lock:
                    self.session.ipc_manager = ipc_utils.IPCSocketManager()
                    ipc_manager = self.session.ipc_manager

            if not ipc_manager.is_connected():
                logging.info(f"IPC not connected. Attempting reconnection to {ipc_path} for graceful quit...")
                ipc_manager.connect(ipc_path, timeout=0.5)

        # 2. Try graceful exit via IPC
        if ipc_manager and ipc_manager.is_connected():
            try:
                ipc_manager.send({"command": ["script-message", "manual_quit_initiated"]}, timeout=0.5, expect_response=False)
                ipc_manager.send({"command": ["quit"]}, timeout=0.5)
                time.sleep(0.1) # Give it a moment to react
            except Exception as e:
                logging.warning(f"Failed to send quit command via IPC: {e}")

        # 3. Wait for process to exit
        was_killed = False
        if proc:
            try:
                proc.wait(timeout=1.0)
                was_killed = True
            except subprocess.TimeoutExpired:
                logging.warning(f"MPV process {pid} did not exit gracefully. Terminating.")
                proc.terminate()
                try:
                    proc.wait(timeout=1.0)
                    was_killed = True
                except subprocess.TimeoutExpired:
                    logging.warning(f"MPV process {pid} did not terminate. Killing.")
                    proc.kill()
                    try:
                        proc.wait(timeout=2.0)
                    except subprocess.TimeoutExpired:
                        logging.warning(f"MPV process {pid} did not exit within 2s after kill.")
                    was_killed = True
        elif pid:
            # Reconnected session (no proc object)
            # PY-H3: Verify that PID actually belongs to MPV before sending signals
            if not ipc_utils.verify_mpv_process(pid, ipc_path=ipc_path):
                logging.warning(f"[PY][Session] Refusing to kill unverified PID {pid}: process is not mpv or does not match session.")
                was_killed = True # Process is not our MPV session; do not send kill signals
            else:
                logging.info(f"Reconnected session: Attempting to close verified MPV PID {pid}")
                try:
                    if platform.system() == "Windows":
                        try:
                            subprocess.run(
                                ["taskkill", "/F", "/T", "/PID", str(pid)],
                                capture_output=True, check=False, timeout=5
                            )
                        except subprocess.TimeoutExpired:
                            logging.warning(f"taskkill timed out for PID {pid}")
                    else:
                        os.kill(pid, signal.SIGTERM)
                        for _ in range(10):
                            time.sleep(0.1)
                            if not ipc_utils.is_pid_running(pid):
                                was_killed = True
                                break

                        if not was_killed:
                            os.kill(pid, signal.SIGKILL)
                            was_killed = True

                    if not was_killed and not ipc_utils.is_pid_running(pid):
                        was_killed = True
                except OSError as e:
                    logging.debug(f"Process {pid} already dead or could not signal: {e}")
                    was_killed = True

        # Clean up enrichment thread pool executor on session termination
        if hasattr(self.session, 'enricher') and self.session.enricher:
            try:
                self.session.enricher.shutdown(wait=False)
            except Exception as e:
                logging.debug(f"Error shutting down enricher executor: {e}")

        if was_killed:
            self.session.clear(mpv_return_code=0, session_generation=getattr(self.session, 'session_generation', None))
            return {"success": True, "message": "MPV session closed."}
        else:
            if not ipc_utils.is_pid_running(pid):
                self.session.clear(mpv_return_code=0, session_generation=getattr(self.session, 'session_generation', None))
                return {"success": True, "message": "MPV session cleared (already dead)."}
            return {"success": False, "error": "Failed to close MPV session."}
