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
sys.dont_write_bytecode = True

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
    import shutil
    import urllib.request
    import platform
    import re
    import uuid # Added for UUID generation
    from logging.handlers import RotatingFileHandler

    # --- Path Correction for CLI Usage ---
    SCRIPT_DIR = os.path.dirname(os.path.abspath(sys.argv[0]))

    # --- Configuration ---
    import file_io
    DATA_DIR = file_io.DATA_DIR
    LOG_FILE = os.path.join(DATA_DIR, "native_host.log")
    MAX_LOG_BYTES = 1024 * 1024 * 5 # 5 MB
    BACKUP_COUNT = 1

    # --- Logging Setup (Must be done BEFORE starting any threads) ---
    os.makedirs(DATA_DIR, exist_ok=True)
    root_logger = logging.getLogger()
    if root_logger.hasHandlers():
        root_logger.handlers.clear()
    root_logger.setLevel(logging.DEBUG)
    
    # Use standard RotatingFileHandler
    handler = RotatingFileHandler(LOG_FILE, maxBytes=MAX_LOG_BYTES, backupCount=BACKUP_COUNT, encoding='utf-8')
    formatter = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')
    handler.setFormatter(formatter)
    root_logger.addHandler(handler)

    # Prevent logs from propagating to the console (important for clean CLI)
    root_logger.propagate = False

    from mpv_session import MpvSessionManager
    from playlist_tracker import PlaylistTracker
    import cli
    import services
    from utils import ipc_utils
    from utils.native_host_handlers import HandlerManager
    from utils.janitor import Janitor

    SESSION_FILE = os.path.join(DATA_DIR, "session.json")
    ANILIST_CACHE_FILE = os.path.join(DATA_DIR, "anilist_cache.json")
    TEMP_PLAYLISTS_DIR = os.path.join(DATA_DIR, "temp_playlists")

    # --- Run Janitor Startup Sweep (Threaded) ---
    # This rotates logs, wipes temp files, and cleans up stale IPC/pycache.
    # Now that logging is configured, its output will go to the file.
    janitor = Janitor(DATA_DIR, TEMP_PLAYLISTS_DIR)
    janitor_thread = threading.Thread(target=janitor.run_startup_sweep, kwargs={'extension_root': SCRIPT_DIR}, daemon=True)
    janitor_thread.start()

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
            # Also filter out ffmpeg hls keepalive spam and thumbnail script errors.
            if "'uname' is not recognized" not in clean_line and "keepalive request failed" not in clean_line and "[mpv_thumbnail_script" not in clean_line:
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
    mpv_session = MpvSessionManager(session_file_path=SESSION_FILE, dependencies={
        'get_all_folders_from_file': file_io.get_all_folders_from_file,
        'get_mpv_executable': file_io.get_mpv_executable,
        'log_stream': log_stream,
        'send_message': send_message,
        'SCRIPT_DIR': SCRIPT_DIR,
        'TEMP_PLAYLISTS_DIR': TEMP_PLAYLISTS_DIR
    })

    handler_manager = HandlerManager(
        mpv_session=mpv_session,
        file_io_module=file_io,
        services_module=services,
        ipc_utils_module=ipc_utils,
        send_message_func=send_message,
        script_dir=SCRIPT_DIR,
        anilist_cache_file=ANILIST_CACHE_FILE,
        temp_playlists_dir=TEMP_PLAYLISTS_DIR,
        log_stream_func=log_stream
    )

    def cleanup_ipc_socket(session_manager):
        """Remove the IPC socket file on exit, if it exists (non-Windows)."""
        # Check if the MPV process is still running. If so, preserve the socket for reconnection.
        if session_manager.pid and ipc_utils.is_pid_running(session_manager.pid):
             logging.info(f"Preserving IPC socket {session_manager.ipc_path} because MPV (PID {session_manager.pid}) is still running.")
             return

        if session_manager.ipc_path and platform.system() != "Windows":
            ipc_dir = os.path.dirname(session_manager.ipc_path)
            if os.path.exists(session_manager.ipc_path):
                try:
                    os.remove(session_manager.ipc_path)
                    logging.info(f"Cleaned up IPC socket: {session_manager.ipc_path}")
                except OSError as e:
                    logging.warning(f"Error removing IPC socket file {session_manager.ipc_path}: {e}")
            if os.path.exists(ipc_dir) and not os.listdir(ipc_dir):
                try:
                    os.rmdir(ipc_dir)
                    logging.info(f"Cleaned up empty IPC directory: {ipc_dir}")
                except OSError as e:
                        logging.warning(f"Error removing IPC directory {ipc_dir}: {e}")

    # Register a cleanup function to run when the script exits.
    atexit.register(cleanup_ipc_socket, mpv_session)
    atexit.register(handler_manager._stop_local_m3u_server)

    def main():
        """Main message loop for native messaging from the browser."""
        # Ensure stdin/stdout are available (critical for native messaging)
        if sys.stdin is None or sys.stdout is None:
            logging.error("Standard input/output is missing. If on Windows, ensure the registry key points to 'python.exe' and not 'pythonw.exe'.")
            sys.exit(1)

        def handle_restore_session(message):
            """Manual trigger for session restoration from the extension."""
            res = mpv_session.restore()
            if res:
                return {"success": True, "action": "session_restored", "result": res}
            return {"success": True, "action": "session_restored", "result": None}

        COMMAND_HANDLERS = {
            'restore_session': handle_restore_session,
            'play': handler_manager.handle_play,
            'play_batch': handler_manager.handle_play_batch,
            'play_m3u': handler_manager.handle_play_m3u,
            'remove_item_live': handler_manager.handle_remove_item_live,
            'reorder_live': handler_manager.handle_reorder_live,
            'append': handler_manager.handle_append,
            'play_new_instance': handler_manager.handle_play_new_instance,
            'close_mpv': handler_manager.handle_close_mpv,
            'is_mpv_running': handler_manager.handle_is_mpv_running,
            'export_data': handler_manager.handle_export_data,
            'export_playlists': handler_manager.handle_export_playlists,
            'export_all_playlists_separately': handler_manager.handle_export_all_separately,
            'list_import_files': handler_manager.handle_list_import_files,
            'import_from_file': handler_manager.handle_import_from_file,
            'open_export_folder': handler_manager.handle_open_export_folder,
            'get_anilist_releases': handler_manager.handle_get_anilist_releases,
            'run_ytdlp_update': handler_manager.handle_run_ytdlp_update,
            'check_dependencies': handler_manager.handle_check_dependencies,
            'get_all_folders': handler_manager.handle_get_all_folders,
            'get_default_automatic_flags': handler_manager.handle_get_default_automatic_flags
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