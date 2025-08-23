#!/usr/bin/env python3
import sys
import json
import struct
import subprocess
import socket
import os
import logging
import platform

# --- Configuration ---
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_FILE = os.path.join(SCRIPT_DIR, "native_host.log")
MAX_LOG_LINES = 200
FOLDERS_FILE = os.path.join(SCRIPT_DIR, "folders.json")
IPC_HOST = '127.0.0.1'
IPC_PORT = 7531 # A default port for MPV communication

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

def _check_ipc_server():
    """
    Checks if the MPV IPC server is active by trying to connect to its TCP socket.
    Returns True if the server is live, False otherwise.
    """
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.2)
            s.connect((IPC_HOST, IPC_PORT))
        return True # Socket is live
    except (ConnectionRefusedError, socket.timeout):
        # This is the expected result if the server is not running.
        return False
    except Exception as e:
        logging.warning(f"Unexpected error when checking IPC server: {e}")
        return False

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

def get_mpv_property(property_name):
    """Queries a property from the running mpv instance via its IPC socket."""
    try:
        # Use a unique request_id to match response to request
        request_id = 1 # Simple ID, could be more robust if multiple concurrent requests were possible
        command = {"command": ["get_property", property_name], "request_id": request_id}
        command_str = json.dumps(command) + '\n'
        
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.5)
            s.connect((IPC_HOST, IPC_PORT))
            s.sendall(command_str.encode('utf-8'))

            response_buffer = b""
            while True:
                chunk = s.recv(4096)
                if not chunk:
                    break
                response_buffer += chunk
                # MPV IPC responses are newline-terminated.
                if b'\n' in response_buffer:
                    line, _, response_buffer = response_buffer.partition(b'\n')
                    if line.strip():
                        try:
                            response_obj = json.loads(line.decode('utf-8'))
                            if response_obj.get("request_id") == request_id:
                                if response_obj.get("error") == "success":
                                    return response_obj.get("data")
                                else:
                                    logging.warning(f"MPV IPC error for property '{property_name}': {response_obj.get('error')}")
                                    return None
                        except json.JSONDecodeError:
                            pass # Not a valid JSON response, might be an event. Ignore.
            
            logging.warning(f"No matching response for property '{property_name}' with request_id {request_id}.")
            return None
    except (ConnectionRefusedError, socket.timeout) as e:
        logging.warning(f"Could not connect to MPV IPC socket to get property '{property_name}': {e}")
        return None
    except Exception as e:
        logging.error(f"Error getting MPV property '{property_name}': {e}")
        return None

def send_mpv_command(command_obj):
    """Sends a JSON command to the running mpv instance via its IPC socket."""
    # This function assumes the socket is valid and will raise exceptions on failure.
    command_str = json.dumps(command_obj) + '\n'
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.connect((IPC_HOST, IPC_PORT))
        s.sendall(command_str.encode('utf-8'))
    logging.info(f"Sent command to MPV: {command_str.strip()}")

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

def start_mpv(playlist, start_index=0):
    """Starts a new mpv process or loads URLs into an existing one."""
    if not playlist:
        logging.warning("Received empty playlist for MPV. Nothing to play.")
        return {"success": False, "error": "Playlist is empty for MPV playback."}

    is_running = _check_ipc_server()

    if is_running:
        # MPV is running, load the new playlist.
        logging.info("MPV is already running. Loading new playlist.")
        try:
            # Atomically replace the playlist and start at the desired index
            send_mpv_command({"command": ["playlist-clear"]})
            for url in playlist:
                send_mpv_command({"command": ["loadfile", url, "append-play"]})

            # Now, explicitly set the position and ensure it's playing
            send_mpv_command({"command": ["set_property", "playlist-pos", start_index]})
            logging.info(f"Set MPV playlist position to {start_index}.")
            
            return {"success": True, "message": "Loaded new playlist into existing MPV instance."}
        except Exception as e:
            logging.error(f"Failed to load playlist into running MPV: {e}")
            return {"success": False, "error": f"Failed to load playlist: {e}"}
    else:
        # MPV is not running, start a new process.
        logging.info("MPV not running. Starting a new instance.")
        mpv_exe = get_mpv_executable()
        try:
            mpv_args = [
                mpv_exe, '--no-terminal', '--force-window', '--idle=once',
                f'--input-ipc-server=tcp://{IPC_HOST}:{IPC_PORT}',
                '--save-position-on-quit', # Save playback position for each file
                '--write-filename-in-watch-later-config' # Use filename in watch_later config
            ] + playlist
            if start_index > 0 and start_index < len(playlist):
                mpv_args.append(f'--playlist-start={start_index}')
                logging.info(f"Starting MPV with playlist position at {start_index}.")

            # --- Add creationflags for Windows to prevent console window flashing ---
            popen_kwargs = {}
            if platform.system() == "Windows":
                # This flag prevents a console window from being created for the mpv process.
                popen_kwargs['creationflags'] = subprocess.CREATE_NO_WINDOW

            subprocess.Popen(mpv_args, **popen_kwargs)
            logging.info(f"Attempting to start MPV process with {len(playlist)} items.")
            return {"success": True, "message": "MPV playback initiated."}
        except FileNotFoundError:
            logging.error(f"Failed to launch mpv. Make sure '{mpv_exe}' is installed and in your system's PATH or configured correctly.")
            return {"success": False, "error": f"Error: '{mpv_exe}' executable not found."}
        except Exception as e:
            logging.error(f"An error occurred while trying to launch mpv: {e}")
            return {"success": False, "error": f"Error launching mpv: {e}"}

def stop_mpv(): # Modified to return playlist_pos
    """Stops the running mpv instance via its IPC socket and returns current playlist position."""
    current_playlist_pos = get_mpv_property("playlist-pos")
    
    if not _check_ipc_server():
        logging.info("Stop command received, but MPV not running (no active IPC server).")
        return {"success": True, "message": "MPV was not running.", "playlist_pos": current_playlist_pos}

    try:
        send_mpv_command({"command": ["quit"]})
        logging.info("Sent 'quit' command to MPV via IPC socket.")
        return {"success": True, "message": "Quit command sent to MPV.", "playlist_pos": current_playlist_pos}
    except Exception as e:
        logging.error(f"Failed to send quit command to MPV: {e}")
        return {"success": False, "error": f"Failed to stop MPV: {e}", "playlist_pos": current_playlist_pos}

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
                    "playlist": folder_content.get("playlist", []),
                    "last_played_pos": folder_content.get("last_played_pos", 0)
                }
            elif isinstance(folder_content, list):
                # Old format: a raw list of URLs
                logging.info(f"Converting old format (list) for folder '{folder_id}' to new format.")
                converted_folders[folder_id] = {"playlist": folder_content, "last_played_pos": 0}
                needs_resave = True
            elif isinstance(folder_content, dict) and "urls" in folder_content:
                # Old format: a dict with a 'urls' key
                logging.info(f"Converting old format (dict with 'urls') for folder '{folder_id}' to new format.")
                converted_folders[folder_id] = {
                    "playlist": folder_content.get("urls", []),
                    "last_played_pos": folder_content.get("last_played_pos", 0)
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
        start_index = folder_info.get("last_played_pos", 0)

        logging.info(f"Found folder '{folder_id}' with {len(playlist)} item(s). Starting mpv...")
        print(f"Starting mpv for folder '{folder_id}' with {len(playlist)} item(s)...")
        start_mpv(playlist, start_index) # Pass start_index to CLI play
    except Exception as e:
        print(f"An error occurred: {e}")
        logging.error(f"CLI Error: {e}")
        sys.exit(1)

def main(): # Modified to pass start_index and handle stop response
    """Main message loop for native messaging from the browser."""
    logging.info("Native host started in messaging mode.")
    while True:
        try:
            message = get_message() # This will block or sys.exit() on disconnect
            command = message.get('action')

            logging.info(f"Received message: {json.dumps(message)}")

            if command == 'play':
                playlist = message.get('playlist', [])
                start_index = message.get('start_index', 0) # Get start_index from message
                response = start_mpv(playlist, start_index)
                send_message(response)

            elif command == 'stop':
                response = stop_mpv() # stop_mpv now returns playlist_pos
                send_message(response)
            
            elif command == 'export_data':
                data_to_export = message.get('data')
                if data_to_export is not None:
                    try:
                        with open(FOLDERS_FILE, 'w') as f:
                            json.dump(data_to_export, f, indent=4)
                        logging.info(f"Data exported to {FOLDERS_FILE}")
                        send_message({"success": True, "message": "Data successfully synced to file."})
                    except Exception as e:
                        error_msg = f"Failed to write to {FOLDERS_FILE}: {e}"
                        logging.error(error_msg)
                        send_message({"success": False, "error": error_msg})
                else:
                    send_message({"success": False, "error": "No data provided for export."})

            else:
                send_message({"success": False, "error": "Unknown command"})

        except Exception as e:
            logging.error(f"Error in main loop: {e}", exc_info=True)
            try:
                send_message({"success": False, "error": f"An unexpected error occurred in the native host: {str(e)}"})
            except Exception as send_e:
                logging.error(f"Could not send error message back to extension: {send_e}")

if __name__ == '__main__':
    # If 'play' is the first argument, it's a CLI call.
    if len(sys.argv) > 1 and sys.argv[1] == 'play':
        handle_cli()
    else:
        # Otherwise, assume native messaging mode for the browser.
        # The arguments passed by Chrome (like the extension origin) are ignored,
        # and the script proceeds to the main messaging loop.
        main()
