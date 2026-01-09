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
# This is used ONLY for the very early crash handler before file_io is imported.
# NOTE: This logic duplicates `file_io.get_user_data_dir`. If you change that,
# you MUST update this fallback to ensure crash logs are stored in the correct location.
def _get_emergency_log_path():
    """A minimal, dependency-free function to find a place to log fatal startup errors."""
    app_name = "MPVPlaylistOrganizer"
    home = os.path.expanduser('~')
    if sys.platform.startswith("win"):
        base = os.environ.get('APPDATA', home)
    elif sys.platform.startswith("darwin"):
        base = os.path.join(home, 'Library/Application Support')
    else:
        base = os.path.join(home, '.local/share')
    
    path = os.path.join(base, app_name)
    try:
        os.makedirs(path, exist_ok=True)
        return os.path.join(path, "native_host_crash.log")
    except:
        return "native_host_crash.log" # Current directory fallback

# --- Failsafe Crash Handler ---
FAILSAFE_LOG_PATH = _get_emergency_log_path()

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
    import ctypes

    def set_process_name():
        """Attempts to set a recognizable name for the process in Task Managers."""
        try:
            if sys.platform.startswith('linux'):
                # Linux: PR_SET_NAME = 15. Max 16 bytes including null terminator.
                libc = ctypes.CDLL('libc.so.6')
                # "mpv-pl-organize" is 15 chars
                libc.prctl(15, b'mpv-pl-organize', 0, 0, 0)
            elif sys.platform == 'win32':
                # Windows: Sets the title shown in the Processes tab
                ctypes.windll.kernel32.SetConsoleTitleW("mpv playlist organizer")
        except Exception:
            pass # Fails silently if restricted or libc missing

    # --- Path Correction for CLI Usage ---
    SCRIPT_DIR = os.path.dirname(os.path.abspath(sys.argv[0]))

    # --- Configuration ---
    import file_io
    DATA_DIR = file_io.DATA_DIR
    
    # Ensure standard Linux binary paths are in the environment PATH
    # This helps sub-processes like yt-dlp find ffmpeg and JS runtimes (node/deno)
    current_path_list = os.environ.get("PATH", "").split(os.pathsep)
    
    if platform.system() == "Linux":
        extra_paths = [
            "/usr/bin", "/usr/local/bin", "/bin", "/usr/sbin", "/sbin",
            os.path.expanduser("~/.local/bin"),
            os.path.expanduser("~/bin")
        ]
        for p in extra_paths:
            if p not in current_path_list:
                current_path_list.insert(0, p) # Prepend for priority
    
    # Inject configured paths for ffmpeg and node if they are set
    config = file_io.get_settings()
    for key in ["ffmpeg_path", "node_path"]:
        val = config.get(key)
        if val and os.path.exists(val):
            dir_path = os.path.dirname(val)
            if dir_path not in current_path_list:
                current_path_list.insert(0, dir_path)
                
    os.environ["PATH"] = os.pathsep.join(current_path_list)

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

    # --- Dedicated IPC Event Logger ---
    # This separates high-frequency tracking noise (like time-pos) into its own file.
    IPC_LOG_FILE = os.path.join(DATA_DIR, "ipc_events.log")
    ipc_logger = logging.getLogger("ipc_events")
    ipc_logger.setLevel(logging.DEBUG)
    ipc_logger.propagate = False # Prevent noise from reaching native_host.log
    
    ipc_handler = RotatingFileHandler(IPC_LOG_FILE, maxBytes=MAX_LOG_BYTES, backupCount=BACKUP_COUNT, encoding='utf-8')
    ipc_handler.setFormatter(formatter)
    ipc_logger.addHandler(ipc_handler)

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
                log_level(f"[PY][MPV]: {decoded_line}")
                if not ytdlp_failure_detected and any(keyword in clean_line for keyword in YTDLP_FAILURE_KEYWORDS):
                    ytdlp_failure_detected = True # Prevent multiple triggers
                    logging.warning("[PY][MPV] Detected a potential yt-dlp failure. Notifying extension.")
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
            logging.info("[PY][MAIN] Stdin closed (EOF). Exiting native host.")
            sys.exit(0)
        message_length = struct.unpack('@I', raw_length)[0]
        message = sys.stdin.buffer.read(message_length).decode('utf-8')
        return json.loads(message)

    print_lock = threading.Lock()

    def send_message(message_content):
        """Encodes and sends a message to stdout."""
        try:
            with print_lock:
                encoded_content = json.dumps(message_content).encode('utf-8')
                message_length = struct.pack('@I', len(encoded_content))
                sys.stdout.buffer.write(message_length)
                sys.stdout.buffer.write(encoded_content)
                sys.stdout.buffer.flush()
        except BrokenPipeError:
            # This happens when the browser closes the connection while we are trying to send a message.
            # It's a normal occurrence during extension reloads or browser shutdown.
            logging.info("[PY] Browser disconnected (Broken Pipe). Normal shutdown.")
        except Exception as e:
            logging.error(f"[PY] Unexpected error in send_message: {e}")

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
             logging.info(f"[PY] Preserving IPC socket {session_manager.ipc_path} because MPV (PID {session_manager.pid}) is still running.")
             return

        if session_manager.ipc_path and platform.system() != "Windows":
            ipc_dir = os.path.dirname(session_manager.ipc_path)
            if os.path.exists(session_manager.ipc_path):
                try:
                    os.remove(session_manager.ipc_path)
                    logging.info(f"[PY] Cleaned up IPC socket: {session_manager.ipc_path}")
                except OSError as e:
                    logging.warning(f"[PY] Error removing IPC socket file {session_manager.ipc_path}: {e}")
            if os.path.exists(ipc_dir) and not os.listdir(ipc_dir):
                try:
                    os.rmdir(ipc_dir)
                    logging.info(f"[PY] Cleaned up empty IPC directory: {ipc_dir}")
                except OSError as e:
                        logging.warning(f"[PY] Error removing IPC directory {ipc_dir}: {e}")

    def signal_handler(sig, frame):
        """Handles termination signals from the browser."""
        sig_name = "SIGTERM" if sig == signal.SIGTERM else "SIGHUP"
        logging.info(f"[PY] Received {sig_name}. Browser connection lost. Native host exiting...")
        # NOTE: We do NOT call mpv_session.close() here. 
        # We want to preserve MPV autonomy so it can be reconnected to later.
        # Calling sys.exit(0) ensures that atexit handlers (like cleanup_ipc_socket) still run.
        sys.exit(0)

    # Register signal handlers for graceful shutdown (Unix only)
    if platform.system() != "Windows":
        signal.signal(signal.SIGTERM, signal_handler)
        signal.signal(signal.SIGHUP, signal_handler)

    # Register a cleanup function to run when the script exits.
    atexit.register(cleanup_ipc_socket, mpv_session)
    atexit.register(handler_manager._stop_local_m3u_server)

    from concurrent.futures import ThreadPoolExecutor

    def main():
        """Main message loop for native messaging from the browser."""
        set_process_name()

        # --- Windows Graceful Shutdown Handler ---
        if sys.platform == "win32":
            def windows_ctrl_handler(ctrl_type):
                # CTRL_CLOSE_EVENT = 2
                if ctrl_type == 2:
                    logging.info("[PY] Received Windows close event. Native host exiting...")
                    sys.exit(0)
                return False
            
            # Create a callback reference to prevent it from being garbage collected
            self_callback = ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.c_uint)(windows_ctrl_handler)
            ctypes.windll.kernel32.SetConsoleCtrlHandler(self_callback, True)
            logging.info("[PY] Windows console control handler registered.")

        # The delegation system: One receptionist (main loop), many workers (threads)
        executor = ThreadPoolExecutor(max_workers=10)

        # --- IPC Event Listener (Background) ---
        def ipc_event_listener():
            """Continuously listens for events from the active MPV session."""
            logging.info("[PY] IPC event listener thread started.")
            while True:
                if mpv_session.ipc_manager and mpv_session.ipc_manager.is_connected():
                    event = mpv_session.ipc_manager.receive_event(timeout=1.0)
                    if event:
                        if event.get('event') == 'client-message':
                            args = event.get('args', [])
                            # Look for our custom ytdl failure signal
                            if len(args) >= 1 and args[0] == "ytdl_error_detected":
                                error_msg = args[1] if len(args) > 1 else "Unknown ytdl error"
                                logging.warning(f"[PY][IPC] YTDL Failure signaled from Lua: {error_msg}")
                                send_message({
                                    "action": "ytdlp_update_check", 
                                    "folderId": mpv_session.owner_folder_id,
                                    "log": {
                                        "text": f"[Native Host]: YTDL Failure detected ({error_msg}). Checking for updates...",
                                        "type": "error"
                                    }
                                })
                    else:
                        # Prevent tight loop if receive_event returns None immediately
                        time.sleep(0.5)
                else:
                    time.sleep(1.0)

        threading.Thread(target=ipc_event_listener, daemon=True).start()

        # Ensure stdin/stdout are available (critical for native messaging)
        if sys.stdin is None or sys.stdout is None:
            logging.error("[PY][MAIN] Standard input/output is missing. If on Windows, ensure the registry key points to 'python.exe' and not 'pythonw.exe'.")
            sys.exit(1)

        # The delegation system: One receptionist (main loop), many workers (threads)
        executor = ThreadPoolExecutor(max_workers=10)

        def handle_restore_session(message):
            """Manual trigger for session restoration from the extension."""
            res = mpv_session.restore()
            if res:
                return {"success": True, "action": "session_restored", "result": res}
            return {"success": True, "action": "session_restored", "result": None}

        def handle_ping(message):
            """Returns basic system info to verify connectivity."""
            return {
                "success": True, 
                "python_version": sys.version,
                "platform": platform.platform(),
                "status": "online"
            }

        COMMAND_HANDLERS = {
            'ping': handle_ping,
            'restore_session': handle_restore_session,
            'play': handler_manager.handle_play,
            'play_batch': handler_manager.handle_play_batch,
            'play_m3u': handler_manager.handle_play_m3u,
            'remove_item_live': handler_manager.handle_remove_item_live,
            'reorder_live': handler_manager.handle_reorder_live,
            'clear_live': handler_manager.handle_clear_live,
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
            'get_ui_preferences': handler_manager.handle_get_ui_preferences,
            'set_ui_preferences': handler_manager.handle_set_ui_preferences,
            'get_default_automatic_flags': handler_manager.handle_get_default_automatic_flags
        }

        def task_wrapper(message):
            """Worker thread task to execute handler and send response."""
            try:
                command = message.get('action')
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
                logging.error(f"[PY][TASK] Error processing {message.get('action')}: {e}", exc_info=True)
                try:
                    error_resp = {"success": False, "error": f"Task error: {str(e)}"}
                    if message.get('request_id'): error_resp['request_id'] = message.get('request_id')
                    send_message(error_resp)
                except: pass

        while True:
            try:
                message = get_message()  # Blocks here waiting for browser input
                logging.info(f"[PY][RECV] (ID: {message.get('request_id')}): {message.get('action')}")
                
                # DELEGATION: hand off heavy work to the thread pool
                executor.submit(task_wrapper, message)

            except Exception as e:
                logging.error(f"[PY][MAIN] Error in main loop: {e}", exc_info=True)
                # If get_message fails critically, the loop might need to break
                if not sys.stdin or sys.stdin.closed: break

    if __name__ == '__main__':
        logging.info(f"[PY][START] Args: {sys.argv}, TTY: {sys.stdin.isatty() if sys.stdin else 'None'}")

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