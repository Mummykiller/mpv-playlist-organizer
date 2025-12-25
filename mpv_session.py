import json
import logging
import os
import platform
import subprocess
import threading
import time
import signal
from utils import ipc_utils
import services

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

        # --- Injected Dependencies ---
        self.get_all_folders_from_file = dependencies['get_all_folders_from_file']
        self.get_mpv_executable = dependencies['get_mpv_executable']
        self.log_stream = dependencies['log_stream']
        self.send_message = dependencies['send_message']
        self.SCRIPT_DIR = dependencies['SCRIPT_DIR']
        self.get_playlist_tracker = dependencies['playlist_tracker']

    def clear(self):
        """Clears the session state and removes the session file."""
        # Immediately signal that the session is no longer active.
        # This is the most critical part to prevent the race condition with the append loop.
        self.is_alive = False
        pid_to_clear = self.pid # Store current pid for logging/tracker before nullifying
        self.pid = None # Explicitly nullify the pid now.

        if pid_to_clear:
            logging.info(f"Clearing session state for PID: {pid_to_clear}")

        # Stop the tracker if it's running
        playlist_tracker = self.get_playlist_tracker()
        if playlist_tracker and playlist_tracker.is_tracking:
            playlist_tracker.stop_tracking()

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

    def _persist_session(self):
        """Saves the current session information to a file."""
        session_data = {
            "pid": self.pid,
            "ipc_path": self.ipc_path,
            "owner_folder_id": self.owner_folder_id
        }
        with open(self.session_file, 'w', encoding='utf-8') as f:
            json.dump(session_data, f, indent=4)
        logging.info(f"MPV session info saved to {self.session_file}")

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

    def append(self, url_item, headers=None, mode="append", disable_http_persistent=False, ytdl_raw_options=None):
        """Attempts to append a single new URL to an already running MPV instance."""
        with self.sync_lock:
            # First, check if the session is still active before trying to append.
            if not self.is_alive:
                logging.warning("Attempted to append to an inactive MPV session. Aborting append.")
                return {"success": False, "error": "Cannot append: MPV session is not active."}

            logging.info(f"MPV is running. Attempting to append item (mode: {mode}).")
            url_to_add = url_item['url']
            
            playlist_tracker = self.get_playlist_tracker()
            if playlist_tracker:
                playlist_tracker.add_item(url_item)

            # Simple check to prevent adding the same URL multiple times.
            # This is a basic check; a more robust one might consider other attributes.
            if self.playlist and url_to_add in [item['url'] for item in self.playlist]:
                logging.info("URL is already in the running playlist. Not re-adding.")
                return {"success": True, "message": "URL already in playlist."}

            try:
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
                ipc_utils.send_ipc_command(self.ipc_path, {"command": ["set_property", "http-header-fields", header_string]}, expect_response=False)

                if headers:
                    if 'User-Agent' in headers:
                        ipc_utils.send_ipc_command(self.ipc_path, {"command": ["set_property", "user-agent", headers['User-Agent']]}, expect_response=False)
                    if 'Referer' in headers:
                        ipc_utils.send_ipc_command(self.ipc_path, {"command": ["set_property", "referrer", headers['Referer']]}, expect_response=False)

                if disable_http_persistent:
                    logging.info("Setting demuxer-lavf-o=http_persistent=0 for this item.")
                    ipc_utils.send_ipc_command(self.ipc_path, {"command": ["set_property", "demuxer-lavf-o", "http_persistent=0"]}, expect_response=False)

                if ytdl_raw_options:
                    logging.info(f"Setting ytdl-raw-options to: '{ytdl_raw_options}'")
                    ipc_utils.send_ipc_command(self.ipc_path, {"command": ["set_property", "ytdl-raw-options", ytdl_raw_options]}, expect_response=False)

                logging.info(f"Loading file '{url_to_add}' with mode '{mode}'.")
                ipc_utils.send_ipc_command(self.ipc_path, {"command": ["loadfile", url_to_add, mode]}, expect_response=False)

                # Update the internal playlist representation
                if self.playlist is None:
                    self.playlist = []
                self.playlist.append(url_item) # Append the full item, not just the URL

                return {"success": True, "message": f"Added '{url_to_add}' to the MPV playlist."}
            except Exception as e:
                logging.warning(f"Live playlist append failed unexpectedly: {e}. Clearing state to allow a restart.")
                self.clear()
                return None

    def _launch(self, url_item, folder_id, geometry, custom_width, custom_height, custom_mpv_flags, automatic_mpv_flags, start_paused, headers=None, disable_http_persistent=False):
        """Launches a new instance of MPV with the given URL and settings."""
        logging.info(f"Starting a new MPV instance for URL: {url_item['url']}.")
        mpv_exe = self.get_mpv_executable()
        ipc_path = ipc_utils.get_ipc_path()

        try:
            full_command, has_terminal_flag = services.construct_mpv_command(
                mpv_exe=mpv_exe,
                ipc_path=ipc_path,
                urls=[url_item['url']],
                is_youtube=url_item.get('is_youtube'),
                ytdl_raw_options=url_item.get('ytdl_raw_options'),
                geometry=geometry,
                custom_width=custom_width,
                custom_height=custom_height,
                custom_mpv_flags=custom_mpv_flags,
                automatic_mpv_flags=automatic_mpv_flags,
                headers=headers,
                disable_http_persistent=disable_http_persistent,
                start_paused=start_paused,
                script_dir=self.SCRIPT_DIR
            )

            popen_kwargs = services.get_mpv_popen_kwargs(has_terminal_flag)

            process = subprocess.Popen(full_command, **popen_kwargs)
            self.process = process
            self.ipc_path = ipc_path
            self.playlist = [url_item] # Store as a single-item list
            self.pid = process.pid
            self.owner_folder_id = folder_id
            self.is_alive = True
            
            playlist_tracker = self.get_playlist_tracker()
            if playlist_tracker:
                playlist_tracker.start_tracking(self.ipc_path)

            # --- PID Correction for Linux Terminal ---
            # If we launched via a terminal emulator, the process PID is for the terminal,
            # not MPV. We need to connect to the IPC socket to get the real MPV PID.
            if platform.system() != "Windows" and has_terminal_flag:
                time.sleep(1) # Give MPV time to start and create the socket
                try:
                    pid_response = ipc_utils.send_ipc_command(self.ipc_path, {"command": ["get_property", "pid"]}, timeout=2.0, expect_response=True)
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

            self._persist_session()

            if platform.system() == "Windows":
                def process_poller(proc, f_id):
                    proc.wait() # Block until the process exits
                    return_code = proc.returncode
                    logging.info(f"MPV process for folder '{f_id}' exited with code {return_code}.")
                    self.send_message({"action": "mpv_exited", "folderId": f_id, "returnCode": return_code})
                    # Clean up the session state
                    self.clear()

                waiter_thread = threading.Thread(target=process_poller, args=(self.process, folder_id))
                waiter_thread.daemon = True
                waiter_thread.start()
            else:
                def process_waiter(proc, f_id):
                    return_code = proc.wait()
                    logging.info(f"MPV process for folder '{f_id}' exited with code {return_code}.")
                    self.send_message({"action": "mpv_exited", "folderId": f_id, "returnCode": return_code})
                    # Clean up the session state
                    self.clear()

                waiter_thread = threading.Thread(target=process_waiter, args=(self.process, folder_id))
                waiter_thread.daemon = True
                waiter_thread.start()

            self.process.waiter_thread = waiter_thread
            logging.info(f"MPV process launched (PID: {process.pid}) for single URL.")
            return {"success": True, "message": "MPV playback initiated."}
        except FileNotFoundError:
            logging.error(f"Failed to launch mpv. Make sure '{mpv_exe}' is installed and in your system's PATH or configured correctly.")
            return {"success": False, "error": f"Error: '{mpv_exe}' executable not found."}
        except Exception as e:
            logging.error(f"An error occurred while trying to launch mpv: {e}")
            return {"success": False, "error": f"Error launching mpv: {e}"}

    def start(self, url_items, folder_id, geometry=None, custom_width=None, custom_height=None, custom_mpv_flags=None, automatic_mpv_flags=None, start_paused=False, headers=None, disable_http_persistent=False, ytdl_raw_options=None):
        """Starts a new mpv process with a playlist of URLs, or attempts to sync."""
        
        # Ensure url_items is a list
        if not isinstance(url_items, list):
            url_items = [url_items]

        if not url_items:
            return {"success": False, "error": "No URL items provided."}

        def _playback_thread():
            if self.pid and not ipc_utils.is_process_alive(self.pid, self.ipc_path):
                logging.info("Detected a stale MPV session. Clearing state before proceeding.")
                self.clear()

            if self.pid:
                if folder_id == self.owner_folder_id:
                    # Append all items to the existing playlist
                    for item in url_items:
                        self.append(item, headers=headers, mode="append-play", disable_http_persistent=disable_http_persistent, ytdl_raw_options=ytdl_raw_options)
                    return
                else:
                    error_message = f"An MPV instance is already running for folder '{self.owner_folder_id}'. Please close it to play from '{folder_id}'."
                    logging.warning(error_message)
                    # We can't return a value from a thread, so we just log.
                    return

            # Launch the first item
            first_item = url_items[0]
            launch_result = self._launch(first_item, folder_id, geometry, custom_width, custom_height, custom_mpv_flags, automatic_mpv_flags, start_paused, headers=headers, disable_http_persistent=disable_http_persistent)

            if launch_result.get("success"):
                # Give mpv time to start
                time.sleep(1)
                # Append the rest of the items
                for item in url_items[1:]:
                    # If the pid was cleared by another thread (e.g., process exited), stop appending.
                    if not self.pid:
                        logging.warning("MPV process terminated during playlist append. Halting.")
                        break
                    self.append(item, headers=headers, mode="append", disable_http_persistent=disable_http_persistent, ytdl_raw_options=ytdl_raw_options)

        # Run the playback logic in a separate thread to avoid blocking
        playback_thread = threading.Thread(target=_playback_thread)
        playback_thread.daemon = True
        playback_thread.start()

        return {"success": True, "message": "Playback initiated."}

    def close(self):
        """Closes the currently running mpv process, if any."""
        playlist_tracker = self.get_playlist_tracker()
        if playlist_tracker:
            playlist_tracker.stop_tracking()
            
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
                    ipc_utils.send_ipc_command(ipc_path_to_use, {"command": ["quit"]}, expect_response=False)
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