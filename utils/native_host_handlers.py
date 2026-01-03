import logging
import os
import time
import uuid
import platform
import subprocess
import re # Added for parsing server output
import sys # Added for sys.executable
from urllib.request import urlopen # Added for server readiness check

os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
sys.dont_write_bytecode = True

# Constants for file patterns
SERVER_PREFIX = "server_"
SERVER_EXT = ".m3u"

class HandlerManager:
    def __init__(self, mpv_session, file_io_module, services_module, ipc_utils_module,
                 send_message_func, script_dir, anilist_cache_file, temp_playlists_dir, log_stream_func):
        self.mpv_session = mpv_session
        self.file_io = file_io_module
        self.services = services_module
        self.ipc_utils = ipc_utils_module
        self.send_message = send_message_func
        self.script_dir = script_dir
        self.anilist_cache_file = anilist_cache_file
        self.temp_playlists_dir = temp_playlists_dir
        self.log_stream = log_stream_func # Passed from native_host for unmanaged MPV logging

        self.playlist_server_process = None
        self.playlist_server_port = None
        self.temp_m3u_file_for_server = None

    def _process_url_item(self, url_item, folder_id, bypass_scripts_config, all_folders):
        """
        Helper to process a single URL item: resolves/assigns ID and applies bypass scripts.
        If the item is a playlist, it expands it and processes each entry.
        Returns a list of updated `url_items` and the updated `all_folders`.
        """
        # Ensure item is a dict
        if isinstance(url_item, str): 
            url_item = {'url': url_item}
        
        # Call the refactored _resolve_or_assign_item_id
        url_item, all_folders = self._resolve_or_assign_item_id(url_item, folder_id, all_folders)
        
        # New return signature from apply_bypass_script (9 values)
        processed_url, script_headers, ytdl_options, use_ytdl_mpv_flag, is_youtube_flag, entries, disable_http_persistent_flag, cookies_file, mark_watched_flag = self.services.apply_bypass_script(
            url_item, self.send_message
        )

        if entries:
            # Expansion occurred!
            processed_entries = []
            for entry in entries:
                # Assign unique ID to every new entry
                entry['id'] = str(uuid.uuid4())
                entry, all_folders = self._resolve_or_assign_item_id(entry, folder_id, all_folders)
                
                # Ensure entries are treated as YouTube but resolved externally
                entry['is_youtube'] = True
                entry['use_ytdl_mpv'] = False
                # Pass the flag to children if they were part of a playlist that triggered it
                if disable_http_persistent_flag:
                    entry['disable_http_persistent'] = True
                processed_entries.append(entry)
            
            # Remove the original "playlist container" item from the folder
            if 'playlist' in all_folders[folder_id]:
                all_folders[folder_id]['playlist'] = [i for i in all_folders[folder_id]['playlist'] if i.get('id') != url_item.get('id')]
            
            return processed_entries, all_folders

        # Single item processing
        url_item['url'] = processed_url # Update URL with processed one
        if script_headers: url_item['headers'] = script_headers
        if ytdl_options: url_item['ytdl_raw_options'] = ytdl_options
        url_item['use_ytdl_mpv'] = use_ytdl_mpv_flag
        url_item['is_youtube'] = is_youtube_flag
        url_item['cookies_file'] = cookies_file # Store cookie path
        url_item['mark_watched'] = mark_watched_flag # Store mark watched flag
        
        # Respect the flag from url_analyzer or fallback to header-based logic
        url_item['disable_http_persistent'] = disable_http_persistent_flag
        
        return [url_item], all_folders

    def _resolve_or_assign_item_id(self, url_item, folder_id, all_folders):
        """
        Ensures a url_item has a stable ID. 
        If the item already has an ID, we check if it exists in the folder to update it.
        Otherwise, a new UUID is assigned.
        URL-based deduplication is removed to allow multiple entries of the same URL.
        """
        logging.debug(f"ResolveOrAssignId: Processing url_item: {url_item.get('title') or url_item['url']}, folder_id: {folder_id}")
        
        if folder_id not in all_folders:
            all_folders[folder_id] = {"playlist": []}
            logging.debug(f"ResolveOrAssignId: Created new folder '{folder_id}'.")

        folder_data = all_folders[folder_id]
        playlist = folder_data.get("playlist", [])

        item_id = url_item.get('id')

        if item_id:
            # Check if this specific ID already exists in the playlist to update it
            for stored_item in playlist:
                if stored_item.get('id') == item_id:
                    logging.debug(f"ResolveOrAssignId: Found existing item by ID: {item_id}. Updating.")
                    stored_item.update(url_item)
                    return url_item, all_folders
        else:
            # No ID provided, generate a new one
            item_id = str(uuid.uuid4())
            url_item['id'] = item_id
            logging.debug(f"ResolveOrAssignId: Assigned new ID: {item_id}")
        
        # If we reach here, it's a new entry (even if URL is same as another)
        playlist.append(url_item)
        folder_data["playlist"] = playlist
        logging.debug(f"ResolveOrAssignId: Added item to folder '{folder_id}'. Item ID: {item_id}")
        return url_item, all_folders

    def handle_play(self, message):
        url_item = message.get('url_item')
        folder_id = message.get('folderId')
        if not folder_id or not url_item:
            return {"success": False, "error": "Missing folderId or url_item for play action."}

        logging.debug(f"handle_play: Original url_item from extension: {url_item}")
        
        # Get settings from config file
        settings = self.file_io.get_settings()
        
        # Merge extension-provided networking and performance overrides
        for key in ['disable_network_overrides', 'enable_cache', 'http_persistence', 
                    'demuxer_max_bytes', 'demuxer_max_back_bytes', 'cache_secs', 
                    'demuxer_readahead_secs', 'stream_buffer_size', 'ytdlp_concurrent_fragments', 
                    'enable_reconnect', 'reconnect_delay', 'mpv_decoder']:
            if key in message:
                settings[key] = message[key]

        # --- STEP 1: Process and Enrich ---
        # Call mpv_session.start() with the raw item to trigger enrichment.
        first_call_result = self.mpv_session.start(
            url_item, 
            folder_id, 
            settings, 
            self.file_io,
            geometry=message.get('geometry'), 
            custom_width=message.get('custom_width'), 
            custom_height=message.get('custom_height'), 
            custom_mpv_flags=message.get('custom_mpv_flags'), 
            automatic_mpv_flags=message.get('automatic_mpv_flags'), 
            start_paused=message.get('start_paused', False),
            force_terminal=message.get('force_terminal', False)
        )
        
        if not first_call_result["success"]:
            return first_call_result

        enriched_url_items = first_call_result["enriched_url_items"]
        enriched_item = enriched_url_items[0]

        # --- STEP 2: Direct Launch ---
        # Launch MPV with the enriched item's direct URL.
        # This avoids the M3U HTTP server and thus avoids protocol restrictions for EDL.
        result = self.mpv_session.start(
            enriched_item, # Launch with the single enriched item
            folder_id, 
            settings, 
            self.file_io,
            geometry=message.get('geometry'), 
            custom_width=message.get('custom_width'), 
            custom_height=message.get('custom_height'), 
            custom_mpv_flags=message.get('custom_mpv_flags'), 
            automatic_mpv_flags=message.get('automatic_mpv_flags'), 
            start_paused=message.get('start_paused', False),
            enriched_items_list=enriched_url_items,
            headers=enriched_item.get('headers'),
            ytdl_raw_options=enriched_item.get('ytdl_raw_options'),
            use_ytdl_mpv=enriched_item.get('use_ytdl_mpv', False),
            is_youtube=enriched_item.get('is_youtube', False),
            disable_http_persistent=enriched_item.get('disable_http_persistent', False),
            force_terminal=message.get('force_terminal', False)
        )
        
        return result if result else {"success": False, "error": "Failed to start MPV session."}

    def handle_play_batch(self, message):
        playlist = message.get('playlist')
        folder_id = message.get('folderId')
        if not folder_id or not playlist:
            return {"success": False, "error": "Missing folderId or playlist for play_batch action."}

        logging.info(f"Processing play_batch request for folder '{folder_id}' with {len(playlist)} items.")
        
        settings = self.file_io.get_settings()
        
        # Merge extension-provided networking and performance overrides
        for key in ['disable_network_overrides', 'enable_cache', 'http_persistence', 
                    'demuxer_max_bytes', 'demuxer_max_back_bytes', 'cache_secs', 
                    'demuxer_readahead_secs', 'stream_buffer_size', 'ytdlp_concurrent_fragments', 
                    'enable_reconnect', 'reconnect_delay', 'mpv_decoder']:
            if key in message:
                settings[key] = message[key]

        # --- STEP 1: Process and Enrich ---
        # Call mpv_session.start() with the list to trigger parallel enrichment.
        first_call_result = self.mpv_session.start(
            playlist, 
            folder_id, 
            settings, 
            self.file_io,
            geometry=message.get('geometry'), 
            custom_width=message.get('custom_width'), 
            custom_height=message.get('custom_height'), 
            custom_mpv_flags=message.get('custom_mpv_flags'), 
            automatic_mpv_flags=message.get('automatic_mpv_flags'), 
            start_paused=message.get('start_paused', False),
            force_terminal=message.get('force_terminal', False)
        )
        
        if not first_call_result["success"]:
            return first_call_result

        enriched_url_items = first_call_result["enriched_url_items"]

        # Baseline flags from first item
        first_item = enriched_url_items[0] if enriched_url_items else {}
        global_headers = first_item.get('headers')
        global_ytdl_raw_options = first_item.get('ytdl_raw_options')
        global_use_ytdl_mpv = any(item.get('use_ytdl_mpv', False) for item in enriched_url_items)
        global_is_youtube = any(item.get('is_youtube', False) for item in enriched_url_items)
        global_disable_http_persistent = first_item.get('disable_http_persistent', False)

        # --- STEP 2: Direct Launch ---
        # Launch MPV with the first item's direct URL, others will be appended via IPC.
        # This avoids the M3U HTTP server.
        result = self.mpv_session.start(
            enriched_url_items, # Launch with the full enriched list
            folder_id, 
            settings, 
            self.file_io,
            geometry=message.get('geometry'), 
            custom_width=message.get('custom_width'), 
            custom_height=message.get('custom_height'), 
            custom_mpv_flags=message.get('custom_mpv_flags'), 
            automatic_mpv_flags=message.get('automatic_mpv_flags'), 
            start_paused=message.get('start_paused', False),
            enriched_items_list=enriched_url_items,
            headers=global_headers,
            ytdl_raw_options=global_ytdl_raw_options,
            use_ytdl_mpv=global_use_ytdl_mpv,
            is_youtube=global_is_youtube,
            disable_http_persistent=global_disable_http_persistent,
            force_terminal=message.get('force_terminal', False)
        )
        
        return result

    def handle_remove_item_live(self, message):
        folder_id = message.get('folderId')
        item_id = message.get('item_id')
        if not folder_id or not item_id:
            return {"success": False, "error": "Missing folderId or item_id."}
        return self.mpv_session.remove(item_id, folder_id)

    def handle_reorder_live(self, message):
        folder_id = message.get('folderId')
        new_order = message.get('new_order')
        if not folder_id or not new_order:
            return {"success": False, "error": "Missing folderId or new_order."}
        return self.mpv_session.reorder(folder_id, new_order)

    def handle_append(self, message):
        url_item = message.get('url_item')
        folder_id = message.get('folderId') # Append also needs folder_id to resolve/assign ID
        if not url_item or not folder_id:
            return {"success": False, "error": "Missing url_item or folderId for append action."}
        
        logging.debug(f"handle_append: Original url_item from extension: {url_item}")
        
        # Fetch all_folders once
        all_folders = self.file_io.get_all_folders_from_file()

        # Prepare URL item (resolve ID, apply bypass scripts)
        bypass_scripts_config = message.get('bypassScripts', {})
        url_items, _ = self._process_url_item(url_item, folder_id, bypass_scripts_config, all_folders)
        logging.debug(f"handle_append: items after processing: {url_items}")

        # NOTE FOR FUTURE EDITORS: We always use 'append_batch' (M3U method) even for single items.
        # This is because 'loadlist' on a temporary M3U is the only IPC mechanism that forces 
        # MPV to accept our custom titles via #EXTINF. Simple 'loadfile' calls will fail to 
        # show titles. Do not "optimize" this to a single append call.
        return self.mpv_session.append_batch(url_items)

    def _launch_unmanaged_mpv(self, playlist, geometry, custom_width, custom_height, custom_mpv_flags, automatic_mpv_flags):
        """Helper to launch unmanaged MPV, moved from native_host.py."""
        logging.info("Launching a new, unmanaged MPV instance.")
        mpv_exe = self.file_io.get_mpv_executable()
        settings = self.file_io.get_settings()
        
        try:
            full_command, has_terminal_flag = self.services.construct_mpv_command(
                mpv_exe=mpv_exe,
                url=playlist,
                geometry=geometry,
                custom_width=custom_width,
                custom_height=custom_height,
                custom_mpv_flags=custom_mpv_flags,
                automatic_mpv_flags=automatic_mpv_flags,
                settings=settings
            )

            popen_kwargs = self.services.get_mpv_popen_kwargs(has_terminal_flag)

            process = subprocess.Popen(full_command, **popen_kwargs)
            
            # log_stream is a global function in native_host.py, needs to be passed
            stderr_thread = threading.Thread(target=self.log_stream, args=(process.stderr, logging.warning, None))
            stderr_thread.daemon = True
            stderr_thread.start()
    
            logging.info(f"Unmanaged MPV process launched (PID: {process.pid}) with {len(playlist)} items.")
            return {"success": True, "message": "New MPV instance launched."}
        except Exception as e:
            logging.error(f"An error occurred while trying to launch unmanaged mpv: {e}")
            return {"success": False, "error": f"Error launching new mpv instance: {e}"}

    def handle_play_new_instance(self, message):
        return self._launch_unmanaged_mpv(
            message.get('playlist', []), 
            message.get('geometry'), 
            message.get('custom_width'), 
            message.get('custom_height'), 
            message.get('custom_mpv_flags'), 
            message.get('automatic_mpv_flags')
        )

    def handle_close_mpv(self, message):
        response = self.mpv_session.close()
        self._stop_local_m3u_server() # Also stop the M3U server when MPV is closed
        return response

    def handle_is_mpv_running(self, message):
        is_running = self.ipc_utils.is_process_alive(self.mpv_session.pid, self.mpv_session.ipc_path)
        if not is_running and self.mpv_session.pid:
            self.mpv_session.clear()
        logging.info(f"MPV running status check: {is_running} (Path: {self.mpv_session.ipc_path})")
        return {
            "success": True, 
            "is_running": is_running,
            "folderId": self.mpv_session.owner_folder_id if is_running else None
        }

    def handle_export_data(self, message):
        data = message.get('data')
        return self.file_io.write_folders_file(data) if data is not None else {"success": False, "error": "No data provided."}

    def handle_export_playlists(self, message):
        data = message.get('data')
        filename = message.get('filename')
        if not data or not filename: return {"success": False, "error": "Missing data or filename."}
        return self.file_io.write_export_file(filename, data)

    def handle_export_all_separately(self, message):
        folders = message.get('data')
        if not folders: return {"success": False, "error": "No folder data provided."}
        count = 0
        for f_id, f_data in folders.items():
            if 'playlist' in f_data:
                safe_name = "".join(c if c.isalnum() or c in ('-', '_') else '_' for c in f_id).rstrip()
                if self.file_io.write_export_file(safe_name, f_data['playlist'])["success"]: count += 1
        return {"success": True, "message": f"Successfully exported {count} playlists."}

    def handle_list_import_files(self, message):
        return self.file_io.list_import_files()

    def handle_import_from_file(self, message):
        filename = message.get('filename')
        if not filename: return {"success": False, "error": "No filename provided."}
        try:
            filepath = os.path.abspath(os.path.join(self.file_io.EXPORT_DIR, filename))
            if not filepath.startswith(os.path.abspath(self.file_io.EXPORT_DIR)):
                return {"success": False, "error": "Access denied."}
            with open(filepath, 'r', encoding='utf-8') as f:
                return {"success": True, "data": f.read()}
        except Exception as e:
            return {"success": False, "error": f"Failed to read file: {e}"}

    def handle_open_export_folder(self, message):
        try:
            os.makedirs(self.file_io.EXPORT_DIR, exist_ok=True)
            path = os.path.abspath(self.file_io.EXPORT_DIR)
            if platform.system() == "Windows": subprocess.Popen(['explorer', os.path.normpath(path)])
            elif platform.system() == "Darwin": subprocess.run(['open', path], check=True)
            else: subprocess.run(['xdg-open', path], check=True)
            return {"success": True, "message": "Opening export folder."}
        except Exception as e:
            return {"success": False, "error": f"Failed to open folder: {e}"}
            
    def handle_get_anilist_releases(self, message):
        return self.services.get_anilist_releases_with_cache(
            message.get('force', False), message.get('delete_cache', False), message.get('is_cache_disabled', False), 
            self.anilist_cache_file, self.script_dir, self.send_message
        )

    def handle_run_ytdlp_update(self, message):
        return self.services.update_ytdlp(self.send_message)

    def handle_check_dependencies(self, message):
        return self.services.check_mpv_and_ytdlp_status(self.file_io.get_mpv_executable, self.send_message)

    def handle_get_all_folders(self, message):
        return {"success": True, "folders": self.file_io.get_all_folders_from_file()}

    def handle_get_ui_preferences(self, message):
        return {"success": True, "preferences": self.file_io.get_settings()}

    def handle_set_ui_preferences(self, message):
        preferences = message.get('preferences')
        if preferences is None:
            return {"success": False, "error": "No preferences provided."}
        return self.file_io.set_settings(preferences)

    def handle_get_default_automatic_flags(self, message):
        return {"success": True, "flags": [
            {"flag": "--pause", "description": "Start MPV paused.", "enabled": False},
            {"flag": "--terminal", "description": "Show a terminal window.", "enabled": False},
            {"flag": "--save-position-on-quit", "description": "Remember playback position on exit.", "enabled": True},
            {"flag": "--loop-playlist=inf", "description": "Loop the entire playlist indefinitely.", "enabled": False},
            {"flag": "--ontop", "description": "Keep the player window on top of other windows.", "enabled": False},
            {"flag": "--force-window=immediate", "description": "Open the window immediately when starting.", "enabled": False}
        ]}

    def _start_local_m3u_server(self, m3u_content):
        """
        Starts or reuses playlist_server.py to serve dynamic M3U content.
        Returns the URL of the served M3U.
        """
        # Use a deterministic path for the server to serve within this instance
        if not self.temp_m3u_file_for_server:
            pid = os.getpid()
            self.temp_m3u_file_for_server = os.path.join(self.temp_playlists_dir, f"{SERVER_PREFIX}{pid}{SERVER_EXT}")

        # Update the file content on disk. The running server reads this on every request.
        logging.info(f"Updating M3U content for server at {self.temp_m3u_file_for_server}")
        with open(self.temp_m3u_file_for_server, 'w', encoding='utf-8') as f:
            f.write(m3u_content)

        # Check if we can reuse the existing server process
        if self.playlist_server_process and self.playlist_server_process.poll() is None:
            logging.info(f"Reusing existing playlist server on port {self.playlist_server_port}.")
            return f"http://localhost:{self.playlist_server_port}/playlist.m3u"

        # If not running (e.g. first launch or crashed), start it
        server_path = os.path.join(self.script_dir, "playlist_server.py")
        if not os.path.exists(server_path):
            logging.error(f"playlist_server.py not found at {server_path}")
            return None

        logging.info("Launching local M3U server process...")
        server_env = os.environ.copy()
        server_env["PYTHONDONTWRITEBYTECODE"] = "1"
        
        try:
            self.playlist_server_process = subprocess.Popen(
                [sys.executable, server_path, '--port', '8000', '--file', self.temp_m3u_file_for_server],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
                env=server_env
            )

            # ... (read actual port from stderr) ...
            port_found_timeout = 5
            start_time = time.time()
            while time.time() - start_time < port_found_timeout:
                line = self.playlist_server_process.stderr.readline()
                if not line: break
                logging.info(f"Server process stderr output: {line.strip()}")
                match = re.search(r"Serving M3U playlist on port (\d+)", line)
                if match:
                    self.playlist_server_port = int(match.group(1))
                    break
            
            if self.playlist_server_port is None:
                raise RuntimeError("Could not determine playlist server port.")

            fetch_url = f"http://localhost:{self.playlist_server_port}/playlist.m3u"
            # Readiness check
            for _ in range(30):
                try:
                    with urlopen(fetch_url, timeout=0.2) as r:
                        if r.getcode() == 200: return fetch_url
                except: pass
                time.sleep(0.2)
            
            raise RuntimeError("Playlist server timed out.")

        except Exception as e:
            logging.error(f"Failed to start local M3U server: {e}", exc_info=True)
            self._stop_local_m3u_server()
            return None


    def _stop_local_m3u_server(self):
        """Stops the local M3U server subprocess and cleans up temp files."""
        if self.playlist_server_process:
            logging.info(f"Terminating local M3U server process (PID: {self.playlist_server_process.pid}).")
            try:
                self.playlist_server_process.terminate()
                self.playlist_server_process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                logging.warning("Server process didn't terminate, killing it.")
                self.playlist_server_process.kill()
                self.playlist_server_process.wait()
            except Exception as e:
                logging.error(f"Error stopping local server: {e}")
            
            self.playlist_server_process = None
            self.playlist_server_port = None
            # Small sleep to ensure OS releases the socket
            time.sleep(0.2)
        
        if self.temp_m3u_file_for_server and os.path.exists(self.temp_m3u_file_for_server):
            try:
                os.remove(self.temp_m3u_file_for_server)
                logging.info(f"Cleaned up temporary M3U file: {self.temp_m3u_file_for_server}")
            except OSError as e:
                logging.warning(f"Failed to remove temporary M3U file {self.temp_m3u_file_for_server}: {e}")
            self.temp_m3u_file_for_server = None

    def handle_play_m3u(self, message):
        """
        Handles a request to play an M3U playlist.
        The message should contain 'm3u_data':
        {'type': 'url', 'value': 'http://remote.com/playlist.m3u'}
        {'type': 'path', 'value': '/local/path/to/playlist.m3u'}
        {'type': 'content', 'value': '#EXTM3U\n...'}
        """
        m3u_data = message.get('m3u_data')
        folder_id = message.get('folderId', str(uuid.uuid4())) # Use a new UUID for folder if not provided
        if not m3u_data or 'type' not in m3u_data or 'value' not in m3u_data:
            return {"success": False, "error": "Missing or malformed 'm3u_data' for play_m3u action."}

        m3u_source_value = m3u_data['value']
        m3u_type = m3u_data['type']

        # Get common settings for both mpv_session.start calls
        settings = self.file_io.get_settings()
        
        # Merge extension-provided networking and performance overrides
        for key in ['disable_network_overrides', 'enable_cache', 'http_persistence', 
                    'demuxer_max_bytes', 'demuxer_max_back_bytes', 'cache_secs', 
                    'demuxer_readahead_secs', 'stream_buffer_size', 'ytdlp_concurrent_fragments', 
                    'enable_reconnect', 'reconnect_delay', 'mpv_decoder']:
            if key in message:
                settings[key] = message[key]
        
        try:
            # Call mpv_session.start() with the raw M3U content/URL/path.
            # This call will return the enriched M3U content and enriched items list.
            logging.info(f"Step 1: Processing and enriching M3U from type '{m3u_type}'.")
            
            first_call_result = self.mpv_session.start(
                m3u_source_value, # Pass the original M3U source
                folder_id, 
                settings, 
                self.file_io,
                geometry=message.get('geometry'), 
                custom_width=message.get('custom_width'), 
                custom_height=message.get('custom_height'), 
                custom_mpv_flags=message.get('custom_mpv_flags'), 
                automatic_mpv_flags=message.get('automatic_mpv_flags'), 
                start_paused=message.get('start_paused', False),
                headers=message.get('headers'), # Pass headers for initial M3U fetch
                force_terminal=message.get('force_terminal', False)
            )
            
            if not first_call_result["success"]:
                return first_call_result # Propagate error from first call

            enriched_url_items = first_call_result["enriched_url_items"]

            # --- NEW: Check if playback was already handled directly (Standard Flow optimization) ---
            if first_call_result.get("handled_directly"):
                logging.info(f"Step 1: Playback handled directly by Standard Flow. Skipping M3U server.")
                return first_call_result

            enriched_m3u_content = first_call_result["enriched_m3u_content"]

            # --- LINKED PLAYLIST LOGIC ---
            # Check if we are already playing this folder.
            # If so, we "sync" instead of starting a new session.
            if self.mpv_session.is_alive and self.mpv_session.owner_folder_id == folder_id:
                logging.info(f"Linked Playlist: Folder '{folder_id}' is already active. Syncing new items.")
                
                # Identify items that are in the new list but not in the active session
                # We use ID as the SOLE unique identifier.
                current_ids = {item['id'] for item in self.mpv_session.playlist if 'id' in item}
                
                new_items = []
                for item in enriched_url_items:
                    item_id = item.get('id')
                    # Skip only if this exact ID is already in the session
                    if item_id and item_id in current_ids:
                        continue
                    new_items.append(item)
                
                # Update the M3U file on disk so the server is up-to-date
                if self.temp_m3u_file_for_server and os.path.exists(self.temp_m3u_file_for_server):
                    logging.info(f"Linked Playlist: Updating M3U file at {self.temp_m3u_file_for_server}")
                    with open(self.temp_m3u_file_for_server, 'w', encoding='utf-8') as f:
                        f.write(enriched_m3u_content)
                
                # Force unpause since this is a 'play' action
                if self.mpv_session.ipc_manager:
                    logging.info("Linked Playlist: Forcing unpause.")
                    self.mpv_session.ipc_manager.send({"command": ["set_property", "pause", False]})

                if new_items:
                    logging.info(f"Linked Playlist: Appending {len(new_items)} new items to active session.")
                    # Use the new batch append logic which creates a delta M3U
                    # to preserve titles and settings natively.
                    return self.mpv_session.append_batch(new_items)
                else:
                    return {"success": True, "message": "Playlist is already up-to-date. Playback resumed."}

            # --- ALWAYS write the M3U file for debugging/logging as requested ---
            if not self.temp_m3u_file_for_server:
                temp_m3u_filename = f"temp_playlist_{uuid.uuid4().hex}.m3u"
                self.temp_m3u_file_for_server = os.path.join(self.temp_playlists_dir, temp_m3u_filename)
            
            logging.info(f"DEBUG: Writing enriched M3U to {self.temp_m3u_file_for_server}")
            with open(self.temp_m3u_file_for_server, 'w', encoding='utf-8') as f:
                f.write(enriched_m3u_content)

            # Extract common headers/options from the items to apply globally.
            # We use a "greedy" approach for ytdl: if ANY item needs it, enable it.
            global_use_ytdl_mpv = any(item.get('use_ytdl_mpv', False) for item in enriched_url_items)
            global_is_youtube = any(item.get('is_youtube', False) for item in enriched_url_items)
            
            # For headers and other flags, we still baseline from the first item
            first_item = enriched_url_items[0] if enriched_url_items else {}
            
            # Reformat headers for MPV command line
            global_headers = first_item.get('headers')
            if global_headers:
                header_list = [f"{k}: {v.replace(',', '')}" for k, v in global_headers.items()]
                global_headers_str = ",".join(header_list)
            else:
                global_headers_str = None

            global_ytdl_raw_options = first_item.get('ytdl_raw_options')
            global_disable_http_persistent = first_item.get('disable_http_persistent', False)

            # --- STEP 2: Start or Reuse Local Server ---
            logging.info("Step 2: Starting or reusing local M3U server with enriched content.")
            local_server_url = self._start_local_m3u_server(enriched_m3u_content)

            if not local_server_url:
                raise RuntimeError("Failed to start local M3U server for enriched content.")
            
            # Calculate start index for the final launch
            playlist_start_index = 0
            all_folders = self.file_io.get_all_folders_from_file()
            last_played_id = all_folders.get(folder_id, {}).get("last_played_id")
            if settings.get("enable_smart_resume", True) and last_played_id:
                for idx, item in enumerate(enriched_url_items):
                    if item.get('id') == last_played_id:
                        playlist_start_index = idx
                        break

            # --- STEP 3: Launch MPV with the Local Server URL ---
            logging.info(f"Step 3: Launching MPV with local server URL: {local_server_url} and playlist-start={playlist_start_index}.")
            
            # Call mpv_session.start() again, this time with the local server URL.
            # Crucially, pass the `enriched_url_items` so the playlist tracker can use them.
            final_launch_result = self.mpv_session.start(
                local_server_url, # MPV will play this URL
                folder_id, 
                settings, 
                self.file_io,
                geometry=message.get('geometry'), 
                custom_width=message.get('custom_width'), 
                custom_height=message.get('custom_height'), 
                custom_mpv_flags=message.get('custom_mpv_flags'), 
                automatic_mpv_flags=message.get('automatic_mpv_flags'), 
                start_paused=message.get('start_paused', False),
                enriched_items_list=enriched_url_items,
                headers=global_headers, # Adaptive: Baseline headers for the first item
                ytdl_raw_options=global_ytdl_raw_options,
                use_ytdl_mpv=global_use_ytdl_mpv,
                is_youtube=global_is_youtube,
                disable_http_persistent=global_disable_http_persistent,
                force_terminal=message.get('force_terminal', False),
                playlist_start_index=playlist_start_index
            )
            
            if final_launch_result and final_launch_result.get("success"):
                final_launch_result["playlist_items"] = enriched_url_items
                
            return final_launch_result if final_launch_result else {"success": False, "error": "Failed to start MPV session with M3U."}

        except Exception as e:
            logging.error(f"Error handling play_m3u: {e}", exc_info=True)
            self._stop_local_m3u_server() # Ensure cleanup on failure
            return {"success": False, "error": f"Error playing M3U: {str(e)}"}
