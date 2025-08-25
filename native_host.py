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
import platform

# --- Configuration ---
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_FILE = os.path.join(SCRIPT_DIR, "native_host.log")
MAX_LOG_LINES = 200
FOLDERS_FILE = os.path.join(SCRIPT_DIR, "folders.json")
SESSION_FILE = os.path.join(SCRIPT_DIR, "session.json")

# --- Global State ---
current_mpv_process = None
current_mpv_ipc_path = None
current_mpv_playlist = None # Holds the list of URLs for the running instance
current_mpv_pid = None # PID of the running instance, for restored sessions
current_mpv_owner_folder_id = None # The folder ID that "owns" the current session

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

def cleanup_ipc_socket():
    """Remove the IPC socket file on exit, if it exists (non-Windows)."""
    global current_mpv_ipc_path
    if current_mpv_ipc_path and platform.system() != "Windows":
        if os.path.exists(current_mpv_ipc_path):
            try:
                os.remove(current_mpv_ipc_path)
                logging.info(f"Cleaned up IPC socket: {current_mpv_ipc_path}")
            except OSError as e:
                logging.warning(f"Error removing IPC socket file {current_mpv_ipc_path}: {e}")

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

def clear_stale_session():
    """Clears the global state variables related to a running MPV instance."""
    global current_mpv_process, current_mpv_ipc_path, current_mpv_playlist, current_mpv_pid, current_mpv_owner_folder_id
    
    if current_mpv_pid:
        logging.info(f"Clearing stale session state for PID: {current_mpv_pid}")
    
    current_mpv_process = None
    current_mpv_ipc_path = None
    current_mpv_playlist = None
    current_mpv_pid = None
    current_mpv_owner_folder_id = None
    if os.path.exists(SESSION_FILE):
        try:
            os.remove(SESSION_FILE)
            logging.info(f"Cleaned up session file: {SESSION_FILE}")
        except OSError as e:
            logging.warning(f"Failed to remove session file during cleanup: {e}")

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

def start_mpv(playlist, folder_id, geometry=None, custom_width=None, custom_height=None):
    """Starts a new mpv process, or syncs the playlist with a running one."""
    global current_mpv_process, current_mpv_ipc_path, current_mpv_playlist, current_mpv_pid, current_mpv_owner_folder_id

    # Use the robust check to see if the process we are tracking is still alive.
    if current_mpv_pid and is_process_alive(current_mpv_ipc_path):
        # A process is running and responsive.
        if folder_id == current_mpv_owner_folder_id:
            logging.info(f"MPV is running for the same folder ('{folder_id}'). Attempting to sync playlist.")
            known_urls = set(current_mpv_playlist) if current_mpv_playlist else set()
            urls_to_add = [url for url in playlist if url not in known_urls]

            if not urls_to_add:
                logging.info("Playlist is already in sync or only contains removals (which are not handled live).")
                current_mpv_playlist = playlist
                return {"success": True, "message": "Playlist is already up to date."}

            try:
                logging.info(f"Appending {len(urls_to_add)} new item(s) to the playlist.")
                for url in urls_to_add:
                    append_command = {"command": ["loadfile", url, "append-play"]}
                    send_ipc_command(current_mpv_ipc_path, append_command, expect_response=False)

                current_mpv_playlist = playlist
                return {"success": True, "message": f"Added {len(urls_to_add)} new item(s) to the MPV playlist."}
            except Exception as e:
                logging.warning(f"Live playlist append failed unexpectedly: {e}. Clearing state to restart.")
                clear_stale_session()
                # Fall through to start a new instance below.
        else:
            # The requested folder is different. Prevent the new one from starting.
            error_message = f"An MPV instance is already running for folder '{current_mpv_owner_folder_id}'. Please close it to play from '{folder_id}'."
            logging.warning(error_message)
            return {"success": False, "error": error_message}
    else:
        # If we have a PID but the process is not alive, it's a stale session. Clear it.
        if current_mpv_pid:
            clear_stale_session()

    # --- Start New Instance Logic ---
    # This part of the code now only runs if no valid process is active.

    logging.info("Starting a new MPV instance.")
    mpv_exe = get_mpv_executable()
    ipc_path = get_ipc_path()

    try:
        # Add the --input-ipc-server flag to enable reliable communication.
        mpv_args = [
            mpv_exe, '--no-terminal', '--force-window=yes',
            '--save-position-on-quit',
            '--write-filename-in-watch-later-config',
            f'--input-ipc-server={ipc_path}',
        ]

        # Add geometry if custom dimensions are provided, otherwise use predefined geometry
        if custom_width and custom_height:
            logging.info(f"Applying custom geometry: {custom_width}x{custom_height}")
            mpv_args.append(f'--geometry={custom_width}x{custom_height}')
        elif geometry:
            # Only apply predefined geometry if custom is not set
            logging.info(f"Applying geometry: {geometry}")
            mpv_args.append(f'--geometry={geometry}')

        mpv_args.extend(['--'] + playlist) # Treat all subsequent arguments as URLs, not options.

        popen_kwargs = {
            'stderr': subprocess.PIPE,
            'stdout': subprocess.DEVNULL,
            'universal_newlines': False
        }
        if platform.system() == "Windows":
            # CREATE_NO_WINDOW prevents a console from flashing.
            # CREATE_NEW_PROCESS_GROUP is required to send CTRL_C_EVENT for graceful shutdown.
            popen_kwargs['creationflags'] = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP

        process = subprocess.Popen(mpv_args, **popen_kwargs)
        current_mpv_process = process # Store the new process object
        current_mpv_ipc_path = ipc_path # Store the IPC path for later use
        current_mpv_playlist = playlist # Store the playlist we just launched with
        current_mpv_pid = process.pid # Store the PID
        current_mpv_owner_folder_id = folder_id # Set the owner

        # --- Persist Session Info ---
        session_data = {
            "pid": current_mpv_pid,
            "ipc_path": current_mpv_ipc_path,
            "playlist": current_mpv_playlist,
            "owner_folder_id": current_mpv_owner_folder_id
        }
        with open(SESSION_FILE, 'w', encoding='utf-8') as f:
            json.dump(session_data, f)
        logging.info(f"MPV session info saved to {SESSION_FILE}")

        # Monitor stderr for diagnostics in a separate thread
        stderr_thread = threading.Thread(target=log_stream, args=(process.stderr, logging.warning))
        stderr_thread.daemon = True
        stderr_thread.start()

        logging.info(f"MPV process launched (PID: {process.pid}) with {len(playlist)} items.")
        return {"success": True, "message": "MPV playback initiated."}

    except FileNotFoundError:
        logging.error(f"Failed to launch mpv. Make sure '{mpv_exe}' is installed and in your system's PATH or configured correctly.")
        return {"success": False, "error": f"Error: '{mpv_exe}' executable not found."}
    except Exception as e:
        logging.error(f"An error occurred while trying to launch mpv: {e}")
        return {"success": False, "error": f"Error launching mpv: {e}"}

def close_mpv():
    """Closes the currently running mpv process, if any."""
    global current_mpv_process, current_mpv_ipc_path, current_mpv_playlist, current_mpv_pid, current_mpv_owner_folder_id

    # Determine if we think a process is running and gather its info
    pid_to_close = None
    ipc_path_to_use = None
    process_object = None

    if current_mpv_process and current_mpv_process.poll() is None:
        pid_to_close = current_mpv_process.pid
        ipc_path_to_use = current_mpv_ipc_path
        process_object = current_mpv_process
    elif current_mpv_pid: # From a restored session
        pid_to_close = current_mpv_pid
        ipc_path_to_use = current_mpv_ipc_path

    if pid_to_close:
        try:
            # --- Method 1: IPC Command (Most Reliable) ---
            if ipc_path_to_use:
                try:
                    logging.info(f"Attempting to close MPV (PID: {pid_to_close}) via IPC: {ipc_path_to_use}")
                    command = json.dumps({"command": ["quit"]}) + '\n'
                    if platform.system() == "Windows":
                        with open(ipc_path_to_use, 'w') as pipe: pipe.write(command)
                    else: # Linux/macOS
                        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
                            sock.connect(ipc_path_to_use)
                            sock.sendall(command.encode('utf-8'))
                    if process_object:
                        process_object.wait(timeout=5)
                    else:
                        time.sleep(1) # Give it a moment to shut down if we don't have the object
                    logging.info(f"MPV process (PID: {pid_to_close}) closed gracefully via IPC.")
                    return {"success": True, "message": "MPV instance has been closed."}
                except Exception as e:
                    logging.warning(f"IPC command to close MPV failed: {e}. Falling back to signal method.")

            # --- Method 2: Signal (Fallback) ---
            if process_object:
                logging.info(f"Attempting to close MPV process (PID: {pid_to_close}) via signal fallback.")
                if platform.system() == "Windows": process_object.send_signal(signal.CTRL_C_EVENT)
                else: process_object.terminate() # Sends SIGTERM
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
            # The state is now cleared inside the try block for more precise control.
            clear_stale_session()
    else:
        logging.info("Received 'close_mpv' command, but no active MPV process was found.")
        # Return success as the desired state (no mpv) is met.
        return {"success": True, "message": "No running MPV instance was found."}

def check_and_restore_session():
    """Checks for a persisted session file and restores state if the process is still alive."""
    global current_mpv_pid, current_mpv_ipc_path, current_mpv_playlist, current_mpv_owner_folder_id

    if not os.path.exists(SESSION_FILE):
        return

    logging.info(f"Found session file: {SESSION_FILE}. Checking for live process.")
    try:
        with open(SESSION_FILE, 'r', encoding='utf-8') as f:
            session_data = json.load(f)

        pid = session_data.get("pid")
        ipc_path = session_data.get("ipc_path")
        playlist = session_data.get("playlist")
        owner_folder_id = session_data.get("owner_folder_id")

        if not all([pid, ipc_path, playlist is not None, owner_folder_id]):
            raise ValueError("Session file is malformed.")

        if is_process_alive(ipc_path):
            # The process is alive! Restore the state.
            current_mpv_pid = pid
            current_mpv_ipc_path = ipc_path
            current_mpv_playlist = playlist
            current_mpv_owner_folder_id = owner_folder_id
            logging.info(f"Successfully restored session for MPV process (PID: {pid}) owned by folder '{owner_folder_id}'.")
        else:
            raise RuntimeError("Process not responding or IPC check failed.")

    except (FileNotFoundError, ConnectionRefusedError, RuntimeError, ValueError, json.JSONDecodeError) as e:
        logging.warning(f"Stale or invalid session file found. Reason: {e}. Cleaning up.")
        try:
            os.remove(SESSION_FILE)
        except OSError:
            pass # File might already be gone.

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

def handle_cli(): # Modified to use new structure and pass start_index
    """Handles command-line invocation."""
    # Log the full command line arguments for better debugging.
    logging.info(f"Native host started in CLI mode with args: {sys.argv}")
    if len(sys.argv) < 3 or sys.argv[1] != 'play':
        logging.warning(f"Invalid CLI arguments. Expected 'play <folder_id>', got: {' '.join(sys.argv[1:])}")
        print("Usage: python3 native_host.py play <folder_id>")
        sys.exit(1)

    folder_id = sys.argv[2]

    if not os.path.exists(FOLDERS_FILE):
        print(f"Error: Data file not found at {FOLDERS_FILE}. Please add an item in the extension first to create it.")
        logging.error(f"CLI Error: Data file not found at {FOLDERS_FILE}")
        sys.exit(1)

    try:
        # Use the new get_all_folders_from_file to ensure correct format
        folders_data = get_all_folders_from_file()
        folder_info = folders_data.get(folder_id)

        if folder_info is None or not isinstance(folder_info, dict) or "playlist" not in folder_info:
            print(f"Error: Folder '{folder_id}' not found or malformed in {FOLDERS_FILE}")
            logging.error(f"CLI Error: Folder '{folder_id}' not found or malformed.")
            sys.exit(1)
        
        playlist = folder_info["playlist"]

        logging.info(f"Found folder '{folder_id}' with {len(playlist)} item(s). Starting mpv...")
        print(f"Starting mpv for folder '{folder_id}' with {len(playlist)} item(s)...")
        start_mpv(playlist, folder_id)
    except Exception as e:
        print(f"An error occurred: {e}")
        logging.error(f"CLI Error: {e}")
        sys.exit(1)

def main():
    """Main message loop for native messaging from the browser."""
    logging.info("Native host started in messaging mode.")
    check_and_restore_session()
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
                if not folder_id:
                    response = {"success": False, "error": "No folderId provided for play action."}
                else:
                    response = start_mpv(playlist, folder_id, geometry=geometry, custom_width=custom_width, custom_height=custom_height)

            elif command == 'close_mpv':
                response = close_mpv()

            elif command == 'is_mpv_running':
                # We only care about the state we are tracking in memory.
                # If the host restarted, check_and_restore_session would have populated it.
                is_running = is_process_alive(current_mpv_ipc_path)

                # If the check fails, we should clear the stale state here too.
                # This makes the check command have a side-effect of cleaning up, which is good.
                if not is_running and current_mpv_pid:
                    clear_stale_session()

                logging.info(f"MPV running status check: {is_running} (Path: {current_mpv_ipc_path})")
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
    # If 'play' is the first argument, it's a CLI call.
    if len(sys.argv) > 1 and sys.argv[1] == 'play':
        handle_cli()
    else:
        # Otherwise, assume native messaging mode for the browser.
        # The arguments passed by Chrome (like the extension origin) are ignored,
        # and the script proceeds to the main messaging loop.
        main()
