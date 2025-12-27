import json
import logging
import os
import platform
import subprocess
import threading
import time
import signal
import tempfile
from utils import ipc_utils
import services
from playlist_tracker import PlaylistTracker # Added this import

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

    def _create_m3u_file(self, url_items):
        """Creates a temporary M3U playlist file from a list of items."""
        fd, path = tempfile.mkstemp(suffix=".m3u", prefix="mpv_playlist_", dir=self.TEMP_PLAYLISTS_DIR)
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write("#EXTM3U\n")
            for item in url_items:
                url = str(item.get('url') or '').strip()
                title = str(item.get('title') or 'Unknown Title').replace('\n', ' ').replace('\r', '')
                # Always write EXTINF to ensure titles are visible in MPV playlist immediately
                f.write(f"#EXTINF:-1,{title}\n")
                f.write(f"{url}\n")
        return path

    def append(self, url_item, headers=None, mode="append", disable_http_persistent=False, ytdl_raw_options=None):
        """Attempts to append a single new URL to an already running MPV instance."""
        with self.sync_lock:
            logging.info(f"Entering append for URL: {url_item.get('url')}")
            # First, check if the session is still active before trying to append.
            if not self.is_alive:
                logging.warning("Attempted to append to an inactive MPV session. Aborting append.")
                return {"success": False, "error": "Cannot append: MPV session is not active."}

            logging.info(f"MPV is running. Attempting to append item (mode: {mode}).")
            url_to_add = url_item['url']
            
            # Simple check to prevent adding the same URL multiple times.
            # This is a basic check; a more robust one might consider other attributes.
            if self.playlist:
                # Check by ID first if available (more robust for bypass scripts that change URLs)
                if url_item.get('id') and any(item.get('id') == url_item['id'] for item in self.playlist):
                    logging.info(f"Item with ID {url_item['id']} already in playlist. Not re-adding.")
                    return {"success": True, "message": "Item already in playlist.", "skipped": True}

            if self.playlist and url_to_add in [item['url'] for item in self.playlist]:
                logging.info("URL is already in the running playlist. Not re-adding.")
                return {"success": True, "message": "URL already in playlist.", "skipped": True}

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

                # If headers are provided, set the http-header-fields property before loading the file.
                # This avoids the parsing issues with passing options to loadfile directly.
                header_string = ""
                if headers:
                    header_list = []
                    for k, v in headers.items():
                        # Remove commas from values to prevent parsing ambiguity in the property list
                        safe_v = v.replace(",", "")
                        header_list.append(f"{k}: {safe_v}")
                    header_string = ",".join(header_list)
                
                logging.info(f"Setting http-header-fields to: '{header_string}'")
                if robust_send({"command": ["set_property", "http-header-fields", header_string]}) is None:
                     raise RuntimeError("Failed to set http-header-fields via IPC")

                if headers:
                    if 'User-Agent' in headers:
                        robust_send({"command": ["set_property", "user-agent", headers['User-Agent']]})
                    if 'Referer' in headers:
                        robust_send({"command": ["set_property", "referrer", headers['Referer']]})

                if disable_http_persistent:
                    logging.info("Setting demuxer-lavf-o=http_persistent=0 for this item.")
                    robust_send({"command": ["set_property", "demuxer-lavf-o", "http_persistent=0"]})

                if ytdl_raw_options:
                    logging.info(f"Setting ytdl-raw-options to: '{ytdl_raw_options}'")
                    robust_send({"command": ["set_property", "ytdl-raw-options", ytdl_raw_options]})

                # Create a temporary M3U file for this single item to preserve title metadata
                m3u_path = self._create_m3u_file([url_item])
                logging.info(f"Loading M3U file '{m3u_path}' with mode '{mode}'.")
                
                load_resp = robust_send({"command": ["loadfile", m3u_path, mode]})
                if load_resp is None or load_resp.get("error") != "success":
                    raise RuntimeError(f"Failed to send loadfile command via IPC: {load_resp}")

                # Update the internal playlist representation
                if self.playlist is None:
                    self.playlist = []
                self.playlist.append(url_item) # Append the full item, not just the URL

                # Update the tracker only after successful loadfile to ensure consistency
                if self.playlist_tracker:
                    self.playlist_tracker.add_item(url_item)

                # Show OSD feedback
                title = url_item.get('title') or url_to_add
                if len(title) > 60: title = title[:57] + "..."
                robust_send({"command": ["show-text", f"Added: {title}", 3000]})

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

    def _launch(self, url_items, folder_id, settings, file_io, geometry, custom_width, custom_height, custom_mpv_flags, automatic_mpv_flags, start_paused, headers=None, disable_http_persistent=False):
        """Launches a new instance of MPV with the given URL and settings."""
        logging.info(f"Starting a new MPV instance with {len(url_items)} items.")
        mpv_exe = self.get_mpv_executable()
        ipc_path = ipc_utils.get_ipc_path()

        # Create M3U playlist for the initial launch with all items
        m3u_path = self._create_m3u_file(url_items)
        
        # Use the first item to determine generic launch flags (e.g. YouTube mode)
        first_item = url_items[0]

        try:
            full_command, has_terminal_flag = services.construct_mpv_command(
                mpv_exe=mpv_exe,
                ipc_path=ipc_path,
                urls=[m3u_path], # Pass the M3U file instead of the raw URL
                is_youtube=first_item.get('is_youtube'),
                ytdl_raw_options=first_item.get('ytdl_raw_options'),
                geometry=geometry,
                custom_width=custom_width,
                custom_height=custom_height,
                custom_mpv_flags=custom_mpv_flags,
                automatic_mpv_flags=automatic_mpv_flags,
                headers=headers,
                disable_http_persistent=disable_http_persistent,
                start_paused=start_paused,
                script_dir=self.SCRIPT_DIR,
                load_on_completion_script=True # NEW ARGUMENT
            )

            popen_kwargs = services.get_mpv_popen_kwargs(has_terminal_flag)

            self.process = subprocess.Popen(full_command, **popen_kwargs)
            self.ipc_path = ipc_path
            self.ipc_manager = ipc_utils.IPCSocketManager()
            if not self.ipc_manager.connect(self.ipc_path):
                raise RuntimeError(f"Failed to connect to MPV IPC at {self.ipc_path}")

            self.playlist = list(url_items) # Store the full list
            self.pid = self.process.pid # Use self.process.pid for actual PID
            self.owner_folder_id = folder_id
            self.is_alive = True
            
            # Instantiate and start the playlist tracker *after* ipc_manager is connected.
            # Pass self.ipc_path so the tracker can create its own independent connection.
            self.playlist_tracker = PlaylistTracker(folder_id, url_items, file_io, settings, self.ipc_path)
            self.playlist_tracker.start_tracking()

            # --- PID Correction for Linux Terminal ---
            # If we launched via a terminal emulator, the process PID is for the terminal,
            # not MPV. We need to connect to the IPC socket to get the real MPV PID.
            if platform.system() != "Windows" and has_terminal_flag:
                time.sleep(1) # Give MPV time to start and create the socket
                try:
                    pid_response = self.ipc_manager.send({"command": ["get_property", "pid"]}, timeout=2.0, expect_response=True)
                    if pid_response and pid_response.get("error") == "success":
                        actual_mpv_pid = pid_response.get("data")
                        if actual_mpv_pid:
                            logging.info(f"Corrected PID from terminal ({self.pid}) to actual MPV PID ({actual_mpv_pid}).")
                            self.pid = actual_mpv_pid
                        else:
                            logging.warning("Could not get actual MPV PID from IPC socket.")
                    else:
                        logging.warning("Failed to get PID from MPV via IPC after launching in terminal.")
                except Exception as e:
                    logging.error(f"Error while trying to get MPV's real PID from terminal launch: {e}")

            stderr_thread = threading.Thread(target=self.log_stream, args=(self.process.stderr, logging.warning, folder_id))
            stderr_thread.daemon = True
            stderr_thread.start()

            # self._persist_session() # Removed as playlist data is now managed in folders.json

            if platform.system() == "Windows":
                def process_poller(proc, f_id):
                    return_code = proc.wait()
                    logging.info(f"MPV process for folder '{f_id}' exited with code {return_code}.")
                    self.send_message({"action": "mpv_exited", "folderId": f_id, "returnCode": return_code})
                    # Clean up the session state
                    self.clear(mpv_return_code=return_code) # Pass return code

                waiter_thread = threading.Thread(target=process_poller, args=(self.process, folder_id))
                waiter_thread.daemon = True
                waiter_thread.start()
            else:
                def process_waiter(proc, f_id):
                    return_code = proc.wait()
                    logging.info(f"MPV process for folder '{f_id}' exited with code {return_code}.")
                    self.send_message({"action": "mpv_exited", "folderId": f_id, "returnCode": return_code})
                    # Clean up the session state
                    self.clear(mpv_return_code=return_code) # Pass return code

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

    def start(self, url_items, folder_id, settings, file_io, geometry=None, custom_width=None, custom_height=None, custom_mpv_flags=None, automatic_mpv_flags=None, start_paused=False, headers=None, disable_http_persistent=False, ytdl_raw_options=None):
        """Starts a new mpv process with a playlist of URLs, or attempts to sync."""
        
        # Ensure url_items is a list
        if not isinstance(url_items, list):
            url_items = [url_items]

        if not url_items:
            return {"success": False, "error": "No URL items provided."}

        # Helper to extract options from item if present, else use defaults
        def get_opts(item):
            h = item.get('headers') if isinstance(item, dict) and 'headers' in item else headers
            d = item.get('disable_http_persistent') if isinstance(item, dict) and 'disable_http_persistent' in item else disable_http_persistent
            y = item.get('ytdl_raw_options') if isinstance(item, dict) and 'ytdl_raw_options' in item else ytdl_raw_options
            return h, d, y

        if self.pid and not ipc_utils.is_process_alive(self.pid, self.ipc_path):
            logging.info("Detected a stale MPV session. Clearing state before proceeding.")
            self.clear()

        if self.pid:
            if folder_id == self.owner_folder_id:
                # Append all items to the existing playlist
                
                # Helper to send commands robustly
                def robust_send(command, timeout=1.0):
                    result = self.ipc_manager.send(command, expect_response=True, timeout=timeout)
                    if result is None:
                        logging.warning("IPC command failed. Attempting to reconnect...")
                        if self.ipc_manager.connect(self.ipc_path):
                            return self.ipc_manager.send(command, expect_response=True, timeout=timeout)
                    return result

                # Filter out duplicates by checking MPV's current playlist
                items_to_add = []
                playlist_resp = robust_send({"command": ["get_property", "playlist"]}, timeout=2.0)
                existing_filenames = set()
                if playlist_resp and playlist_resp.get("error") == "success":
                    mpv_playlist = playlist_resp.get("data", [])
                    existing_filenames = {item.get("filename") for item in mpv_playlist}
                
                for item in url_items:
                    if item['url'] not in existing_filenames:
                        items_to_add.append(item)
                
                if not items_to_add:
                    return {"success": True, "message": "All items already in playlist.", "skipped": True}

                # Append items individually to ensure they appear as flat entries with titles
                for item in items_to_add:
                    h, d, y = get_opts(item)
                    # We use self.append which now handles force-media-title correctly
                    res = self.append(item, headers=h, mode="append-play", disable_http_persistent=d, ytdl_raw_options=y)
                    if not res:
                        return {"success": False, "error": "Failed to append item to existing session."}
                
                robust_send({"command": ["show-text", f"Appended {len(items_to_add)} items", 2000]})
                return {"success": True, "message": f"Appended {len(items_to_add)} items to existing session.", "skipped": False}
            else:
                error_message = f"An MPV instance is already running for folder '{self.owner_folder_id}'. Please close it to play from '{folder_id}'."
                logging.warning(error_message)
                return {"success": False, "error": error_message}

        # Launch the first item
        first_item = url_items[0]
        h, d, y = get_opts(first_item)
        launch_result = self._launch(
            url_items, folder_id, settings, file_io,
            geometry=geometry, 
            custom_width=custom_width, 
            custom_height=custom_height, 
            custom_mpv_flags=custom_mpv_flags, 
            automatic_mpv_flags=automatic_mpv_flags, 
            start_paused=start_paused, 
            headers=h, 
            disable_http_persistent=d
        )

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