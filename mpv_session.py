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

        # --- Injected Dependencies ---
        self.get_all_folders_from_file = dependencies['get_all_folders_from_file']
        self.get_mpv_executable = dependencies['get_mpv_executable']
        self.log_stream = dependencies['log_stream']
        self.send_message = dependencies['send_message']
        self.SCRIPT_DIR = dependencies['SCRIPT_DIR']
        self.TEMP_PLAYLISTS_DIR = dependencies['TEMP_PLAYLISTS_DIR']

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
        if os.path.exists(self.session_file):
            try:
                os.remove(self.session_file)
                logging.info(f"Cleaned up session file: {self.session_file}")
            except OSError as e:
                logging.warning(f"Failed to remove session file during cleanup: {e}")

    def restore(self):
        """Checks for a persisted session file and restores state if the process is still alive."""
        if not os.path.exists(self.session_file):
            return None

        logging.info(f"Found session file: {self.session_file}. Checking for live process.")
        try:
            with open(self.session_file, 'r', encoding='utf-8') as f:
                session_data = json.load(f)

            pid = session_data.get("pid")
            ipc_path = session_data.get("ipc_path")
            owner_folder_id = session_data.get("owner_folder_id")

            if not all([pid, ipc_path, owner_folder_id]):
                raise ValueError("Session file is malformed.")

            if ipc_utils.is_process_alive(pid, ipc_path):
                all_folders = self.get_all_folders_from_file()
                folder_data = all_folders.get(owner_folder_id)
                if not folder_data or "playlist" not in folder_data:
                    raise RuntimeError(f"Could not find playlist data for restored folder '{owner_folder_id}'.")

                self.pid = pid
                self.ipc_path = ipc_path
                self.playlist = [item['url'] if isinstance(item, dict) else item for item in folder_data["playlist"]]
                self.owner_folder_id = owner_folder_id
                logging.info(f"Successfully restored session for MPV process (PID: {pid}) owned by folder '{owner_folder_id}'.")
                return {"was_stale": False}
            else:
                logging.warning(f"Stale session for PID {pid} found. Cleaning up.")
                try:
                    os.remove(self.session_file)
                except OSError: pass
                return {"was_stale": True, "folderId": owner_folder_id, "returnCode": -1}

        except Exception as e:
            logging.warning(f"Could not restore session due to an error: {e}. Cleaning up.")
            try: os.remove(self.session_file)
            except OSError: pass
            return None

    def append_batch(self, items, mode="append"):
        """Appends multiple items using a temporary M3U to preserve titles and options natively."""
        if not items:
            return {"success": True, "message": "No items to append."}

        logging.info(f"Linked Playlist: Preparing to append {len(items)} items.")

        # 1. Register options for all items with the Lua script first
        for item in items:
            lua_options = {
                "id": item.get('id'), # Pass the ID for live deduplication
                "title": item.get('title'),
                "headers": item.get('headers'),
                "ytdl_raw_options": item.get('ytdl_raw_options'),
                "use_ytdl_mpv": item.get('use_ytdl_mpv', False) or item.get('is_youtube', False),
                "original_url": item.get('original_url') or item.get('url'),
                "disable_http_persistent": item.get('disable_http_persistent', False),
                "cookies_file": item.get('cookies_file')
            }
            self.ipc_manager.send({"command": ["script-message", "set_url_options", item['url'], json.dumps(lua_options)]})
            
            # Sync internal playlist state
            if self.playlist is None: self.playlist = []
            
            # Deduplicate STRICTLY by ID. 
            # This allows duplicate URLs to be added as long as they are new entries (new IDs).
            item_id = item.get('id')
            is_duplicate = any(i.get('id') == item_id for i in self.playlist)

            if not is_duplicate:
                self.playlist.append(item)
                if self.playlist_tracker: self.playlist_tracker.add_item(item)

        # 2. Create a Delta M3U string
        m3u_lines = ["#EXTM3U"]
        for item in items:
            m3u_lines.append(f"#EXTINF:-1,{item.get('title', item['url'])}")
            m3u_lines.append(item['url'])
        
        m3u_content = "\n".join(m3u_lines)
        
        # 3. Write to a unique temporary file
        try:
            # Ensure the temp directory exists
            os.makedirs(self.TEMP_PLAYLISTS_DIR, exist_ok=True)
            
            with tempfile.NamedTemporaryFile(mode='w', suffix='.m3u', dir=self.TEMP_PLAYLISTS_DIR, delete=False, encoding='utf-8') as tf:
                tf.write(m3u_content)
                temp_path = tf.name
            
            logging.info(f"Linked Playlist: Created delta M3U at {temp_path}")

            # 4. Tell MPV to load this M3U as a list
            # We use loadlist because it parses #EXTINF titles natively.
            res = self.ipc_manager.send({"command": ["loadlist", temp_path, mode]}, expect_response=True)
            
            # Cleanup the delta file after a short delay to ensure MPV has read it
            def cleanup():
                time.sleep(5)
                try:
                    if os.path.exists(temp_path):
                        os.remove(temp_path)
                        logging.debug(f"Cleaned up delta M3U: {temp_path}")
                except Exception as e:
                    logging.warning(f"Failed to cleanup delta M3U: {e}")
            
            threading.Thread(target=cleanup, daemon=True).start()

            if res and res.get("error") == "success":
                return {"success": True, "message": f"Appended {len(items)} items to active session."}
            else:
                raise RuntimeError(f"MPV rejected loadlist command: {res}")

        except Exception as e:
            logging.error(f"Failed to append batch via delta M3U: {e}")
            return {"success": False, "error": str(e)}

    def append(self, url_item, headers=None, mode="append", disable_http_persistent=False, ytdl_raw_options=None, use_ytdl_mpv=False, is_youtube=False):
        """Attempts to append a single new URL to an already running MPV instance."""
        with self.sync_lock:
            logging.info(f"Entering append for URL: {url_item.get('url')}")
            # First, check if the session is still active before trying to append.
            if not self.is_alive:
                logging.warning("Attempted to append to an inactive MPV session. Aborting append.")
                return {"success": False, "error": "Cannot append: MPV session is not active."}

            logging.info(f"MPV is running. Attempting to append item (mode: {mode}).")
            url_to_add = url_item['url']
            item_id = url_item.get('id')
            original_url = url_item.get('original_url')
            
            # Helper to send commands robustly
            def robust_send(command, timeout=1.0):
                result = self.ipc_manager.send(command, expect_response=True, timeout=timeout)
                if result is None:
                    if self.ipc_manager.connect(self.ipc_path):
                        return self.ipc_manager.send(command, expect_response=True, timeout=timeout)
                return result

            # --- STEP 1: Deep Live Check (Strict ID-Only) ---
            # Instead of just checking our local list, we ask MPV for the real truth.
            # We ONLY deduplicate if the exact same item ID is already in the player.
            is_duplicate = False
            if item_id:
                playlist_resp = robust_send({"command": ["get_property", "playlist"]}, timeout=2.0)
                
                if playlist_resp and playlist_resp.get("error") == "success":
                    mpv_playlist = playlist_resp.get("data", [])
                    
                    # We check every item in the LIVE playlist
                    for i, _ in enumerate(mpv_playlist):
                        # Check ID from user-data (The ONLY source of truth now)
                        id_resp = robust_send({"command": ["get_property", f"playlist/{i}/user-data/id"]}, timeout=0.5)
                        if id_resp and id_resp.get("data") == item_id:
                            is_duplicate = True
                            break

            if is_duplicate:
                logging.info(f"Deep Check: Item ID '{item_id}' already in live MPV playlist. Skipping.")
                # Sync our local list if needed
                if self.playlist is None: self.playlist = []
                if not any(i.get('id') == item_id for i in self.playlist):
                    self.playlist.append(url_item)
                return {"success": True, "message": "Item already in playlist.", "skipped": True}

            try:
                # Construct options for the item
                lua_options = {
                    "id": item_id,
                    "title": url_item.get('title'),
                    "headers": url_item.get('headers') or headers,
                    "ytdl_raw_options": url_item.get('ytdl_raw_options') or ytdl_raw_options,
                    "use_ytdl_mpv": url_item.get('use_ytdl_mpv', use_ytdl_mpv),
                    "original_url": original_url or url_to_add,
                    "disable_http_persistent": url_item.get('disable_http_persistent', disable_http_persistent),
                    "cookies_file": url_item.get('cookies_file')
                }
                robust_send({"command": ["script-message", "set_url_options", url_to_add, json.dumps(lua_options)]})

                # Simple loadfile command
                ipc_command = {"command": ["loadfile", url_to_add, mode]}
                load_resp = robust_send(ipc_command)
                
                if load_resp and load_resp.get("error") == "success":
                    if self.playlist is None: self.playlist = []
                    self.playlist.append(url_item)
                    if self.playlist_tracker: self.playlist_tracker.add_item(url_item)
                    return {"success": True, "message": f"Added '{url_to_add}' to the MPV playlist."}
                else:
                    raise RuntimeError(f"Failed to send loadfile command via IPC: {load_resp}")

            except Exception as e:
                logging.warning(f"Live playlist append failed unexpectedly: {e}.")
                if self.pid and not ipc_utils.is_process_alive(self.pid, self.ipc_path):
                    self.clear()
                return None

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
                
                title = removed_item.get('title') or "Item"
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

    def _launch(self, url_item, folder_id, settings, file_io, geometry, custom_width, custom_height, custom_mpv_flags, automatic_mpv_flags, start_paused, headers=None, disable_http_persistent=False, ytdl_raw_options=None, use_ytdl_mpv=False, is_youtube=False, full_playlist=None, force_terminal=False):
        """Launches a new instance of MPV with a single URL and prepares for playlist construction via IPC."""
        logging.info(f"Starting a new MPV instance for URL: {url_item.get('url')}")
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
                idle="once", # Use 'once' so mpv waits for the first file but exits on error/finish
                force_terminal=force_terminal
            )

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
                    item_headers = item.get('headers')
                    item_ytdl_raw_options = item.get('ytdl_raw_options')
                    item_use_ytdl_mpv = item.get('use_ytdl_mpv', False) or item.get('is_youtube', False)
                    
                    lua_options = {
                        "title": item.get('title'),
                        "headers": item_headers,
                        "ytdl_raw_options": item_ytdl_raw_options,
                        "use_ytdl_mpv": item_use_ytdl_mpv,
                        "original_url": item.get('original_url') or item.get('url'),
                        "disable_http_persistent": item.get('disable_http_persistent', False) or disable_http_persistent,
                        "cookies_file": item.get('cookies_file')
                    }
                    self.ipc_manager.send({"command": ["script-message", "set_url_options", item['url'], json.dumps(lua_options)]})
                logging.info(f"Registered options for {len(self.playlist)} items with adaptive_headers.lua")

            # Now start playback of the actual URL
            self.ipc_manager.send({"command": ["loadfile", url_item['url'], "replace"]})

            self.pid = self.process.pid
            self.owner_folder_id = folder_id
            self.is_alive = True
            
            # Persist session data to file so it can be restored if the native host restarts.
            try:
                session_data = {
                    "pid": self.pid,
                    "ipc_path": self.ipc_path,
                    "owner_folder_id": self.owner_folder_id
                }
                with open(self.session_file, 'w', encoding='utf-8') as f:
                    json.dump(session_data, f)
                logging.info(f"Saved session data to {self.session_file}")
            except Exception as e:
                logging.warning(f"Failed to write session file: {e}")
            
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
                
                # Robust Completion Check: Check for the flag file written by on_completion.lua
                # This handles cases where MPV exits with code 0 but actually finished the playlist.
                if self.ipc_path:
                    ipc_dir = os.path.dirname(self.ipc_path)
                    flag_file = os.path.join(ipc_dir, 'mpv_natural_completion.flag')
                    logging.info(f"Checking for natural completion flag at: {flag_file}")
                    
                    if os.path.exists(flag_file):
                        logging.info(f"Natural completion flag FOUND for folder '{f_id}'. Overriding return code to 99.")
                        return_code = 99
                        try:
                            os.remove(flag_file)
                        except Exception as e: 
                            logging.warning(f"Failed to remove flag file: {e}")
                    else:
                        logging.info(f"Natural completion flag NOT found for folder '{f_id}'.")

                logging.info(f"MPV process for folder '{f_id}' exited with code {return_code}.")
                self.send_message({"action": "mpv_exited", "folderId": f_id, "returnCode": return_code})
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

    def enrich_single_item(self, item):
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

        url_dict_for_analysis = {'url': item.get('url'), 'title': item.get('title'), 'id': item.get('id')}
        
        (
            processed_url,
            headers_for_mpv,
            ytdl_raw_options_for_mpv,
            use_ytdl_mpv_flag,
            is_youtube_flag_from_script,
            entries,
            disable_http_persistent_flag,
            cookies_file
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
        item['enriched'] = True
        return [item]

    def start(self, url_items_or_m3u, folder_id, settings, file_io, geometry=None, custom_width=None, custom_height=None, custom_mpv_flags=None, automatic_mpv_flags=None, start_paused=False, enriched_items_list=None, headers=None, disable_http_persistent=False, ytdl_raw_options=None, use_ytdl_mpv=False, is_youtube=False, force_terminal=False):
        logging.info(f"DEBUG: Start function received enriched_items_list (len): {len(enriched_items_list) if enriched_items_list is not None else 'None'}")
        """Starts a new mpv process with a playlist of URLs (or an M3U), loaded sequentially via IPC."""
        
        m3u_input_was_raw_content_or_items = False
        _url_items_list = enriched_items_list if enriched_items_list is not None else []
        m3u_content = None 

        if isinstance(url_items_or_m3u, str):
            # 1. Local Server URL check
            if url_items_or_m3u.startswith('http://localhost') and enriched_items_list is not None:
                 logging.info(f"Local M3U server URL detected: {url_items_or_m3u}. Skipping M3U parsing because enriched_items_list is provided.")
                 m3u_input_was_raw_content_or_items = False
            else:
                # 2. YouTube Playlist Check (Expansion before enrichment)
                is_youtube_playlist = "youtube.com/playlist" in url_items_or_m3u or ("youtube.com/watch" in url_items_or_m3u and "list=" in url_items_or_m3u)
                
                if is_youtube_playlist:
                    logging.info(f"Expanding YouTube playlist before enrichment: {url_items_or_m3u}")
                    # Use apply_bypass_script directly to get expansion results
                    _, _, _, _, _, entries, _, _ = apply_bypass_script({'url': url_items_or_m3u}, self.send_message)
                    if entries:
                        _url_items_list = entries
                        m3u_input_was_raw_content_or_items = True # Trigger enrichment for children
                        logging.info(f"Expanded YouTube playlist into {len(_url_items_list)} items.")
                    else:
                        logging.warning("YouTube playlist expansion returned no entries. Treating as single URL.")
                        _url_items_list = [{'url': url_items_or_m3u}]
                        m3u_input_was_raw_content_or_items = True

                # 3. M3U / Content check if not already expanded
                if not _url_items_list:
                    if os.path.exists(url_items_or_m3u):
                        m3u_input_was_raw_content_or_items = True
                        with open(url_items_or_m3u, 'r', encoding='utf-8') as f:
                            m3u_content = f.read()
                    elif urlparse(url_items_or_m3u).scheme in ['http', 'https']:
                        try:
                            fetch_headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'}
                            if headers: fetch_headers.update(headers)
                            req = Request(url_items_or_m3u, headers=fetch_headers)
                            with urlopen(req, timeout=10) as response:
                                m3u_content = response.read().decode('utf-8')
                            m3u_input_was_raw_content_or_items = True
                        except Exception as e:
                            logging.error(f"Failed to fetch M3U from URL {url_items_or_m3u}: {e}")
                            return {"success": False, "error": f"Failed to fetch M3U: {e}"}
                    else:
                        m3u_input_was_raw_content_or_items = True
                        m3u_content = url_items_or_m3u

                if m3u_content:
                    _url_items_list = parse_m3u(m3u_content)
                    logging.info(f"Parsed M3U content ({len(_url_items_list)} items).")

        elif isinstance(url_items_or_m3u, list):
            _url_items_list = url_items_or_m3u
            if enriched_items_list is None: m3u_input_was_raw_content_or_items = True
        elif isinstance(url_items_or_m3u, dict):
            _url_items_list = [url_items_or_m3u]
            if enriched_items_list is None: m3u_input_was_raw_content_or_items = True

        if not _url_items_list:
            return {"success": False, "error": "No URL items provided or parsed from M3U."}

        # --- Enrichment Logic ---
        if m3u_input_was_raw_content_or_items:
            from concurrent.futures import ThreadPoolExecutor

            # YouTube Playlist Check: Expansion if needed
            is_youtube_playlist = False
            if isinstance(url_items_or_m3u, str):
                is_youtube_playlist = "youtube.com/playlist" in url_items_or_m3u or ("youtube.com/watch" in url_items_or_m3u and "list=" in url_items_or_m3u)
            
            # Use Standard Flow optimization for YouTube: Just resolve the first item now.
            # Otherwise, for M3U flow (local files, non-YT URLs), resolve everything in parallel.
            is_definitely_m3u_flow = m3u_content is not None or (isinstance(url_items_or_m3u, str) and not is_youtube_playlist)
            
            if is_definitely_m3u_flow:
                logging.info(f"M3U-Flow suspected. Enriching ALL {len(_url_items_list)} items in parallel...")
                with ThreadPoolExecutor(max_workers=10) as executor:
                    results = list(executor.map(self.enrich_single_item, _url_items_list))
                _url_items_list = [item for sublist in results for item in sublist]

                # Generate Enriched M3U Content
                m3u_output_lines = ["#EXTM3U"]
                for item in _url_items_list:
                    title = item.get('title', item['url'])
                    m3u_output_lines.append(f"#EXTINF:-1,{title}")
                    if item.get('headers'):
                        header_string = "|".join([f"{k}={v}" for k, v in item['headers'].items()])
                        m3u_output_lines.append(f"#EXTHTTPHEADERS:{header_string}")
                    if item.get('ytdl_raw_options'):
                        options_val = item['ytdl_raw_options'].replace(',', '|')
                        m3u_output_lines.append(f"#EXTYTDLOPTIONS:{options_val}")
                    m3u_output_lines.append(item['url'])
                
                enriched_m3u_content = "\n".join(m3u_output_lines)
                return {
                    "success": True,
                    "enriched_m3u_content": enriched_m3u_content,
                    "enriched_url_items": _url_items_list,
                    "message": "Enriched content generated."
                }
            else:
                # Standard Flow optimization: Just resolve the first item now.
                logging.info("Standard-Flow suspected. Resolving first item only for quick launch.")
                first_item_list = self.enrich_single_item(_url_items_list[0])
                _url_items_list = first_item_list + _url_items_list[1:]
                # Proceed to Launch Logic below instead of returning early.

        # --- Launch Logic ---
        def get_opts(item):
            if not isinstance(item, dict): return headers, disable_http_persistent, ytdl_raw_options, use_ytdl_mpv, is_youtube
            h = item.get('headers') or headers
            d = item.get('disable_http_persistent', disable_http_persistent)
            y = item.get('ytdl_raw_options') or ytdl_raw_options
            u = item.get('use_ytdl_mpv', use_ytdl_mpv)
            i = item.get('is_youtube', is_youtube)
            return h, d, y, u, i
        
        if isinstance(url_items_or_m3u, str) and url_items_or_m3u.startswith('http://localhost'):
            launch_item = {'url': url_items_or_m3u}
            rest_items = []
            playlist_for_launch = _url_items_list
        else:
            launch_item = _url_items_list[0]
            rest_items = _url_items_list[1:]
            playlist_for_launch = [launch_item]

        if self.pid and not ipc_utils.is_process_alive(self.pid, self.ipc_path):
            self.clear()

        if self.pid:
            if folder_id == self.owner_folder_id:
                return {"success": True, "message": "MPV session already active.", "already_active": True}
            else:
                self.close()

        h, d, y, u, i = get_opts(launch_item)
        logging.info(f"Launching MPV with item 1/{len(_url_items_list)}: {launch_item.get('title', 'Unknown')}")
        
        launch_result = self._launch(
            launch_item, folder_id, settings, file_io,
            geometry=geometry, custom_width=custom_width, custom_height=custom_height, 
            custom_mpv_flags=custom_mpv_flags, automatic_mpv_flags=automatic_mpv_flags, 
            start_paused=start_paused, headers=h, disable_http_persistent=d,
            ytdl_raw_options=y, use_ytdl_mpv=u, is_youtube=i,
            full_playlist=playlist_for_launch,
            force_terminal=force_terminal
        )

        if launch_result and launch_result["success"] and rest_items:
            def append_remaining_items():
                time.sleep(1.5) # Give MPV time to start and initialize IPC
                if not self.is_alive: return
                
                logging.info(f"Standard Flow: Batch-appending {len(rest_items)} items for title visibility.")
                # 1. Immediate Batch Append (Unresolved webpage URLs)
                # This ensures titles are visible in the playlist ahead-of-time!
                self.append_batch(rest_items, mode="append")
                
                logging.info(f"Standard Flow: Starting sequential resolution for {len(rest_items)} items.")
                # 2. Sequential Resolution and Update
                for idx, item in enumerate(rest_items):
                    if not self.is_alive: break
                    
                    # Resolve background item
                    logging.debug(f"Enriching background item {idx+2}: {item.get('url')}")
                    enriched_results = self.enrich_single_item(item)
                    # Note: Expansion here is rare for YT, we take the first result
                    enriched_item = enriched_results[0]

                    logging.info(f"Updating item {idx+2}/{len(_url_items_list)}: {enriched_item.get('title', 'Unknown')}")
                    
                    try:
                        # Index in MPV: 0 is launch_item, 1 is rest_items[0], etc.
                        mpv_index = idx + 1
                        
                        # Register options for the NEW direct stream URL in Lua
                        lua_options = {
                            "id": enriched_item.get('id'),
                            "title": enriched_item.get('title'),
                            "headers": enriched_item.get('headers'),
                            "ytdl_raw_options": enriched_item.get('ytdl_raw_options'),
                            "use_ytdl_mpv": enriched_item.get('use_ytdl_mpv', False),
                            "original_url": enriched_item.get('original_url') or enriched_item.get('url'),
                            "disable_http_persistent": enriched_item.get('disable_http_persistent', False),
                            "cookies_file": enriched_item.get('cookies_file')
                        }
                        self.ipc_manager.send({"command": ["script-message", "set_url_options", enriched_item['url'], json.dumps(lua_options)]})
                        
                        # Update the URL in MPV's live playlist
                        self.ipc_manager.send({"command": ["set_property", f"playlist/{mpv_index}/url", enriched_item['url']]})
                        
                        # Sync local state
                        if mpv_index < len(self.playlist):
                            self.playlist[mpv_index] = enriched_item
                            if self.playlist_tracker:
                                self.playlist_tracker.update_playlist_order(self.playlist)

                    except Exception as e:
                        logging.error(f"Exception during background update for item {idx+2}: {e}")
                    
                    time.sleep(0.05) # Tiny delay
                logging.info("Standard Flow: Background resolution and updates finished.")
            
            threading.Thread(target=append_remaining_items, daemon=True).start()

        # If we reach here and launch was successful, and we were in enrichment phase,
        # return handled_directly to signal the caller to stop.
        if launch_result and launch_result.get("success") and m3u_input_was_raw_content_or_items:
            launch_result["handled_directly"] = True
            launch_result["enriched_url_items"] = _url_items_list

        return launch_result

    def close(self):
        """Closes the currently running mpv process, if any."""
        if self.playlist_tracker:
            self.playlist_tracker.stop_tracking()
            
        pid_to_close, ipc_path_to_use, process_object = None, None, None

        if self.process and self.process.poll() is None:
            pid_to_close, ipc_path_to_use, process_object = self.pid, self.ipc_path, self.process
        elif self.pid and ipc_utils.is_process_alive(self.pid, self.ipc_path):
             pid_to_close, ipc_path_to_use = self.pid, self.ipc_path

        if not pid_to_close:
            logging.info("Received 'close_mpv' command, but no active MPV process was found.")
            self.clear()
            return {"success": True, "message": "No running MPV instance was found."}

        try:
            if ipc_path_to_use:
                try:
                    logging.info(f"Attempting to close MPV (PID: {pid_to_close}) via IPC: {ipc_path_to_use}")
                    # Use the manager's send method for consistency.
                    if self.ipc_manager:
                        self.ipc_manager.send({"command": ["quit"]}, expect_response=False)
                    else:
                        logging.warning("IPC manager not available during close, attempting fallback quit command.")
                        # Fallback to direct socket communication if ipc_manager is unexpectedly None.
                        # This should ideally not be reached if the session was active.
                        try:
                            command_str = json.dumps({"command": ["quit"]}) + '\n'
                            if platform.system() == "Windows":
                                with open(ipc_path_to_use, 'w', encoding='utf-8') as pipe:
                                    pipe.write(command_str)
                            else:
                                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
                                    sock.settimeout(1.0) # Short timeout
                                    sock.connect(ipc_path_to_use)
                                    sock.sendall(command_str.encode('utf-8'))
                        except Exception as e:
                            logging.warning(f"Fallback IPC quit command failed: {e}")
                            
                    if process_object: process_object.wait(timeout=3)
                    else: time.sleep(1)
                    
                    if not ipc_utils.is_process_alive(pid_to_close, ipc_path_to_use):
                        logging.info(f"MPV process (PID: {pid_to_close}) closed gracefully via IPC.")
                        return {"success": True, "message": "MPV instance has been closed."}
                except Exception as e:
                    logging.warning(f"IPC command to close MPV failed: {e}. Falling back to signal method.")

            logging.info(f"Attempting to close MPV process (PID: {pid_to_close}) via signal fallback.")
            if process_object:
                if platform.system() == "Windows": process_object.send_signal(signal.CTRL_C_EVENT)
                else: process_object.terminate()
                process_object.wait(timeout=5)
            else:
                if platform.system() == "Windows":
                    os.kill(pid_to_close, signal.SIGTERM)
                else:
                    os.kill(pid_to_close, signal.SIGTERM)
                time.sleep(2)

            if not ipc_utils.is_process_alive(pid_to_close, ipc_path_to_use):
                logging.info(f"MPV process (PID: {pid_to_close}) terminated successfully via signal.")
                return {"success": True, "message": "MPV instance has been closed."}
            else:
                raise subprocess.TimeoutExpired(None, timeout=0)

        except subprocess.TimeoutExpired:
            logging.warning(f"MPV process (PID: {pid_to_close}) did not terminate in time, forcing kill.")
            if process_object: process_object.kill()
            else: os.kill(pid_to_close, signal.SIGKILL)
            return {"success": True, "message": "MPV instance was forcefully closed."}
        except Exception as e:
            error_msg = f"An error occurred while closing MPV process (PID: {pid_to_close}): {e}"
            logging.error(error_msg)
            return {"success": False, "error": error_msg}
        finally:
            self.clear()
