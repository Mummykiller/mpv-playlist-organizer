#!/usr/bin/env python3
import sys
import os
import traceback
from datetime import datetime

# --- Path Correction for CLI Usage ---
# This ensures that if the script is run from a different directory (e.g., via PATH),
# it can still find its own modules like 'file_io' and 'cli'.
SCRIPT_DIR_FOR_PATH = os.path.dirname(os.path.abspath(sys.argv[0]))
sys.path.insert(0, SCRIPT_DIR_FOR_PATH)
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'

# --- Standalone Function for Failsafe Path ---
# This is intentionally self-contained to avoid import errors if dependencies are missing.
def _get_failsafe_data_dir():
    """A simple, dependency-free function to get the user data directory path."""
    app_name = "MPVPlaylistOrganizer"
    system = sys.platform
    if system.startswith("win"):
        return os.path.join(os.environ.get('APPDATA', ''), app_name)
    elif system.startswith("darwin"):
        return os.path.join(os.path.expanduser('~/Library/Application Support'), app_name)
    else: # Linux and other Unix-like systems
        xdg_data_home = os.getenv('XDG_DATA_HOME')
        if xdg_data_home:
            return os.path.join(xdg_data_home, app_name)
        else:
            return os.path.join(os.path.expanduser('~/.local/share'), app_name)

# --- Failsafe Crash Handler ---
# This block is added to catch any startup errors and log them to a file.
FAILSAFE_LOG_PATH = None
try:
    data_dir_path = _get_failsafe_data_dir()
    os.makedirs(data_dir_path, exist_ok=True)
    FAILSAFE_LOG_PATH = os.path.join(data_dir_path, "native_host_crash.log")
except Exception:
    # If creating the data directory fails, fall back to the script's directory.
    FAILSAFE_LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(sys.argv[0])), "native_host_crash.log")
    # As a last resort, try to use the main log file name in the same fallback directory.
    LOG_FILE = os.path.join(os.path.dirname(os.path.abspath(sys.argv[0])), "native_host.log")

try:
    # --- Windows pythonw.exe Guard ---
    # If this script is started by the browser on Windows, it might be launched with
    # an executable that has no console (like pythonw.exe), which makes sys.stdin `None`.
    # This breaks native messaging. This guard detects that situation and re-launches
    # the script with the standard python.exe, which has the necessary I/O streams.
    # This check is skipped if CLI arguments are present, assuming it's an interactive session.
    if sys.platform == "win32" and sys.stdin is None:
        import subprocess
        # Re-launch with python.exe. CREATE_NO_WINDOW prevents a console from flashing.
        si = subprocess.STARTUPINFO()
        si.dwFlags = subprocess.STARTF_USESTDHANDLES
        creation_flags = subprocess.CREATE_NO_WINDOW
        # Use sys.executable to find the python.exe corresponding to the current pythonw.exe
        script_path = os.path.abspath(sys.argv[0])
        
        subprocess.Popen([sys.executable.replace("pythonw.exe", "python.exe"), script_path] + sys.argv[1:], creationflags=creation_flags, startupinfo=si)
        sys.exit(0)

    import json
    import struct
    import subprocess
    import atexit
    import logging
    import time
    import signal
    import threading
    import argparse
    import shutil
    import urllib.request
    import platform
    import re
    from mpv_session import MpvSessionManager
    from playlist_tracker import PlaylistTracker
    import file_io
    import cli
    import services
    from utils import ipc_utils

    # --- Function to get the appropriate user data directory ---
    def get_user_data_dir():
        """Returns a platform-specific, user-writable directory for app data."""
        return file_io.get_user_data_dir()

    # --- Configuration ---
    DATA_DIR = file_io.DATA_DIR
    LOG_FILE = os.path.join(DATA_DIR, "native_host.log")
    MAX_LOG_LINES = 200
    SESSION_FILE = os.path.join(DATA_DIR, "session.json")
    ANILIST_CACHE_FILE = os.path.join(DATA_DIR, "anilist_cache.json")

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
    # Ensure the data directory exists before setting up the logger
    os.makedirs(DATA_DIR, exist_ok=True)
    root_logger = logging.getLogger()
    if root_logger.hasHandlers():
        root_logger.handlers.clear()
    root_logger.setLevel(logging.INFO)
    handler = TrimmingFileHandler(LOG_FILE, max_lines=MAX_LOG_LINES, encoding='utf-8')
    formatter = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')
    handler.setFormatter(formatter)
    root_logger.addHandler(handler)
    SCRIPT_DIR = os.path.dirname(os.path.abspath(sys.argv[0]))

    def log_stream(stream, log_level, owner_folder_id):
        """Reads from a stream line by line and logs it."""
        # Keywords that suggest yt-dlp is outdated for YouTube.
        YTDLP_FAILURE_KEYWORDS = [
            "HTTP Error 410", # "HTTP Error 410: Gone" is a classic sign.
            "This video is unavailable",
            "unable to extract video data"
        ]
        ytdlp_failure_detected = False
        
        # Regex to strip ANSI escape codes (colors)
        ansi_escape = re.compile(r'\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])')

        # The `for line in iter(...)` construct is a standard way to read
        # from a stream until it's closed.
        for line in iter(stream.readline, b''):
            decoded_line = line.decode('utf-8', errors='ignore').strip()
            clean_line = ansi_escape.sub('', decoded_line)
            # Filter out the noisy and irrelevant 'uname' warning on Windows.
            # Also filter out ffmpeg hls keepalive spam.
            if "'uname' is not recognized" not in clean_line and "keepalive request failed" not in clean_line:
                log_level(f"[MPV Process]: {decoded_line}")
                if not ytdlp_failure_detected and any(keyword in clean_line for keyword in YTDLP_FAILURE_KEYWORDS):
                    ytdlp_failure_detected = True # Prevent multiple triggers
                    logging.warning("Detected a potential yt-dlp failure. Notifying extension.")
                    # Send a message to the extension to check if auto-update is enabled
                    send_message({
                        "action": "ytdlp_update_check", 
                        "folderId": owner_folder_id,
                        "log": {
                            "text": "[Native Host]: YouTube playback failed. This may be due to an outdated yt-dlp. Checking for auto-update...",
                            "type": "error"
                        }
                    })
        stream.close()

    def get_message():
        """Reads a message from stdin and decodes it."""
        raw_length = sys.stdin.buffer.read(4)
        if len(raw_length) == 0:
            sys.exit(0)
        message_length = struct.unpack('@I', raw_length)[0]
        message = sys.stdin.buffer.read(message_length).decode('utf-8')
        return json.loads(message)

    print_lock = threading.Lock()

    def send_message(message_content):
        """Encodes and sends a message to stdout."""
        with print_lock:
            encoded_content = json.dumps(message_content).encode('utf-8')
            message_length = struct.pack('@I', len(encoded_content))
            sys.stdout.buffer.write(message_length)
            sys.stdout.buffer.write(encoded_content)
            sys.stdout.buffer.flush()

    # --- Global Instances ---
    playlist_tracker = None
    mpv_session = MpvSessionManager(session_file_path=SESSION_FILE, dependencies={
        'get_all_folders_from_file': file_io.get_all_folders_from_file,
        'get_mpv_executable': file_io.get_mpv_executable,
        'log_stream': log_stream,
        'send_message': send_message,
        'SCRIPT_DIR': SCRIPT_DIR,
        'playlist_tracker': lambda: playlist_tracker
    })
    
    
    def cleanup_ipc_socket():
        """Remove the IPC socket file on exit, if it exists (non-Windows)."""
        # Access the ipc_path from the global session manager instance
        if mpv_session.ipc_path and platform.system() != "Windows":
            ipc_dir = os.path.dirname(mpv_session.ipc_path)
            if os.path.exists(mpv_session.ipc_path):
                try:
                    os.remove(mpv_session.ipc_path)
                    logging.info(f"Cleaned up IPC socket: {mpv_session.ipc_path}")
                except OSError as e:
                    logging.warning(f"Error removing IPC socket file {mpv_session.ipc_path}: {e}")
            # Clean up the containing directory if it's empty
            if os.path.exists(ipc_dir) and not os.listdir(ipc_dir):
                try:
                    os.rmdir(ipc_dir)
                    logging.info(f"Cleaned up empty IPC directory: {ipc_dir}")
                except OSError as e:
                     logging.warning(f"Error removing IPC directory {ipc_dir}: {e}")
    
    def launch_unmanaged_mpv(playlist, geometry, custom_width, custom_height, custom_mpv_flags, automatic_mpv_flags):
        """Launches a new, unmanaged instance of MPV."""
        logging.info("Launching a new, unmanaged MPV instance.")
        mpv_exe = file_io.get_mpv_executable()
        # This instance will not have a persistent IPC server, so it's fire-and-forget.
        # We don't need to generate a unique IPC path.
        
        try:
            full_command, has_terminal_flag = services.construct_mpv_command(
                mpv_exe=mpv_exe,
                urls=playlist,
                geometry=geometry,
                custom_width=custom_width,
                custom_height=custom_height,
                custom_mpv_flags=custom_mpv_flags,
                automatic_mpv_flags=automatic_mpv_flags
            )

            popen_kwargs = services.get_mpv_popen_kwargs(has_terminal_flag)

            process = subprocess.Popen(full_command, **popen_kwargs)
            
            stderr_thread = threading.Thread(target=log_stream, args=(process.stderr, logging.warning, None))
            stderr_thread.daemon = True
            stderr_thread.start()
    
            logging.info(f"Unmanaged MPV process launched (PID: {process.pid}) with {len(playlist)} items.")
            return {"success": True, "message": "New MPV instance launched."}
        except Exception as e:
            logging.error(f"An error occurred while trying to launch unmanaged mpv: {e}")
            return {"success": False, "error": f"Error launching new mpv instance: {e}"}

    # --- Command Handlers ---
    def handle_play(message):
        global playlist_tracker
        url_item = message.get('url_item')
        folder_id = message.get('folderId')
        if not folder_id or not url_item:
            return {"success": False, "error": "Missing folderId or url_item for play action."}

        # Get settings from config file
        settings = file_io.get_settings()

        # Create a new tracker for this playback session
        playlist_tracker = PlaylistTracker(folder_id, [url_item], file_io, settings)

        bypass_scripts_config = message.get('bypassScripts', {})
        processed_url, script_headers, ytdl_options = services.apply_bypass_script(url_item, bypass_scripts_config, send_message, SCRIPT_DIR, mpv_session)
        url_item['url'] = processed_url
        
        disable_http_persistent = True if (script_headers and not ytdl_options) else False
        custom_mpv_flags = message.get('custom_mpv_flags')
        if disable_http_persistent:
            persistent_flag = "--demuxer-lavf-o=http_persistent=0"
            custom_mpv_flags = (custom_mpv_flags + " " + persistent_flag) if custom_mpv_flags else persistent_flag

        def run_mpv_session():
            mpv_session.start(
                url_item, folder_id, 
                geometry=message.get('geometry'), 
                custom_width=message.get('custom_width'), 
                custom_height=message.get('custom_height'), 
                custom_mpv_flags=custom_mpv_flags, 
                automatic_mpv_flags=message.get('automatic_mpv_flags'), 
                start_paused=message.get('start_paused', False), 
                headers=script_headers, 
                disable_http_persistent=disable_http_persistent,
                ytdl_raw_options=ytdl_options
            )
        
        mpv_thread = threading.Thread(target=run_mpv_session)
        mpv_thread.daemon = True
        mpv_thread.start()
        return {"success": True, "message": "Playback initiated."}

    def handle_append(message):
        global playlist_tracker
        url_item = message.get('url_item')
        if not url_item:
            return {"success": False, "error": "Missing url_item for append action."}
        
        if playlist_tracker:
            playlist_tracker.add_item(url_item)

        logging.info("Processing append request: resolving URL via bypass script if configured.")
        bypass_scripts_config = message.get('bypassScripts', {})
        processed_url, script_headers, ytdl_options = services.apply_bypass_script(url_item, bypass_scripts_config, send_message, SCRIPT_DIR, mpv_session)
        url_item['url'] = processed_url
        
        disable_http_persistent = True if (script_headers and not ytdl_options) else False
        response = mpv_session.append(url_item, headers=script_headers, mode="append", disable_http_persistent=disable_http_persistent, ytdl_raw_options=ytdl_options)
        return response if response else {"success": False, "error": "Failed to append to MPV playlist."}

    def handle_play_new_instance(message):
        return launch_unmanaged_mpv(
            message.get('playlist', []), 
            message.get('geometry'), 
            message.get('custom_width'), 
            message.get('custom_height'), 
            message.get('custom_mpv_flags'), 
            message.get('automatic_mpv_flags')
        )

    def handle_is_mpv_running(message):
        is_running = ipc_utils.is_process_alive(mpv_session.pid, mpv_session.ipc_path)
        if not is_running and mpv_session.pid:
            mpv_session.clear()
        logging.info(f"MPV running status check: {is_running} (Path: {mpv_session.ipc_path})")
        return {"success": True, "is_running": is_running}

    def handle_export_data(message):
        data = message.get('data')
        return file_io.write_folders_file(data) if data is not None else {"success": False, "error": "No data provided."}

    def handle_export_playlists(message):
        data = message.get('data')
        filename = message.get('filename')
        if not data or not filename: return {"success": False, "error": "Missing data or filename."}
        return file_io.write_export_file(filename, data)

    def handle_export_all_separately(message):
        folders = message.get('data')
        if not folders: return {"success": False, "error": "No folder data provided."}
        count = 0
        for f_id, f_data in folders.items():
            if 'playlist' in f_data:
                safe_name = "".join(c if c.isalnum() or c in ('-', '_') else '_' for c in f_id).rstrip()
                if file_io.write_export_file(safe_name, f_data['playlist'])["success"]: count += 1
        return {"success": True, "message": f"Successfully exported {count} playlists."}

    def handle_import_from_file(message):
        filename = message.get('filename')
        if not filename: return {"success": False, "error": "No filename provided."}
        try:
            filepath = os.path.abspath(os.path.join(file_io.EXPORT_DIR, filename))
            if not filepath.startswith(os.path.abspath(file_io.EXPORT_DIR)):
                return {"success": False, "error": "Access denied."}
            with open(filepath, 'r', encoding='utf-8') as f:
                return {"success": True, "data": f.read()}
        except Exception as e:
            return {"success": False, "error": f"Failed to read file: {e}"}

    def handle_open_export_folder(message):
        try:
            os.makedirs(file_io.EXPORT_DIR, exist_ok=True)
            path = os.path.abspath(file_io.EXPORT_DIR)
            if platform.system() == "Windows": subprocess.Popen(['explorer', os.path.normpath(path)])
            elif platform.system() == "Darwin": subprocess.run(['open', path], check=True)
            else: subprocess.run(['xdg-open', path], check=True)
            return {"success": True, "message": "Opening export folder."}
        except Exception as e:
            return {"success": False, "error": f"Failed to open folder: {e}"}

    def main():
        """Main message loop for native messaging from the browser."""

        # Ensure stdin/stdout are available (critical for native messaging)
        if sys.stdin is None or sys.stdout is None:
            logging.error("Standard input/output is missing. If on Windows, ensure the registry key points to 'python.exe' and not 'pythonw.exe'.")
            sys.exit(1)

        logging.info("Native host started in messaging mode.")

        # On startup, try to restore a session. The result will be handled by the
        # background script, which might trigger cleanup for a stale session.
        restore_result = mpv_session.restore()

        if restore_result:
            send_message({"action": "session_restored", "result": restore_result})

        COMMAND_HANDLERS = {
            'play': handle_play,
            'append': handle_append,
            'play_new_instance': handle_play_new_instance,
            'close_mpv': lambda m: (playlist_tracker.stop_tracking() if playlist_tracker else None) and mpv_session.close(),
            'is_mpv_running': handle_is_mpv_running,
            'export_data': handle_export_data,
            'export_playlists': handle_export_playlists,
            'export_all_playlists_separately': handle_export_all_separately,
            'list_import_files': lambda m: file_io.list_import_files(),
            'import_from_file': handle_import_from_file,
            'open_export_folder': handle_open_export_folder,
            'get_anilist_releases': lambda m: services.get_anilist_releases_with_cache(
                m.get('force', False), m.get('delete_cache', False), m.get('is_cache_disabled', False), 
                ANILIST_CACHE_FILE, SCRIPT_DIR, send_message
            ),
            'run_ytdlp_update': lambda m: services.update_ytdlp(send_message),
            'check_dependencies': lambda m: services.check_mpv_and_ytdlp_status(file_io.get_mpv_executable, send_message),
            'get_default_automatic_flags': lambda m: {"success": True, "flags": [
                {"flag": "--pause", "description": "Start MPV paused.", "enabled": False},
                {"flag": "terminal", "description": "Show a terminal window.", "enabled": False}
            ]}
        }

        while True:
            try:
                message = get_message()  # This will block or sys.exit() on disconnect
                command = message.get('action')
                logging.info(f"Received message (ID: {message.get('request_id')}): {json.dumps(message)}")
                
                handler = COMMAND_HANDLERS.get(command)
                if handler:
                    response = handler(message)
                else:
                    response = {"success": False, "error": "Unknown command"}

                # Add the request_id to the response so the extension can match it
                request_id = message.get('request_id')
                if request_id:
                    response['request_id'] = request_id
                send_message(response)

            except Exception as e:
                logging.error(f"Error in main loop: {e}", exc_info=True)
                try:
                    error_response = {"success": False, "error": f"An unexpected error occurred in the native host: {str(e)}"}
                    # Check if 'message' was successfully assigned before the error
                    if 'message' in locals() and isinstance(message, dict) and message.get('request_id'):
                        error_response['request_id'] = message.get('request_id')
                    send_message(error_response)
                except Exception as send_e:
                    logging.error(f"Could not send error message back to extension: {send_e}")
    
    # Register a cleanup function to run when the script exits.
    atexit.register(cleanup_ipc_socket)

    if __name__ == '__main__':
        logging.info(f"Startup Args: {sys.argv}, TTY: {sys.stdin.isatty() if sys.stdin else 'None'}")

        # Robust Browser Detection
        is_browser = False
        if len(sys.argv) > 1:
            if sys.argv[1].startswith('chrome-extension://') or sys.argv[1].startswith('moz-extension://'):
                is_browser = True
            elif sys.argv[1].endswith('.json') and os.path.isabs(sys.argv[1]):
                is_browser = True
        if not is_browser and sys.stdin and not sys.stdin.isatty():
            is_browser = True

        if is_browser:
            main()
            sys.exit(0)

        # handle_cli() will parse arguments and execute the command if it's a CLI call.
        # It returns True if it was a CLI call, and False otherwise.
        try:
            # Inject dependencies into the CLI module before handling any commands.
            cli.inject_dependencies({
                'file_io': file_io,
                'mpv_session': mpv_session,
                'ipc_utils': ipc_utils,
                'time': time
            })
            if not cli.handle_cli():
                # If it wasn't a CLI call, start the main message loop for the browser.
                main()
        except SystemExit:
            # Argparse calls sys.exit() on --help or on input errors. This is normal.
            pass
        except Exception as cli_error:
            # Catch any other unexpected errors during CLI execution.
            logging.error(f"An unexpected CLI error occurred: {cli_error}", exc_info=True)
            print(f"Error: {cli_error}", file=sys.stderr)
            sys.exit(1)

except Exception as e:
    # This is the failsafe block that catches any error during script initialization or execution.
    # Use the main LOG_FILE path if it was defined, otherwise use the crash-specific path.
    log_path_to_use = 'LOG_FILE' in locals() and LOG_FILE or FAILSAFE_LOG_PATH
    if log_path_to_use:
        try:
            with open(log_path_to_use, "a", encoding="utf-8") as f:
                f.write(f"---\n--- Native Host Crashed ---\n")
                f.write(f"Timestamp: {datetime.now().isoformat()}\n")
                f.write(f"Error: {str(e)}\n\n")
                f.write(traceback.format_exc())
                f.write("\n---------------------------\n\n")
        except Exception:
            # If even the failsafe logger fails, there's nothing more we can do.
            pass
    # It's critical to re-raise the exception so the process still exits with an error,
    # which is the behavior the user is observing.
    raise