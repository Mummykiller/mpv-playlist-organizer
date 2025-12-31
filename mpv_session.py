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
            
            # Deduplicate by ID if available, otherwise by URL
            item_id = item.get('id')
            item_url = item.get('url')
            is_duplicate = False
            if item_id:
                is_duplicate = any(i.get('id') == item_id for i in self.playlist)
            else:
                is_duplicate = any(i.get('url') == item_url for i in self.playlist)

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
            
            # Check for duplicates using ID (primary) or URL (fallback)
            if self.playlist:
                item_id = url_item.get('id')
                item_url = url_item['url']
                
                is_duplicate = False
                if item_id:
                    is_duplicate = any(i.get('id') == item_id for i in self.playlist)
                else:
                    is_duplicate = any(i.get('url') == item_url for i in self.playlist)
                
                if is_duplicate:
                    logging.info(f"Item already in playlist (ID/URL match). Not re-adding.")
                    return {"success": True, "message": "Item already in playlist.", "skipped": True}

            try:
                # Helper to send commands robustly, attempting reconnection if needed
                def robust_send(command, timeout=1.0):
                    result = self.ipc_manager.send(command, expect_response=True, timeout=timeout)
                    if result is None:
                        logging.warning("IPC command failed. Attempting to reconnect...")
                        if self.ipc_manager.connect(self.ipc_path):
                            return self.ipc_manager.send(command, expect_response=True, timeout=timeout)
                    return result

                # Check if URL is already in MPV playlist to prevent duplicates from retries
                playlist_resp = robust_send({"command": ["get_property", "playlist"]}, timeout=2.0)
                if playlist_resp and playlist_resp.get("error") == "success":
                    mpv_playlist = playlist_resp.get("data", [])
                    for item in mpv_playlist:
                        if item.get("filename") == url_to_add:
                            logging.info(f"URL '{url_to_add}' found in MPV playlist via IPC. Skipping loadfile.")
                            # Ensure internal state is synced
                            if self.playlist is None: self.playlist = []
                            if url_to_add not in [i['url'] for i in self.playlist]:
                                self.playlist.append(url_item)
                                if self.playlist_tracker: self.playlist_tracker.add_item(url_item)
                            return {"success": True, "message": "Item already in playlist (synced).", "skipped": True}

                # Construct options for the item
                # Instead of putting them in the loadfile string or setting global properties,
                # we send them to the 'adaptive_headers.lua' script which applies them on_load.
                effective_headers = url_item.get('headers') if 'headers' in url_item else headers
                effective_ytdl_raw_options = url_item.get('ytdl_raw_options') if 'ytdl_raw_options' in url_item else ytdl_raw_options
                effective_use_ytdl_mpv = url_item.get('use_ytdl_mpv') if 'use_ytdl_mpv' in url_item else use_ytdl_mpv
                effective_is_youtube = url_item.get('is_youtube') if 'is_youtube' in url_item else is_youtube

                lua_options = {
                    "title": url_item.get('title'),
                    "headers": effective_headers,
                    "ytdl_raw_options": effective_ytdl_raw_options,
                    "use_ytdl_mpv": effective_use_ytdl_mpv or effective_is_youtube,
                    "original_url": url_item.get('original_url') or url_item.get('url'),
                    "disable_http_persistent": url_item.get('disable_http_persistent', False) or disable_http_persistent,
                    "cookies_file": url_item.get('cookies_file')
                }
                robust_send({"command": ["script-message", "set_url_options", url_to_add, json.dumps(lua_options)]})

                # Simple loadfile command
                ipc_command = {"command": ["loadfile", url_to_add, mode]}

                logging.info(f"Loading URL '{url_to_add}' with mode '{mode}' and adaptive settings registered via script message.")

                load_resp = robust_send(ipc_command)
                
                if load_resp is None or load_resp.get("error") != "success":
                    raise RuntimeError(f"Failed to send loadfile command via IPC: {load_resp}")

                return {"success": True, "message": f"Added '{url_to_add}' to the MPV playlist."}
            except Exception as e:
                logging.warning(f"Live playlist append failed unexpectedly: {e}.")
                # Only clear the session if the process is actually dead.
                if self.pid and not ipc_utils.is_process_alive(self.pid, self.ipc_path):
                    logging.warning("MPV process appears dead. Clearing session state.")
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

    def _launch(self, url_item, folder_id, settings, file_io, geometry, custom_width, custom_height, custom_mpv_flags, automatic_mpv_flags, start_paused, headers=None, disable_http_persistent=False, ytdl_raw_options=None, use_ytdl_mpv=False, is_youtube=False, full_playlist=None):
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
                is_youtube_override=is_youtube,
                idle="once" # Use 'once' so mpv waits for the first file but exits on error/finish
            )

            popen_kwargs = services.get_mpv_popen_kwargs(has_terminal_flag)

            # Launch MPV
            self.process = subprocess.Popen(full_command, **popen_kwargs)
            self.ipc_path = ipc_path
            self.ipc_manager = ipc_utils.IPCSocketManager()
            if not self.ipc_manager.connect(self.ipc_path):
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
            
            # We pass the full intended playlist to the tracker, even though only one item is loaded initially
            self.playlist_tracker = PlaylistTracker(folder_id, self.playlist, file_io, settings, self.ipc_path)
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

            stderr_thread = threading.Thread(target=self.log_stream, args=(self.process.stdout, logging.warning, folder_id))
            stderr_thread.daemon = True
            stderr_thread.start()

            def process_waiter(proc, f_id):
                return_code = proc.wait()
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

    def start(self, url_items_or_m3u, folder_id, settings, file_io, geometry=None, custom_width=None, custom_height=None, custom_mpv_flags=None, automatic_mpv_flags=None, start_paused=False, enriched_items_list=None, headers=None, disable_http_persistent=False, ytdl_raw_options=None, use_ytdl_mpv=False, is_youtube=False):
        logging.info(f"DEBUG: Start function received enriched_items_list (len): {len(enriched_items_list) if enriched_items_list is not None else 'None'}")
        """Starts a new mpv process with a playlist of URLs (or an M3U), loaded sequentially via IPC."""
        
        m3u_input_was_raw_content_or_items = False # Initialize the flag at the very top
        _url_items_list = enriched_items_list if enriched_items_list is not None else []
        m3u_content = None # Initialize m3u_content to ensure it's always defined
        if isinstance(url_items_or_m3u, str):
            # Check if it's the local server URL first
            if url_items_or_m3u.startswith('http://localhost') and enriched_items_list is not None:
                 logging.info(f"Local M3U server URL detected: {url_items_or_m3u}. Skipping M3U parsing because enriched_items_list is provided.")
                 m3u_input_was_raw_content_or_items = False
            else:
                # Attempt to parse as M3U
                logging.info(f"Attempting to parse M3U: {url_items_or_m3u}")
                # Check if it's a file path
                if os.path.exists(url_items_or_m3u):
                    m3u_input_was_raw_content_or_items = True
                    with open(url_items_or_m3u, 'r', encoding='utf-8') as f:
                        m3u_content = f.read()
                    logging.info(f"Read M3U from local file: {url_items_or_m3u}")
                # Check if it's a remote URL
                elif urlparse(url_items_or_m3u).scheme in ['http', 'https']:
                    # Only fetch if it's a remote URL (already checked localhost above)
                    try:
                        # Use provided headers or fallback to a sensible default
                        fetch_headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'}
                        if headers:
                            fetch_headers.update(headers)
                        
                        req = Request(url_items_or_m3u, headers=fetch_headers)
                        with urlopen(req, timeout=10) as response:
                            m3u_content = response.read().decode('utf-8')
                        m3u_input_was_raw_content_or_items = True # Treat fetched content as raw for enrichment
                        logging.info(f"Fetched M3U from remote URL: {url_items_or_m3u}")
                    except Exception as e:
                        logging.error(f"Failed to fetch M3U from URL {url_items_or_m3u}: {e}")
                        return {"success": False, "error": f"Failed to fetch M3U: {e}"}
                else:
                    # If it's a string, but not a URL or file path, it's raw M3U content.
                    m3u_input_was_raw_content_or_items = True
                    m3u_content = url_items_or_m3u
                    logging.info("Input string treated as raw M3U content.")

            if m3u_content:
                _url_items_list = parse_m3u(m3u_content)
                logging.info(f"Parsed M3U content ({len(_url_items_list)} items).")
            elif m3u_input_was_raw_content_or_items:
                return {"success": False, "error": "M3U content could not be loaded."}
        elif isinstance(url_items_or_m3u, list):
            _url_items_list = url_items_or_m3u
            if enriched_items_list is None:
                m3u_input_was_raw_content_or_items = True
        elif isinstance(url_items_or_m3u, dict):
            _url_items_list = [url_items_or_m3u]
            m3u_input_was_raw_content_or_items = True
        else:
            return {"success": False, "error": "Invalid type for url_items_or_m3u. Expected list, dict, or string (M3U path/URL)."}

        if not _url_items_list:
            return {"success": False, "error": "No URL items provided or parsed from M3U."}

        # --- NEW: Enrich url_items with dynamically determined playback options ---
        # This enrichment and M3U generation ONLY happens during the first call
        # (when raw M3U content/URLs are provided).
        if m3u_input_was_raw_content_or_items:
            from concurrent.futures import ThreadPoolExecutor

            def enrich_item(item):
                # If item is already resolved, skip
                if item.get('enriched'):
                    return item

                # Ensure item has an ID
                if not item.get('id'):
                    item['id'] = str(uuid.uuid4())

                # Store the original URL before it potentially gets replaced
                if not item.get('original_url'):
                    item['original_url'] = item.get('url')

                # item.get('url') is used here, but it's important to pass a dictionary
                # that apply_bypass_script can work with.
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
                
                # Update the original item with the enriched data
                item['url'] = processed_url # This might be a resolved URL
                
                # Merge headers (M3U headers take precedence if they exist)
                if headers_for_mpv:
                    if not item.get('headers'):
                        item['headers'] = headers_for_mpv
                    else:
                        # Merge them, keeping existing ones
                        merged_headers = headers_for_mpv.copy()
                        merged_headers.update(item['headers'])
                        item['headers'] = merged_headers

                # Merge YTDL options
                if ytdl_raw_options_for_mpv:
                    if not item.get('ytdl_raw_options'):
                        item['ytdl_raw_options'] = ytdl_raw_options_for_mpv
                    else:
                        # Both exist, merge comma-separated strings
                        existing = item['ytdl_raw_options'].split(',')
                        new_opts = ytdl_raw_options_for_mpv.split(',')
                        # Create a dict to de-duplicate by key
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
                item['disable_http_persistent'] = disable_http_persistent_flag # Pass the flag
                item['cookies_file'] = cookies_file
                item['enriched'] = True
                return item

            logging.info(f"Enriching {len(_url_items_list)} items in parallel...")
            with ThreadPoolExecutor(max_workers=10) as executor:
                enriched_url_items = list(executor.map(enrich_item, _url_items_list))
            
            _url_items_list = enriched_url_items # Use the enriched list for subsequent processing

            # --- Generate Enriched M3U Content ---
            m3u_output_lines = ["#EXTM3U"]
            for item in _url_items_list:
                title = item.get('title', item['url'])
                m3u_output_lines.append(f"#EXTINF:-1,{title}")

                # Add #EXTHTTPHEADERS using '|' and '=' for robustness
                if item.get('headers'):
                    header_string = "|".join([f"{k}={v}" for k, v in item['headers'].items()])
                    m3u_output_lines.append(f"#EXTHTTPHEADERS:{header_string}")
                
                # Add #EXTYTDLOPTIONS
                if item.get('ytdl_raw_options'):
                    # Use '|' as separator for our custom tag to avoid confusion with commas in values
                    options_val = item['ytdl_raw_options'].replace(',', '|')
                    m3u_output_lines.append(f"#EXTYTDLOPTIONS:{options_val}")
                
                m3u_output_lines.append(item['url'])
            
            enriched_m3u_content = "\n".join(m3u_output_lines)
            logging.info("Generated enriched M3U content for server.")

            return {
                "success": True,
                "enriched_m3u_content": enriched_m3u_content,
                "enriched_url_items": _url_items_list, # The list of items with their dynamic options
                "message": "Enriched M3U content generated. Ready for server."
            }

        # --- END NEW ENRICHMENT LOGIC ---

        # --- Remaining logic is for launching MPV after server is ready ---
        # If we reach this point, it means `url_items_or_m3u` is either:
        # 1. A single URL string (e.g., the local M3U server URL or a direct media URL)
        # 2. A list of URL items that are already enriched and will be played directly (legacy flow)

        def get_opts(item):
            h = item.get('headers') if isinstance(item, dict) and item.get('headers') else headers
            d = item.get('disable_http_persistent') if isinstance(item, dict) and 'disable_http_persistent' in item else disable_http_persistent
            y = item.get('ytdl_raw_options') if isinstance(item, dict) and item.get('ytdl_raw_options') else ytdl_raw_options
            u = item.get('use_ytdl_mpv') if isinstance(item, dict) and 'use_ytdl_mpv' in item else use_ytdl_mpv
            i = item.get('is_youtube') if isinstance(item, dict) and 'is_youtube' in item else is_youtube
            return h, d, y, u, i
        
        # Determine the effective _url_items_list for direct MPV launch.
        # If it was a raw M3U string, _url_items_list would contain the enriched items from the first pass.
        # If it was already a list of enriched items, use that.
        # If it's a single URL string (like the local server URL), create a single item list.
        logging.info(f"DEBUG: Before launch. url_items_or_m3u type: {type(url_items_or_m3u)}, _url_items_list len: {len(_url_items_list)}")
        
        if isinstance(url_items_or_m3u, str) and url_items_or_m3u.startswith('http://localhost'):
            # M3U Flow: Launch with the local server URL
            # We do NOT set a title here so that MPV can use the individual titles from the M3U (#EXTINF)
            launch_item = {'url': url_items_or_m3u}
            rest_items = []
            # For M3U flow, we pass the full list of enriched items so the tracker knows them all
            # and self.playlist is populated with them immediately.
            playlist_for_launch = _url_items_list
        else:
            # Standard Flow: Launch with the first item, append the rest
            launch_item = _url_items_list[0]
            rest_items = _url_items_list[1:]
            # For Standard flow, we ONLY pass the first item.
            # The rest will be added to self.playlist and the tracker via the append() loop.
            playlist_for_launch = [launch_item]

        # Original logic for checking and launching MPV
        if self.pid and not ipc_utils.is_process_alive(self.pid, self.ipc_path):
            logging.info("Detected a stale MPV session. Clearing state before proceeding.")
            self.clear()

        if self.pid:
            if folder_id == self.owner_folder_id:
                # If we are here, it means the caller (native_host_handlers) might want
                # to sync/append to the active session. We return success but indicate
                # that a launch is not needed.
                logging.info(f"Session for folder '{folder_id}' is already active. Launch skipped.")
                return {"success": True, "message": "MPV session already active.", "already_active": True}
            else:
                logging.info(f"Switching from folder '{self.owner_folder_id}' to '{folder_id}'. Closing current session.")
                self.close()
                # After close(), self.pid is None and state is cleared, so we proceed to launch the new session.

        h, d, y, u, i = get_opts(launch_item)
        logging.info(f"Standard Flow: Launching MPV with item 1/{len(_url_items_list)}: {launch_item.get('title', 'Unknown')}")
        
        launch_result = self._launch(
            launch_item, folder_id, settings, file_io,
            geometry=geometry, 
            custom_width=custom_width, 
            custom_height=custom_height, 
            custom_mpv_flags=custom_mpv_flags, 
            automatic_mpv_flags=automatic_mpv_flags, 
            start_paused=start_paused, 
            headers=h, 
            disable_http_persistent=d,
            ytdl_raw_options=y,
            use_ytdl_mpv=u,
            is_youtube=i,
            full_playlist=playlist_for_launch # Pass the correct initial playlist state
        )

        if launch_result and launch_result["success"] and rest_items:
            logging.info(f"Standard Flow: MPV launch successful. Starting thread to append {len(rest_items)} remaining items.")
            def append_remaining_items():
                time.sleep(1.5)  # Give MPV time to start and initialize IPC
                logging.info("Standard Flow: Append thread started.")
                for idx, item in enumerate(rest_items):
                    if not self.is_alive:
                        logging.warning("MPV session ended prematurely. Stopping append thread.")
                        break
                    
                    logging.info(f"Standard Flow: Appending item {idx+2}/{len(_url_items_list)}: {item.get('title', 'Unknown')}")
                    h_item, d_item, y_item, u_item, i_item = get_opts(item)
                    try:
                        resp = self.append(item, headers=h_item, mode="append", disable_http_persistent=d_item, ytdl_raw_options=y_item, use_ytdl_mpv=u_item, is_youtube=i_item)
                        if resp and resp.get('success'):
                            logging.info(f"Standard Flow: Append success for item {idx+2}")
                        else:
                            logging.warning(f"Standard Flow: Append failed for item {idx+2}: {resp}")
                    except Exception as e:
                        logging.error(f"Standard Flow: Exception during append for item {idx+2}: {e}")
                    
                    time.sleep(0.1) # Tiny delay to prevent IPC flooding
                logging.info("Standard Flow: Append thread finished.")

            threading.Thread(target=append_remaining_items, daemon=True).start()
        elif not rest_items:
            logging.info("Standard Flow: No remaining items to append.")
        else:
            logging.error("Standard Flow: MPV launch failed, cannot append remaining items.")

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
