import json
import logging
import os
import sys

# Prevent __pycache__ generation
sys.dont_write_bytecode = True
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'

import platform
import subprocess
import threading
import time
import signal
import tempfile
import uuid # Added uuid import
from urllib.parse import urlparse # Import for URL parsing
from urllib.request import urlopen, Request # Import for fetching URLs
from utils import ipc_utils
import services
from services import apply_bypass_script
from playlist_tracker import PlaylistTracker # Added this import
from utils.m3u_parser import parse_m3u # Import the new M3U parser

# Constants for file patterns
DELTA_PREFIX = "delta_"
DELTA_EXT = ".m3u"
NATURAL_COMPLETION_FLAG = "mpv_natural_completion_"


def sanitize_url(url):
    """Sanitizes a URL by removing potentially dangerous characters for shell commands."""
    import file_io
    return file_io.sanitize_string(url, is_filename=False)


class MpvSessionManager:
    def __init__(self, session_file_path, dependencies):
        self.process = None
        self.ipc_path = None
        self.playlist = None
        self.pid = None
        self.owner_folder_id = None
        self.session_file = session_file_path
        self.sync_lock = threading.Lock()
        self.is_alive = False
        self.ipc_manager = None
        self.playlist_tracker = None # New attribute to hold the PlaylistTracker instance
        self.manual_quit = False # Track if the session was closed by the user
        self.session_cookies = set() # Track cookie files created during this session

        # --- Injected Dependencies ---
        self.get_all_folders_from_file = dependencies['get_all_folders_from_file']
        self.get_mpv_executable = dependencies['get_mpv_executable']
        self.log_stream = dependencies['log_stream']
        self.send_message = dependencies['send_message']
        self.SCRIPT_DIR = dependencies['SCRIPT_DIR']
        self.TEMP_PLAYLISTS_DIR = dependencies['TEMP_PLAYLISTS_DIR']
        self.FLAG_DIR = os.path.join(os.path.dirname(self.TEMP_PLAYLISTS_DIR), "flags")
        
        # Ensure flag directory exists
        try:
            os.makedirs(self.FLAG_DIR, exist_ok=True)
        except Exception as e:
            logging.warning(f"Could not create flag directory {self.FLAG_DIR}: {e}")

    def _log_audit(self, message):
        """Appends a message to the human-readable audit file."""
        try:
            import file_io
            from datetime import datetime
            inspection_path = os.path.join(file_io.DATA_DIR, "last_mpv_command.txt")
            with open(inspection_path, 'a', encoding='utf-8') as f:
                f.write(f"\n[{datetime.now().strftime('%H:%M:%S')}] SESSION UPDATE: {message}\n")
        except Exception:
            pass

    def clear(self, mpv_return_code=None):
        """Clears the session state and removes the session file."""
        # Immediately signal that the session is no longer active.
        # This is the most critical part to prevent the race condition with the append loop.
        self.is_alive = False
        pid_to_clear = self.pid # Store current pid for logging/tracker before nullifying
        self.pid = None # Explicitly nullify the pid now.

        if pid_to_clear:
            logging.info(f"Clearing session state for PID: {pid_to_clear}")

        # Stop the tracker if it's running
        if self.playlist_tracker and self.playlist_tracker.is_tracking:
            self.playlist_tracker.stop_tracking(mpv_return_code=mpv_return_code) # Pass return code to tracker
        self.playlist_tracker = None # Clear the reference to the tracker

        if self.ipc_manager: # Close the persistent socket connection
            self.ipc_manager.close()
            self.ipc_manager = None # Clear the reference

        self.process = None
        self.ipc_path = None
        self.playlist = None
        self.owner_folder_id = None
        self.manual_quit = False # Reset manual quit flag for the next session

        # Cleanup session cookies
        if self.session_cookies:
            logging.info(f"Cleaning up {len(self.session_cookies)} session cookies.")
            for cookie_path in list(self.session_cookies):
                try:
                    if os.path.exists(cookie_path):
                        os.remove(cookie_path)
                        logging.debug(f"Removed session cookie: {cookie_path}")
                except Exception as e:
                    logging.warning(f"Failed to remove session cookie {cookie_path}: {e}")
            self.session_cookies.clear()

        if os.path.exists(self.session_file):
            try:
                os.remove(self.session_file)
                logging.info(f"Cleaned up session file: {self.session_file}")
            except OSError as e:
                logging.warning(f"Failed to remove session file during cleanup: {e}")

    def restore(self):
        """Checks for a persisted session file and restores state if the process is still alive."""
        if self.is_alive and self.pid and ipc_utils.is_pid_running(self.pid):
            logging.info(f"Restore: Session for PID {self.pid} is already active in this host instance. Returning current state.")
            return {"was_stale": False, "folderId": self.owner_folder_id, "lastPlayedId": getattr(self, 'last_played_id_cache', None)}

        if not os.path.exists(self.session_file):
            logging.debug("[PY][Session] Restore: No session file found.")
            return None

        logging.info(f"[PY][Session] Found session file: {self.session_file}. Checking for live process.")
        try:
            with open(self.session_file, 'r', encoding='utf-8') as f:
                session_data = json.load(f)

            pid = session_data.get("pid")
            ipc_path = session_data.get("ipc_path")
            owner_folder_id = session_data.get("owner_folder_id")
            token = session_data.get("token")

            if not all([pid, ipc_path, owner_folder_id]):
                raise ValueError("Session file is malformed.")

            if ipc_utils.is_process_alive(pid, ipc_path):
                all_folders = self.get_all_folders_from_file()
                folder_data = all_folders.get(owner_folder_id)
                if not folder_data or "playlist" not in folder_data:
                    raise RuntimeError(f"Could not find playlist data for restored folder '{owner_folder_id}'.")

                self.pid = pid
                self.ipc_path = ipc_path
                self.playlist = folder_data.get("playlist", [])
                self.owner_folder_id = owner_folder_id
                self.current_token = token
                self.is_alive = True # Mark as alive so other methods can use it
                
                # Initialize the IPC manager for the restored session
                self.ipc_manager = ipc_utils.IPCSocketManager()
                logging.info(f"[PY][Session] Restore: Attempting to connect to existing IPC at {self.ipc_path}...")
                if not self.ipc_manager.connect(self.ipc_path):
                    logging.warning(f"[PY][Session] Restored session found, but failed to connect to IPC at {self.ipc_path}.")
                    # Don't fail the whole restore, but we won't have IPC until it reconnects
                
                # Try to identify current playing item for UI sync
                last_played_id = None
                if self.ipc_manager.is_connected():
                    try:
                        # Get current path and title from MPV
                        path_resp = self.ipc_manager.send({"command": ["get_property", "path"]}, expect_response=True)
                        title_resp = self.ipc_manager.send({"command": ["get_property", "media-title"]}, expect_response=True)
                        
                        current_path = path_resp.get("data") if path_resp and path_resp.get("error") == "success" else None
                        current_title = title_resp.get("data") if title_resp and title_resp.get("error") == "success" else None

                        if current_path or current_title:
                            for item in self.playlist:
                                if current_path and (item.get('url') == current_path or item.get('original_url') == current_path):
                                    last_played_id = item.get('id')
                                    break
                                if current_title and item.get('title') == current_title:
                                    last_played_id = item.get('id')
                                    break
                            
                            if last_played_id:
                                logging.info(f"Restore: Identified active item ID: {last_played_id}")
                                self.last_played_id_cache = last_played_id
                    except Exception as e:
                        logging.warning(f"Failed to query active item during restore: {e}")
                
                # Restart the tracker for the restored session
                import file_io
                settings = file_io.get_settings()
                
                self.playlist_tracker = PlaylistTracker(
                    owner_folder_id, 
                    self.playlist, 
                    file_io, 
                    settings, 
                    self.ipc_path, 
                    self.send_message
                )
                self.playlist_tracker.start_tracking()

                # --- CRITICAL: Start a watcher thread for the restored orphaned process ---
                self._start_restored_process_watcher(pid, ipc_path, owner_folder_id)

                logging.info(f"[PY][Session] Successfully restored session and tracker for MPV process (PID: {pid}) owned by folder '{owner_folder_id}'.")
                return {"was_stale": False, "folderId": owner_folder_id, "lastPlayedId": last_played_id, "token": token}
            else:
                logging.warning(f"[PY][Session] Stale session for PID {pid} found. Cleaning up.")
                try:
                    os.remove(self.session_file)
                except OSError: pass
                return {"was_stale": True, "folderId": owner_folder_id, "returnCode": -1}

        except Exception as e:
            logging.warning(f"[PY][Session] Could not restore session due to an error: {e}. Cleaning up.")
            try: os.remove(self.session_file)
            except OSError: pass
            return None

    def _start_restored_process_watcher(self, pid, ipc_path, folder_id):
        """Starts a background thread to poll for the exit of a restored (orphaned) process."""
        def watcher():
            logging.info(f"Restored Process Watcher: Monitoring PID {pid} for folder '{folder_id}'.")
            while True:
                time.sleep(1.0)
                # Check if the process is still alive using the robust check from ipc_utils
                if not ipc_utils.is_pid_running(pid):
                    logging.info(f"Restored Process Watcher: Detected exit of orphaned MPV process (PID {pid}).")
                    
                    return_code = -1 # Default for orphaned processes where we can't get real code
                    
                    # Check for natural completion flag to support auto-clearing
                    if ipc_path:
                        ipc_dir = os.path.dirname(ipc_path)
                        flag_file = os.path.join(ipc_dir, f'mpv_natural_completion_{pid}.flag')
                        if os.path.exists(flag_file):
                            if getattr(self, 'manual_quit', False):
                                logging.info(f"Restored Watcher: Natural completion flag found, but manual_quit is TRUE. Ignoring flag.")
                            else:
                                logging.info(f"Restored Watcher: Natural completion flag FOUND. Overriding return code to 99.")
                                return_code = 99
                            
                            try:
                                os.remove(flag_file)
                            except Exception as e:
                                logging.warning(f"Restored Watcher: Failed to remove flag file: {e}")

                    # Notify the extension so it can handle clearing/UI updates
                    self.send_message({"action": "mpv_exited", "folderId": folder_id, "returnCode": return_code})
                    self.clear(mpv_return_code=return_code)
                    break
                
                # Also stop watching if this session object is cleared/replaced
                if not self.is_alive or self.pid != pid:
                    logging.info(f"Restored Process Watcher: Session state changed. Stopping watcher for PID {pid}.")
                    break

        watcher_thread = threading.Thread(target=watcher, daemon=True)
        watcher_thread.start()

    def append_batch(self, items, mode="append"):
        """Appends multiple items using a temporary M3U to preserve titles and options natively."""
        if not items:
            return {"success": True, "message": "No items to append."}

        logging.info(f"Linked Playlist: Preparing to append {len(items)} items.")

        # 1. Register options for all items with the Lua script first
        import file_io
        import shutil
        settings = file_io.get_settings()
        ytdlp_path = shutil.which("yt-dlp") or "yt-dlp"
        
        for item in items:
            item_url = sanitize_url(item['url'])
            lua_options = {
                "id": item.get('id'), # Pass the ID for live deduplication
                "title": item.get('title'),
                "headers": item.get('headers'),
                "ytdl_raw_options": file_io.sanitize_ytdlp_options(item.get('ytdl_raw_options')),
                "use_ytdl_mpv": item.get('use_ytdl_mpv', False) or item.get('is_youtube', False),
                "original_url": sanitize_url(item.get('original_url') or item.get('url')),
                "disable_http_persistent": item.get('disable_http_persistent', False),
                "cookies_file": item.get('cookies_file'),
                "disable_network_overrides": settings.get('disable_network_overrides', False),
                "http_persistence": settings.get('http_persistence', 'auto'),
                "enable_reconnect": settings.get('enable_reconnect', True),
                "reconnect_delay": settings.get('reconnect_delay', 4)
            }
            self.ipc_manager.send({"command": ["script-message", "set_url_options", item_url, json.dumps(lua_options)]})
            self._log_audit(f"Registered Metadata for {item.get('title', 'Unknown')}\n  URL: {item_url}\n  YT-DLP Opts: {lua_options['ytdl_raw_options']}")
            
            # Sync internal playlist state
            if self.playlist is None: self.playlist = []
            
            # Deduplicate STRICTLY by ID. 
            # This allows duplicate URLs to be added as long as they are new entries (new IDs).
            item_id = item.get('id')
            is_duplicate = any(i.get('id') == item_id for i in self.playlist)

            if not is_duplicate:
                item['url'] = item_url # Store sanitized URL
                self.playlist.append(item)
                if self.playlist_tracker: self.playlist_tracker.add_item(item)

        # 2. Create a Delta M3U string
        m3u_lines = ["#EXTM3U"]
        for item in items:
            # Sanitize title to prevent M3U injection via newlines
            safe_title = sanitize_url(item.get('title', item['url']))
            m3u_lines.append(f"#EXTINF:-1,{safe_title}")
            m3u_lines.append(sanitize_url(item['url']))
        
        m3u_content = "\n".join(m3u_lines)
        
        # 3. Write to a unique temporary file
        try:
            # Ensure the temp directory exists
            os.makedirs(self.TEMP_PLAYLISTS_DIR, exist_ok=True)
            
            # Include PID in the filename for smart cleanup
            pid = os.getpid()
            unique_id = uuid.uuid4().hex[:8]
            temp_filename = f"{DELTA_PREFIX}{pid}_{unique_id}{DELTA_EXT}"
            temp_path = os.path.join(self.TEMP_PLAYLISTS_DIR, temp_filename)
            
            with open(temp_path, 'w', encoding='utf-8') as tf:
                tf.write(m3u_content)
            
            logging.info(f"Linked Playlist: Created delta M3U at {temp_path}")
            self._log_audit(f"Loading Delta M3U: {temp_path}\n--- M3U CONTENT ---\n{m3u_content}\n-------------------")

            # 4. Tell MPV to load this M3U as a list
            # We use loadlist because it parses #EXTINF titles natively.
            res = self.ipc_manager.send({"command": ["loadlist", temp_path, mode]}, expect_response=True)
            
            # Cleanup the delta file immediately after MPV has processed the command
            try:
                if os.path.exists(temp_path):
                    os.remove(temp_path)
                    logging.debug(f"Cleaned up delta M3U: {temp_path}")
            except Exception as e:
                logging.warning(f"Failed to cleanup delta M3U: {e}")

            if res and res.get("error") == "success":
                # If MPV is currently idle (e.g. finished the playlist), 
                # appending won't automatically start playback. We force it.
                idle_resp = self.ipc_manager.send({"command": ["get_property", "idle-active"]})
                if idle_resp and idle_resp.get("data") == True:
                    logging.info("MPV is idle. Forcing playback to start after append.")
                    self.ipc_manager.send({"command": ["set_property", "pause", False]})
                    self.ipc_manager.send({"command": ["playlist-next", "weak"]})
                
                # Show OSD feedback
                msg = f"Appended {len(items)} new item{'s' if len(items) > 1 else ''}"
                self.ipc_manager.send({"command": ["show-text", msg, 3000]})
                
                return {"success": True, "message": f"Appended {len(items)} items to active session."}
            else:
                raise RuntimeError(f"MPV rejected loadlist command: {res}")

        except Exception as e:
            logging.error(f"Failed to append batch via delta M3U: {e}")
            return {"success": False, "error": str(e)}

    def remove(self, item_id, folder_id):
        """Removes an item from the active MPV playlist by ID."""
        with self.sync_lock:
            if not self.is_alive or self.owner_folder_id != folder_id:
                return {"success": False, "message": "Session not active or folder mismatch."}
            
            # Find the index of the item in the internal playlist
            index_to_remove = -1
            if self.playlist:
                for i, item in enumerate(self.playlist):
                    if item.get('id') == item_id:
                        index_to_remove = i
                        break
            
            if index_to_remove != -1:
                logging.info(f"Removing item index {index_to_remove} (ID: {item_id}) from live MPV session.")
                # MPV playlist indices are 0-based.
                self.ipc_manager.send({"command": ["playlist-remove", index_to_remove]}, expect_response=True)
                
                # Update internal state
                removed_item = self.playlist.pop(index_to_remove)
                
                # Update tracker so it doesn't expect this item
                if self.playlist_tracker:
                    self.playlist_tracker.remove_item_internal(item_id)
                
                title = sanitize_url(removed_item.get('title') or "Item")
                if len(title) > 60: title = title[:57] + "..."
                self.ipc_manager.send({"command": ["show-text", f"Removed: {title}", 2000]}, expect_response=True)
                
                return {"success": True, "message": "Item removed from live session."}
            
            return {"success": False, "message": "Item not found in live session."}

    def reorder(self, folder_id, new_order_items):
        """Reorders the live MPV playlist to match the new order provided."""
        with self.sync_lock:
            if not self.is_alive or self.owner_folder_id != folder_id:
                return {"success": False, "message": "Session not active or folder mismatch."}
            
            if not self.playlist:
                return {"success": False, "message": "Playlist is empty."}

            # We simulate the moves on a local copy of the list to determine the correct indices for MPV commands.
            # MPV playlist-move i j: moves item at i to j.
            simulated_playlist = list(self.playlist)
            
            # We iterate through the target order. For each position 'target_index',
            # we find where that item currently is in our simulated list ('current_index')
            # and move it to 'target_index'.
            for target_index, item_data in enumerate(new_order_items):
                target_id = item_data.get('id')
                if not target_id:
                    logging.warning(f"Live Reorder: Skipping item at index {target_index} because it has no ID.")
                    continue

                # Find current index of this item ID
                current_index = -1
                for idx, item in enumerate(simulated_playlist):
                    if item.get('id') == target_id:
                        current_index = idx
                        break
                
                if current_index != -1 and current_index != target_index:
                    logging.info(f"Live Reorder: Moving item {target_id} from {current_index} to {target_index}")
                    self.ipc_manager.send({"command": ["playlist-move", current_index, target_index]}, expect_response=True)
                    
                    # Update simulation to match MPV state
                    item_to_move = simulated_playlist.pop(current_index)
                    simulated_playlist.insert(target_index, item_to_move)
            
            # Update actual state
            self.playlist = simulated_playlist
            if self.playlist_tracker:
                self.playlist_tracker.update_playlist_order(simulated_playlist)
                
            self.ipc_manager.send({"command": ["show-text", "Playlist reordered", 2000]}, expect_response=True)
            
            return {"success": True, "message": "Live playlist reordered."}

    def _launch(self, url_item, folder_id, settings, file_io, geometry, custom_width, custom_height, custom_mpv_flags, automatic_mpv_flags, start_paused, headers=None, disable_http_persistent=False, ytdl_raw_options=None, use_ytdl_mpv=False, is_youtube=False, full_playlist=None, force_terminal=False, playlist_start_index=0):
        """Launches a new instance of MPV with a single URL and prepares for playlist construction via IPC."""
        logging.info(f"[PY][Session] Starting a new MPV instance for URL: {url_item.get('url')}")
        mpv_exe = self.get_mpv_executable()
        ipc_path = ipc_utils.get_ipc_path()

        try:
            full_command, has_terminal_flag = services.construct_mpv_command(
                mpv_exe=mpv_exe,
                ipc_path=ipc_path,
                url=None, # DO NOT pass URL on command line to avoid race condition
                is_youtube=is_youtube,
                ytdl_raw_options=ytdl_raw_options,
                geometry=geometry,
                custom_width=custom_width,
                custom_height=custom_height,
                custom_mpv_flags=custom_mpv_flags,
                automatic_mpv_flags=automatic_mpv_flags,
                headers=headers,
                disable_http_persistent=disable_http_persistent,
                start_paused=start_paused,
                script_dir=self.SCRIPT_DIR,
                load_on_completion_script=True,
                title=url_item.get('title'),
                use_ytdl_mpv=use_ytdl_mpv,
                is_youtube_override=use_ytdl_mpv,
                idle="yes", # Use 'yes' so we have full control over the exit via Lua
                force_terminal=force_terminal,
                input_terminal="no" if not force_terminal else "yes", # Only disable if no terminal requested
                settings=settings,
                flag_dir=self.FLAG_DIR
            )

            # Manually add playlist-start if needed (CommandBuilder might not handle it via construct_mpv_command)
            if playlist_start_index > 0:
                full_command.insert(1, f"--playlist-start={playlist_start_index}")

            popen_kwargs = services.get_mpv_popen_kwargs(has_terminal_flag)

            # Clean environment to prevent browser library conflicts with system apps (like Konsole)
            env = os.environ.copy()
            for key in ['LD_LIBRARY_PATH', 'QT_PLUGIN_PATH', 'QT_QPA_PLATFORM_PLUGIN_PATH']:
                env.pop(key, None)

            # Launch MPV
            self.process = subprocess.Popen(full_command, env=env, **popen_kwargs)
            self.ipc_path = ipc_path

            # Start reading logs immediately to prevent pipe buffer deadlock
            stderr_thread = threading.Thread(target=self.log_stream, args=(self.process.stdout, logging.warning, folder_id))
            stderr_thread.daemon = True
            stderr_thread.start()

            self.ipc_manager = ipc_utils.IPCSocketManager()
            if not self.ipc_manager.connect(self.ipc_path, timeout=15.0):
                raise RuntimeError(f"Failed to connect to MPV IPC at {self.ipc_path}")

            self.playlist = full_playlist if full_playlist is not None else [url_item]
            
            # --- Register options for ALL items BEFORE starting playback ---
            if self.playlist:
                for item in self.playlist:
                    item_url = sanitize_url(item['url'])
                    item_headers = item.get('headers')
                    item_ytdl_raw_options = file_io.sanitize_ytdlp_options(item.get('ytdl_raw_options'))
                    item_use_ytdl_mpv = item.get('use_ytdl_mpv', False) or item.get('is_youtube', False)
                    
                    lua_options = {
                        "id": item.get('id'), # Crucial for tracking!
                        "title": item.get('title'),
                        "headers": item_headers,
                        "ytdl_raw_options": item_ytdl_raw_options,
                        "use_ytdl_mpv": item_use_ytdl_mpv,
                        "original_url": sanitize_url(item.get('original_url') or item.get('url')),
                        "disable_http_persistent": item.get('disable_http_persistent', False) or disable_http_persistent,
                        "cookies_file": item.get('cookies_file'),
                        "disable_network_overrides": settings.get('disable_network_overrides', False),
                        "http_persistence": settings.get('http_persistence', 'auto'),
                        "enable_reconnect": settings.get('enable_reconnect', True),
                        "reconnect_delay": settings.get('reconnect_delay', 4)
                    }
                    self.ipc_manager.send({"command": ["script-message", "set_url_options", item_url, json.dumps(lua_options)]})
                logging.info(f"Registered options for {len(self.playlist)} items with adaptive_headers.lua")

            # Now start playback of the actual URL
            loadfile_opts = {}
            sanitized_launch_url = sanitize_url(url_item['url'])
            if settings.get('enable_precise_resume') and url_item.get('resume_time'):
                resume_time = url_item.get('resume_time')
                if resume_time > 0:
                    logging.info(f"Precise Resume: Resuming from {resume_time}s.")
                    loadfile_opts["start"] = f"{resume_time}"

            if loadfile_opts:
                self.ipc_manager.send({"command": ["loadfile", sanitized_launch_url, "replace", loadfile_opts]})
            else:
                self.ipc_manager.send({"command": ["loadfile", sanitized_launch_url, "replace"]})

            self.pid = self.process.pid
            self.owner_folder_id = folder_id
            self.is_alive = True
            
            # Persist session data to file so it can be restored if the native host restarts.
            try:
                session_data = {
                    "pid": self.pid,
                    "ipc_path": self.ipc_path,
                    "owner_folder_id": self.owner_folder_id,
                    "token": getattr(self, 'current_token', None) # Include the token
                }
                with open(self.session_file, 'w', encoding='utf-8') as f:
                    json.dump(session_data, f)
                logging.info(f"[PY][Session] Saved session data to {self.session_file}")
            except Exception as e:
                logging.warning(f"[PY][Session] Failed to write session file: {e}")
            
            # We pass the full intended playlist to the tracker, even though only one item is loaded initially
            self.playlist_tracker = PlaylistTracker(folder_id, self.playlist, file_io, settings, self.ipc_path, self.send_message)
            self.playlist_tracker.start_tracking()

            if platform.system() != "Windows" and has_terminal_flag:
                try:
                    pid_response = self.ipc_manager.send({"command": ["get_property", "pid"]}, timeout=5.0, expect_response=True)
                    if pid_response and pid_response.get("error") == "success":
                        actual_mpv_pid = pid_response.get("data")
                        if actual_mpv_pid:
                            logging.info(f"Corrected PID from terminal ({self.pid}) to actual MPV PID ({actual_mpv_pid}).")
                            self.pid = actual_mpv_pid
                except Exception as e:
                    logging.error(f"Error while trying to get MPV's real PID from terminal launch: {e}")

            def process_waiter(proc, f_id):
                return_code = proc.wait()
                exit_reason = None
                
                # Robust Completion Check: Check for the flag file written by on_completion.lua
                # This handles cases where MPV exits with code 0 but actually finished the playlist.
                actual_pid = getattr(self, 'pid', None)
                if actual_pid:
                    # Potential locations for the flag file
                    flag_candidates = [
                        os.path.join(self.FLAG_DIR, f'mpv_natural_completion_{actual_pid}.flag'),
                    ]
                    
                    if self.ipc_path:
                        flag_candidates.append(os.path.join(os.path.dirname(self.ipc_path), f'mpv_natural_completion_{actual_pid}.flag'))

                    for flag_file in flag_candidates:
                        logging.info(f"Checking for natural completion flag at: {flag_file}")
                        if os.path.exists(flag_file):
                            if getattr(self, 'manual_quit', False):
                                logging.info(f"Natural completion flag found, but manual_quit is TRUE. Ignoring flag for folder '{f_id}'.")
                            else:
                                try:
                                    with open(flag_file, 'r', encoding='utf-8') as f:
                                        exit_reason = f.read().strip()
                                    logging.info(f"Natural completion flag FOUND for folder '{f_id}'. Reason: {exit_reason}")
                                except Exception as e:
                                    logging.warning(f"Failed to read flag file: {e}")
                                    exit_reason = "completed"
                                
                                return_code = 99
                            
                            try:
                                os.remove(flag_file)
                            except Exception as e: 
                                logging.warning(f"Failed to remove flag file: {e}")
                            break # Found and processed one candidate

                logging.info(f"MPV process for folder '{f_id}' exited with code {return_code}. Reason: {exit_reason or 'manual/unknown'}")
                self.send_message({
                    "action": "mpv_exited", 
                    "folderId": f_id, 
                    "returnCode": return_code,
                    "reason": exit_reason
                })
                self.clear(mpv_return_code=return_code)

            waiter_thread = threading.Thread(target=process_waiter, args=(self.process, folder_id))
            waiter_thread.daemon = True
            waiter_thread.start()

            self.process.waiter_thread = waiter_thread
            logging.info(f"MPV process launched (PID: {self.process.pid}) for single URL.")
            return {"success": True, "message": "MPV playback initiated."}
        except FileNotFoundError:
            logging.error(f"Failed to launch mpv. Make sure '{mpv_exe}' is installed and in your system's PATH or configured correctly.")
            return {"success": False, "error": f"Error: '{mpv_exe}' executable not found."}
        except Exception as e:
            logging.error(f"An error occurred while trying to launch mpv: {e}")
            return {"success": False, "error": f"Error launching mpv: {e}"}

    def enrich_single_item(self, item, folder_id=None):
        """Enriches a single item with playback options (direct URL, headers, etc.)."""
        # If item is already resolved, skip
        if item.get('enriched'):
            return [item]

        # Ensure item has a stable ID if it doesn't already have one
        if not item.get('id'):
            item['id'] = str(uuid.uuid4())

        # Store the original URL before it potentially gets replaced
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
            mark_watched_flag
        ) = apply_bypass_script(url_dict_for_analysis, self.send_message)
        
        if entries:
            # For expanded playlists, ensure every entry gets its own unique ID
            processed_entries = []
            for entry in entries:
                if not entry.get('id'):
                    entry['id'] = str(uuid.uuid4())
                
                # We do NOT mark them as enriched yet, so they can be resolved individually
                entry['is_youtube'] = True
                if 'use_ytdl_mpv' not in entry:
                    entry['use_ytdl_mpv'] = False 
                processed_entries.append(entry)
            return processed_entries

        # Update the original item with the enriched data
        item['url'] = processed_url
        
        if headers_for_mpv:
            if not item.get('headers'):
                item['headers'] = headers_for_mpv
            else:
                merged_headers = headers_for_mpv.copy()
                merged_headers.update(item['headers'])
                item['headers'] = merged_headers

        if ytdl_raw_options_for_mpv:
            if not item.get('ytdl_raw_options'):
                item['ytdl_raw_options'] = ytdl_raw_options_for_mpv
            else:
                existing = item['ytdl_raw_options'].split(',')
                new_opts = ytdl_raw_options_for_mpv.split(',')
                merged_map = {}
                for o in new_opts + existing:
                    if '=' in o:
                        k, v = o.split('=', 1)
                        merged_map[k.strip()] = v.strip()
                    else:
                        merged_map[o.strip()] = ""
                item['ytdl_raw_options'] = ','.join([f"{k}={v}" if v is not None and v != "" else f"{k}=" for k, v in merged_map.items()])

        item['use_ytdl_mpv'] = use_ytdl_mpv_flag
        item['is_youtube'] = is_youtube_flag_from_script
        item['disable_http_persistent'] = disable_http_persistent_flag
        item['cookies_file'] = cookies_file
        item['mark_watched'] = mark_watched_flag
        if cookies_file:
            with self.sync_lock:
                self.session_cookies.add(cookies_file)
        item['enriched'] = True
        return [item]

    def _resolve_input_items(self, url_items_or_m3u, enriched_items_list, headers):
        """Normalizes various input formats into a list of items and handles M3U/YouTube parsing."""
        _url_items_list = enriched_items_list if enriched_items_list is not None else []
        m3u_content = None 
        input_was_raw = False

        if isinstance(url_items_or_m3u, str):
            # 1. Local Server URL check
            if url_items_or_m3u.startswith('http://localhost') and enriched_items_list is not None:
                 logging.info(f"Local M3U server URL detected: {url_items_or_m3u}. Skipping M3U parsing.")
            else:
                # 2. YouTube Playlist Check
                is_youtube_playlist = "youtube.com/playlist" in url_items_or_m3u or ("youtube.com/watch" in url_items_or_m3u and "list=" in url_items_or_m3u)
                
                if is_youtube_playlist:
                    logging.info(f"Expanding YouTube playlist: {url_items_or_m3u}")
                    _, _, _, _, _, entries, _, _, _ = apply_bypass_script({'url': url_items_or_m3u}, self.send_message)
                    if entries:
                        _url_items_list = entries
                        input_was_raw = True
                    else:
                        _url_items_list = [{'url': url_items_or_m3u}]
                        input_was_raw = True

                # 3. M3U / Content check if not already expanded
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

    def _handle_standard_flow_launch(self, url_items, start_index, folder_id, settings, file_io):
        """Handles the background restoration of playlist order and sequential metadata enrichment."""
        def task():
            time.sleep(2.0)
            if not self.is_alive: return
            
            history_items = url_items[:start_index]
            future_items = url_items[start_index + 1:]
            
            # 1. Restore Order
            if future_items:
                self.append_batch(future_items, mode="append")
                time.sleep(0.5)

            if history_items:
                self.append_batch(history_items, mode="append")
                time.sleep(0.5)
                
                total_len = len(url_items)
                history_count = len(history_items)
                for i in range(history_count):
                    source_idx = (total_len - history_count) + i
                    self.ipc_manager.send({"command": ["playlist-move", source_idx, i]})
                    if self.playlist and source_idx < len(self.playlist):
                        item = self.playlist.pop(source_idx)
                        self.playlist.insert(i, item)

            if self.playlist_tracker:
                self.playlist_tracker.update_playlist_order(self.playlist)
            
            # 2. Sequential Enrichment
            for idx, item in enumerate(url_items):
                if idx == start_index or not self.is_alive: continue
                
                enriched = self.enrich_single_item(item, folder_id)[0]
                target_url = sanitize_url(enriched['url'])
                if enriched.get('is_youtube') and enriched.get('original_url'):
                    target_url = sanitize_url(enriched['original_url'])

                lua_options = {
                    "id": enriched.get('id'), "title": enriched.get('title'),
                    "headers": enriched.get('headers'),
                    "ytdl_raw_options": file_io.sanitize_ytdlp_options(enriched.get('ytdl_raw_options')),
                    "use_ytdl_mpv": enriched.get('use_ytdl_mpv', False),
                    "original_url": sanitize_url(enriched.get('original_url') or enriched.get('url')),
                    "disable_http_persistent": enriched.get('disable_http_persistent', False),
                    "cookies_file": enriched.get('cookies_file'),
                    "disable_network_overrides": settings.get('disable_network_overrides', False),
                    "http_persistence": settings.get('http_persistence', 'auto')
                }
                self.ipc_manager.send({"command": ["script-message", "set_url_options", target_url, json.dumps(lua_options)]})
                self.ipc_manager.send({"command": ["set_property", f"playlist/{idx}/url", target_url]})
                if idx < len(self.playlist): self.playlist[idx] = enriched
                
                time.sleep(0.05)

        threading.Thread(target=task, daemon=True).start()

    def _generate_m3u_content(self, items):
        """Generates M3U content from a list of items."""
        m3u_lines = ["#EXTM3U"]
        for item in items:
            safe_title = sanitize_url(item.get('title', item['url']))
            m3u_lines.append(f"#EXTINF:-1,{safe_title}")
            m3u_lines.append(sanitize_url(item['url']))
        return "\n".join(m3u_lines)

    def start(self, url_items_or_m3u, folder_id, settings, file_io, **kwargs):
        """Starts a new mpv process with a playlist of URLs or an M3U."""
        _url_items_list, input_was_raw = self._resolve_input_items(url_items_or_m3u, kwargs.get('enriched_items_list'), kwargs.get('headers'))
        
        if not _url_items_list:
            return {"success": False, "error": "No URL items provided or parsed."}

        # Handle Enrichment for Raw Inputs
        if input_was_raw:
            is_m3u_flow = isinstance(url_items_or_m3u, str) and not ("youtube.com" in url_items_or_m3u)
            if is_m3u_flow:
                from concurrent.futures import ThreadPoolExecutor
                with ThreadPoolExecutor(max_workers=10) as executor:
                    results = list(executor.map(lambda x: self.enrich_single_item(x, folder_id), _url_items_list))
                _url_items_list = [i for r in results for i in r]
                return {
                    "success": True, 
                    "enriched_url_items": _url_items_list, 
                    "enriched_m3u_content": self._generate_m3u_content(_url_items_list),
                    "message": "Enriched content generated."
                }
            else:
                first_enriched = self.enrich_single_item(_url_items_list[0], folder_id)
                _url_items_list = first_enriched + _url_items_list[1:]

        # Smart Resume
        playlist_start_index = 0
        if settings.get("enable_smart_resume", True):
            last_id = file_io.get_all_folders_from_file().get(folder_id, {}).get("last_played_id")
            for idx, item in enumerate(_url_items_list):
                if item.get('id') == last_id:
                    playlist_start_index = idx
                    break

        launch_item = _url_items_list[playlist_start_index]
        
        if self.pid:
            if not ipc_utils.is_process_alive(self.pid, self.ipc_path): self.clear()
            elif folder_id == self.owner_folder_id: 
                return {
                    "success": True, 
                    "already_active": True, 
                    "enriched_url_items": _url_items_list,
                    "enriched_m3u_content": self._generate_m3u_content(_url_items_list)
                }
            else: self.close()

        launch_result = self._launch(
            launch_item, folder_id, settings, file_io,
            geometry=kwargs.get('geometry'), custom_width=kwargs.get('custom_width'), 
            custom_height=kwargs.get('custom_height'), custom_mpv_flags=kwargs.get('custom_mpv_flags'), 
            automatic_mpv_flags=kwargs.get('automatic_mpv_flags'), start_paused=kwargs.get('start_paused'), 
            headers=launch_item.get('headers') or kwargs.get('headers'), 
            disable_http_persistent=launch_item.get('disable_http_persistent', kwargs.get('disable_http_persistent', False)),
            ytdl_raw_options=launch_item.get('ytdl_raw_options') or kwargs.get('ytdl_raw_options'), 
            use_ytdl_mpv=launch_item.get('use_ytdl_mpv', False) or kwargs.get('use_ytdl_mpv', False), 
            is_youtube=launch_item.get('is_youtube', False) or kwargs.get('is_youtube', False),
            full_playlist=[launch_item], force_terminal=kwargs.get('force_terminal', False)
        )

        if launch_result.get("success") and len(_url_items_list) > 1:
            self._handle_standard_flow_launch(_url_items_list, playlist_start_index, folder_id, settings, file_io)

        if launch_result.get("success") and input_was_raw:
            launch_result["handled_directly"] = True
            launch_result["enriched_url_items"] = _url_items_list
            launch_result["enriched_m3u_content"] = self._generate_m3u_content(_url_items_list)

        return launch_result

    def close(self):
        """Closes the current mpv session gracefully via IPC, then forcefully if needed."""
        if not self.pid:
            return {"success": True, "message": "No active session to close."}

        logging.info(f"[PY][Session] Closing MPV session (PID {self.pid}) for folder '{self.owner_folder_id}'")
        self.manual_quit = True
        
        # 1. Try Graceful Quit via IPC
        if self.ipc_manager and self.is_alive:
            try:
                logging.debug("[PY][Session] Sending 'quit' command via IPC.")
                # Inform Lua this is manual to prevent completion flags
                self.ipc_manager.send({"command": ["script-message", "manual_quit_initiated"]}, expect_response=False)
                self.ipc_manager.send({"command": ["quit", 0]}, expect_response=False)
                
                # Wait briefly for process to die
                for _ in range(10): # 0.5 seconds max
                    if not ipc_utils.is_pid_running(self.pid):
                        logging.info("[PY][Session] MPV exited gracefully via IPC.")
                        self.clear()
                        return {"success": True, "message": "MPV closed gracefully via IPC."}
                    time.sleep(0.05)
            except Exception as e:
                logging.debug(f"[PY][Session] IPC quit failed: {e}")

        # 2. Fallback to Termination
        if ipc_utils.is_pid_running(self.pid):
            logging.warning(f"[PY][Session] MPV did not exit gracefully. Terminating process {self.pid}...")
            try:
                if platform.system() == "Windows":
                    subprocess.run(['taskkill', '/F', '/T', '/PID', str(self.pid)], capture_output=True)
                else:
                    os.kill(self.pid, 15) # SIGTERM
                    time.sleep(0.2)
                    if ipc_utils.is_pid_running(self.pid):
                        os.kill(self.pid, 9) # SIGKILL
            except Exception as e:
                logging.error(f"[PY][Session] Failed to kill MPV process: {e}")
        
        self.clear()
        logging.info("[PY][Session] MPV process closed.")
        return {"success": True, "message": "MPV session closed."}
