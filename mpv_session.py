import os
import json
import logging
import platform
import signal
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

    def _sync(self, playlist):
        """Attempts to append new URLs to an already running MPV instance."""
        with self.sync_lock:
            logging.info(f"MPV is running for the same folder. Attempting to sync playlist.")
            known_urls = set(self.playlist) if self.playlist else set()
            urls_to_add = [url for url in playlist if url not in known_urls]

            if not urls_to_add:
                logging.info("Playlist is already in sync or only contains removals (which are not handled live).")
                self.playlist = playlist
                return {"success": True, "message": "Playlist is already up to date."}

            try:
                logging.info(f"Appending {len(urls_to_add)} new item(s) to the playlist.")
                for url in urls_to_add:
                    append_command = {"command": ["loadfile", url, "append-play"]}
                    self.send_ipc_command(self.ipc_path, append_command, expect_response=False)

                self.playlist = playlist
                return {"success": True, "message": f"Added {len(urls_to_add)} new item(s) to the MPV playlist."}
            except Exception as e:
                logging.warning(f"Live playlist append failed unexpectedly: {e}. Clearing state to allow a restart.")
                self.clear()
                return None

    def _launch(self, playlist, folder_id, geometry, custom_width, custom_height, custom_mpv_flags, automatic_mpv_flags, start_paused, clear_on_completion):
        """Launches a new instance of MPV with the given playlist and settings."""
        logging.info("Starting a new MPV instance.")
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

            if custom_width and custom_height:
                logging.info(f"Applying custom geometry: {custom_width}x{custom_height}")
                mpv_args.append(f'--geometry={custom_width}x{custom_height}')
            elif geometry:
                logging.info(f"Applying geometry: {geometry}")
                mpv_args.append(f'--geometry={geometry}')
            
            full_command = mpv_args + ['--'] + playlist

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
                    # On non-windows, we pass the actual flag to mpv
                    if '--terminal' not in mpv_args:
                        mpv_args.insert(1, '--terminal')
            
            # Re-create full_command in case --terminal was added for non-windows
            full_command = mpv_args + ['--'] + playlist

            process = subprocess.Popen(full_command, **popen_kwargs)
            self.process = process
            self.ipc_path = ipc_path
            self.playlist = playlist
            self.pid = process.pid
            self.owner_folder_id = folder_id

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
            logging.info(f"MPV process launched (PID: {process.pid}) with {len(playlist)} items.")
            return {"success": True, "message": "MPV playback initiated."}
        except FileNotFoundError:
            logging.error(f"Failed to launch mpv. Make sure '{mpv_exe}' is installed and in your system's PATH or configured correctly.")
            return {"success": False, "error": f"Error: '{mpv_exe}' executable not found."}
        except Exception as e:
            logging.error(f"An error occurred while trying to launch mpv: {e}")
            return {"success": False, "error": f"Error launching mpv: {e}"}

    def start(self, playlist, folder_id, geometry=None, custom_width=None, custom_height=None, custom_mpv_flags=None, automatic_mpv_flags=None, start_paused=False, clear_on_completion=False):
        """Starts a new mpv process, or syncs the playlist with a running one."""
        if self.pid and not self.is_process_alive(self.pid, self.ipc_path):
            logging.info("Detected a stale MPV session. Clearing state before proceeding.")
            self.clear()

        if self.pid:
            if folder_id == self.owner_folder_id:
                sync_result = self._sync(playlist)
                if sync_result is not None:
                    return sync_result
            else:
                error_message = f"An MPV instance is already running for folder '{self.owner_folder_id}'. Please close it to play from '{folder_id}'."
                logging.warning(error_message)
                return {"success": False, "error": error_message}
        
        return self._launch(playlist, folder_id, geometry, custom_width, custom_height, custom_mpv_flags, automatic_mpv_flags, start_paused, clear_on_completion)

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