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

# --- Global State ---
current_mpv_process = None
current_mpv_ipc_path = None

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

def start_mpv(playlist):
    """Starts a new mpv process, preventing duplicates if one is already running."""
    global current_mpv_process, current_mpv_ipc_path

    # Check if a process was previously launched and is still running
    if current_mpv_process and current_mpv_process.poll() is None:
        logging.warning("MPV process is already running. Blocking new instance.")
        return {"success": False, "error": "An MPV instance is already running. Close it to start a new one."}

    if not playlist:
        logging.warning("Received empty playlist for MPV. Nothing to play.")
        return {"success": False, "error": "Playlist is empty. Nothing to play."}

    logging.info("Starting a new MPV instance.")
    mpv_exe = get_mpv_executable()
    ipc_path = get_ipc_path()
    
    try:
        # Add the --input-ipc-server flag to enable reliable communication.
        mpv_args = [
            mpv_exe, '--no-terminal', '--force-window',
            '--save-position-on-quit',
            '--write-filename-in-watch-later-config',
            f'--input-ipc-server={ipc_path}',
            '--' # Treat all subsequent arguments as URLs, not options.
        ] + playlist

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
    global current_mpv_process, current_mpv_ipc_path

    # Check if we have a process object and if it's still running
    if current_mpv_process and current_mpv_process.poll() is None:
        pid = current_mpv_process.pid # Capture PID while process is confirmed alive
        try:
            # --- Method 1: IPC Command (Most Reliable) ---
            if current_mpv_ipc_path:
                try:
                    logging.info(f"Attempting to close MPV (PID: {pid}) via IPC: {current_mpv_ipc_path}")
                    command = json.dumps({"command": ["quit"]}) + '\n'
                    if platform.system() == "Windows":
                        with open(current_mpv_ipc_path, 'w') as pipe: pipe.write(command)
                    else: # Linux/macOS
                        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
                            sock.connect(current_mpv_ipc_path)
                            sock.sendall(command.encode('utf-8'))
                    current_mpv_process.wait(timeout=5)
                    logging.info(f"MPV process (PID: {pid}) closed gracefully via IPC.")
                    return {"success": True, "message": "MPV instance has been closed."}
                except Exception as e:
                    logging.warning(f"IPC command to close MPV failed: {e}. Falling back to signal method.")

            # --- Method 2: Signal (Fallback) ---
            logging.info(f"Attempting to close MPV process (PID: {pid}) via signal fallback.")
            if platform.system() == "Windows": current_mpv_process.send_signal(signal.CTRL_C_EVENT)
            else: current_mpv_process.terminate() # Sends SIGTERM
            current_mpv_process.wait(timeout=5)
            logging.info(f"MPV process (PID: {pid}) terminated successfully via signal.")
            return {"success": True, "message": "MPV instance has been closed."}
        except subprocess.TimeoutExpired:
            logging.warning(f"MPV process (PID: {pid}) did not terminate in time, forcing kill.")
            current_mpv_process.kill()
            return {"success": True, "message": "MPV instance was forcefully closed."}
        except Exception as e:
            error_msg = f"An error occurred while closing MPV process (PID: {pid}): {e}"
            logging.error(error_msg)
            return {"success": False, "error": error_msg}
        finally:
            # This block ensures the global state is always cleaned up after an attempt to close.
            current_mpv_process = None
            current_mpv_ipc_path = None
    else:
        logging.info("Received 'close_mpv' command, but no active MPV process was found.")
        # Return success as the desired state (no mpv) is met.
        return {"success": True, "message": "No running MPV instance was found."}

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
        start_mpv(playlist)
    except Exception as e:
        print(f"An error occurred: {e}")
        logging.error(f"CLI Error: {e}")
        sys.exit(1)

def main():
    """Main message loop for native messaging from the browser."""
    logging.info("Native host started in messaging mode.")
    while True:
        try:
            message = get_message() # This will block or sys.exit() on disconnect
            request_id = message.get('request_id')
            command = message.get('action')

            logging.info(f"Received message (ID: {request_id}): {json.dumps(message)}")

            response = {}
            if command == 'play':
                playlist = message.get('playlist', [])
                response = start_mpv(playlist)

            elif command == 'close_mpv':
                response = close_mpv()

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
