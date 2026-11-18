import logging
import logging.handlers
import os
import queue
import sys
import threading
import time
from contextvars import ContextVar
from typing import Optional

# Prevent __pycache__ generation
sys.dont_write_bytecode = True
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'

# Context variable for request correlation
request_id_var: ContextVar[Optional[str]] = ContextVar("request_id", default=None)

# Global variables for the logging system
_log_queue = queue.Queue(-1)
_listener: Optional[logging.handlers.QueueListener] = None
_is_initialized = False
_active_data_dir: Optional[str] = None
_init_lock = threading.RLock()

class ContextQueueHandler(logging.handlers.QueueHandler):
    """
    Custom QueueHandler that injects ContextVar data into the record
    before it is sent to the background thread.
    """
    def prepare(self, record):
        record = super().prepare(record)
        record.request_id = request_id_var.get()
        return record

class SecurityFormatter(logging.Formatter):
    """
    Formatter that masks sensitive paths and data in log messages.
    """
    def __init__(self, fmt=None, datefmt=None, style='%'):
        super().__init__(fmt, datefmt, style)
        # Import security here to avoid circular dependencies
        from . import security
        self.security = security

    def format(self, record):
        # Store original message to avoid mutating it permanently if needed
        original_msg = record.msg

        # Add Request ID if available (injected by ContextQueueHandler)
        req_id = getattr(record, 'request_id', None)
        if req_id:
            record.msg = f"[Req: {req_id}] {record.msg}"

        try:
            formatted = super().format(record)
        finally:
            # Restore original message for other handlers if any
            record.msg = original_msg

        # Apply path masking on the formatted string so %s record.args are also masked
        return self.security.mask_path(
            formatted,
            getattr(self, 'data_dir', None),
            getattr(self, 'script_dir', None)
        )

def initialize(data_dir: str, script_dir: str = None, level=logging.DEBUG):
    """
    Initializes the non-blocking logging system.
    Degrades gracefully to stderr-only logging if data_dir is read-only or unwritable.
    Returns the resolved writable data_dir.
    """
    global _listener, _is_initialized, _active_data_dir
    with _init_lock:
        if _is_initialized:
            return _active_data_dir or data_dir

        formatter = SecurityFormatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
        formatter.data_dir = data_dir
        formatter.script_dir = script_dir

        handlers = []
        try:
            try:
                os.makedirs(data_dir, exist_ok=True)
                if not os.access(data_dir, os.W_OK):
                    raise OSError("Directory not writable") from None
            except OSError:
                import tempfile
                data_dir = os.path.join(tempfile.gettempdir(), "MPVPlaylistOrganizer")
                os.makedirs(data_dir, exist_ok=True)
                if not os.access(data_dir, os.W_OK):
                    raise OSError("Directory not writable") from None
                formatter.data_dir = data_dir

            main_log_file = os.path.join(data_dir, "native_host.log")
            ipc_log_file = os.path.join(data_dir, "ipc_events.log")
            browser_log_file = os.path.join(data_dir, "browser_errors.log")

            # Ensure browser_errors.log exists immediately for easy inspection / tailing
            if not os.path.exists(browser_log_file):
                with open(browser_log_file, "a", encoding="utf-8"):
                    pass

            # 1. Main Handler (Rotating File)
            main_handler = logging.handlers.RotatingFileHandler(
                main_log_file, maxBytes=1024 * 1024 * 5, backupCount=2, encoding='utf-8'
            )
            # 2. IPC Handler (Rotating File)
            ipc_handler = logging.handlers.RotatingFileHandler(
                ipc_log_file, maxBytes=1024 * 1024 * 5, backupCount=1, encoding='utf-8'
            )
            # 3. Dedicated Browser Error Handler (Rotating File)
            browser_handler = logging.handlers.RotatingFileHandler(
                browser_log_file, maxBytes=1024 * 1024 * 2, backupCount=2, encoding='utf-8'
            )

            main_handler.setFormatter(formatter)
            ipc_handler.setFormatter(formatter)
            browser_handler.setFormatter(formatter)

            class IPCFilter(logging.Filter):
                def filter(self, record):
                    return record.name == "ipc_events"

            class BrowserFilter(logging.Filter):
                def filter(self, record):
                    return record.name == "browser_errors"

            class MainFilter(logging.Filter):
                def filter(self, record):
                    return record.name not in ("ipc_events", "browser_errors")

            ipc_handler.addFilter(IPCFilter())
            browser_handler.addFilter(BrowserFilter())
            main_handler.addFilter(MainFilter())

            handlers = [main_handler, ipc_handler, browser_handler]
        except OSError as e:
            for h in handlers:
                h.close()
            print(f"[LOGGER] Data dir '{data_dir}' is not writable ({e}); degrading to stderr logging.", file=sys.stderr)
            stderr_handler = logging.StreamHandler(sys.stderr)
            stderr_handler.setFormatter(formatter)
            handlers = [stderr_handler]

        # Queue Handler (The Non-blocking Part)
        queue_handler = ContextQueueHandler(_log_queue)

        root = logging.getLogger()
        for h in root.handlers[:]:
            h.close()
            root.removeHandler(h)

        root.addHandler(queue_handler)
        root.setLevel(level)

        # Start the Listener Thread
        _listener = logging.handlers.QueueListener(
            _log_queue, *handlers, respect_handler_level=True
        )
        _listener.start()

        _active_data_dir = data_dir
        _is_initialized = True
        logging.info(f"Logging initialized. Data Dir: {data_dir}")
        return data_dir

def shutdown():
    """
    Ensures all logs are flushed before exit.
    """
    global _listener, _is_initialized, _active_data_dir
    with _init_lock:
        if _listener:
            # Stop the listener first (it will flush the queue)
            _listener.stop()

            # CRITICAL: Manually close the handlers that were passed to the listener
            # because QueueListener.stop() does not automatically close them.
            for handler in _listener.handlers:
                handler.close()

            _listener = None

        # Close all handlers in the root logger
        root = logging.getLogger()
        for h in root.handlers[:]:
            h.close()
            root.removeHandler(h)

        _is_initialized = False
        _active_data_dir = None

# --- Convenience API ---

def info(msg, ui_notify=False, **kwargs):
    logging.info(msg, **kwargs)
    if ui_notify:
        _send_ui_notification(msg, "info")

def error(msg, ui_notify=True, **kwargs):
    logging.error(msg, **kwargs)
    if ui_notify:
        _send_ui_notification(msg, "error")

def debug(msg, **kwargs):
    logging.debug(msg, **kwargs)

def warning(msg, ui_notify=False, **kwargs):
    logging.warning(msg, **kwargs)
    if ui_notify:
        _send_ui_notification(msg, "warning")

def _send_ui_notification(text, log_type):
    """
    Helper to send a log message back to the Chrome Extension UI.
    Requires 'send_message' to be injected into this module later.
    """
    send_func = getattr(sys.modules[__name__], '_ui_send_func', None)
    if send_func:
        try:
            send_func({"log": {"text": text, "type": log_type}})
        except (OSError, ValueError, TypeError) as e:
            print(f"[LOGGER] Failed to send UI notification: {e}", file=sys.stderr)

def set_ui_sender(send_func):
    """Injects the bridge's send_message function for UI notifications."""
    sys.modules[__name__]._ui_send_func = send_func

# --- Decorators ---

def trace(name=None):
    """Decorator to log function entry, exit, and duration."""
    def decorator(func):
        import functools
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            func_name = name or func.__name__
            start_time = time.time()
            logging.debug(f"[TRACE] ENTERING {func_name}")
            try:
                result = func(*args, **kwargs)
                duration = time.time() - start_time
                logging.debug(f"[TRACE] EXITING {func_name} (Duration: {duration:.4f}s)")
                return result
            except Exception as e:
                duration = time.time() - start_time
                logging.error(f"[TRACE] FAILED {func_name} after {duration:.4f}s: {e}")
                raise
        return wrapper
    return decorator

def catch(ui_alert=True):
    """Decorator to catch all exceptions, log them, and optionally alert the UI."""
    def decorator(func):
        import functools
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            try:
                return func(*args, **kwargs)
            except Exception as e:
                import traceback
                tb = traceback.format_exc()
                logging.error(f"Crashed in {func.__name__}: {e}\n{tb}")
                if ui_alert:
                    _send_ui_notification(f"Fatal Error in {func.__name__}: {e}", "error")
                # We don't re-raise here to prevent process crash if used on high-level tasks
                # but for some logic it might be needed. For this app, usually we want to survive.
                return None
        return wrapper
    return decorator

def observe_stream(tag="SUBPROCESS", folder_id=None, send_message_func=None):
    """
    Standardizes how subprocess stderr streams are captured and logged.
    Includes specialized detection for yt-dlp failures.
    """
    import re

    # Keywords that suggest yt-dlp is outdated for YouTube.
    YTDLP_FAILURE_KEYWORDS = [
        "HTTP Error 410", # "HTTP Error 410: Gone" is a classic sign.
        "This video is unavailable",
        "unable to extract video data",
        "Sign in to confirm your age",
        "confirm you’re not a bot",
        "403: Forbidden"
    ]

    # Regex to strip ANSI escape codes (colors)
    ansi_escape = re.compile(r'\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])')

    def logger_thread(pipe):
        ytdlp_failure_detected = False
        try:
            with pipe:
                for line in iter(pipe.readline, b''):
                    decoded_line = line.decode('utf-8', errors='replace').strip()
                    if not decoded_line:
                        continue

                    clean_line = ansi_escape.sub('', decoded_line)

                    # Noise filters
                    if any(x in clean_line for x in ["'uname' is not recognized", "keepalive request failed", "[mpv_thumbnail_script]"]):
                        continue

                    logging.info(f"[{tag}] {clean_line}")

                    # yt-dlp Failure Detection
                    if not ytdlp_failure_detected and any(keyword in clean_line for keyword in YTDLP_FAILURE_KEYWORDS):
                        ytdlp_failure_detected = True
                        logging.warning(f"[{tag}] Potential yt-dlp failure detected: {clean_line}")

                        if send_message_func and folder_id:
                            send_message_func({
                                "action": "ytdlp_update_check",
                                "folder_id": folder_id,
                                "log": {
                                    "text": "[Native Host]: YouTube playback failed. This may be due to an outdated yt-dlp. Checking for auto-update...",
                                    "type": "error"
                                }
                            })
        except Exception as e:
            logging.error(f"Error observing {tag} stream: {e}")
    return logger_thread
