#!/usr/bin/env python3
import sys
import json
import struct
import subprocess
import atexit
import socket
import os
import logging
import time
import signal
import threading
import argparse
import platform

# --- Configuration ---
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_FILE = os.path.join(SCRIPT_DIR, "native_host.log")
MAX_LOG_LINES = 200
FOLDERS_FILE = os.path.join(SCRIPT_DIR, "folders.json")
SESSION_FILE = os.path.join(SCRIPT_DIR, "session.json")
EXPORT_DIR = os.path.join(SCRIPT_DIR, "exported")

class TrimmingFileHandler(logging.FileHandler):
    """
    A logging handler that keeps the log file trimmed to a maximum number of lines.
    When a new line is added, if the line count exceeds the max, the oldest
    line is removed from the top of the file.
    """
    def __init__(self, filename, max_lines=200, mode='a', encoding=None, delay=False):
        self._max_lines = max_lines
        super().__init__(filename, mode, encoding, delay)
        # Trim on initialization in case the file is already too long from a previous run
        self._trim()

    def emit(self, record):
        """Emit a record and then trim the log file if necessary."""
        super().emit(record)
        self._trim()

    def _trim(self):
        """Trims the log file to the specified maximum number of lines."""
        if not os.path.exists(self.baseFilename):
            return # Nothing to trim
        try:
            with open(self.baseFilename, 'r', encoding=self.encoding) as f:
                lines = f.readlines()
            if len(lines) > self._max_lines:
                with open(self.baseFilename, 'w', encoding=self.encoding) as f:
                    f.writelines(lines[-self._max_lines:])
        except Exception:
            # We can't log an error here as it would cause a recursion loop.
            # We'll just let the default handler error mechanism work.
            self.handleError(None)

# Setup logging
root_logger = logging.getLogger()
if root_logger.hasHandlers():
    root_logger.handlers.clear()
root_logger.setLevel(logging.INFO)
handler = TrimmingFileHandler(LOG_FILE, max_lines=MAX_LOG_LINES, encoding='utf-8')
formatter = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')
handler.setFormatter(formatter)
root_logger.addHandler(handler)

def _write_export_file(filename, data):
    """Helper to write data to a file in the export directory."""
    try:
        os.makedirs(EXPORT_DIR, exist_ok=True)

        # Sanitize filename to prevent path traversal (e.g., '../malicious.txt').
        # os.path.basename strips any directory parts.
        safe_basename = os.path.basename(filename)

        # Ensure the filename ends with .json
        if not safe_basename.lower().endswith('.json'):
            final_filename = f"{safe_basename}.json"
        else:
            final_filename = safe_basename

        filepath = os.path.join(EXPORT_DIR, final_filename)

        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=4)

        logging.info(f"Data exported to {filepath}")
        return {"success": True, "message": f"Data exported to '{final_filename}' in the 'exported' folder."}
    except Exception as e:
        error_msg = f"Failed to export data: {e}"
        logging.error(error_msg)
        return {"success": False, "error": error_msg}


def log_stream(stream, log_level):
    """Reads from a stream line by line and logs it."""
    # The `for line in iter(...)` construct is a standard way to read
    # from a stream until it's closed.
    for line in iter(stream.readline, b''):
        log_level(f"[MPV Process]: {line.decode('utf-8', errors='ignore').strip()}")
    stream.close()

def get_message():
    """Reads a message from stdin and decodes it."""
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) == 0:
        sys.exit(0)
    message_length = struct.unpack('@I', raw_length)[0]
    message = sys.stdin.buffer.read(message_length).decode('utf-8')
    return json.loads(message)

def send_message(message_content):
    """Encodes and sends a message to stdout."""
    encoded_content = json.dumps(message_content).encode('utf-8')
    message_length = struct.pack('@I', len(encoded_content))
    sys.stdout.buffer.write(message_length)
    sys.stdout.buffer.write(encoded_content)
    sys.stdout.buffer.flush()

def get_ipc_path():
    """Generates a unique, platform-specific path for the mpv IPC socket/pipe."""
    pid = os.getpid()
    if platform.system() == "Windows":
        # Named pipes on Windows have a specific format.
        return f"\\\\.\\pipe\\mpv-ipc-{pid}"
    else:
        # Use a temporary directory for Unix sockets, which is standard.
        return f"/tmp/mpv-socket-{pid}"

def get_mpv_executable():
    """Gets the path to the mpv executable based on OS and config."""
    if platform.system() == "Windows":
        config_path = os.path.join(SCRIPT_DIR, "config.json")
        if os.path.exists(config_path):
            with open(config_path, 'r') as f:
                config = json.load(f)
                return config.get("mpv_path", "mpv.exe")
        return "mpv.exe" # Fallback
    return "mpv" # For Linux/macOS

def is_process_alive(ipc_path):
    """Checks if an MPV process is responsive at the given IPC path."""
    if not ipc_path:
        return False
    
    is_alive = False
    if platform.system() == "Windows":
        try:
            # On Windows, we can't easily read, so we just check if the pipe exists by trying to open it.
            with open(ipc_path, 'w', encoding='utf-8'): pass
            is_alive = True
        except (FileNotFoundError, PermissionError):
            is_alive = False
    else: # Linux/macOS
        try:
            ipc_response = send_ipc_command(ipc_path, {"command": ["get_property", "pid"]}, timeout=0.5, expect_response=True)
            if ipc_response and ipc_response.get("error") == "success":
                is_alive = True
        except Exception:
            is_alive = False # Any exception means it's not running or responsive.
    return is_alive

def send_ipc_command(ipc_path, command_dict, timeout=2.0, expect_response=True):
    """
    Sends a JSON command to the mpv IPC server.
    On Linux/macOS, it can return a response.
    On Windows, this implementation can only send commands, not receive responses,
    due to the complexity of non-blocking named pipe I/O without extra libraries.
    """
    command_str = json.dumps(command_dict) + '\n'

    try:
        if platform.system() == "Windows":
            if expect_response:
                logging.warning("Receiving data from MPV on Windows is not supported by this script's simple IPC. Sync will fail.")
                return None # Signal failure to receive response.

            # Fire-and-forget for commands like 'loadfile' or 'quit'
            with open(ipc_path, 'w', encoding='utf-8') as pipe:
                pipe.write(command_str)
            return {"error": "success"} # Assume success

        else: # Linux/macOS
            encoded_command = command_str.encode('utf-8')
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
                sock.settimeout(timeout)
                sock.connect(ipc_path)
                sock.sendall(encoded_command)

                if not expect_response:
                    return {"error": "success"}

                # Read the response. A single JSON object terminated by a newline is expected.
                with sock.makefile('rb') as sock_file:
                    response_line = sock_file.readline()

                if not response_line:
                    logging.warning("No response from MPV IPC.")
                    return None

                return json.loads(response_line.decode('utf-8').strip())
    except (FileNotFoundError, ConnectionRefusedError):
        logging.error(f"IPC connection failed. Is MPV running? Path: {ipc_path}")
        raise RuntimeError("IPC connection failed.")
    except Exception as e:
        logging.error(f"An unexpected error occurred during IPC command: {e}")
        raise

class MpvSessionManager:
    """Manages the state and lifecycle of a single MPV instance."""

    def __init__(self, session_file_path):
        self.process = None
        self.ipc_path = None
        self.playlist = None
        self.pid = None
        self.owner_folder_id = None
        self.session_file = session_file_path

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
            "playlist": self.playlist,
            "owner_folder_id": self.owner_folder_id
        }
        with open(self.session_file, 'w', encoding='utf-8') as f:
            json.dump(session_data, f)
        logging.info(f"MPV session info saved to {self.session_file}")

    def restore(self):
        """Checks for a persisted session file and restores state if the process is still alive."""
        if not os.path.exists(self.session_file):
            return

        logging.info(f"Found session file: {self.session_file}. Checking for live process.")
        try:
            with open(self.session_file, 'r', encoding='utf-8') as f:
                session_data = json.load(f)

            pid = session_data.get("pid")
            ipc_path = session_data.get("ipc_path")
            playlist = session_data.get("playlist")
            owner_folder_id = session_data.get("owner_folder_id")

            if not all([pid, ipc_path, playlist is not None, owner_folder_id]):
                raise ValueError("Session file is malformed.")

            if is_process_alive(ipc_path):
                self.pid = pid
                self.ipc_path = ipc_path
                self.playlist = playlist
                self.owner_folder_id = owner_folder_id
                logging.info(f"Successfully restored session for MPV process (PID: {pid}) owned by folder '{owner_folder_id}'.")
            else:
                raise RuntimeError("Process not responding or IPC check failed.")

        except (FileNotFoundError, ConnectionRefusedError, RuntimeError, ValueError, json.JSONDecodeError) as e:
            logging.warning(f"Stale or invalid session file found. Reason: {e}. Cleaning up.")
            try:
                os.remove(self.session_file)
            except OSError:
                pass # File might already be gone.

    def _sync(self, playlist):
        """Attempts to append new URLs to an already running MPV instance."""
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
                send_ipc_command(self.ipc_path, append_command, expect_response=False)

            self.playlist = playlist
            return {"success": True, "message": f"Added {len(urls_to_add)} new item(s) to the MPV playlist."}
        except Exception as e:
            logging.warning(f"Live playlist append failed unexpectedly: {e}. Clearing state to allow a restart.")
            self.clear()
            return None # Signal to the caller to fall back to launching a new instance.

    def _launch(self, playlist, folder_id, geometry, custom_width, custom_height, custom_mpv_flags, start_paused):
        """Launches a new instance of MPV with the given playlist and settings."""
        logging.info("Starting a new MPV instance.")
        mpv_exe = get_mpv_executable()
        ipc_path = get_ipc_path()
        on_completion_script_path = os.path.join(SCRIPT_DIR, "on_completion.lua")

        try:
            mpv_args = [
                mpv_exe, '--no-terminal', '--force-window=yes',
                '--save-position-on-quit',
                '--write-filename-in-watch-later-config',
                f'--input-ipc-server={ipc_path}',
            ]

            # Add the script to detect natural playlist completion.
            if os.path.exists(on_completion_script_path):
                mpv_args.append(f'--script={on_completion_script_path}')
            else:
                logging.warning(f"Completion script not found at {on_completion_script_path}. 'Clear on Completion' may not work as expected.")

            if start_paused:
                logging.info("Applying --pause flag.")
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

            mpv_args.extend(['--'] + playlist)

            popen_kwargs = {
                'stderr': subprocess.PIPE,
                'stdout': subprocess.DEVNULL,
                'universal_newlines': False
            }
            if platform.system() == "Windows":
                popen_kwargs['creationflags'] = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP

            process = subprocess.Popen(mpv_args, **popen_kwargs)
            self.process = process
            self.ipc_path = ipc_path
            self.playlist = playlist
            self.pid = process.pid
            self.owner_folder_id = folder_id

            self._persist_session()

            stderr_thread = threading.Thread(target=log_stream, args=(process.stderr, logging.warning))
            stderr_thread.daemon = True
            stderr_thread.start()

            # Start a separate thread to wait for the process to exit and notify the extension.
            def process_waiter(proc, f_id):
                return_code = proc.wait()
                logging.info(f"MPV process for folder '{f_id}' exited with code {return_code}.")
                send_message({"action": "mpv_exited", "folderId": f_id, "returnCode": return_code})

            waiter_thread = threading.Thread(target=process_waiter, args=(self.process, folder_id))
            waiter_thread.daemon = True
            waiter_thread.start()

            logging.info(f"MPV process launched (PID: {process.pid}) with {len(playlist)} items.")
            return {"success": True, "message": "MPV playback initiated."}
        except FileNotFoundError:
            logging.error(f"Failed to launch mpv. Make sure '{mpv_exe}' is installed and in your system's PATH or configured correctly.")
            return {"success": False, "error": f"Error: '{mpv_exe}' executable not found."}
        except Exception as e:
            logging.error(f"An error occurred while trying to launch mpv: {e}")
            return {"success": False, "error": f"Error launching mpv: {e}"}

    def start(self, playlist, folder_id, geometry=None, custom_width=None, custom_height=None, custom_mpv_flags=None, start_paused=False):
        """Starts a new mpv process, or syncs the playlist with a running one."""
        if self.pid and not is_process_alive(self.ipc_path):
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

        return self._launch(playlist, folder_id, geometry, custom_width, custom_height, custom_mpv_flags, start_paused)

    def close(self):
        """Closes the currently running mpv process, if any."""
        pid_to_close, ipc_path_to_use, process_object = None, None, None

        if self.process and self.process.poll() is None:
            pid_to_close, ipc_path_to_use, process_object = self.pid, self.ipc_path, self.process
        elif self.pid:
            pid_to_close, ipc_path_to_use = self.pid, self.ipc_path

        if not pid_to_close:
            logging.info("Received 'close_mpv' command, but no active MPV process was found.")
            return {"success": True, "message": "No running MPV instance was found."}

        try:
            if ipc_path_to_use:
                try:
                    logging.info(f"Attempting to close MPV (PID: {pid_to_close}) via IPC: {ipc_path_to_use}")
                    send_ipc_command(ipc_path_to_use, {"command": ["quit"]}, expect_response=False)
                    if process_object: process_object.wait(timeout=5)
                    else: time.sleep(1)
                    logging.info(f"MPV process (PID: {pid_to_close}) closed gracefully via IPC.")
                    return {"success": True, "message": "MPV instance has been closed."}
                except Exception as e:
                    logging.warning(f"IPC command to close MPV failed: {e}. Falling back to signal method.")

            if process_object:
                logging.info(f"Attempting to close MPV process (PID: {pid_to_close}) via signal fallback.")
                if platform.system() == "Windows": process_object.send_signal(signal.CTRL_C_EVENT)
                else: process_object.terminate()
                process_object.wait(timeout=5)
                logging.info(f"MPV process (PID: {pid_to_close}) terminated successfully via signal.")
                return {"success": True, "message": "MPV instance has been closed."}
            else:
                raise RuntimeError("IPC close failed and no process object available for signal fallback.")

        except subprocess.TimeoutExpired:
            logging.warning(f"MPV process (PID: {pid_to_close}) did not terminate in time, forcing kill.")
            if process_object: process_object.kill()
            return {"success": True, "message": "MPV instance was forcefully closed."}
        except Exception as e:
            error_msg = f"An error occurred while closing MPV process (PID: {pid_to_close}): {e}"
            logging.error(error_msg)
            return {"success": False, "error": error_msg}
        finally:
            self.clear()

# --- Global Instance ---
# A single instance of the session manager to handle the MPV state.
mpv_session = MpvSessionManager(session_file_path=SESSION_FILE)

def cleanup_ipc_socket():
    """Remove the IPC socket file on exit, if it exists (non-Windows)."""
    # Access the ipc_path from the global session manager instance
    if mpv_session.ipc_path and platform.system() != "Windows":
        if os.path.exists(mpv_session.ipc_path):
            try:
                os.remove(mpv_session.ipc_path)
                logging.info(f"Cleaned up IPC socket: {mpv_session.ipc_path}")
            except OSError as e:
                logging.warning(f"Error removing IPC socket file {mpv_session.ipc_path}: {e}")

def get_all_folders_from_file(): # Modified to handle new structure
    """Reads all folders data from folders.json, ensuring new format."""
    if not os.path.exists(FOLDERS_FILE):
        return {}
    try:
        with open(FOLDERS_FILE, 'r') as f:
            raw_folders = json.load(f)
        
        converted_folders = {}
        needs_resave = False
        for folder_id, folder_content in raw_folders.items():
            if isinstance(folder_content, dict) and "playlist" in folder_content:
                # Already in new format, just ensure keys exist
                converted_folders[folder_id] = {
                    "playlist": folder_content.get("playlist", [])
                }
            elif isinstance(folder_content, list):
                # Old format: a raw list of URLs
                logging.info(f"Converting old format (list) for folder '{folder_id}' to new format.")
                converted_folders[folder_id] = {"playlist": folder_content}
                needs_resave = True
            elif isinstance(folder_content, dict) and "urls" in folder_content:
                # Old format: a dict with a 'urls' key
                logging.info(f"Converting old format (dict with 'urls') for folder '{folder_id}' to new format.")
                converted_folders[folder_id] = {
                    "playlist": folder_content.get("urls", [])
                }
                needs_resave = True
            else:
                logging.warning(f"Skipping malformed folder data for '{folder_id}' during load: {folder_content}")
        
        if needs_resave:
            logging.info("Resaving folders file after converting old data formats.")
            with open(FOLDERS_FILE, 'w') as f:
                json.dump(converted_folders, f, indent=4)

        return converted_folders
    except Exception as e:
        logging.error(f"Failed to read folders from file: {e}")
        return {}

def _cli_list_folders(args):
    """CLI command to list all available folders and their item counts."""
    if not os.path.exists(FOLDERS_FILE):
        print(f"Data file not found at {FOLDERS_FILE}. No folders to list.")
        logging.warning("CLI 'list' command: Data file not found.")
        return

    folders_data = get_all_folders_from_file()
    if not folders_data:
        print("No folders found.")
        return

    print("Available folders:")
    # List folders alphabetically for consistent output.
    for folder_id, folder_info in sorted(folders_data.items()):
        playlist = folder_info.get("playlist", [])
        item_count = len(playlist)
        print(f"  - {folder_id} ({item_count} item{'s' if item_count != 1 else ''})")

def _cli_play_folder(args):
    """CLI command to play a specific folder."""
    folder_id = args.folder_id

    if not os.path.exists(FOLDERS_FILE):
        print(f"Error: Data file not found at {FOLDERS_FILE}. Please add an item in the extension first to create it.", file=sys.stderr)
        logging.error(f"CLI Error: Data file not found at {FOLDERS_FILE}")
        sys.exit(1)

    folders_data = get_all_folders_from_file()
    folder_info = folders_data.get(folder_id)

    if folder_info is None or not isinstance(folder_info, dict) or "playlist" not in folder_info:
        print(f"Error: Folder '{folder_id}' not found.", file=sys.stderr)
        logging.error(f"CLI Error: Folder '{folder_id}' not found.")
        # Be helpful and list available folders.
        if folders_data:
            print("\nAvailable folders are:")
            for available_folder_id in sorted(folders_data.keys()):
                print(f"  - {available_folder_id}")
        sys.exit(1)
    
    playlist = folder_info.get("playlist", [])
    if not playlist:
        print(f"Playlist for folder '{folder_id}' is empty. Nothing to play.")
        logging.info(f"CLI: Playlist for '{folder_id}' is empty. Aborting.")
        sys.exit(0)

    logging.info(f"Found folder '{folder_id}' with {len(playlist)} item(s). Starting mpv...")
    print(f"Starting mpv for folder '{folder_id}' with {len(playlist)} item(s)...")
    mpv_session.start(playlist, folder_id)

def handle_cli():
    """Handles command-line invocation using argparse for a more robust CLI."""
    # The browser will call the script with an origin argument, not a valid command.
    # We can distinguish a CLI call by checking if the first argument is one of our commands.
    if len(sys.argv) < 2 or sys.argv[1] not in ['play', 'list', '-h', '--help']:
        return False # Not a CLI call, proceed to browser messaging mode.

    logging.info(f"Native host started in CLI mode with args: {sys.argv}")

    parser = argparse.ArgumentParser(
        description="Command-line interface for MPV Playlist Organizer.",
        formatter_class=argparse.RawTextHelpFormatter # For better help text formatting
    )
    subparsers = parser.add_subparsers(dest='command', required=True, help='Available commands')

    # --- Play Command ---
    play_parser = subparsers.add_parser('play', help='Play a playlist from a specified folder.')
    play_parser.add_argument('folder_id', help='The name of the folder to play.')
    play_parser.set_defaults(func=_cli_play_folder)

    # --- List Command ---
    list_parser = subparsers.add_parser('list', help='List all available folders and their item counts.')
    list_parser.set_defaults(func=_cli_list_folders)

    try:
        args = parser.parse_args()
        args.func(args)
    except SystemExit:
        # Argparse calls sys.exit() on --help or errors, which is fine. We just pass.
        pass
    except Exception as e:
        # This will catch errors from the command functions (e.g., file not found).
        print(f"An unexpected CLI error occurred: {e}", file=sys.stderr)
        logging.error(f"Unexpected CLI Error: {e}", exc_info=True)
        sys.exit(1)
    
    return True # Indicates that a CLI command was successfully handled.

def launch_unmanaged_mpv(playlist, geometry, custom_width, custom_height, custom_mpv_flags):
    """Launches a new, unmanaged instance of MPV."""
    logging.info("Launching a new, unmanaged MPV instance.")
    mpv_exe = get_mpv_executable()
    # This instance will not have a persistent IPC server, so it's fire-and-forget.
    # We don't need to generate a unique IPC path.
    
    try:
        mpv_args = [
            mpv_exe, '--no-terminal', '--force-window=yes',
            '--save-position-on-quit',
            '--write-filename-in-watch-later-config',
            # No --input-ipc-server, so it's unmanaged
        ]

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

        mpv_args.extend(['--'] + playlist)

        popen_kwargs = {
            'stderr': subprocess.PIPE,
            'stdout': subprocess.DEVNULL,
            'universal_newlines': False
        }
        if platform.system() == "Windows":
            popen_kwargs['creationflags'] = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP

        process = subprocess.Popen(mpv_args, **popen_kwargs)
        
        stderr_thread = threading.Thread(target=log_stream, args=(process.stderr, logging.warning))
        stderr_thread.daemon = True
        stderr_thread.start()

        logging.info(f"Unmanaged MPV process launched (PID: {process.pid}) with {len(playlist)} items.")
        return {"success": True, "message": "New MPV instance launched."}
    except Exception as e:
        logging.error(f"An error occurred while trying to launch unmanaged mpv: {e}")
        return {"success": False, "error": f"Error launching new mpv instance: {e}"}

def main():
    """Main message loop for native messaging from the browser."""
    logging.info("Native host started in messaging mode.")
    mpv_session.restore()
    while True:
        try:
            message = get_message() # This will block or sys.exit() on disconnect
            request_id = message.get('request_id')
            command = message.get('action')

            logging.info(f"Received message (ID: {request_id}): {json.dumps(message)}")

            response = {}
            if command == 'play':
                playlist = message.get('playlist', [])
                folder_id = message.get('folderId')
                geometry = message.get('geometry')
                custom_width = message.get('custom_width')
                custom_height = message.get('custom_height')
                custom_mpv_flags = message.get('custom_mpv_flags')
                start_paused = message.get('start_paused', False)
                if not folder_id:
                    response = {"success": False, "error": "No folderId provided for play action."}
                else:
                    response = mpv_session.start(playlist, folder_id, geometry=geometry, custom_width=custom_width, custom_height=custom_height, custom_mpv_flags=custom_mpv_flags, start_paused=start_paused)

            elif command == 'play_new_instance':
                playlist = message.get('playlist', [])
                geometry = message.get('geometry')
                custom_width = message.get('custom_width')
                custom_height = message.get('custom_height')
                custom_mpv_flags = message.get('custom_mpv_flags')
                # This bypasses the session manager entirely
                response = launch_unmanaged_mpv(playlist, geometry, custom_width, custom_height, custom_mpv_flags)

            elif command == 'close_mpv':
                response = mpv_session.close()

            elif command == 'is_mpv_running':
                is_running = is_process_alive(mpv_session.ipc_path)

                # If the check fails, clear the stale state.
                if not is_running and mpv_session.pid:
                    mpv_session.clear()

                logging.info(f"MPV running status check: {is_running} (Path: {mpv_session.ipc_path})")
                response = {"success": True, "is_running": is_running}
            elif command == 'export_data':
                data_to_export = message.get('data')
                if data_to_export is not None:
                    try:
                        with open(FOLDERS_FILE, 'w') as f:
                            json.dump(data_to_export, f, indent=4)
                        logging.info(f"Data exported to {FOLDERS_FILE}")
                        response = {"success": True, "message": "Data successfully synced to file."}
                    except Exception as e:
                        error_msg = f"Failed to write to {FOLDERS_FILE}: {e}"
                        logging.error(error_msg)
                        response = {"success": False, "error": error_msg}
                else:
                    response = {"success": False, "error": "No data provided for export."}
            
            elif command == 'export_playlists':
                data_to_export = message.get('data')
                custom_filename = message.get('filename')
                if data_to_export is not None and custom_filename:
                    response = _write_export_file(custom_filename, data_to_export)
                elif not custom_filename:
                    response = {"success": False, "error": "No filename provided for export."}
                else:
                    response = {"success": False, "error": "No data provided for export."}

            elif command == 'export_all_playlists_separately':
                folders_to_export = message.get('data')
                if not folders_to_export:
                    response = {"success": False, "error": "No folder data provided for export."}
                else:
                    exported_count = 0
                    for folder_id, folder_data in folders_to_export.items():
                        playlist = folder_data.get('playlist')
                        if playlist is None:
                            logging.warning(f"Skipping folder '{folder_id}' during batch export: 'playlist' key not found.")
                            continue

                        # Sanitize folder_id to create a safe filename
                        safe_filename_base = "".join(c if c.isalnum() or c in ('-', '_') else '_' for c in folder_id).rstrip()
                        result = _write_export_file(safe_filename_base, playlist)
                        if result["success"]:
                            exported_count += 1
                    
                    logging.info(f"Batch exported {exported_count} playlists.")
                    response = {"success": True, "message": f"Successfully exported {exported_count} playlists to separate files."}

            elif command == 'list_import_files':
                try:
                    if not os.path.isdir(EXPORT_DIR):
                        response = {"success": True, "files": []}
                    else:
                        files = sorted([f for f in os.listdir(EXPORT_DIR) if f.endswith('.json')], reverse=True)
                        response = {"success": True, "files": files}
                except Exception as e:
                    error_msg = f"Failed to list import files: {e}"
                    logging.error(error_msg)
                    response = {"success": False, "error": error_msg}

            elif command == 'import_from_file':
                filename = message.get('filename')
                if filename:
                    try:
                        filepath = os.path.abspath(os.path.join(EXPORT_DIR, filename))
                        if not filepath.startswith(os.path.abspath(EXPORT_DIR)):
                            logging.error(f"Security violation: Attempted to access file outside of export directory: {filepath}")
                            response = {"success": False, "error": "Access denied."}
                        else:
                            with open(filepath, 'r', encoding='utf-8') as f:
                                content = f.read()
                            response = {"success": True, "data": content}
                    except Exception as e:
                        response = {"success": False, "error": f"Failed to read import file: {e}"}

            elif command == 'open_export_folder':
                try:
                    # Ensure the directory exists before trying to open it.
                    os.makedirs(EXPORT_DIR, exist_ok=True)
                    abs_path = os.path.abspath(EXPORT_DIR)

                    system = platform.system()
                    if system == "Windows":
                        # os.startfile() can be unreliable when called from a non-interactive
                        # context like a native messaging host. Using subprocess.Popen to
                        # call explorer.exe directly is more robust. os.path.normpath
                        # ensures the path uses the correct backslashes for Windows.
                        subprocess.Popen(['explorer', os.path.normpath(abs_path)])
                    elif system == "Darwin":  # macOS
                        subprocess.run(['open', abs_path], check=True)
                    else:  # Linux and other Unix-like systems
                        subprocess.run(['xdg-open', abs_path], check=True)

                    logging.info(f"Successfully issued command to open export folder at: {abs_path}")
                    response = {"success": True, "message": "Opening export folder."}
                except FileNotFoundError:
                    error_msg = "Could not open file explorer. Command not found (e.g., 'xdg-open' on Linux)."
                    logging.error(error_msg)
                    response = {"success": False, "error": error_msg}
                except Exception as e:
                    error_msg = f"An unexpected error occurred while opening the folder: {e}"
                    logging.error(error_msg)
                    response = {"success": False, "error": error_msg}

            elif command == 'get_anilist_releases':
                try:
                    # Execute the anilist_releases.py script using the same python interpreter
                    script_path = [sys.executable, os.path.join(SCRIPT_DIR, 'anilist_releases.py')]
                    result = subprocess.run(
                        script_path,
                        capture_output=True,
                        text=True, # Capture stdout/stderr as text
                        check=True # Raise an exception for non-zero exit codes
                    )
                    response = {"success": True, "output": result.stdout}
                except subprocess.CalledProcessError as e:
                    logging.error(f"Error running anilist_releases.py: {e.stderr}")
                    response = {"success": False, "error": f"Error fetching AniList releases: {e.stderr}"}
                except Exception as e:
                    logging.error(f"Unexpected error fetching AniList releases: {e}")
                    response = {"success": False, "error": f"Unexpected error: {e}"}

            else:
                response = {"success": False, "error": "Unknown command"}

            # Add the request_id to the response so the extension can match it
            if request_id:
                response['request_id'] = request_id
            send_message(response)

        except Exception as e:
            logging.error(f"Error in main loop: {e}", exc_info=True)
            try:
                error_response = {"success": False, "error": f"An unexpected error occurred in the native host: {str(e)}"}
                # Check if 'message' was successfully assigned before the error
                if 'message' in locals() and message.get('request_id'):
                    error_response['request_id'] = message.get('request_id')
                send_message(error_response)
            except Exception as send_e:
                logging.error(f"Could not send error message back to extension: {send_e}")

# Register a cleanup function to run when the script exits.
atexit.register(cleanup_ipc_socket)

if __name__ == '__main__':
    # handle_cli() will parse arguments and execute the command if it's a CLI call.
    # It returns True if it was a CLI call, and False otherwise.
    if not handle_cli():
        # Otherwise, assume native messaging mode for the browser.
        main()
