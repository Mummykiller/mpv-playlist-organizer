import os
import json
import logging
import platform
import signal
import shutil
import socket
import subprocess
import threading
import time

class MpvSessionManager:
    """Manages the state and lifecycle of a single MPV instance."""

    def __init__(self, session_file_path, dependencies):
        self.process = None
        self.ipc_path = None
        self.playlist = None
        self.pid = None
        self.owner_folder_id = None
        self.session_file = session_file_path
        self.sync_lock = threading.Lock()

        # --- Injected Dependencies ---
        self.is_process_alive = dependencies['is_process_alive']
        self.send_ipc_command = dependencies['send_ipc_command']
        self.get_all_folders_from_file = dependencies['get_all_folders_from_file']
        self.get_mpv_executable = dependencies['get_mpv_executable']
        self.get_ipc_path = dependencies['get_ipc_path']
        self.log_stream = dependencies['log_stream']
        self.send_message = dependencies['send_message']
        self.SCRIPT_DIR = dependencies['SCRIPT_DIR']

    def clear(self):
        """Clears the session state and removes the session file."""
        if self.pid:
            logging.info(f"Clearing session state for PID: {self.pid}")

        self.process = None
        self.ipc_path = None
        self.playlist = None
        self.pid = None
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

            if self.is_process_alive(pid, ipc_path):
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

    def append(self, url_item, headers=None, mode="append"):
        """Attempts to append a single new URL to an already running MPV instance."""
        with self.sync_lock:
            logging.info(f"MPV is running. Attempting to append item (mode: {mode}).")
            url_to_add = url_item['url']
            
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
                self.send_ipc_command(self.ipc_path, {"command": ["set_property", "http-header-fields", header_string]}, expect_response=False)

                logging.info(f"Loading file '{url_to_add}' with mode '{mode}'.")
                self.send_ipc_command(self.ipc_path, {"command": ["loadfile", url_to_add, mode]}, expect_response=False)

                # Update the internal playlist representation
                if self.playlist is None:
                    self.playlist = []
                self.playlist.append(url_item) # Append the full item, not just the URL

                return {"success": True, "message": f"Added '{url_to_add}' to the MPV playlist."}
            except Exception as e:
                logging.warning(f"Live playlist append failed unexpectedly: {e}. Clearing state to allow a restart.")
                self.clear()
                return None

    def _launch(self, url_item, folder_id, geometry, custom_width, custom_height, custom_mpv_flags, automatic_mpv_flags, start_paused, clear_on_completion, headers=None):
        """Launches a new instance of MPV with the given URL and settings."""
        logging.info(f"Starting a new MPV instance for URL: {url_item['url']}.")
        mpv_exe = self.get_mpv_executable()
        ipc_path = self.get_ipc_path()
        
        on_completion_script_path = os.path.join(self.SCRIPT_DIR, "on_completion.lua")
        logging.info(f"Checking for on_completion.lua at: {on_completion_script_path}")
        try:
            mpv_args = [
                mpv_exe,
                f'--input-ipc-server={ipc_path}',
            ]

            has_terminal_flag = False
            if automatic_mpv_flags:
                enabled_flags = []
                for flag_info in automatic_mpv_flags:
                    if flag_info.get('enabled'):
                        if flag_info.get('flag') == 'terminal':
                            has_terminal_flag = True
                        else:
                            # Ensure we don't append None or empty strings
                            if flag_info.get('flag'):
                                enabled_flags.append(flag_info.get('flag'))
                mpv_args.extend(enabled_flags)

            if clear_on_completion:
                logging.info("'Clear on Completion' is enabled for this session.")
                if os.path.exists(on_completion_script_path):
                    logging.info(f"on_completion.lua found. Adding --script={on_completion_script_path} to MPV arguments.")
                    mpv_args.append(f'--script={on_completion_script_path}')
                else:
                    logging.warning(f"Completion script not found at {on_completion_script_path}. 'Clear on Completion' may not work as expected.")

            # The --pause flag from automatic flags can be overridden by the explicit start_paused parameter from the 'play' command.
            if start_paused and '--pause' not in mpv_args:
                logging.info("Applying --pause flag from explicit 'start_paused' parameter.")
                mpv_args.append('--pause')

            if custom_mpv_flags:
                import shlex
                try:
                    parsed_flags = shlex.split(custom_mpv_flags)
                    logging.info(f"Applying custom MPV flags: {parsed_flags}")
                    mpv_args.extend(parsed_flags)
                except Exception as e:
                    logging.error(f"Could not parse custom MPV flags '{custom_mpv_flags}'. Error: {e}")

            # Check if --terminal is present in args (e.g. from custom flags)
            if '--terminal' in mpv_args:
                has_terminal_flag = True

            if custom_width and custom_height:
                logging.info(f"Applying custom geometry: {custom_width}x{custom_height}")
                mpv_args.append(f'--geometry={custom_width}x{custom_height}')
            elif geometry:
                logging.info(f"Applying geometry: {geometry}")
                mpv_args.append(f'--geometry={geometry}')
            
            full_command = mpv_args + ['--'] + [url_item['url']] # Use the single URL

            popen_kwargs = {
                'stderr': subprocess.PIPE,
                'stdout': subprocess.DEVNULL,
                'universal_newlines': False
            }
            if platform.system() == "Windows":
                creation_flags = subprocess.CREATE_NEW_PROCESS_GROUP
                if not has_terminal_flag:
                    creation_flags |= subprocess.CREATE_NO_WINDOW
                popen_kwargs['creationflags'] = creation_flags
            else:
                popen_kwargs['start_new_session'] = True
                if has_terminal_flag:
                    if '--terminal' not in mpv_args:
                        mpv_args.insert(1, '--terminal')
                    
                    # Linux: Wrap in a terminal emulator if possible
                    term_cmd = []
                    if shutil.which('x-terminal-emulator'): term_cmd = ['x-terminal-emulator', '-e']
                    elif shutil.which('gnome-terminal'): term_cmd = ['gnome-terminal', '--wait', '--']
                    elif shutil.which('konsole'): term_cmd = ['konsole', '-e']
                    elif shutil.which('xfce4-terminal'): term_cmd = ['xfce4-terminal', '--disable-server', '-x']
                    elif shutil.which('xterm'): term_cmd = ['xterm', '-e']
            
            # Re-create full_command in case --terminal was added for non-windows
            full_command = mpv_args + ['--'] + [url_item['url']]

            # Apply terminal wrapper if detected (Linux only)
            if platform.system() != "Windows" and has_terminal_flag and 'term_cmd' in locals() and term_cmd:
                 full_command = term_cmd + full_command

            process = subprocess.Popen(full_command, **popen_kwargs)
            self.process = process
            self.ipc_path = ipc_path
            self.playlist = [url_item] # Store as a single-item list
            self.pid = process.pid
            self.owner_folder_id = folder_id

            # --- PID Correction for Linux Terminal ---
            # If we launched via a terminal emulator, the process PID is for the terminal,
            # not MPV. We need to connect to the IPC socket to get the real MPV PID.
            if platform.system() != "Windows" and has_terminal_flag:
                time.sleep(1) # Give MPV time to start and create the socket
                try:
                    pid_response = self.send_ipc_command(self.ipc_path, {"command": ["get_property", "pid"]}, timeout=2.0, expect_response=True)
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
                    while proc.poll() is None:
                        time.sleep(0.2)
                    return_code = proc.returncode
                    logging.info(f"MPV process for folder '{f_id}' exited with code {return_code}.")
                    self.send_message({"action": "mpv_exited", "folderId": f_id, "returnCode": return_code})

                waiter_thread = threading.Thread(target=process_poller, args=(self.process, folder_id))
                waiter_thread.daemon = True
                waiter_thread.start()
            else:
                def process_waiter(proc, f_id):
                    return_code = proc.wait()
                    logging.info(f"MPV process for folder '{f_id}' exited with code {return_code}.")
                    self.send_message({"action": "mpv_exited", "folderId": f_id, "returnCode": return_code})

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

    def start(self, url_item, folder_id, geometry=None, custom_width=None, custom_height=None, custom_mpv_flags=None, automatic_mpv_flags=None, start_paused=False, clear_on_completion=False, headers=None):
        """Starts a new mpv process with a single URL, or attempts to sync."""
        if self.pid and not self.is_process_alive(self.pid, self.ipc_path):
            logging.info("Detected a stale MPV session. Clearing state before proceeding.")
            self.clear()

        if self.pid:
            if folder_id == self.owner_folder_id:
                # If an MPV instance is already running for the same folder, attempt to sync.
                # In single-URL playback, this means adding the new URL to the existing MPV instance.
                # Use append-play mode to ensure it starts playing if the playlist was finished
                sync_result = self.append(url_item, headers=headers, mode="append-play")
                if sync_result is not None:
                    return sync_result
            else:
                error_message = f"An MPV instance is already running for folder '{self.owner_folder_id}'. Please close it to play from '{folder_id}'."
                logging.warning(error_message)
                return {"success": False, "error": error_message}
        
        # If no MPV is running, or if sync failed/was not attempted, launch a new one.
        return self._launch(url_item, folder_id, geometry, custom_width, custom_height, custom_mpv_flags, automatic_mpv_flags, start_paused, clear_on_completion, headers=headers)

    def close(self):
        """Closes the currently running mpv process, if any."""
        pid_to_close, ipc_path_to_use, process_object = None, None, None

        if self.process and self.process.poll() is None:
            pid_to_close, ipc_path_to_use, process_object = self.pid, self.ipc_path, self.process
        elif self.pid and self.is_process_alive(self.pid, self.ipc_path):
             pid_to_close, ipc_path_to_use = self.pid, self.ipc_path

        if not pid_to_close:
            logging.info("Received 'close_mpv' command, but no active MPV process was found.")
            self.clear()
            return {"success": True, "message": "No running MPV instance was found."}

        try:
            if ipc_path_to_use:
                try:
                    logging.info(f"Attempting to close MPV (PID: {pid_to_close}) via IPC: {ipc_path_to_use}")
                    self.send_ipc_command(ipc_path_to_use, {"command": ["quit"]}, expect_response=False)
                    if process_object: process_object.wait(timeout=3)
                    else: time.sleep(1)
                    
                    if not self.is_process_alive(pid_to_close, ipc_path_to_use):
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

            if not self.is_process_alive(pid_to_close, ipc_path_to_use):
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