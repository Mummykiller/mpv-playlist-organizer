import logging
import json
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

        self.playlist_server_process = None
        self.playlist_server_port = None
        self.temp_m3u_file_for_server = None

        self.playlist_server_process = None
        self.playlist_server_port = None
        self.temp_m3u_file_for_server = None

    def _process_url_item(self, url_item, folder_id, bypass_scripts_config, all_folders):
        """
        Helper to process a single URL item: resolves/assigns ID and applies bypass scripts.
        Returns the updated `url_item`, `script_headers`, `ytdl_options`, `use_ytdl_mpv`, `is_youtube`, and `all_folders`.
        """
        # Ensure item is a dict
        if isinstance(url_item, str): 
            url_item = {'url': url_item}
        
        # Call the refactored _resolve_or_assign_item_id
        url_item, all_folders = self._resolve_or_assign_item_id(url_item, folder_id, all_folders)
        
        # New return signature from apply_bypass_script (5 values)
        processed_url, script_headers, ytdl_options, use_ytdl_mpv_flag, is_youtube_flag = self.services.apply_bypass_script(
            url_item, self.send_message
        )
        url_item['url'] = processed_url # Update URL with processed one
        if script_headers: url_item['headers'] = script_headers
        if ytdl_options: url_item['ytdl_raw_options'] = ytdl_options
        # Store these flags in url_item for consistency if needed later, e.g., in batch processing
        url_item['use_ytdl_mpv'] = use_ytdl_mpv_flag
        url_item['is_youtube'] = is_youtube_flag

        url_item['disable_http_persistent'] = True if (script_headers and not ytdl_options) else False
        
        return url_item, script_headers, ytdl_options, use_ytdl_mpv_flag, is_youtube_flag, all_folders

    def _prepare_mpv_flags(self, message, script_headers, ytdl_options):
        """
        Helper to construct MPV flags based on message parameters and bypass script outputs.
        Returns the updated custom_mpv_flags and the disable_http_persistent flag.
        """
        disable_http_persistent = True if (script_headers and not ytdl_options) else False
        custom_mpv_flags = message.get('custom_mpv_flags')
        if disable_http_persistent:
            persistent_flag = "--demuxer-lavf-o=http_persistent=0"
            custom_mpv_flags = (custom_mpv_flags + " " + persistent_flag) if custom_mpv_flags else persistent_flag
        
        return custom_mpv_flags, disable_http_persistent

    def _resolve_or_assign_item_id(self, url_item, folder_id, all_folders):
        """
        Ensures a url_item has a stable ID. If the item (by URL) already exists
        in folders.json within the specified folder, its existing ID is used.
        Otherwise, a new UUID is assigned, and the item is added to the folder's playlist
        in folders.json.
        Takes `all_folders` and returns the updated `all_folders` object along with the url_item.
        The caller is responsible for writing `all_folders` to file if `persist` is True.
        """
        logging.debug(f"ResolveOrAssignId: Processing url_item: {url_item.get('title') or url_item['url']}, folder_id: {folder_id}")
        
        # If all_folders is not provided, fetch it. This maintains flexibility for callers.
        # However, for the pure function concept, the expectation is `all_folders` is always passed.
        # Removing the auto-fetch for simplicity as per the "pure function" goal.

        if folder_id not in all_folders:
            all_folders[folder_id] = {"playlist": []}
            logging.debug(f"ResolveOrAssignId: Created new folder '{folder_id}'.")

        folder_data = all_folders[folder_id]
        playlist = folder_data.get("playlist", [])

        # Check if item already exists by URL
        for stored_item in playlist:
            if stored_item.get('url') == url_item['url']:
                # If found, use its ID. Ensure the item in url_item has this ID.
                url_item['id'] = stored_item.get('id', str(uuid.uuid4()))
                logging.debug(f"ResolveOrAssignId: Found existing item. Assigned ID: {url_item['id']}")
                # Also, update the existing item in storage with potentially new title/settings from url_item
                stored_item.update(url_item)
                return url_item, all_folders
        
        # If not found, assign a new ID and add it to the playlist in storage
        if 'id' not in url_item:
            url_item['id'] = str(uuid.uuid4())
            logging.debug(f"ResolveOrAssignId: Assigned new ID: {url_item['id']}")
        
        playlist.append(url_item)
        folder_data["playlist"] = playlist
        logging.debug(f"ResolveOrAssignId: Added new item to folder '{folder_id}'. Item ID: {url_item['id']}")
        return url_item, all_folders

    def handle_play(self, message):
        url_item = message.get('url_item')
        folder_id = message.get('folderId')
        if not folder_id or not url_item:
            return {"success": False, "error": "Missing folderId or url_item for play action."}

        logging.debug(f"handle_play: Original url_item from extension: {url_item}")
        
        # Fetch all_folders once
        all_folders = self.file_io.get_all_folders_from_file()

        # Prepare URL item (resolve ID, apply bypass scripts)
        bypass_scripts_config = message.get('bypassScripts', {})
        url_item, script_headers, ytdl_options, use_ytdl_mpv_flag, is_youtube_flag, all_folders = self._process_url_item(url_item, folder_id, bypass_scripts_config, all_folders)
        logging.debug(f"handle_play: url_item after processing: {url_item}")

        # Write changes to all_folders back to file
        self.file_io.write_folders_file(all_folders)

        # Get settings from config file
        settings = self.file_io.get_settings()

        # Prepare MPV flags
        custom_mpv_flags, disable_http_persistent = self._prepare_mpv_flags(message, script_headers, ytdl_options)

        # Run synchronously to ensure MPV is ready before returning success
        result = self.mpv_session.start(
            url_item, folder_id, settings, self.file_io,
            geometry=message.get('geometry'), 
            custom_width=message.get('custom_width'), 
            custom_height=message.get('custom_height'), 
            custom_mpv_flags=custom_mpv_flags, 
            automatic_mpv_flags=message.get('automatic_mpv_flags'), 
            start_paused=message.get('start_paused', False), 
            headers=script_headers, 
            disable_http_persistent=disable_http_persistent,
            ytdl_raw_options=ytdl_options,
            use_ytdl_mpv=use_ytdl_mpv_flag, # NEW
            is_youtube=is_youtube_flag      # NEW
        )
        return result if result else {"success": False, "error": "Failed to start MPV session."}

    def handle_play_batch(self, message):
        playlist = message.get('playlist')
        folder_id = message.get('folderId')
        if not folder_id or not playlist:
            return {"success": False, "error": "Missing folderId or playlist for play_batch action."}

        logging.info(f"Processing play_batch request for folder '{folder_id}' with {len(playlist)} items.")
        
        settings = self.file_io.get_settings()
        bypass_scripts_config = message.get('bypassScripts', {})
        
        # Optimization: Read folders file once, update all IDs, write once.
        all_folders = self.file_io.get_all_folders_from_file()
        
        from concurrent.futures import ThreadPoolExecutor
        
        def process_item_parallel(item):
            # We need to be careful with all_folders here as it's not thread-safe for writing.
            # But _process_url_item mostly reads from it or appends if missing.
            # Since we are using the same all_folders object, we should ideally lock it
            # or just do the ID assignment sequentially first.
            return self._process_url_item(item, folder_id, bypass_scripts_config, all_folders)

        # Do ID assignment sequentially first to avoid race conditions in all_folders
        for item in playlist:
            if isinstance(item, str): item = {'url': item}
            _, all_folders = self._resolve_or_assign_item_id(item, folder_id, all_folders)

        logging.info(f"Enriching {len(playlist)} batch items in parallel...")
        with ThreadPoolExecutor(max_workers=10) as executor:
            # Note: _process_url_item now expects all_folders to be updated.
            # We pass a copy of the list to ensure order.
            results = list(executor.map(lambda item: self._process_url_item(item, folder_id, bypass_scripts_config, all_folders), playlist))
            
        processed_items = [r[0] for r in results]
            
        self.file_io.write_folders_file(all_folders) # Write changes to all_folders once

        # MPV flags (geometry, custom_mpv_flags, etc.) are passed as part of the main start call,
        # not per item in batch. So we extract them from the message directly.
        # disable_http_persistent for batch is tricky: if any item triggers it, should all items have it?
        # The mpv_session.start method handles passing item-specific headers and ytdl_raw_options.
        # disable_http_persistent can also be set per item. We will rely on item's own flags.
        
        result = self.mpv_session.start(
            processed_items, folder_id, settings, self.file_io,
            geometry=message.get('geometry'), 
            custom_width=message.get('custom_width'), 
            custom_height=message.get('custom_height'), 
            custom_mpv_flags=message.get('custom_mpv_flags'), 
            automatic_mpv_flags=message.get('automatic_mpv_flags'), 
            start_paused=message.get('start_paused', False)
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
        url_item, script_headers, ytdl_options, use_ytdl_mpv_flag, is_youtube_flag, all_folders = self._process_url_item(url_item, folder_id, bypass_scripts_config, all_folders)
        logging.debug(f"handle_append: url_item after processing: {url_item}")

        # Write changes to all_folders back to file, as ID resolution and processing are done
        self.file_io.write_folders_file(all_folders)

        disable_http_persistent = True if (script_headers and not ytdl_options) else False
        
        # Retry logic for append to handle transient IPC busy states
        max_retries = 3
        for attempt in range(max_retries):
            response = self.mpv_session.append(url_item, headers=script_headers, mode="append", disable_http_persistent=disable_http_persistent, ytdl_raw_options=ytdl_options, use_ytdl_mpv=use_ytdl_mpv_flag, is_youtube=is_youtube_flag)
            if response and response.get("success"):
                return response
            logging.warning(f"Append failed (attempt {attempt+1}/{max_retries}). Retrying in 0.5s...")
            time.sleep(0.5)
            
        return {"success": False, "error": "Failed to append to MPV playlist after retries."}

    def _launch_unmanaged_mpv(self, playlist, geometry, custom_width, custom_height, custom_mpv_flags, automatic_mpv_flags):
        """Helper to launch unmanaged MPV, moved from native_host.py."""
        logging.info("Launching a new, unmanaged MPV instance.")
        mpv_exe = self.file_io.get_mpv_executable()
        
        try:
            full_command, has_terminal_flag = self.services.construct_mpv_command(
                mpv_exe=mpv_exe,
                urls=playlist,
                geometry=geometry,
                custom_width=custom_width,
                custom_height=custom_height,
                custom_mpv_flags=custom_mpv_flags,
                automatic_mpv_flags=automatic_mpv_flags
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
        return {"success": True, "is_running": is_running}

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

    def handle_get_default_automatic_flags(self, message):
        return {"success": True, "flags": [
            {"flag": "--pause", "description": "Start MPV paused.", "enabled": False},
            {"flag": "terminal", "description": "Show a terminal window.", "enabled": False}
        ]}

    def _start_local_m3u_server(self, m3u_content):
        """
        Starts playlist_server.py as a subprocess to serve dynamic M3U content.
        Returns the URL of the served M3U.
        """
        if self.playlist_server_process and self.playlist_server_process.poll() is None:
            logging.info("Local M3U server already running. Stopping to update content.")
            self._stop_local_m3u_server() 
            time.sleep(0.1) # Give it a moment to release port

        # Create a unique temporary M3U file for the server to serve
        temp_m3u_filename = f"temp_playlist_{uuid.uuid4().hex}.m3u"
        self.temp_m3u_file_for_server = os.path.join(self.temp_playlists_dir, temp_m3u_filename)
        
        logging.info(f"DEBUG: Writing M3U content to {self.temp_m3u_file_for_server}:\n{m3u_content}")

        with open(self.temp_m3u_file_for_server, 'w', encoding='utf-8') as f:
            f.write(m3u_content)
        
        logging.info(f"Created temporary M3U file: {self.temp_m3u_file_for_server}")

        server_path = os.path.join(self.script_dir, "playlist_server.py")
        if not os.path.exists(server_path):
            logging.error(f"playlist_server.py not found at {server_path}")
            return None

        logging.info("Launching local M3U server process...")
        server_env = os.environ.copy()
        server_env["PYTHONDONTWRITEBYTECODE"] = "1" # Prevent __pycache__ for server
        
        try:
            self.playlist_server_process = subprocess.Popen(
                [sys.executable, server_path, '--port', '8000', '--file', self.temp_m3u_file_for_server], # Pass temp M3U file
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
                env=server_env
            )

            # Read stderr line by line to find the actual port and confirm readiness
            port_found_timeout = 10 # seconds
            start_time = time.time()
            
            while time.time() - start_time < port_found_timeout:
                line = self.playlist_server_process.stderr.readline() # Read from stderr
                if not line:
                    if self.playlist_server_process.poll() is not None: # Process exited
                        break
                    time.sleep(0.1)
                    continue

                logging.info(f"Server process stderr output: {line.strip()}")
                match = re.search(r"Serving M3U playlist on port (\d+)", line)
                if match:
                    self.playlist_server_port = int(match.group(1))
                    logging.info(f"Playlist server bound to port {self.playlist_server_port}.")
                    break
            
            if self.playlist_server_port is None:
                raise RuntimeError("Could not determine playlist server port from its output.")

            m3u_url = f"http://localhost:{self.playlist_server_port}/{os.path.basename(self.temp_m3u_file_for_server)}"

            # Check if the server process exited immediately after reporting its port
            if self.playlist_server_process.poll() is not None: # Server exited before readiness check
                stdout, stderr = self.playlist_server_process.communicate()
                logging.error(f"Playlist server process exited prematurely after port reporting. Stdout:\n{stdout}\nStderr:\n{stderr}")
                return None

            # Final readiness check by trying to connect
            max_retries = 20 # 20 retries * 0.5 sec = 10 seconds timeout
            for i in range(max_retries):
                try:
                    # Note: We are trying to fetch the file from the root path for the server (e.g. /temp_playlist_ABC.m3u)
                    # The playlist_server.py serves 'playlist.m3u' currently so we need to ensure that the request path is also 'playlist.m3u'.
                    # We will update playlist_server.py to handle arbitrary paths to the served file
                    # Or modify _start_local_m3u_server to make it always request /playlist.m3u.
                    # For now, let's stick to /playlist.m3u and modify playlist_server.py to use this.
                    fetch_url = f"http://localhost:{self.playlist_server_port}/playlist.m3u"
                    with urlopen(fetch_url, timeout=0.5) as response:
                        if response.getcode() == 200:
                            logging.info(f"Playlist server is ready after {i+1} attempts.")
                            return fetch_url # Return the URL for the M3U
                except Exception as e:
                    logging.debug(f"Attempt {i+1}: Server not ready yet ({e}). Retrying...")
                time.sleep(0.5)
            
            raise RuntimeError("Playlist server did not become ready within the timeout.")

        except Exception as e:
            logging.error(f"Failed to start local M3U server: {e}", exc_info=True)
            self._stop_local_m3u_server() # Ensure cleanup on failure
            return None

    def _stop_local_m3u_server(self):
        """Stops the local M3U server subprocess and cleans up temp files."""
        if self.playlist_server_process and self.playlist_server_process.poll() is None:
            logging.info("Terminating local M3U server process.")
            self.playlist_server_process.terminate()
            try:
                self.playlist_server_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.playlist_server_process.kill()
            self.playlist_server_process = None
            self.playlist_server_port = None
        
        if self.temp_m3u_file_for_server and os.path.exists(self.temp_m3u_file_for_server):
            try:
                # os.remove(self.temp_m3u_file_for_server)
                logging.info(f"DEBUG: Preserving temporary M3U file: {self.temp_m3u_file_for_server}")
            except OSError as e:
                logging.warning(f"Failed to remove temporary M3U file {self.temp_m3u_file_for_server}: {e}")
            # self.temp_m3u_file_for_server = None

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
        
        try:
            # --- STEP 1: Process and Enrich the M3U Content ---
            # Call mpv_session.start() with the raw M3U content/URL/path.
            # This call will return the enriched M3U content and enriched items list.
            logging.info(f"Step 1: Processing and enriching M3U from type '{m3u_type}'.")
            
            first_call_result = self.mpv_session.start(
                m3u_source_value, # Pass the original M3U source
                folder_id, 
                settings, 
                self.file_io,
                headers=message.get('headers') # Pass headers for initial M3U fetch
            )
            
            if not first_call_result["success"]:
                return first_call_result # Propagate error from first call

            enriched_m3u_content = first_call_result["enriched_m3u_content"]
            enriched_url_items = first_call_result["enriched_url_items"]

            # --- LINKED PLAYLIST LOGIC ---
            # Check if we are already playing this folder.
            # If so, we "sync" instead of starting a new session.
            if self.mpv_session.is_alive and self.mpv_session.owner_folder_id == folder_id:
                logging.info(f"Linked Playlist: Folder '{folder_id}' is already active. Syncing new items.")
                
                # Identify items that are in the new list but not in the active session
                # We use ID as the primary unique identifier, falling back to URL.
                current_ids = {item['id'] for item in self.mpv_session.playlist if 'id' in item}
                current_urls = {item['url'] for item in self.mpv_session.playlist if 'url' in item}
                
                new_items = []
                for item in enriched_url_items:
                    item_id = item.get('id')
                    item_url = item.get('url')
                    if (item_id and item_id in current_ids) or (not item_id and item_url in current_urls):
                        continue
                    new_items.append(item)
                
                # Update the M3U file on disk so the server is up-to-date
                if self.temp_m3u_file_for_server and os.path.exists(self.temp_m3u_file_for_server):
                    logging.info(f"Linked Playlist: Updating M3U file at {self.temp_m3u_file_for_server}")
                    with open(self.temp_m3u_file_for_server, 'w', encoding='utf-8') as f:
                        f.write(enriched_m3u_content)
                
                if new_items:
                    logging.info(f"Linked Playlist: Appending {len(new_items)} new items to active session.")
                    # Use the new batch append logic which creates a delta M3U
                    # to preserve titles and settings natively.
                    return self.mpv_session.append_batch(new_items)
                else:
                    return {"success": True, "message": "Playlist is already up-to-date."}

            # --- ALWAYS write the M3U file for debugging/logging as requested ---
            if not self.temp_m3u_file_for_server:
                temp_m3u_filename = f"temp_playlist_{uuid.uuid4().hex}.m3u"
                self.temp_m3u_file_for_server = os.path.join(self.temp_playlists_dir, temp_m3u_filename)
            
            logging.info(f"DEBUG: Writing enriched M3U to {self.temp_m3u_file_for_server}")
            with open(self.temp_m3u_file_for_server, 'w', encoding='utf-8') as f:
                f.write(enriched_m3u_content)

            # Extract common headers/options from the first item to apply globally.
            # This is "adaptive": we use the first item's requirements as the global baseline.
            # For homogeneous playlists (like all AnimePahe), this is perfect.
            # For mixed playlists (YT + AnimePahe), YT usually works fine with extra headers.
            first_item = enriched_url_items[0] if enriched_url_items else {}
            
            # Reformat headers for MPV command line
            global_headers = first_item.get('headers')
            if global_headers:
                header_list = [f"{k}: {v.replace(',', '')}" for k, v in global_headers.items()]
                global_headers_str = ",".join(header_list)
            else:
                global_headers_str = None

            global_ytdl_raw_options = first_item.get('ytdl_raw_options')
            global_use_ytdl_mpv = first_item.get('use_ytdl_mpv', False)
            global_is_youtube = first_item.get('is_youtube', False)

            # --- STEP 2: Start Local Server ---
            logging.info("Step 2: Starting local M3U server with enriched content.")
            self._stop_local_m3u_server() # Ensure clean state
            local_server_url = self._start_local_m3u_server(enriched_m3u_content)

            if not local_server_url:
                raise RuntimeError("Failed to start local M3U server for enriched content.")
            
            # --- STEP 3: Launch MPV with the Local Server URL ---
            logging.info(f"Step 3: Launching MPV with local server URL: {local_server_url}")
            
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
                is_youtube=global_is_youtube
            )
            return final_launch_result if final_launch_result else {"success": False, "error": "Failed to start MPV session with M3U."}

        except Exception as e:
            logging.error(f"Error handling play_m3u: {e}", exc_info=True)
            self._stop_local_m3u_server() # Ensure cleanup on failure
            return {"success": False, "error": f"Error playing M3U: {str(e)}"}
