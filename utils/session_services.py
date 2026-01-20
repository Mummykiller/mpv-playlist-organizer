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
            ytdl_format_from_script,
            cookies_browser
        ) = apply_bypass_script(url_dict_for_analysis, self.send_message, settings=settings)
        
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
                if cookies_browser: entry['cookies_browser'] = cookies_browser
                if cookies_file: entry['cookies_file'] = cookies_file

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
        _url_items_list = enriched_items_list if enriched_items_list is not None else []
        input_was_raw = False

        if isinstance(url_items_or_m3u, str):
            if url_items_or_m3u.startswith('http://localhost') and enriched_items_list is not None:
                 logging.info(f"Local M3U server URL detected: {url_items_or_m3u}. Skipping M3U parsing.")
            else:
                is_youtube_playlist = "youtube.com/playlist" in url_items_or_m3u or ("youtube.com/watch" in url_items_or_m3u and "list=" in url_items_or_m3u)
                
                if is_youtube_playlist:
                    logging.info(f"Expanding YouTube playlist: {url_items_or_m3u}")
                    # Unpack all 11 values to avoid ValueError
                    _, _, _, _, _, entries, _, _, _, _, _ = apply_bypass_script({'url': url_items_or_m3u}, self.send_message)
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
                        if not is_safe_url(url_items_or_m3u):
                            logging.error(f"SSRF Protection: Blocked access to {url_items_or_m3u}")
                            return None, False

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
            try:
                # Poll for readiness instead of hard sleep
                start_wait = time.time()
                while time.time() - start_wait < 10.0:
                    if not session.is_alive: return
                    if session.ipc_manager and session.ipc_manager.is_connected():
                        # Optional: Ping to ensure responsiveness
                        ping = session.ipc_manager.send({"command": ["get_property", "pid"]}, timeout=0.5, expect_response=True)
                        if ping:
                            break
                    time.sleep(0.2)
                
                if not session.is_alive: return
                
                history_items = url_items[:start_index]
                future_items = url_items[start_index + 1:]
                
                logging.info(f"[PY][Session] Background Flow: start_index={start_index}, history={len(history_items)}, future={len(future_items)}")
                
                # 1. Enrich and Batch Append Future Items
                if future_items:
                    logging.info(f"[PY][Session] Background: Enriching {len(future_items)} future items sequentially.")
                    enriched_future = []
                    for item in future_items:
                        if not session.is_alive: return
                        res = self.enrich_single_item(item, folder_id, session.session_cookies, session.sync_lock, settings=settings)
                        if res: enriched_future.extend(res)
                    
                    if enriched_future and session.is_alive:
                        logging.info(f"[PY][Session] Background: Appending batch of {len(enriched_future)} future items.")
                        session.append_batch(enriched_future, mode="append")

                # 2. Enrich and Batch Append History Items
                if history_items:
                    logging.info(f"[PY][Session] Background: Enriching {len(history_items)} history items sequentially.")
                    enriched_history = []
                    for item in history_items:
                        if not session.is_alive: return
                        res = self.enrich_single_item(item, folder_id, session.session_cookies, session.sync_lock, settings=settings)
                        if res: enriched_history.extend(res)
                    
                    if enriched_history and session.is_alive:
                        logging.info(f"[PY][Session] Background: Appending and moving {len(enriched_history)} history items.")
                        # Append them to the end first
                        session.append_batch(enriched_history, mode="append")
                        
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
                    essential_flags = services.get_essential_ytdlp_flags()
                    for idx, item in enumerate(session.playlist):
                        item_url = sanitize_url(item['url'])
                        if item.get('is_youtube') and item.get('original_url'):
                            item_url = sanitize_url(item['original_url'])
                        
                        raw_opts = item.get('ytdl_raw_options')
                        if item.get('cookies_browser'):
                             browser_opt = f"cookies-from-browser={item['cookies_browser']}"
                             raw_opts = f"{raw_opts},{browser_opt}" if raw_opts else browser_opt
                        final_item_raw_opts = file_io.merge_ytdlp_options(raw_opts, essential_flags)

                        # Helper to get mark_watched
                        def get_mark_watched(it):
                            val = it.get('mark_watched')
                            if val is None: val = it.get('settings', {}).get('yt_mark_watched', True)
                            return val.lower() in ("true", "yes", "1") if isinstance(val, str) else bool(val)

                        lua_options = {
                            "id": item.get('id'), "title": item.get('title'),
                            "headers": item.get('headers'), "ytdl_raw_options": final_item_raw_opts,
                            "use_ytdl_mpv": item.get('use_ytdl_mpv', False) or item.get('is_youtube', False),
                            "ytdl_format": item.get('ytdl_format'),
                            "ffmpeg_path": settings.get('ffmpeg_path'),
                            "original_url": sanitize_url(item.get('original_url') or item.get('url')),
                            "cookies_browser": item.get('cookies_browser'),
                            "resume_time": item.get('resume_time'),
                            "project_root": session.SCRIPT_DIR,
                            "mark_watched": get_mark_watched(item),
                            "marked_as_watched": item.get('marked_as_watched', False),
                            "targeted_defaults": settings.get('targeted_defaults', 'none')
                        }
                        session.ipc_manager.send({"command": ["script-message", "set_url_options", item_url, json.dumps(lua_options), str(idx)]})

                logging.info("[PY][Session] Background: Batched restoration complete.")
            except Exception as e:
                logging.error(f"[PY][Session] Background task error: {e}", exc_info=True)
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
                                    except:
                                        exit_reason = "completed"
                                    logging.info(f"Restored Watcher: Natural completion flag FOUND (Reason: {exit_reason}). Overriding return code to 99.")
                                    return_code = 99
                                try: os.remove(flag_file)
                                except: pass
                                break

                    self.session.send_message({"action": "mpv_exited", "folderId": folder_id, "returnCode": return_code, "reason": exit_reason})
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
        is_youtube = kwargs.get('is_youtube') if kwargs.get('is_youtube') is not None else url_item.get('is_youtube', False)
        use_ytdl_mpv = kwargs.get('use_ytdl_mpv') if kwargs.get('use_ytdl_mpv') is not None else url_item.get('use_ytdl_mpv', False)
        ytdl_raw_options = kwargs.get('ytdl_raw_options') or url_item.get('ytdl_raw_options')
        headers = kwargs.get('headers') or url_item.get('headers')
        disable_http_persistent = kwargs.get('disable_http_persistent') if kwargs.get('disable_http_persistent') is not None else url_item.get('disable_http_persistent', False)
        cookies_browser = kwargs.get('cookies_browser') or url_item.get('cookies_browser')

        launch_url = sanitize_url(url_item.get('url'))
        
        # --- Solid ID Injection ---
        if url_item.get('id'):
            separator = "#" if "#" not in launch_url else "&"
            launch_url = f"{launch_url}{separator}mpv_organizer_id={url_item['id']}"

        # --- DETERMINISTIC BYPASS HINT ---
        # We check if the process should start in 'Nuclear Bypass' mode based on the first item
        force_bypass = False
        targeted = settings.get('targeted_defaults', 'none')
        if targeted == 'animepahe' and launch_url:
            if "kwik.cx" in launch_url or "owocdn.top" in launch_url or "uwucdn.top" in launch_url:
                force_bypass = True
        elif targeted == 'all-none-yt' and not is_youtube:
            force_bypass = True

        try:
            # IDLE LAUNCH: Start MPV empty, then load file via IPC. 
            # This ensures IPC options (headers) are registered before the file starts loading.
            full_command, has_terminal_flag = services.construct_mpv_command(
                mpv_exe=mpv_exe,
                ipc_path=ipc_path,
                url=None, # Start idle
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
                playlist_start_index=playlist_start_index,
                cookies_browser=cookies_browser,
                force_bypass=force_bypass
            )

            # Add precise resume if needed for initial launch
            # (Resume logic moved to IPC loadfile command below)

            popen_kwargs = services.get_mpv_popen_kwargs(has_terminal_flag)
            
            # Environment Scrubbing (Zero-Trust)
            if not has_terminal_flag:
                base_env = os.environ
                env = {}
                
                # Platform-specific whitelist
                if platform.system() == "Windows":
                    ALLOWED_KEYS = {
                        'ALLUSERSPROFILE', 'APPDATA', 'COMPUTERNAME', 'ComSpec', 'CommonProgramFiles',
                        'CommonProgramFiles(x86)', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'LOGONSERVER',
                        'NUMBER_OF_PROCESSORS', 'OS', 'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE',
                        'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'ProgramData',
                        'ProgramFiles', 'ProgramFiles(x86)', 'Public', 'SystemDrive', 'SystemRoot',
                        'TEMP', 'TMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'windir'
                    }
                else:
                    ALLOWED_KEYS = {
                        'HOME', 'LANG', 'LC_ALL', 'LOGNAME', 'PATH', 'PWD', 'SHELL', 'TERM', 'USER',
                        'DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
                        'XDG_CACHE_HOME', 'DBUS_SESSION_BUS_ADDRESS',
                        'WAYLAND_DISPLAY', 'XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP',
                        'MPV_HOME', 'PULSE_SERVER', 'PIPEWIRE_RUNTIME_DIR'
                    }
                
                for key, val in base_env.items():
                    # Allow specific keys and safe prefixes (like LC_ for locale)
                    if key in ALLOWED_KEYS or key.startswith("LC_") or (platform.system() != "Windows" and key.startswith("XDG_")):
                        env[key] = val
            else:
                # Terminal emulators (Konsole, GNOME Terminal) require full environment (Qt/GTK libs)
                env = os.environ.copy()

            process = subprocess.Popen(full_command, env=env, **popen_kwargs)
            self.session.process = process
            self.session.ipc_path = ipc_path

            if process.stdout:
                stderr_thread = threading.Thread(target=self.session.log_stream, args=(process.stdout, logging.warning, folder_id))
                stderr_thread.daemon = True
                stderr_thread.start()

            self.session.ipc_manager = ipc_utils.IPCSocketManager()
            if not self.session.ipc_manager.connect(self.session.ipc_path, timeout=5.0):
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
                for i, item in enumerate(self.session.playlist):
                    item_url = sanitize_url(item['url'])
                    if item.get('is_youtube') and item.get('original_url'):
                        item_url = sanitize_url(item['original_url'])
                    
                    # --- Centralized Flag Collection for Launch ---
                    essential_flags = services.get_essential_ytdlp_flags()
                    raw_opts = item.get('ytdl_raw_options')
                    if item.get('cookies_browser'):
                         browser_opt = f"cookies-from-browser={item['cookies_browser']}"
                         raw_opts = f"{raw_opts},{browser_opt}" if raw_opts else browser_opt
                    final_item_raw_opts = file_io.merge_ytdlp_options(raw_opts, essential_flags)

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
                        "cookies_browser": item.get('cookies_browser'),
                        "disable_network_overrides": settings.get('disable_network_overrides', False),
                        "http_persistence": settings.get('http_persistence', 'auto'),
                        "enable_reconnect": settings.get('enable_reconnect', True),
                        "reconnect_delay": settings.get('reconnect_delay', 4),
                        "demuxer_max_bytes": settings.get('demuxer_max_bytes'),
                        "demuxer_max_back_bytes": settings.get('demuxer_max_back_bytes'),
                        "cache_secs": settings.get('cache_secs'),
                        "demuxer_readahead_secs": settings.get('demuxer_readahead_secs'),
                        "stream_buffer_size": settings.get('stream_buffer_size'),
                        "enable_cache": settings.get('enable_cache', True),
                        "resume_time": item.get('resume_time') if settings.get('enable_precise_resume') else None,
                        "project_root": self.session.SCRIPT_DIR,
                        "mark_watched": item.get('mark_watched', False),
                        "marked_as_watched": item.get('marked_as_watched', False),
                        "targeted_defaults": settings.get('targeted_defaults', 'none')
                    }
                    self.session.ipc_manager.send({"command": ["script-message", "set_url_options", item_url, json.dumps(lua_options), str(playlist_start_index + i)]})

            # --- PRE-LOAD PROPERTY SYNC (Eliminates race conditions) ---
            # We only set hot-swap-options for the SPECIFIC item we are about to load.
            # This ensures adaptive_headers.lua has the correct context immediately.
            essential_flags = services.get_essential_ytdlp_flags()
            raw_opts = url_item.get('ytdl_raw_options')
            if url_item.get('cookies_browser'):
                 browser_opt = f"cookies-from-browser={url_item['cookies_browser']}"
                 raw_opts = f"{raw_opts},{browser_opt}" if raw_opts else browser_opt
            final_launch_raw_opts = file_io.merge_ytdlp_options(raw_opts, essential_flags)
            
            # Helper to get mark_watched with proper fallbacks and normalization
            def get_mark_watched(it):
                val = it.get('mark_watched')
                if val is None:
                    val = it.get('settings', {}).get('yt_mark_watched', True)
                if isinstance(val, str):
                    return val.lower() in ("true", "yes", "1")
                return bool(val)

            launch_lua_options = {
                "id": url_item.get('id'),
                "title": url_item.get('title'),
                "headers": url_item.get('headers'),
                "ytdl_raw_options": final_launch_raw_opts,
                "use_ytdl_mpv": url_item.get('use_ytdl_mpv', False) or url_item.get('is_youtube', False),
                "ytdl_format": url_item.get('ytdl_format'),
                "ffmpeg_path": settings.get('ffmpeg_path'),
                "original_url": sanitize_url(url_item.get('original_url') or url_item.get('url')),
                "disable_http_persistent": url_item.get('disable_http_persistent', False) or kwargs.get('disable_http_persistent', False),
                "cookies_file": url_item.get('cookies_file'),
                "cookies_browser": url_item.get('cookies_browser'),
                "disable_network_overrides": settings.get('disable_network_overrides', False),
                "http_persistence": settings.get('http_persistence', 'auto'),
                "enable_reconnect": settings.get('enable_reconnect', True),
                "reconnect_delay": settings.get('reconnect_delay', 4),
                "demuxer_max_bytes": settings.get('demuxer_max_bytes'),
                "demuxer_max_back_bytes": settings.get('demuxer_max_back_bytes'),
                "cache_secs": settings.get('cache_secs'),
                "demuxer_readahead_secs": settings.get('demuxer_readahead_secs'),
                "stream_buffer_size": settings.get('stream_buffer_size'),
                "enable_cache": settings.get('enable_cache', True),
                "resume_time": url_item.get('resume_time') if settings.get('enable_precise_resume') else None,
                "project_root": self.session.SCRIPT_DIR,
                "mark_watched": get_mark_watched(url_item),
                "marked_as_watched": url_item.get('marked_as_watched', False),
                "targeted_defaults": settings.get('targeted_defaults', 'none')
            }
            self.session.ipc_manager.send({"command": ["set_property", "user-data/hot-swap-options", json.dumps(launch_lua_options)]})

            orig_url = url_item.get('original_url') or url_item.get('url', '')
            self.session.ipc_manager.send({"command": ["set_property", "user-data/original-url", sanitize_url(orig_url)]})
            self.session.ipc_manager.send({"command": ["set_property", "user-data/id", url_item.get('id', "")]})
            self.session.ipc_manager.send({"command": ["set_property", "user-data/folder-id", folder_id]})
            self.session.ipc_manager.send({"command": ["set_property", "user-data/project-root", self.session.SCRIPT_DIR]})
            self.session.ipc_manager.send({"command": ["set_property", "user-data/cookies-browser", url_item.get('cookies_browser', "")]})
            self.session.ipc_manager.send({"command": ["set_property", "user-data/is-youtube", "yes" if url_item.get('is_youtube') else "no"]})

            # Explicitly force ytdl state for initial file
            ytdl_val = "yes" if url_item.get('is_youtube') or url_item.get('use_ytdl_mpv') else "no"
            self.session.ipc_manager.send({"command": ["set_property", "ytdl", ytdl_val]})

            # --- Trigger Atomic Load via Script Message Priming ---
            if launch_lua_options.get('resume_time') and float(launch_lua_options['resume_time']) > 0:
                start_time = int(float(launch_lua_options['resume_time']))
                # Send a scripted message that Lua will catch during the on_load hook
                self.session.ipc_manager.send({"command": ["script-message", "primed_resume_time", str(start_time)]})
                self.session.ipc_manager.send({"command": ["loadfile", launch_url, "replace"]})
            else:
                self.session.ipc_manager.send({"command": ["loadfile", launch_url, "replace"]})

            from playlist_tracker import PlaylistTracker
            self.session.playlist_tracker = PlaylistTracker(folder_id, self.session.playlist, file_io, settings, self.session.ipc_path, self.session.send_message)
            self.session.playlist_tracker.start_tracking()

            def process_waiter(proc, f_id):
                initial_pid = proc.pid
                # Retrieve the resolved MPV PID which might be different if a terminal wrapper is used.
                actual_pid = getattr(self.session, 'pid', None)
                
                # If we have a separate MPV process (likely via terminal wrapper),
                # we monitor both to avoid delays caused by shell 'sleep' or wrapper persistence.
                if actual_pid and actual_pid != initial_pid:
                    logging.info(f"[PY][Session] process_waiter: Parallel monitoring for Wrapper({initial_pid}) and MPV({actual_pid})")
                    while proc.poll() is None:
                        if not ipc_utils.is_pid_running(actual_pid):
                            logging.info(f"[PY][Session] MPV({actual_pid}) exited early while wrapper is still running. Proceeding with exit logic.")
                            break
                        time.sleep(0.1)
                
                # Determine the return code. If the wrapper is still running but MPV is dead,
                # we use a placeholder that will be overridden by the completion flag check if applicable.
                return_code = proc.poll()
                if return_code is None:
                    # proc is still running, so we've broken out because MPV is dead.
                    # We'll use 0 as a placeholder; the flag check below will set it to 99 if natural completion.
                    return_code = 0
                    # Ensure the wrapper process is eventually reaped in the background.
                    threading.Thread(target=proc.wait, daemon=True).start()
                else:
                    # proc finished naturally
                    pass
                
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

                stats = self.session.clear(mpv_return_code=return_code)
                self.session.send_message({
                    "action": "mpv_exited", 
                    "folderId": f_id, 
                    "returnCode": return_code, 
                    "reason": exit_reason,
                    "played_ids": stats.get("played_ids", []),
                    "session_ids": stats.get("session_ids", [])
                })

            threading.Thread(target=process_waiter, args=(process, folder_id), daemon=True).start()
            
            resume_msg = f" at {int(float(launch_lua_options['resume_time']))}s" if launch_lua_options.get('resume_time') else ""
            return {"success": True, "message": f"MPV playback initiated{resume_msg}."}
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
                self.session.ipc_manager.connect(self.session.ipc_path, timeout=0.5)

        # 2. Try graceful exit via IPC
        if self.session.ipc_manager and self.session.ipc_manager.is_connected():
            try:
                self.session.ipc_manager.send({"command": ["quit"]}, timeout=0.5)
                time.sleep(0.1) # Give it a moment to react
            except Exception as e:
                logging.warning(f"Failed to send quit command via IPC: {e}")

        # 3. Wait for process to exit
        if self.session.process:
            try:
                self.session.process.wait(timeout=1.0)
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
        
        # --- REFRESH LUA INDICES ---
        if self.session.ipc_manager and self.session.ipc_manager.is_connected():
            import file_io
            settings = file_io.get_settings()
            essential_flags = services.get_essential_ytdlp_flags()
            
            for idx, item in enumerate(simulated_playlist):
                item_url = sanitize_url(item['url'])
                if item.get('is_youtube') and item.get('original_url'):
                    item_url = sanitize_url(item['original_url'])
                
                raw_opts = item.get('ytdl_raw_options')
                if item.get('cookies_browser'):
                     browser_opt = f"cookies-from-browser={item['cookies_browser']}"
                     raw_opts = f"{raw_opts},{browser_opt}" if raw_opts else browser_opt
                final_item_raw_opts = file_io.merge_ytdlp_options(raw_opts, essential_flags)

                lua_options = {
                    "id": item.get('id'), "title": item.get('title'),
                    "headers": item.get('headers'), "ytdl_raw_options": final_item_raw_opts,
                    "use_ytdl_mpv": item.get('use_ytdl_mpv', False),
                    "original_url": sanitize_url(item.get('original_url') or item.get('url')),
                    "cookies_browser": item.get('cookies_browser'),
                    "resume_time": item.get('resume_time'),
                    "demuxer_max_bytes": settings.get('demuxer_max_bytes'),
                    "cache_secs": settings.get('cache_secs'),
                    "project_root": self.session.SCRIPT_DIR,
                    "targeted_defaults": settings.get('targeted_defaults', 'none')
                }
                self.session.ipc_manager.send({"command": ["script-message", "set_url_options", item_url, json.dumps(lua_options), str(idx)]})

        if self.session.playlist_tracker:
            self.session.playlist_tracker.update_playlist_order(simulated_playlist)
        self.session.ipc_manager.send({"command": ["show-text", "Playlist reordered", 2000]})
        return {"success": True, "message": "Live playlist reordered."}
