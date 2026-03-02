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
        
        # Apply path masking
        if isinstance(record.msg, str):
            record.msg = self.security.mask_path(record.msg, getattr(self, 'data_dir', None), getattr(self, 'script_dir', None))

        # Add Request ID if available (injected by ContextQueueHandler)
        req_id = getattr(record, 'request_id', None)
        if req_id:
            record.msg = f"[Req: {req_id}] {record.msg}"

        result = super().format(record)
        
        # Restore original message for other handlers if any
        record.msg = original_msg
        return result

def initialize(data_dir: str, script_dir: str = None, level=logging.DEBUG):
    """
    Initializes the non-blocking logging system.
    """
    global _listener, _is_initialized
    if _is_initialized:
        return
    
    os.makedirs(data_dir, exist_ok=True)
    
    main_log_file = os.path.join(data_dir, "native_host.log")
    ipc_log_file = os.path.join(data_dir, "ipc_events.log")
    
    # 1. Main Handler (Rotating File)
    main_handler = logging.handlers.RotatingFileHandler(
        main_log_file, maxBytes=1024 * 1024 * 5, backupCount=2, encoding='utf-8'
    )
    
    # 2. IPC Handler (Rotating File)
    ipc_handler = logging.handlers.RotatingFileHandler(
        ipc_log_file, maxBytes=1024 * 1024 * 5, backupCount=1, encoding='utf-8'
    )
    
    # 3. Security Formatter
    formatter = SecurityFormatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
    formatter.data_dir = data_dir
    formatter.script_dir = script_dir
    
    main_handler.setFormatter(formatter)
    ipc_handler.setFormatter(formatter)
    
    # 4. Filter for IPC Logger
    class IPCFilter(logging.Filter):
        def filter(self, record):
            return record.name == "ipc_events"
            
    class MainFilter(logging.Filter):
        def filter(self, record):
            return record.name != "ipc_events"
            
    ipc_handler.addFilter(IPCFilter())
    main_handler.addFilter(MainFilter())
    
    # 5. Queue Handler (The Non-blocking Part)
    # Use our custom handler to preserve context
    queue_handler = ContextQueueHandler(_log_queue)
    
    root = logging.getLogger()
    # Remove existing handlers
    for h in root.handlers[:]:
        h.close()
        root.removeHandler(h)
        
    root.addHandler(queue_handler)
    root.setLevel(level)
    
    # 6. Start the Listener Thread
    # It consumes from the queue and writes to the real handlers
    _listener = logging.handlers.QueueListener(
        _log_queue, main_handler, ipc_handler, respect_handler_level=True
    )
    _listener.start()
    
    _is_initialized = True
    logging.info(f"Logging initialized. Data Dir: {data_dir}")

def shutdown():
    """
    Ensures all logs are flushed before exit.
    """
    global _listener, _is_initialized
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
        except Exception:
            pass

def set_ui_sender(send_func):
    """Injects the bridge's send_message function for UI notifications."""
    setattr(sys.modules[__name__], '_ui_send_func', send_func)

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
                                    "text": f"[Native Host]: YouTube playback failed. This may be due to an outdated yt-dlp. Checking for auto-update...",
                                    "type": "error"
                                }
                            })
        except Exception as e:
            logging.error(f"Error observing {tag} stream: {e}")
    return logger_thread
