#!/usr/bin/env python3
"""
MPV Playlist Organizer - Native Host
This script acts as the bridge between the Chrome Extension and the local system.
"""

import sys
import os
import json
import struct
import subprocess
import atexit
import logging
import time
import signal
import threading
import platform
import re
import traceback
import ctypes
from datetime import datetime
from logging.handlers import RotatingFileHandler
from concurrent.futures import ThreadPoolExecutor

# --- Path Correction for CLI Usage ---
# This ensures that if the script is run from a different directory (e.g., via PATH),
# it can still find its own modules like 'file_io' and 'cli'.
SCRIPT_DIR = os.path.dirname(os.path.abspath(sys.argv[0]))
sys.path.insert(0, SCRIPT_DIR)
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
sys.dont_write_bytecode = True

# --- Standalone Function for Failsafe Path ---
# This is used ONLY for the very early crash handler before file_io is imported.
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
    except Exception:
        return "native_host_crash.log" # Current directory fallback

# --- Failsafe Crash Handler ---
FAILSAFE_LOG_PATH = _get_emergency_log_path()

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

try:
    # --- Configuration & Environment Setup ---
    import file_io
    DATA_DIR = file_io.DATA_DIR
    HOME_DIR = os.path.expanduser("~")
    
    # --- Logging Setup (EARLY) ---
    from utils import logger
    logger.initialize(DATA_DIR, SCRIPT_DIR)
    LOG_FILE = os.path.join(DATA_DIR, "native_host.log") # For the crash handler check
    
    # Root logger for general logic
    logging.info(f"[PY][MAIN] Native host starting. Version: 1.1.1. Data Dir: {DATA_DIR}")

    # Ensure standard Linux binary paths are in the environment PATH
    current_path_list = os.environ.get("PATH", "").split(os.pathsep)
    
    # Add SCRIPT_DIR to PATH (helps find mpv.exe if it's in the same folder as native_host.py)
    if SCRIPT_DIR not in current_path_list:
        current_path_list.insert(0, SCRIPT_DIR)
        
    # Also add the directory of the current python executable (sometimes mpv is nearby)
    py_dir = os.path.dirname(sys.executable)
    if py_dir not in current_path_list:
        current_path_list.insert(0, py_dir)

    if platform.system() == "Linux":
        extra_paths = [
            "/sbin", "/usr/sbin", "/bin", "/usr/local/bin", "/usr/bin",
            os.path.expanduser("~/.local/bin"),
            os.path.expanduser("~/bin")
        ]
        for p in extra_paths:
            if p not in current_path_list:
                current_path_list.insert(0, p)
    
    # Update PATH EARLY so get_settings() can use it for shutil.which
    os.environ["PATH"] = os.pathsep.join(current_path_list)

    # Inject configured paths for ffmpeg and node if they are set
    config = file_io.get_settings()
    for key in ["ffmpeg_path", "node_path"]:
        val = config.get(key)
        if val and os.path.exists(val):
            dir_path = os.path.dirname(val)
            if dir_path not in current_path_list:
                current_path_list.insert(0, dir_path)
                
    # Final PATH update with configured paths
    os.environ["PATH"] = os.pathsep.join(current_path_list)

    from mpv_session import MpvSessionManager
    import cli
    import services
    from utils import ipc_utils, security
    from utils.native_host_handlers import HandlerManager
    from utils.handlers.registry import HandlerRegistry
    from utils.janitor import Janitor
    from utils import native_link

    SESSION_FILE = os.path.join(DATA_DIR, "session.json")
    ANILIST_CACHE_FILE = os.path.join(DATA_DIR, "anilist_cache.json")
    TEMP_PLAYLISTS_DIR = os.path.join(DATA_DIR, "temp_playlists")

    # --- Run Janitor Startup Sweep (Threaded) ---
    janitor = Janitor(DATA_DIR, TEMP_PLAYLISTS_DIR)
    janitor_thread = threading.Thread(target=janitor.run_startup_sweep, kwargs={'extension_root': SCRIPT_DIR}, daemon=True)
    janitor_thread.start()

    class DiagnosticCollector:
        def __init__(self):
            self.errors = []
            self.lock = threading.Lock()

        def add_error(self, context, error):
            with self.lock:
                timestamp = datetime.now().isoformat()
                masked_error = security.mask_path(str(error), DATA_DIR, SCRIPT_DIR, HOME_DIR)
                self.errors.append({"timestamp": timestamp, "context": context, "error": masked_error})
                if len(self.errors) > 50:
                    self.errors.pop(0)

        def get_errors(self):
            with self.lock:
                return list(self.errors)

    diagnostic_collector = DiagnosticCollector()

    def get_message():
        """Reads a message from stdin and decodes it."""
        if sys.stdin is None:
            raise EOFError("stdin is None")
            
        raw_length = sys.stdin.buffer.read(4)
        if len(raw_length) == 0:
            logging.info("[PY][MAIN] Stdin closed (EOF). Exiting native host.")
            sys.exit(0)
            
        message_length = struct.unpack('@I', raw_length)[0]
        # Security check: Limit incoming message size
        if message_length > security.SECURITY_LIMITS['MAX_IPC_MESSAGE_SIZE']:
             logging.error(f"[PY][MAIN] Incoming message too large: {message_length} bytes.")
             sys.exit(1)
             
        message = sys.stdin.buffer.read(message_length).decode('utf-8')
        return json.loads(message)

    print_lock = threading.Lock()

    def send_message(message_content):
        """Encodes and sends a message to stdout."""
        try:
            with print_lock:
                # Recursive Path Masking
                if isinstance(message_content, dict):
                    def mask_recursive(obj):
                        if isinstance(obj, str):
                            return security.mask_path(obj, DATA_DIR, SCRIPT_DIR, HOME_DIR)
                        elif isinstance(obj, list):
                            return [mask_recursive(item) for item in obj]
                        elif isinstance(obj, dict):
                            return {k: mask_recursive(v) for k, v in obj.items()}
                        return obj
                    
                    message_content = mask_recursive(message_content)

                translated_content = native_link.responder._translate_keys(message_content)
                encoded_content = json.dumps(translated_content).encode('utf-8')
                message_length = struct.pack('@I', len(encoded_content))
                sys.stdout.buffer.write(message_length)
                sys.stdout.buffer.write(encoded_content)
                sys.stdout.buffer.flush()
        except BrokenPipeError:
            logging.info("[PY] Browser disconnected (Broken Pipe). Normal shutdown.")
        except Exception as e:
            logging.error(f"[PY] Unexpected error in send_message: {e}")

    # --- Global Instances ---
    metadata_cache = native_link.metadata_cache.MetadataCache(DATA_DIR, file_io)
    task_manager = native_link.task_manager.TaskManager(send_message)

    mpv_session = MpvSessionManager(session_file_path=SESSION_FILE, dependencies={
        'get_all_folders_from_file': file_io.get_all_folders_from_file,
        'get_mpv_executable': file_io.get_mpv_executable,
        'log_stream': logger.observe_stream,
        'send_message': send_message,
        'SCRIPT_DIR': SCRIPT_DIR,
        'TEMP_PLAYLISTS_DIR': TEMP_PLAYLISTS_DIR,
        'metadata_cache': metadata_cache,
        'task_manager': task_manager
    })

    handler_manager = HandlerManager(
        mpv_session=mpv_session,
        file_io=file_io,
        services=services,
        ipc_utils=ipc_utils,
        send_message=send_message,
        script_dir=SCRIPT_DIR,
        anilist_cache_file=ANILIST_CACHE_FILE,
        temp_playlists_dir=TEMP_PLAYLISTS_DIR,
        log_stream=logger.observe_stream,
        data_dir=DATA_DIR,
        metadata_cache=metadata_cache,
        task_manager=task_manager,
        diagnostic_collector=diagnostic_collector
    )

    def cleanup_ipc_socket(session_manager):
        """Remove the IPC socket file on exit, if it exists (non-Windows)."""
        logger.shutdown()
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
        sys.exit(0)

    # Register signal handlers for graceful shutdown (Unix only)
    if platform.system() != "Windows":
        signal.signal(signal.SIGTERM, signal_handler)
        signal.signal(signal.SIGHUP, signal_handler)

    atexit.register(cleanup_ipc_socket, mpv_session)
    atexit.register(mpv_session.clear)
    atexit.register(handler_manager._stop_local_m3u_server)
    
    from utils.url_analyzer import VolatileCookieManager
    atexit.register(VolatileCookieManager.cleanup_volatile_dir)

    def main():
        """Main message loop for native messaging from the browser."""
        set_process_name()
        logger.set_ui_sender(send_message)

        # --- Pre-emptive Cleanup ---
        try:
            from utils.url_analyzer import VolatileCookieManager
            VolatileCookieManager.cleanup_volatile_dir()
            logging.info("[PY][MAIN] Pre-emptive cleanup of volatile directory complete.")
        except Exception as e:
            logging.warning(f"[PY][MAIN] Pre-emptive cleanup failed: {e}")

        # --- Windows Graceful Shutdown Handler ---
        if sys.platform == "win32":
            def windows_ctrl_handler(ctrl_type):
                if ctrl_type == 2: # CTRL_CLOSE_EVENT
                    logging.info("[PY] Received Windows close event. Native host exiting...")
                    sys.exit(0)
                return False
            
            self_callback = ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.c_uint)(windows_ctrl_handler)
            ctypes.windll.kernel32.SetConsoleCtrlHandler(self_callback, True)
            logging.info("[PY] Windows console control handler registered.")

        executor = ThreadPoolExecutor(max_workers=10)

        if sys.stdin is None or sys.stdout is None:
            logging.error("[PY][MAIN] Standard input/output is missing.")
            sys.exit(1)

        # --- Built-in Meta Handlers ---
        @HandlerRegistry.command('ping')
        def handle_ping(request: native_link.BaseRequest):
            return native_link.success({
                "python_version": sys.version,
                "platform": platform.platform(),
                "status": "online"
            })

        @HandlerRegistry.command('restore_session')
        def handle_restore_session(request: native_link.BaseRequest):
            res = mpv_session.restore()
            current_level = logging.getLevelName(logging.getLogger().getEffectiveLevel())
            return native_link.success(res, action="session_restored", log_level=current_level)

        @HandlerRegistry.command('get_native_diagnostics')
        def handle_get_native_diagnostics(request: native_link.BaseRequest):
            return {"success": True, "errors": diagnostic_collector.get_errors()}

        @HandlerRegistry.command('get_debug_bundle')
        def handle_get_debug_bundle(request: native_link.BaseRequest):
            logger.shutdown()
            logger.initialize(DATA_DIR, SCRIPT_DIR)
            
            def read_safe(path):
                if os.path.exists(path):
                    try:
                        with open(path, 'r', encoding='utf-8', errors='replace') as f:
                            return f.read()[-50000:] # Last 50KB
                    except Exception as e:
                        return f"Error reading file: {e}"
                return "File not found."

            bundle = {
                "native_host_log": read_safe(os.path.join(DATA_DIR, "native_host.log")),
                "ipc_events_log": read_safe(os.path.join(DATA_DIR, "ipc_events.log")),
                "session_json": read_safe(os.path.join(DATA_DIR, "session.json")),
                "diagnostics": diagnostic_collector.get_errors(),
                "timestamp": datetime.now().isoformat()
            }
            return native_link.success(bundle)

        @logger.catch(ui_alert=True)
        def task_wrapper(message):
            req_id = message.get('request_id')
            token = logger.request_id_var.set(req_id)

            try:
                is_valid, err_msg = security.validate_payload(message)
                if not is_valid:
                    logging.warning(f"[PY][SECURITY] Blocked malicious payload: {err_msg}")
                    error_resp = native_link.failure(f"Security block: {err_msg}")
                    if req_id:
                        error_resp['request_id'] = req_id
                    send_message(error_resp)
                    return

                request = native_link.translate(message)
                command_name = request.action
                handler = HandlerRegistry.get_handler(command_name)

                if handler:
                    response = handler(request)
                else:
                    response = native_link.failure(f"Unknown command: {command_name}")

                if response:
                    if req_id:
                        response['request_id'] = req_id
                    send_message(response)
            finally:
                logger.request_id_var.reset(token)

        def async_restore():
            try:
                restore_data = mpv_session.restore()
                if restore_data:
                    logging.info(f"[PY][MAIN] Automatic restoration successful for folder '{mpv_session.owner_folder_id}'.")
                    time.sleep(0.5)
                    current_level = logging.getLevelName(logging.getLogger().getEffectiveLevel())
                    send_message(native_link.success(restore_data, action="session_restored", log_level=current_level))
            except Exception as e:
                logging.error(f"[PY][MAIN] Error during automatic session restoration: {e}")
        
        threading.Thread(target=async_restore, daemon=True).start()

        while True:
            try:
                message = get_message()
                logging.info(f"[PY][RECV] (ID: {message.get('request_id')}): {message.get('action')}")
                executor.submit(task_wrapper, message)
            except Exception as e:
                logging.error(f"[PY][MAIN] Error in main loop: {e}", exc_info=True)
                if not sys.stdin or sys.stdin.closed:
                    break

    if __name__ == '__main__':
        logging.info(f"[PY][START] Args: {sys.argv}, TTY: {sys.stdin.isatty() if sys.stdin else 'None'}")
        
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

        try:
            cli.inject_dependencies({
                'file_io': file_io,
                'mpv_session': mpv_session,
                'ipc_utils': ipc_utils,
                'time': time
            })
            if not cli.handle_cli():
                main()
        except SystemExit:
            pass
        except Exception as cli_error:
            logging.error(f"An unexpected CLI error occurred: {cli_error}", exc_info=True)
            print(f"Error: {cli_error}", file=sys.stderr)
            sys.exit(1)

except Exception as e:
    log_path_to_use = locals().get('LOG_FILE', FAILSAFE_LOG_PATH)
    try:
        with open(log_path_to_use, "a", encoding="utf-8") as f:
            f.write("---\n--- Native Host Crashed ---\n")
            f.write(f"Timestamp: {datetime.now().isoformat()}\n")
            f.write(f"Error: {str(e)}\n\n")
            f.write(traceback.format_exc())
            f.write("\n---------------------------\n\n")
    except Exception:
        pass
    raise
