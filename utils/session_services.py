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
import services

def sanitize_url(url):
    import file_io
    return file_io.sanitize_string(url, is_filename=False)

class EnrichmentService:
    def __init__(self, send_message_func):
        self.send_message = send_message_func

    def enrich_single_item(self, item, folder_id=None, session_cookies_ref=None, sync_lock=None, settings=None):
        if item.get('enriched'):
            return [item]

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
            ytdl_format_from_script
        ) = apply_bypass_script(url_dict_for_analysis, self.send_message, settings=settings)
        
        if entries:
            processed_entries = []
            for entry in entries:
                if not entry.get('id'):
                    entry['id'] = str(uuid.uuid4())
                entry['is_youtube'] = True
                if 'use_ytdl_mpv' not in entry:
                    entry['use_ytdl_mpv'] = False 
                processed_entries.append(entry)
            return processed_entries

        item['url'] = processed_url
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
        _url_items_list = enriched_items_list if enriched_items_list is not None else []
        input_was_raw = False

        if isinstance(url_items_or_m3u, str):
            if url_items_or_m3u.startswith('http://localhost') and enriched_items_list is not None:
                 logging.info(f"Local M3U server URL detected: {url_items_or_m3u}. Skipping M3U parsing.")
            else:
                is_youtube_playlist = "youtube.com/playlist" in url_items_or_m3u or ("youtube.com/watch" in url_items_or_m3u and "list=" in url_items_or_m3u)
                
                if is_youtube_playlist:
                    logging.info(f"Expanding YouTube playlist: {url_items_or_m3u}")
                    # Unpack all 10 values to avoid ValueError
                    _, _, _, _, _, entries, _, _, _, _ = apply_bypass_script({'url': url_items_or_m3u}, self.send_message)
                    if entries:
                        _url_items_list = entries
                        input_was_raw = True
                    else:
                        _url_items_list = [{'url': url_items_or_m3u}]
                        input_was_raw = True

                if not _url_items_list:
                    if os.path.exists(url_items_or_m3u):
                        input_was_raw = True
                        with open(url_items_or_m3u, 'r', encoding='utf-8') as f:
                            m3u_content = f.read()
                    elif urlparse(url_items_or_m3u).scheme in ['http', 'https']:
                        try:
                            fetch_headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'}
                            if headers: fetch_headers.update(headers)
                            req = Request(url_items_or_m3u, headers=fetch_headers)
                            with urlopen(req, timeout=10) as response:
                                m3u_content = response.read().decode('utf-8')
                            input_was_raw = True
                        except Exception as e:
                            logging.error(f"Failed to fetch M3U: {e}")
                            return None, False
                    else:
                        input_was_raw = True
                        m3u_content = url_items_or_m3u

                if m3u_content:
                    _url_items_list = parse_m3u(m3u_content)

        elif isinstance(url_items_or_m3u, list):
            _url_items_list = url_items_or_m3u
            if enriched_items_list is None: input_was_raw = True
        elif isinstance(url_items_or_m3u, dict):
            _url_items_list = [url_items_or_m3u]
            if enriched_items_list is None: input_was_raw = True

        return _url_items_list, input_was_raw

    def handle_standard_flow_launch(self, session, url_items, start_index, folder_id, settings, file_io):
        """Handles the background restoration of playlist order and sequential metadata enrichment."""
        def task():
            time.sleep(2.0)
            if not session.is_alive: return
            
            history_items = url_items[:start_index]
            future_items = url_items[start_index + 1:]
            
            # 1. Restore Order
            if future_items:
                session.append_batch(future_items, mode="append")
                time.sleep(0.5)

            if history_items:
                session.append_batch(history_items, mode="append")
                time.sleep(0.5)
                
                total_len = len(url_items)
                history_count = len(history_items)
                for i in range(history_count):
                    source_idx = (total_len - history_count) + i
                    session.ipc_manager.send({"command": ["playlist-move", source_idx, i]})
                    if session.playlist and source_idx < len(session.playlist):
                        item = session.playlist.pop(source_idx)
                        session.playlist.insert(i, item)

            if session.playlist_tracker:
                session.playlist_tracker.update_playlist_order(session.playlist)
            
            # 2. Sequential Enrichment
            for idx, item in enumerate(url_items):
                if idx == start_index or not session.is_alive: continue
                
                enriched = self.enrich_single_item(item, folder_id, session.session_cookies, session.sync_lock, settings=settings)[0]
                target_url = sanitize_url(enriched['url'])
                if enriched.get('is_youtube') and enriched.get('original_url'):
                    target_url = sanitize_url(enriched['original_url'])

                # --- Centralized Flag Collection for Background Enrichment ---
                local_essential_flags = "ignore-config="
                if settings and settings.get('ffmpeg_path'):
                    local_essential_flags = f"{local_essential_flags},ffmpeg-location={settings['ffmpeg_path']}"
                
                final_item_raw_opts = file_io.merge_ytdlp_options(enriched.get('ytdl_raw_options'), local_essential_flags)

                lua_options = {
                    "id": enriched.get('id'), "title": enriched.get('title'),
                    "headers": enriched.get('headers'),
                    "ytdl_raw_options": final_item_raw_opts,
                    "use_ytdl_mpv": enriched.get('use_ytdl_mpv', False),
                    "ytdl_format": enriched.get('ytdl_format'),
                    "ffmpeg_path": settings.get('ffmpeg_path'),
                    "original_url": sanitize_url(enriched.get('original_url') or enriched.get('url')),
                    "disable_http_persistent": enriched.get('disable_http_persistent', False),
                    "cookies_file": enriched.get('cookies_file'),
                    "disable_network_overrides": settings.get('disable_network_overrides', False),
                    "http_persistence": settings.get('http_persistence', 'auto'),
                    "enable_reconnect": settings.get('enable_reconnect', True),
                    "reconnect_delay": settings.get('reconnect_delay', 4)
                }
                session.ipc_manager.send({"command": ["script-message", "set_url_options", target_url, json.dumps(lua_options)]})
                session.ipc_manager.send({"command": ["set_property", f"playlist/{idx}/url", target_url]})
                if idx < len(session.playlist): session.playlist[idx] = enriched
                
                time.sleep(0.05)

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
                    if ipc_path:
                        ipc_dir = os.path.dirname(ipc_path)
                        flag_file = os.path.join(ipc_dir, f'mpv_natural_completion_{pid}.flag')
                        if os.path.exists(flag_file):
                            if getattr(self.session, 'manual_quit', False):
                                logging.info(f"Restored Watcher: Natural completion flag found, but manual_quit is TRUE. Ignoring flag.")
                            else:
                                logging.info(f"Restored Watcher: Natural completion flag FOUND. Overriding return code to 99.")
                                return_code = 99
                            try: os.remove(flag_file)
                            except Exception as e: logging.warning(f"Restored Watcher: Failed to remove flag file: {e}")

                    self.session.send_message({"action": "mpv_exited", "folderId": folder_id, "returnCode": return_code})
                    self.session.clear(mpv_return_code=return_code)
                    break
                
                if not self.session.is_alive or self.session.pid != pid:
                    logging.info(f"Restored Process Watcher: Session state changed. Stopping watcher for PID {pid}.")
                    break

        threading.Thread(target=watcher, daemon=True).start()

    def launch(self, url_item, folder_id, settings, file_io, **kwargs):
        logging.info(f"[PY][Session] Starting a new MPV instance for URL: {url_item.get('url')}")
        mpv_exe = self.session.get_mpv_executable()
        ipc_path = ipc_utils.get_ipc_path()

        force_terminal = kwargs.get('force_terminal', False)
        playlist_start_index = kwargs.get('playlist_start_index', 0)

        # Prioritize item-specific flags if they were enriched just before this call
        is_youtube = kwargs.get('is_youtube', url_item.get('is_youtube', False))
        use_ytdl_mpv = kwargs.get('use_ytdl_mpv', url_item.get('use_ytdl_mpv', False))
        ytdl_raw_options = kwargs.get('ytdl_raw_options', url_item.get('ytdl_raw_options'))
        headers = kwargs.get('headers', url_item.get('headers'))
        disable_http_persistent = kwargs.get('disable_http_persistent', url_item.get('disable_http_persistent', False))

        launch_url = sanitize_url(url_item.get('url'))

        try:
            full_command, has_terminal_flag = services.construct_mpv_command(
                mpv_exe=mpv_exe,
                ipc_path=ipc_path,
                url=launch_url, # Pass URL directly along with options
                is_youtube=is_youtube,
                ytdl_raw_options=ytdl_raw_options,
                geometry=kwargs.get('geometry'),
                custom_width=kwargs.get('custom_width'),
                custom_height=kwargs.get('custom_height'),
                custom_mpv_flags=kwargs.get('custom_mpv_flags'),
                automatic_mpv_flags=kwargs.get('automatic_mpv_flags'),
                headers=headers,
                disable_http_persistent=disable_http_persistent,
                start_paused=kwargs.get('start_paused', False),
                script_dir=self.session.SCRIPT_DIR,
                load_on_completion_script=True,
                title=url_item.get('title'),
                use_ytdl_mpv=use_ytdl_mpv,
                is_youtube_override=use_ytdl_mpv,
                idle="yes", 
                force_terminal=force_terminal,
                input_terminal="no" if not force_terminal else "yes",
                settings=settings,
                flag_dir=self.session.FLAG_DIR,
                playlist_start_index=playlist_start_index
            )

            # Add precise resume if needed for initial launch
            if settings.get('enable_precise_resume') and url_item.get('resume_time'):
                resume_time = url_item.get('resume_time')
                if resume_time > 0:
                    full_command.insert(1, f"--start={resume_time}")

            popen_kwargs = services.get_mpv_popen_kwargs(has_terminal_flag)
            env = os.environ.copy()
            
            # Security/Compatibility: browser-injected libs can break MPV.
            # However, we MUST NOT strip these if we are launching a terminal emulator (like Konsole)
            # because it needs its own Qt environment to start.
            if not has_terminal_flag:
                for key in ['LD_LIBRARY_PATH', 'QT_PLUGIN_PATH', 'QT_QPA_PLATFORM_PLUGIN_PATH']:
                    env.pop(key, None)

            process = subprocess.Popen(full_command, env=env, **popen_kwargs)
            self.session.process = process
            self.session.ipc_path = ipc_path

            if process.stdout:
                stderr_thread = threading.Thread(target=self.session.log_stream, args=(process.stdout, logging.warning, folder_id))
                stderr_thread.daemon = True
                stderr_thread.start()

            self.session.ipc_manager = ipc_utils.IPCSocketManager()
            if not self.session.ipc_manager.connect(self.session.ipc_path, timeout=15.0):
                raise RuntimeError(f"Failed to connect to MPV IPC at {self.session.ipc_path}")

            # --- PID Resolution & Persistence ---
            # IMPORTANT: We must get the REAL mpv PID from the IPC server because
            # if a terminal wrapper was used, process.pid is the terminal emulator's PID.
            self.session.pid = process.pid # Fallback to process PID
            try:
                pid_response = self.session.ipc_manager.send({"command": ["get_property", "pid"]}, timeout=5.0, expect_response=True)
                if pid_response and pid_response.get("error") == "success":
                    actual_mpv_pid = pid_response.get("data")
                    if actual_mpv_pid:
                        self.session.pid = actual_mpv_pid
                        logging.info(f"[PY][Session] Resolved actual MPV PID: {self.session.pid} (Process PID: {process.pid})")
            except Exception as e:
                logging.debug(f"[PY][Session] Failed to resolve actual MPV PID via IPC (using process PID): {e}")

            self.session.owner_folder_id = folder_id
            self.session.is_alive = True
            self.session.persist_session()

            self.session.playlist = kwargs.get('full_playlist') if kwargs.get('full_playlist') is not None else [url_item]
            
            if self.session.playlist:
                for item in self.session.playlist:
                    item_url = sanitize_url(item['url'])
                    
                    # --- Centralized Flag Collection for Launch ---
                    local_essential_flags = "ignore-config="
                    if settings and settings.get('ffmpeg_path'):
                        local_essential_flags = f"{local_essential_flags},ffmpeg-location={settings['ffmpeg_path']}"
                    
                    final_item_raw_opts = file_io.merge_ytdlp_options(item.get('ytdl_raw_options'), local_essential_flags)

                    lua_options = {
                        "id": item.get('id'),
                        "title": item.get('title'),
                        "headers": item.get('headers'),
                        "ytdl_raw_options": final_item_raw_opts,
                        "use_ytdl_mpv": item.get('use_ytdl_mpv', False) or item.get('is_youtube', False),
                        "ytdl_format": item.get('ytdl_format'),
                        "ffmpeg_path": settings.get('ffmpeg_path'),
                        "original_url": sanitize_url(item.get('original_url') or item.get('url')),
                        "disable_http_persistent": item.get('disable_http_persistent', False) or kwargs.get('disable_http_persistent', False),
                        "cookies_file": item.get('cookies_file'),
                        "disable_network_overrides": settings.get('disable_network_overrides', False),
                        "http_persistence": settings.get('http_persistence', 'auto'),
                        "enable_reconnect": settings.get('enable_reconnect', True),
                        "reconnect_delay": settings.get('reconnect_delay', 4)
                    }
                    self.session.ipc_manager.send({"command": ["script-message", "set_url_options", item_url, json.dumps(lua_options)]})

            self.session.ipc_manager.send({"command": ["set_property", "user-data/original-url", url_item.get('original_url', launch_url)]})

            from playlist_tracker import PlaylistTracker
            self.session.playlist_tracker = PlaylistTracker(folder_id, self.session.playlist, file_io, settings, self.session.ipc_path, self.session.send_message)
            self.session.playlist_tracker.start_tracking()

            def process_waiter(proc, f_id):
                initial_pid = proc.pid
                return_code = proc.wait()
                exit_reason = None
                
                # Check for completion flags. We check multiple PIDs because if a terminal wrapper
                # was used, the actual MPV PID might be different from the process PID.
                actual_pid = getattr(self.session, 'pid', None)
                pids_to_check = list(set(filter(None, [initial_pid, actual_pid])))
                
                logging.debug(f"[PY][Session] Process {initial_pid} exited. Return code: {return_code}. Checking flags for PIDs: {pids_to_check}")

                # --- Handle Terminal Wrapper Exit ---
                # If the wrapper exited but the actual MPV PID is still running,
                # we don't clear the session yet. Instead, we hand off to the orphaned watcher.
                if actual_pid and actual_pid != initial_pid:
                    if ipc_utils.is_pid_running(actual_pid):
                        logging.info(f"[PY][Session] Terminal wrapper (PID {initial_pid}) exited, but MPV (PID {actual_pid}) is still alive. Handing off to restored process watcher.")
                        self.start_restored_process_watcher(actual_pid, self.session.ipc_path, f_id)
                        return

                flag_found = False
                for pid in pids_to_check:
                    flag_candidates = [
                        os.path.join(self.session.FLAG_DIR, f'mpv_natural_completion_{pid}.flag'),
                        os.path.join("/tmp", f'mpv_natural_completion_{pid}.flag') # Fallback location used by Lua
                    ]
                    if self.session.ipc_path:
                        flag_candidates.append(os.path.join(os.path.dirname(self.session.ipc_path), f'mpv_natural_completion_{pid}.flag'))

                    for flag_file in flag_candidates:
                        if os.path.exists(flag_file):
                            if getattr(self.session, 'manual_quit', False):
                                logging.info(f"[PY][Session] Natural completion flag found for PID {pid}, but manual_quit is TRUE. Ignoring flag.")
                            else:
                                try:
                                    with open(flag_file, 'r', encoding='utf-8') as f:
                                        exit_reason = f.read().strip()
                                except:
                                    exit_reason = "completed"
                                logging.info(f"[PY][Session] Natural completion detected for PID {pid} (Reason: {exit_reason}). Overriding return code to 99.")
                                return_code = 99
                            
                            try: os.remove(flag_file)
                            except: pass
                            flag_found = True
                            break
                    if flag_found: break

                self.session.send_message({"action": "mpv_exited", "folderId": f_id, "returnCode": return_code, "reason": exit_reason})
                self.session.clear(mpv_return_code=return_code)

            threading.Thread(target=process_waiter, args=(process, folder_id), daemon=True).start()
            return {"success": True, "message": "MPV playback initiated."}
        except Exception as e:
            logging.error(f"Launcher Error: {e}")
            return {"success": False, "error": f"Error launching mpv: {e}"}

    def close(self):
        """Closes the current mpv session gracefully via IPC, then forcefully if needed."""
        if not self.session.is_alive or not self.session.pid:
            return {"success": True, "message": "No active session to close."}

        logging.info(f"Closing MPV session for PID: {self.session.pid}")
        self.session.manual_quit = True

        # 1. Try to reconnect if needed to ensure graceful quit
        if self.session.ipc_path:
            if not self.session.ipc_manager:
                self.session.ipc_manager = ipc_utils.IPCSocketManager()
            
            if not self.session.ipc_manager.is_connected():
                logging.info(f"IPC not connected. Attempting reconnection to {self.session.ipc_path} for graceful quit...")
                # Use a short timeout as we'll fall back to signals anyway
                self.session.ipc_manager.connect(self.session.ipc_path, timeout=2.0)

        # 2. Try graceful exit via IPC
        if self.session.ipc_manager and self.session.ipc_manager.is_connected():
            try:
                self.session.ipc_manager.send({"command": ["quit"]}, timeout=1.0)
                time.sleep(0.2) # Give it a moment to react
            except Exception as e:
                logging.warning(f"Failed to send quit command via IPC: {e}")

        # 3. Wait for process to exit
        if self.session.process:
            try:
                self.session.process.wait(timeout=2.0)
            except subprocess.TimeoutExpired:
                logging.warning(f"MPV process {self.session.pid} did not exit gracefully. Terminating.")
                self.session.process.terminate()
                try:
                    self.session.process.wait(timeout=1.0)
                except subprocess.TimeoutExpired:
                    logging.warning(f"MPV process {self.session.pid} did not terminate. Killing.")
                    self.session.process.kill()
        elif self.session.pid:
            # Fallback if we only have the PID (e.g. after restore)
            try:
                if platform.system() == "Windows":
                    # Simple taskkill fallback for Windows if process object is missing
                    subprocess.run(["taskkill", "/F", "/T", "/PID", str(self.session.pid)], 
                                 capture_output=True, check=False)
                else:
                    os.kill(self.session.pid, signal.SIGTERM)
                    time.sleep(0.5)
                    if ipc_utils.is_pid_running(self.session.pid):
                        os.kill(self.session.pid, signal.SIGKILL)
            except OSError:
                pass # Process already gone

        self.session.clear()
        return {"success": True, "message": "MPV session closed."}

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
        if self.session.playlist_tracker:
            self.session.playlist_tracker.update_playlist_order(simulated_playlist)
        self.session.ipc_manager.send({"command": ["show-text", "Playlist reordered", 2000]})
        return {"success": True, "message": "Live playlist reordered."}
