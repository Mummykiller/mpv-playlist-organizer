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

def sanitize_url(url):
    return file_io.sanitize_string(url, is_filename=False)

class EnrichmentService:
    def __init__(self, send_message_func):
        self.send_message = send_message_func

    def enrich_single_item(self, item, folder_id=None, session_cookies_ref=None, sync_lock=None, settings=None, session=None):
        if item.get('enriched'):
            return [item]
        
        if session and getattr(session, 'launch_cancelled', False):
            raise RuntimeError("Launch cancelled by user.")

        if not item.get('id'):
            item['id'] = str(uuid.uuid4())

        if not item.get('original_url'):
            item['original_url'] = item.get('url')

        url_dict_for_analysis = {'url': item.get('url'), 'title': item.get('title'), 'id': item.get('id'), 'folder_id': folder_id}
        
        (
            processed_url,
            headers_for_mpv,
            ytdl_raw_options_for_mpv,
            use_ytdl_mpv_flag,
            is_youtube_flag_from_script,
            entries,
            disable_http_persistent_flag,
            cookies_file,
            mark_watched_flag,
            ytdl_format_from_script,
            cookies_browser
        ) = apply_bypass_script(url_dict_for_analysis, self.send_message, settings=settings, session=session)
        
        if entries:
            processed_entries = []
            for entry in entries:
                if not entry.get('id'):
                    entry['id'] = str(uuid.uuid4())
                if not entry.get('original_url'):
                    entry['original_url'] = entry.get('url')
                entry['is_youtube'] = True
                if 'use_ytdl_mpv' not in entry:
                    entry['use_ytdl_mpv'] = False 
                
                # Propagate cookies browser if available
                if cookies_browser:
                    entry['cookies_browser'] = cookies_browser
                if cookies_file:
                    entry['cookies_file'] = cookies_file

                processed_entries.append(entry)
            return processed_entries

        item['url'] = processed_url
        item['original_url'] = item.get('original_url') or item.get('url')
        item['ytdl_format'] = ytdl_format_from_script # Save format preference
        
        if headers_for_mpv:
            if not item.get('headers'):
                item['headers'] = headers_for_mpv
            else:
                merged_headers = headers_for_mpv.copy()
                merged_headers.update(item['headers'])
                item['headers'] = merged_headers

        if ytdl_raw_options_for_mpv:
            import file_io
            item['ytdl_raw_options'] = file_io.merge_ytdlp_options(item.get('ytdl_raw_options'), ytdl_raw_options_for_mpv)

        item['use_ytdl_mpv'] = use_ytdl_mpv_flag
        item['is_youtube'] = is_youtube_flag_from_script
        item['disable_http_persistent'] = disable_http_persistent_flag
        item['cookies_file'] = cookies_file
        item['cookies_browser'] = cookies_browser # Store browser name
        item['mark_watched'] = mark_watched_flag
        
        if cookies_file and session_cookies_ref is not None:
            if sync_lock:
                with sync_lock:
                    session_cookies_ref.add(cookies_file)
            else:
                session_cookies_ref.add(cookies_file)
                
        item['enriched'] = True
        return [item]

    def resolve_input_items(self, url_items_or_m3u, enriched_items_list, headers):
        """Resolves raw input (URL, Path, M3U content, or List) into a list of items."""
        if enriched_items_list is not None:
            if isinstance(url_items_or_m3u, str) and url_items_or_m3u.startswith('http://localhost'):
                logging.info(f"Local M3U server URL detected: {url_items_or_m3u}. Skipping M3U parsing.")
            return enriched_items_list, False

        # If we reach here, enriched_items_list is None, so we must resolve the raw input.
        if isinstance(url_items_or_m3u, list):
            return url_items_or_m3u, True
        if isinstance(url_items_or_m3u, dict):
            return [url_items_or_m3u], True
        
        if not isinstance(url_items_or_m3u, str):
            return [], False

        # String-based input (URL, Path, or raw M3U)
        url_items, input_was_raw = self._resolve_string_input(url_items_or_m3u, headers)
        return url_items, input_was_raw

    def _resolve_string_input(self, input_str, headers):
        """Helper to resolve string-based input into items."""
        # 1. YouTube Playlist Check
        is_yt_pl = "youtube.com/playlist" in input_str or ("youtube.com/watch" in input_str and "list=" in input_str)
        if is_yt_pl:
            logging.info(f"Expanding YouTube playlist: {input_str}")
            res = apply_bypass_script({'url': input_str}, self.send_message)
            entries = res[5] # entries index
            if entries:
                return entries, True
            return [{'url': input_str}], True

        # 2. File Path Check
        if os.path.exists(input_str):
            with open(input_str, 'r', encoding='utf-8') as f:
                return parse_m3u(f.read()), True

        # 3. URL Check
        if urlparse(input_str).scheme in ['http', 'https']:
            if not is_safe_url(input_str):
                logging.error(f"SSRF Protection: Blocked access to {input_str}")
                return None, False
            
            m3u_content = self._fetch_remote_m3u(input_str, headers)
            if m3u_content:
                return parse_m3u(m3u_content), True
            return [{'url': input_str}], True

        # 4. Raw M3U fallback
        return parse_m3u(input_str), True

    def _fetch_remote_m3u(self, url, headers):
        """Fetches M3U content from a remote URL."""
        try:
            fetch_headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'}
            if headers:
                fetch_headers.update(headers)
            req = Request(url, headers=fetch_headers)
            with urlopen(req, timeout=10) as response:
                return response.read().decode('utf-8')
        except Exception as e:
            logging.error(f"Failed to fetch remote M3U: {e}")
            return None

    def handle_standard_flow_launch(self, session, url_items, start_index, folder_id, settings, file_io):
        """Handles the background restoration of playlist order and sequential metadata enrichment."""
        def task():
            try:
                # Poll for readiness instead of hard sleep
                start_wait = time.time()
                while time.time() - start_wait < 10.0:
                    if not session.is_alive:
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
                        session.append_batch(enriched_future, mode="append", folder_id=folder_id)

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
                        logging.info(f"[PY][Session] Background: Appending and moving {len(enriched_history)} history items.")
                        # Append them to the end first
                        session.append_batch(enriched_history, mode="append", folder_id=folder_id)
                        
                        # Move them to the front (0, 1, 2...)
                        total_len = len(session.playlist)
                        history_count = len(enriched_history)
                        for i in range(history_count):
                            source_idx = (total_len - history_count) + i
                            session.ipc_manager.send({"command": ["playlist-move", source_idx, i]})
                            if session.playlist and source_idx < len(session.playlist):
                                item = session.playlist.pop(source_idx)
                                session.playlist.insert(i, item)

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

                logging.info("[PY][Session] Background: Batched restoration complete.")
            except Exception as e:
                logging.error(f"[PY][Session] Background task error: {e}", exc_info=True)

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
        
        # 1. Register all playlist items' options
        if self.session.playlist:
            for i, item in enumerate(self.session.playlist):
                lua_opts, item_url = services.construct_lua_options(
                    item, settings, self.session.SCRIPT_DIR, index=playlist_start_index + i
                )
                mgr.send({"command": ["script-message", "set_url_options", item_url, json.dumps(lua_opts), str(playlist_start_index + i)]})

        # 2. Set Hot-Swap Properties for the current item
        mgr.send({"command": ["set_property", "user-data/hot-swap-options", json.dumps(launch_lua_options)]})
        
        orig_url = url_item.get('original_url') or url_item.get('url', '')
        props = {
            "user-data/original-url": sanitize_url(orig_url),
            "user-data/id": url_item.get('id', ""),
            "user-data/folder-id": folder_id,
            "user-data/project-root": self.session.SCRIPT_DIR,
            "user-data/cookies-browser": url_item.get('cookies_browser', ""),
            "user-data/is-youtube": "yes" if url_item.get('is_youtube') else "no",
            "ytdl": "yes" if url_item.get('is_youtube') or url_item.get('use_ytdl_mpv') else "no"
        }
        for k, v in props.items():
            mgr.send({"command": ["set_property", k, v]})

        # 3. Atomic Load with Resume Priming
        if launch_lua_options.get('resume_time') and float(launch_lua_options['resume_time']) > 0:
            start_time = int(float(launch_lua_options['resume_time']))
            mgr.send({"command": ["script-message", "primed_resume_time", str(start_time)]})
        
        mgr.send({"command": ["loadfile", launch_url, "replace"]})

    def launch(self, url_item, folder_id, settings, file_io, **kwargs):
        logging.info(f"[PY][Session] Starting a new MPV instance for URL: {url_item.get('url')}")
        mpv_exe = self.session.get_mpv_executable()
        ipc_path = ipc_utils.get_ipc_path()
        playlist_start_index = kwargs.get('playlist_start_index', 0)

        # 1. Prepare Metadata & Launch URL
        is_youtube = kwargs.get('is_youtube') if kwargs.get('is_youtube') is not None else url_item.get('is_youtube', False)
        use_ytdl_mpv = kwargs.get('use_ytdl_mpv') if kwargs.get('use_ytdl_mpv') is not None else url_item.get('use_ytdl_mpv', False)
        launch_url = sanitize_url(url_item.get('url'))
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
            return {"success": False, "error": "Launch cancelled by user."}

        try:
            # 3. Construct Command
            full_command, has_terminal_flag = services.construct_mpv_command(
                mpv_exe=mpv_exe, ipc_path=ipc_path, url=None, is_youtube=is_youtube,
                ytdl_raw_options=kwargs.get('ytdl_raw_options') or url_item.get('ytdl_raw_options'),
                geometry=kwargs.get('geometry'), custom_width=kwargs.get('custom_width'),
                custom_height=kwargs.get('custom_height'), custom_mpv_flags=kwargs.get('custom_mpv_flags'),
                automatic_mpv_flags=kwargs.get('automatic_mpv_flags'),
                headers=kwargs.get('headers') or url_item.get('headers'),
                disable_http_persistent=kwargs.get('disable_http_persistent', False),
                start_paused=kwargs.get('start_paused', False), script_dir=self.session.SCRIPT_DIR,
                load_on_completion_script=True, title=url_item.get('title'),
                use_ytdl_mpv=use_ytdl_mpv, is_youtube_override=use_ytdl_mpv, idle="yes", 
                force_terminal=kwargs.get('force_terminal', False), settings=settings,
                flag_dir=self.session.FLAG_DIR, playlist_start_index=playlist_start_index,
                cookies_browser=kwargs.get('cookies_browser') or url_item.get('cookies_browser'),
                force_bypass=force_bypass
            )

            # 4. Spawn Process
            env = self._prepare_launch_env(has_terminal_flag)
            process = subprocess.Popen(full_command, env=env, **services.get_mpv_popen_kwargs(has_terminal_flag))
            self.session.process, self.session.ipc_path = process, ipc_path

            if process.stdout:
                threading.Thread(target=self.session.log_stream, args=(process.stdout, logging.warning, folder_id), daemon=True).start()

            # 5. Connect & Sync
            self.session.ipc_manager = ipc_utils.IPCSocketManager()
            if not self.session.ipc_manager.connect(self.session.ipc_path, timeout=5.0):
                raise RuntimeError(f"Failed to connect to MPV IPC at {self.session.ipc_path}")

            # Resolve actual PID (important for terminal wrappers)
            self.session.pid = process.pid
            pid_res = self.session.ipc_manager.send({"command": ["get_property", "pid"]}, timeout=5.0, expect_response=True)
            if pid_res and pid_res.get("error") == "success":
                self.session.pid = pid_res.get("data")

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
                "played_ids": stats.get("played_ids", []), "session_ids": stats.get("session_ids", [])
            })

        threading.Thread(target=process_waiter, args=(process, folder_id), daemon=True).start()

    def close(self):
        """Closes the current mpv session gracefully via IPC, then forcefully if needed."""
        with self.session.sync_lock:
            if not self.session.is_alive or not self.session.pid:
                return {"success": True, "message": "No active session to close."}

            logging.info(f"Closing MPV session for PID: {self.session.pid}")
            self.session.manual_quit = True
            
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
        if not self.session.is_alive or self.session.owner_folder_id != folder_id:
            return {"success": False, "message": "Session mismatch."}
        
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