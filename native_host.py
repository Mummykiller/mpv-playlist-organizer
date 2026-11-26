#!/usr/bin/env python3
"""
MPV Playlist Organizer - Native Host
This script acts as the bridge between the Chrome Extension and the local system.
"""

import sys
import os
import json
import struct
import atexit
import logging
import time
import signal
import threading
import platform
import traceback
import ctypes
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor

# --- Path Correction for CLI Usage ---
# This ensures that if the script is run from a different directory (e.g., via PATH),
# it can still find its own modules like 'file_io' and 'cli'.
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
sys.dont_write_bytecode = True

HOST_VERSION = "1.1.1"

CONTROL_ACTIONS = frozenset({
    "ping",
    "close_mpv",
    "restore_session",
    "get_playback_status",
    "is_mpv_running",
    "log_event",
    "log_browser_error",
})


def select_executor(action, control_executor, worker_executor):
    """Routes fast control/query actions to control_executor so heavy launches never starve them."""
    return control_executor if action in CONTROL_ACTIONS else worker_executor

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
        base = os.getenv('XDG_DATA_HOME') or os.path.join(home, '.local/share')

    return os.path.join(base, app_name, "native_host_crash.log")

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
    except (OSError, AttributeError) as e:
        logging.debug(f"[PY][MAIN] Could not set process name: {e}")

try:
    # --- Configuration & Environment Setup ---
    import file_io
    DATA_DIR = file_io.DATA_DIR
    HOME_DIR = os.path.expanduser("~")

    # --- Logging Setup (Deferred to runtime init, or safe on demand) ---
    from utils import logger
    LOG_FILE = os.path.join(DATA_DIR, "native_host.log") # For the crash handler check

    def _configure_environment_paths():
        """Ensures standard OS and configured tool paths are present in PATH."""
        current_path_list = [p for p in os.environ.get("PATH", "").split(os.pathsep) if p]

        if platform.system() == "Linux":
            extra_paths = [
                "/sbin", "/usr/sbin", "/bin", "/usr/local/bin", "/usr/bin",
                os.path.expanduser("~/.local/bin"),
                os.path.expanduser("~/bin")
            ]
            for p in extra_paths:
                if p not in current_path_list:
                    current_path_list.insert(0, p)

        if SCRIPT_DIR not in current_path_list:
            current_path_list.append(SCRIPT_DIR)

        py_dir = os.path.dirname(sys.executable)
        if py_dir not in current_path_list:
            current_path_list.append(py_dir)

        os.environ["PATH"] = os.pathsep.join(current_path_list)

        config = file_io.get_settings()
        for key in ["ffmpeg_path", "node_path"]:
            val = config.get(key)
            if val and os.path.exists(val):
                dir_path = os.path.dirname(val)
                if dir_path and dir_path not in current_path_list:
                    current_path_list.append(dir_path)

        os.environ["PATH"] = os.pathsep.join(current_path_list)

    from mpv_session import MpvSessionManager
    import cli
    import services
    from utils import ipc_utils, security, session_health
    from utils.native_host_handlers import HandlerManager
    from utils.handlers.registry import HandlerRegistry
    from utils.janitor import Janitor
    from utils import native_link

    SESSION_FILE = os.path.join(DATA_DIR, "session.json")
    ANILIST_CACHE_FILE = os.path.join(DATA_DIR, "anilist_cache.json")
    TEMP_PLAYLISTS_DIR = os.path.join(DATA_DIR, "temp_playlists")

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
        if len(raw_length) < 4:
            logging.info(f"[PY][MAIN] Stdin truncated header ({len(raw_length)} bytes). Exiting native host.")
            sys.exit(0)

        message_length = struct.unpack('@I', raw_length)[0]
        # Security check: Limit incoming message size
        if message_length > security.SECURITY_LIMITS['MAX_IPC_MESSAGE_SIZE']:
             logging.error(f"[PY][MAIN] Incoming message too large: {message_length} bytes.")
             sys.exit(1)

        chunks = bytearray()
        while len(chunks) < message_length:
            chunk = sys.stdin.buffer.read(message_length - len(chunks))
            if not chunk:
                logging.info(
                    f"[PY][MAIN] Stdin closed mid-frame (expected {message_length} bytes, got {len(chunks)} bytes)."
                )
                return None
            chunks.extend(chunk)

        message = chunks.decode('utf-8')
        return json.loads(message)

    print_lock = threading.Lock()
    MAX_OUTBOUND_MESSAGE_SIZE = 900 * 1024  # 900 KB guard against Chrome 1 MiB limit
    SAFE_OUTBOUND_PAYLOAD_SIZE = session_health.SAFE_OUTBOUND_PAYLOAD_SIZE

    def send_message_binary(message_content):
        """Encodes and sends a length-prefixed JSON message to stdout for browser native messaging."""
        try:
            with print_lock:
                # Mask paths only in log/diagnostic fields to avoid corrupting settings paths or file URLs
                if isinstance(message_content, dict):
                    def mask_recursive(obj):
                        if isinstance(obj, str):
                            return security.mask_path(obj, DATA_DIR, SCRIPT_DIR, HOME_DIR)
                        elif isinstance(obj, list):
                            return [mask_recursive(item) for item in obj]
                        elif isinstance(obj, dict):
                            return {k: mask_recursive(v) for k, v in obj.items()}
                        return obj

                    message_content = dict(message_content)
                    if "log" in message_content:
                        message_content["log"] = mask_recursive(message_content["log"])
                    if "error" in message_content:
                        message_content["error"] = mask_recursive(message_content["error"])
                    if message_content.get("success") is False and "message" in message_content:
                        message_content["message"] = mask_recursive(message_content["message"])

                translated_content = native_link.responder._translate_keys(message_content)
                encoded_content = json.dumps(translated_content).encode('utf-8')

                # PY-H2: Trim optional large preview fields before hitting Chrome's 1 MiB limit
                if len(encoded_content) > SAFE_OUTBOUND_PAYLOAD_SIZE and isinstance(translated_content, dict):
                    session_health.trim_oversized_reply(
                        translated_content,
                        max_bytes=SAFE_OUTBOUND_PAYLOAD_SIZE,
                        camel_case=True,
                    )
                    encoded_content = json.dumps(translated_content).encode('utf-8')

                # PY-H2: Guard against oversized outbound messages exceeding Chrome limit
                if len(encoded_content) > MAX_OUTBOUND_MESSAGE_SIZE:
                    logging.error(
                        f"[PY] Outbound message exceeds 900 KB limit ({len(encoded_content)} bytes). "
                        "Suppressing outbound message to prevent Chrome terminating native host."
                    )
                    req_id = None
                    if isinstance(message_content, dict):
                        req_id = message_content.get("request_id")
                        if req_id is None:
                            req_id = message_content.get("requestId")
                    if req_id is not None and message_content.get("action") != "error":
                        error_resp = native_link.failure(
                            f"Response payload exceeds maximum allowed size ({len(encoded_content)} bytes > 900 KB).",
                            request_id=req_id
                        )
                        translated_err = native_link.responder._translate_keys(error_resp)
                        encoded_err = json.dumps(translated_err).encode('utf-8')
                        err_len = struct.pack('@I', len(encoded_err))
                        sys.stdout.buffer.write(err_len)
                        sys.stdout.buffer.write(encoded_err)
                        sys.stdout.buffer.flush()
                    return

                message_length = struct.pack('@I', len(encoded_content))
                sys.stdout.buffer.write(message_length)
                sys.stdout.buffer.write(encoded_content)
                sys.stdout.buffer.flush()
        except BrokenPipeError:
            logging.info("[PY] Browser disconnected (Broken Pipe). Normal shutdown.")
        except Exception as e:
            logging.error(f"[PY] Unexpected error in send_message: {e}")

    def send_message_cli(message_content):
        """CLI text logger / no-op sender so no binary frames are written to stdout in terminal CLI mode."""
        if not isinstance(message_content, dict):
            logging.debug(f"[CLI] Non-dict message: {message_content}")
            return
        action = message_content.get('action')
        log_payload = message_content.get('log')
        if log_payload and isinstance(log_payload, dict):
            text = log_payload.get('text', '')
            log_type = log_payload.get('type', 'info')
            if log_type == 'error':
                logging.error(f"[CLI] {text}")
            else:
                logging.debug(f"[CLI] {text}")
        elif action in ('error', 'failure'):
            logging.error(f"[CLI] Error: {message_content.get('error') or message_content}")
        else:
            logging.debug(f"[CLI] Suppressed background event in CLI mode: {action}")

    _active_sender = [send_message_binary]

    def set_active_sender(sender_fn):
        _active_sender[0] = sender_fn

    def send_message(message_content):
        return _active_sender[0](message_content)

    # --- Global Runtime State (Populated lazily by initialize_runtime) ---
    metadata_cache = None
    task_manager = None
    mpv_session = None
    handler_manager = None
    _runtime_initialized = False
    _runtime_lock = threading.Lock()

    def handle_ping(request: native_link.BaseRequest):
        """Health-check handler returning host version, Python version, and platform."""
        return native_link.success({
            "version": HOST_VERSION,
            "python_version": sys.version,
            "platform": platform.platform(),
            "status": "online"
        })

    def build_handler_registry(
        mpv_session_inst=None,
        handler_manager_inst=None,
        restore_lock=None,
        restore_state=None
    ):
        """
        Registers module-level meta handlers ('ping', 'restore_session') and binds
        HandlerManager handlers on HandlerRegistry without requiring main() or stdin.
        """
        lock = restore_lock if restore_lock is not None else threading.Lock()
        state = restore_state if restore_state is not None else {"done_by_handler": False, "stale_result": None}

        HandlerRegistry.command('ping')(handle_ping)

        @HandlerRegistry.command('restore_session')
        def handle_restore_session(request: native_link.BaseRequest):
            session_target = mpv_session_inst if mpv_session_inst is not None else mpv_session
            with lock:
                state["done_by_handler"] = True
                if state["stale_result"] is not None:
                    res = state["stale_result"]
                    state["stale_result"] = None
                elif session_target is not None:
                    res = session_target.restore()
                else:
                    res = None
            current_level = logging.getLevelName(logging.getLogger().getEffectiveLevel())
            return native_link.success(res, action="session_restored", log_level=current_level)

        return HandlerRegistry

    def cleanup_ipc_socket(session_manager):
        """Remove the IPC socket file on exit, if it exists (non-Windows)."""
        logger.shutdown()
        if session_manager is None:
            return
        sync_lock = getattr(session_manager, 'sync_lock', None)
        if sync_lock is not None:
            with sync_lock:
                pid = session_manager.pid
                ipc_path = session_manager.ipc_path
        else:
            pid = session_manager.pid
            ipc_path = session_manager.ipc_path

        if pid and ipc_utils.is_pid_running(pid):
            logging.info(f"[PY] Preserving IPC socket {ipc_path} because MPV (PID {pid}) is still running.")
            return

        if ipc_path and platform.system() != "Windows":
            ipc_dir = os.path.dirname(ipc_path)
            if os.path.exists(ipc_path):
                try:
                    os.remove(ipc_path)
                    logging.info(f"[PY] Cleaned up IPC socket: {ipc_path}")
                except OSError as e:
                    logging.warning(f"[PY] Error removing IPC socket file {ipc_path}: {e}")

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

    def initialize_runtime():
        """Initializes logging, PATH, janitor, session manager, handlers, and exit hooks."""
        global metadata_cache, task_manager, mpv_session, handler_manager, _runtime_initialized, DATA_DIR, LOG_FILE, SESSION_FILE, ANILIST_CACHE_FILE, TEMP_PLAYLISTS_DIR
        with _runtime_lock:
            if _runtime_initialized:
                return
            resolved_dir = logger.initialize(DATA_DIR, SCRIPT_DIR)
            if resolved_dir:
                DATA_DIR = resolved_dir
                LOG_FILE = os.path.join(DATA_DIR, "native_host.log")
                SESSION_FILE = os.path.join(DATA_DIR, "session.json")
                ANILIST_CACHE_FILE = os.path.join(DATA_DIR, "anilist_cache.json")
                TEMP_PLAYLISTS_DIR = os.path.join(DATA_DIR, "temp_playlists")
            logging.info(f"[PY][MAIN] Native host starting. Version: {HOST_VERSION}. Data Dir: {DATA_DIR}")
            _configure_environment_paths()

            janitor = Janitor(DATA_DIR, TEMP_PLAYLISTS_DIR)
            threading.Thread(target=janitor.run_startup_sweep, daemon=True).start()

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

            if platform.system() != "Windows":
                signal.signal(signal.SIGTERM, signal_handler)
                signal.signal(signal.SIGHUP, signal_handler)

            atexit.register(mpv_session.clear)
            atexit.register(cleanup_ipc_socket, mpv_session)
            atexit.register(handler_manager._stop_local_m3u_server)

            from utils.url_analyzer import VolatileCookieManager
            atexit.register(VolatileCookieManager.cleanup_volatile_dir)
            _runtime_initialized = True

    def main():
        """Main message loop for native messaging from the browser."""
        initialize_runtime()
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

        control_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="NHControl")
        worker_executor = ThreadPoolExecutor(max_workers=8, thread_name_prefix="NHWorker")

        try:
            if sys.stdin is None or sys.stdout is None:
                logging.error("[PY][MAIN] Standard input/output is missing.")
                sys.exit(1)

            restore_lock = threading.Lock()
            _restore_state = {"done_by_handler": False, "stale_result": None}
            build_handler_registry(
                mpv_session_inst=mpv_session,
                handler_manager_inst=handler_manager,
                restore_lock=restore_lock,
                restore_state=_restore_state
            )

            @logger.catch(ui_alert=True)
            def task_wrapper(message):
                req_id = message.get('request_id') if isinstance(message, dict) else None
                token = logger.request_id_var.set(req_id)

                try:
                    is_valid, err_msg = security.validate_payload(message)
                    if not is_valid:
                        logging.warning(f"[PY][SECURITY] Blocked malicious payload: {err_msg}")
                        diagnostic_collector.add_error("SECURITY", err_msg)
                        error_resp = native_link.failure(f"Security block: {err_msg}")
                        if req_id is not None:
                            error_resp['request_id'] = req_id
                        send_message(error_resp)
                        return

                    request = native_link.translate(message)
                    command_name = request.action
                    handler = HandlerRegistry.get_handler(command_name)

                    if handler:
                        response = handler(request)
                        if isinstance(response, dict) and response.get("success") is False and response.get("error"):
                            diagnostic_collector.add_error(command_name, response.get("error"))
                    else:
                        diagnostic_collector.add_error("DISPATCH", f"Unknown command: {command_name}")
                        response = native_link.failure(f"Unknown command: {command_name}")

                    if response:
                        if req_id is not None:
                            response['request_id'] = req_id
                        send_message(response)
                except Exception as e:
                    action_ctx = message.get("action", "TASK") if isinstance(message, dict) else "TASK"
                    diagnostic_collector.add_error(action_ctx, e)
                    masked_err = security.mask_path(str(e), DATA_DIR, SCRIPT_DIR, HOME_DIR)
                    logging.error(f"[PY][TASK] Unhandled error in '{action_ctx}': {masked_err}", exc_info=True)
                    if req_id is not None:
                        send_message(native_link.failure(masked_err, request_id=req_id))
                finally:
                    logger.request_id_var.reset(token)

            def async_restore():
                try:
                    with restore_lock:
                        if _restore_state["done_by_handler"]:
                            return
                        restore_data = mpv_session.restore()
                        if restore_data and restore_data.get("was_stale"):
                            _restore_state["stale_result"] = restore_data
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
                    if message is None:
                        logging.info("[PY][MAIN] Native messaging stdin closed mid-frame (EOF), exiting.")
                        break
                    action = message.get('action') if isinstance(message, dict) else None
                    logging.info(f"[PY][RECV] (ID: {message.get('request_id')}): {action}")
                    target_executor = select_executor(action, control_executor, worker_executor)
                    target_executor.submit(task_wrapper, message)
                except EOFError:
                    logging.info("[PY][MAIN] Native messaging stdin closed (EOF), exiting.")
                    break
                except Exception as e:
                    logging.error(f"[PY][MAIN] Error in main loop: {e}", exc_info=True)
                    if not sys.stdin or sys.stdin.closed:
                        break
        finally:
            control_executor.shutdown(wait=False, cancel_futures=True)
            worker_executor.shutdown(wait=False, cancel_futures=True)

    if __name__ == '__main__':
        initialize_runtime()
        logging.info(f"[PY][START] Args: {sys.argv}, TTY: {sys.stdin.isatty() if sys.stdin else 'None'}")

        is_browser = False
        is_cli_command = len(sys.argv) > 1 and sys.argv[1] in ('play', 'list', '-h', '--help')
        if len(sys.argv) > 1 and not is_cli_command:
            if sys.argv[1].startswith('chrome-extension://') or sys.argv[1].startswith('moz-extension://'):
                is_browser = True
            elif sys.argv[1].endswith('.json') and os.path.isabs(sys.argv[1]):
                is_browser = True
        if not is_browser and not is_cli_command and sys.stdin and not sys.stdin.isatty():
            is_browser = True

        if is_browser:
            set_active_sender(send_message_binary)
            main()
            sys.exit(0)

        # CLI Mode: Switch sender to text logger / no-op to prevent binary frames on terminal stdout
        set_active_sender(send_message_cli)
        if hasattr(mpv_session, 'send_message'):
            mpv_session.send_message = send_message_cli
        if hasattr(mpv_session, 'dependencies') and isinstance(mpv_session.dependencies, dict):
            mpv_session.dependencies['send_message'] = send_message_cli
        if hasattr(mpv_session, 'enricher') and mpv_session.enricher is not None:
            mpv_session.enricher.send_message = send_message_cli

        try:
            cli.inject_dependencies({
                'file_io': file_io,
                'mpv_session': mpv_session,
                'ipc_utils': ipc_utils,
                'time': time,
                'send_message': send_message_cli
            })
            if not cli.handle_cli():
                set_active_sender(send_message_binary)
                if hasattr(mpv_session, 'send_message'):
                    mpv_session.send_message = send_message
                if hasattr(mpv_session, 'dependencies') and isinstance(mpv_session.dependencies, dict):
                    mpv_session.dependencies['send_message'] = send_message
                if hasattr(mpv_session, 'enricher') and mpv_session.enricher is not None:
                    mpv_session.enricher.send_message = send_message
                main()
        except SystemExit:
            raise
        except Exception as cli_error:
            logging.error(f"An unexpected CLI error occurred: {cli_error}", exc_info=True)
            print(f"Error: {cli_error}", file=sys.stderr)
            sys.exit(1)

except Exception as e:
    log_path_to_use = locals().get('LOG_FILE', FAILSAFE_LOG_PATH)
    crash_entry = (
        "---\n--- Native Host Crashed ---\n"
        f"Timestamp: {datetime.now().isoformat()}\n"
        f"Error: {str(e)}\n\n"
        f"{traceback.format_exc()}"
        "\n---------------------------\n\n"
    )
    try:
        try:
            os.makedirs(os.path.dirname(log_path_to_use), exist_ok=True)
            with open(log_path_to_use, "a", encoding="utf-8") as f:
                f.write(crash_entry)
        except OSError:
            try:
                os.makedirs(os.path.dirname(FAILSAFE_LOG_PATH), exist_ok=True)
                with open(FAILSAFE_LOG_PATH, "a", encoding="utf-8") as f:
                    f.write(crash_entry)
            except OSError:
                import tempfile
                tmp_crash_log = os.path.join(tempfile.gettempdir(), "native_host_crash.log")
                with open(tmp_crash_log, "a", encoding="utf-8") as f:
                    f.write(crash_entry)
    except Exception as log_err:
        sys.stderr.write(f"Failed to write to crash log ({log_path_to_use}): {log_err}\n")
        sys.stderr.flush()
    raise
