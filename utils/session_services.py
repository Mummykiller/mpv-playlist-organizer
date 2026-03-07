import json
import logging
import os
import threading
import time
import uuid
import platform
import subprocess
import signal
from urllib.parse import urlparse
from urllib.request import urlopen, Request
from utils import ipc_utils
from utils.m3u_parser import parse_m3u
from services import apply_bypass_script
from utils.url_analyzer import is_safe_url
import services
import file_io
from .item_processor import ItemProcessor

class EnrichmentService(ItemProcessor):
    def __init__(self, services, send_message_func, file_io_module, metadata_cache=None, task_manager=None):
        super().__init__(services, send_message_func, file_io_module, metadata_cache=metadata_cache, task_manager=task_manager)
        self._sync_in_progress = False

    def handle_standard_flow_launch(self, session, url_items, start_index, folder_id, settings, file_io):
        """Handles the background restoration of playlist order and sequential metadata enrichment."""
        if self._sync_in_progress:
            logging.info(f"[PY][Session] Sync already in progress for folder '{folder_id}'. Skipping redundant trigger.")
            return

        def task():
            self._sync_in_progress = True
            try:
                # Poll for readiness instead of hard sleep
                start_wait = time.time()
                while time.time() - start_wait < 10.0:
                    # --- CANCELLATION CHECK ---
                    if not session.is_alive or getattr(session, 'launch_cancelled', False):
                        logging.info(f"[PY][Session] Background Flow aborted: Session dead or cancelled.")
                        return
                    if session.ipc_manager and session.ipc_manager.is_connected():
                        # Optional: Ping to ensure responsiveness
                        ping = session.ipc_manager.send({"command": ["get_property", "pid"]}, timeout=0.5, expect_response=True)
                        if ping:
                            break
                    time.sleep(0.2)
                
                if not session.is_alive:
                    return
                
                history_items = url_items[:start_index]
                future_items = url_items[start_index + 1:]
                
                logging.info(f"[PY][Session] Background Flow: start_index={start_index}, history={len(history_items)}, future={len(future_items)}")
                
                # 1. Enrich and Batch Append Future Items
                if future_items:
                    logging.info(f"[PY][Session] Background: Enriching {len(future_items)} future items sequentially.")
                    enriched_future = []
                    for item in future_items:
                        if not session.is_alive:
                            return
                        res = self.enrich_single_item(item, folder_id, session.session_cookies, session.sync_lock, settings=settings, session=session)
                        if res:
                            enriched_future.extend(res)
                    
                    if enriched_future and session.is_alive:
                        logging.info(f"[PY][Session] Background: Appending batch of {len(enriched_future)} future items.")
                        session.append_batch(enriched_future, mode="append", folder_id=folder_id, quiet=True)

                # 2. Enrich and Batch Append History Items
                if history_items:
                    logging.info(f"[PY][Session] Background: Enriching {len(history_items)} history items sequentially.")
                    enriched_history = []
                    for item in history_items:
                        if not session.is_alive:
                            return
                        res = self.enrich_single_item(item, folder_id, session.session_cookies, session.sync_lock, settings=settings, session=session)
                        if res:
                            enriched_history.extend(res)
                    
                    if enriched_history and session.is_alive:
                        logging.info(f"[PY][Session] Background: Prepending batch of {len(enriched_history)} history items.")
                        session.append_batch(enriched_history, mode="prepend", folder_id=folder_id, quiet=True)

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
                self._sync_in_progress = False

        threading.Thread(target=task, daemon=True).start()

class LauncherService:
    def __init__(self, mpv_session):
        self.session = mpv_session

    def start_restored_process_watcher(self, pid, ipc_path, folder_id):
        """Starts a background thread to poll for the exit of a restored (orphaned) process."""
        def watcher():
            logging.info(f"Restored Process Watcher: Monitoring PID {pid} for folder '{folder_id}'.")
            while True:
                time.sleep(1.0)
                if not ipc_utils.is_pid_running(pid):
                    logging.info(f"Restored Process Watcher: Detected exit of orphaned MPV process (PID {pid}).")
                    
                    return_code = -1 
                    exit_reason = None
                    if ipc_path:
                        # Check multiple flag locations for robustness
                        flag_candidates = [
                            os.path.join(self.session.FLAG_DIR, f'mpv_natural_completion_{pid}.flag'),
                            os.path.join(os.path.dirname(ipc_path), f'mpv_natural_completion_{pid}.flag'),
                            os.path.join("/tmp", f'mpv_natural_completion_{pid}.flag')
                        ]
                        
                        for flag_file in flag_candidates:
                            if os.path.exists(flag_file):
                                if getattr(self.session, 'manual_quit', False):
                                    logging.info("Restored Watcher: Natural completion flag found, but manual_quit is TRUE. Ignoring flag.")
                                else:
                                    try:
                                        with open(flag_file, 'r', encoding='utf-8') as f:
                                            exit_reason = f.read().strip()
                                    except Exception:
                                        exit_reason = "completed"
                                    logging.info(f"Restored Watcher: Natural completion flag FOUND (Reason: {exit_reason}). Overriding return code to 99.")
                                    return_code = 99
                                try:
                                    os.remove(flag_file)
                                except Exception:
                                    pass
                                break

                    self.session.send_message({
            "action": "mpv_exited", 
            "folder_id": folder_id, 
            "return_code": return_code, 
            "reason": exit_reason
        })
                    self.session.clear(mpv_return_code=return_code)
                    break
                
                if not self.session.is_alive or self.session.pid != pid:
                    logging.info(f"Restored Process Watcher: Session state changed. Stopping watcher for PID {pid}.")
                    break

        threading.Thread(target=watcher, daemon=True).start()

    def _prepare_launch_env(self, has_terminal_flag):
        """Scrubs environment variables based on a whitelist for security."""
        if has_terminal_flag:
            return os.environ.copy()
            
        base_env = os.environ
        env = {}
        if platform.system() == "Windows":
            allowed = {
                'ALLUSERSPROFILE', 'APPDATA', 'COMPUTERNAME', 'ComSpec', 'CommonProgramFiles',
                'CommonProgramFiles(x86)', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'LOGONSERVER',
                'NUMBER_OF_PROCESSORS', 'OS', 'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE',
                'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'ProgramData',
                'ProgramFiles', 'ProgramFiles(x86)', 'Public', 'SystemDrive', 'SystemRoot',
                'TEMP', 'TMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'windir'
            }
        else:
            allowed = {
                'HOME', 'LANG', 'LC_ALL', 'LOGNAME', 'PATH', 'PWD', 'SHELL', 'TERM', 'USER',
                'DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
                'XDG_CACHE_HOME', 'DBUS_SESSION_BUS_ADDRESS',
                'WAYLAND_DISPLAY', 'XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP',
                'MPV_HOME', 'PULSE_SERVER', 'PIPEWIRE_RUNTIME_DIR'
            }
        
        for key, val in base_env.items():
            if key in allowed or key.startswith("LC_") or (platform.system() != "Windows" and key.startswith("XDG_")):
                env[key] = val
        return env

    def _sync_initial_state(self, url_item, folder_id, settings, playlist_start_index, launch_lua_options, launch_url):
        """Sets up IPC properties, lua options, and triggers the initial file load."""
        mgr = self.session.ipc_manager
        
        # 1. Register the current item's options with its actual global index
        lua_opts, item_url = services.construct_lua_options(
            url_item, settings, self.session.SCRIPT_DIR, index=playlist_start_index
        )
        mgr.send({"command": ["script-message", "set_url_options", item_url, json.dumps(lua_opts), str(playlist_start_index)]})

        # 2. Set Hot-Swap Properties for the current item
        mgr.send({"command": ["set_property", "user-data/hot-swap-options", json.dumps(launch_lua_options)]})
        
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
            except (ValueError, TypeError):
                pass

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

        # 2. Force Bypass Hint
        force_bypass = False
        targeted = settings.get('targeted_defaults', 'none')
        if targeted == 'animepahe' and any(x in launch_url for x in ["kwik.cx", "owocdn.top", "uwucdn.top"]):
            force_bypass = True
        elif targeted == 'all-none-yt' and not is_youtube:
            force_bypass = True

        if getattr(self.session, 'launch_cancelled', False):
            logging.info("[PY][Session] Launch cancelled flag detected.")
            return {"success": False, "error": "Launch cancelled by user."}

        try:
            # 2.5 Generate Metadata Handshake File
            logging.info("[PY][Session] Generating handshake file...")
            handshake_data = {
                "folder_id": folder_id,
                "project_root": self.session.SCRIPT_DIR,
                "flag_dir": self.session.FLAG_DIR,
                "playlist_start_index": playlist_start_index,
                "is_youtube": is_youtube,
                "use_ytdl_mpv": use_ytdl_mpv,
                "title": url_item.get('title'),
                "id": url_item.get('id'),
                "original_url": services.sanitize_url(url_item.get('original_url') or url_item.get('url', '')),
                "headers": kwargs.get('headers') or url_item.get('headers'),
                "cookies_browser": kwargs.get('cookies_browser') or url_item.get('cookies_browser'),
                "lua_options": services.construct_lua_options(url_item, settings, self.session.SCRIPT_DIR)[0],
                "is_unmanaged": kwargs.get('is_unmanaged', False)
            }
            
            handshake_path = os.path.join(self.session.FLAG_DIR, f"handshake_{uuid.uuid4().hex}.json")
            with open(handshake_path, 'w', encoding='utf-8') as f:
                json.dump(handshake_data, f)
            
            handshake_flag = f"--script-opts=mpv_organizer-handshake={handshake_path}"
            current_custom_flags = kwargs.get('custom_mpv_flags') or ""
            updated_custom_flags = f"{current_custom_flags} {handshake_flag}".strip()

            # 3. Construct Command
            logging.info("[PY][Session] Constructing mpv command...")
            full_command, has_terminal_flag = services.construct_mpv_command(
                mpv_exe=mpv_exe, ipc_path=ipc_path, url=launch_url, is_youtube=is_youtube,
                ytdl_raw_options=kwargs.get('ytdl_raw_options') or url_item.get('ytdl_raw_options'),
                geometry=kwargs.get('geometry'), 
                custom_width=kwargs.get('custom_width'),
                custom_height=kwargs.get('custom_height'), custom_mpv_flags=updated_custom_flags,
                automatic_mpv_flags=kwargs.get('automatic_mpv_flags'),
                headers=kwargs.get('headers') or url_item.get('headers'),
                disable_http_persistent=kwargs.get('disable_http_persistent', False),
                start_paused=kwargs.get('start_paused', False), script_dir=self.session.SCRIPT_DIR,
                load_on_completion_script=True, title=url_item.get('title'),
                use_ytdl_mpv=use_ytdl_mpv, is_youtube_override=use_ytdl_mpv, idle="yes", 
                force_terminal=kwargs.get('force_terminal', False), settings=settings,
                flag_dir=self.session.FLAG_DIR, playlist_start_index=0,
                cookies_browser=kwargs.get('cookies_browser') or url_item.get('cookies_browser'),
                force_bypass=force_bypass
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

            pid_res = self.session.ipc_manager.send({"command": ["get_property", "pid"]}, timeout=5.0, expect_response=True)
            if pid_res and pid_res.get("error") == "success":
                self.session.pid = pid_res.get("data")
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
            return {"success": False, "error": f"Error launching mpv: {str(e)}"}

    def _start_exit_watcher(self, process, folder_id):
        """Helper to start the process waiter thread."""
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
                self.start_restored_process_watcher(actual_pid, self.session.ipc_path, f_id)
                return

            for pid in pids:
                flag_candidates = [
                    os.path.join(self.session.FLAG_DIR, f'mpv_natural_completion_{pid}.flag'),
                    os.path.join("/tmp", f'mpv_natural_completion_{pid}.flag')
                ]
                if self.session.ipc_path: flag_candidates.append(os.path.join(os.path.dirname(self.session.ipc_path), f'mpv_natural_completion_{pid}.flag'))

                for flag_file in flag_candidates:
                    if os.path.exists(flag_file):
                        if not getattr(self.session, 'manual_quit', False):
                            try:
                                with open(flag_file, 'r', encoding='utf-8') as f: exit_reason = f.read().strip()
                            except Exception: exit_reason = "completed"
                            return_code = 99
                        try: os.remove(flag_file)
                        except Exception: pass
                        break
                if exit_reason: break

            stats = self.session.clear(mpv_return_code=return_code)
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
                    proc.wait()
                    was_killed = True
        elif pid:
            # Reconnected session (no proc object)
            logging.info(f"Reconnected session: Attempting to close via PID {pid}")
            try:
                if platform.system() == "Windows":
                    # On Windows, we use taskkill to be thorough
                    subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)], 
                                 capture_output=True, check=False)
                else:
                    # Unix: try SIGTERM then SIGKILL
                    os.kill(pid, signal.SIGTERM)
                    # Poll for a moment
                    for _ in range(10):
                        time.sleep(0.1)
                        if not ipc_utils.is_pid_running(pid):
                            was_killed = True
                            break
                    
                    if not was_killed:
                        os.kill(pid, signal.SIGKILL)
                        was_killed = True
                
                # Check if it actually died (final verification)
                if not was_killed and not ipc_utils.is_pid_running(pid):
                    was_killed = True
            except OSError:
                was_killed = True # Process already gone

        if was_killed:
            self.session.clear()
            return {"success": True, "message": "MPV session closed."}
        else:
            # Even if we couldn't verify death, we clear our state if PID is gone
            if not ipc_utils.is_pid_running(pid):
                self.session.clear()
                return {"success": True, "message": "MPV session cleared (already dead)."}
            return {"success": False, "error": "Failed to close MPV session."}

class IPCService:
    def __init__(self, session):
        self.session = session

    def reorder_live(self, folder_id, new_order_items):
        if not self.session.is_alive or not self.session.owner_folder_id or self.session.owner_folder_id.lower() != folder_id.lower():
            return {"success": False, "message": "Session mismatch."}
        
        # Ensure internal playlist matches MPV reality before reordering
        self.session._sync_playlist_from_mpv()

        simulated_playlist = list(self.session.playlist)
        for target_index, item_data in enumerate(new_order_items):
            target_id = item_data.get('id')
            current_index = next((idx for idx, item in enumerate(simulated_playlist) if item.get('id') == target_id), -1)
            
            if current_index != -1 and current_index != target_index:
                self.session.ipc_manager.send({"command": ["playlist-move", current_index, target_index]})
                item_to_move = simulated_playlist.pop(current_index)
                simulated_playlist.insert(target_index, item_to_move)
        
        self.session.playlist = simulated_playlist
        
        # --- REFRESH LUA INDICES ---
        if self.session.ipc_manager and self.session.ipc_manager.is_connected():
            settings = file_io.get_settings()
            
            for idx, item in enumerate(simulated_playlist):
                # Centralized helper handles enrichment, headers, and setting normalization
                lua_options, item_url = services.construct_lua_options(
                    item, settings, self.session.SCRIPT_DIR, index=idx
                )
                self.session.ipc_manager.send({"command": ["script-message", "set_url_options", item_url, json.dumps(lua_options), str(idx)]})

        if self.session.playlist_tracker:
            self.session.playlist_tracker.update_playlist_order(simulated_playlist)
        self.session.ipc_manager.send({"command": ["show-text", "Playlist reordered", 2000]})
        return {"success": True, "message": "Live playlist reordered."}