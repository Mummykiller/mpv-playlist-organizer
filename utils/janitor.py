import os
import logging
import platform
import sys
import time
import re
import shutil
from utils.ipc_utils import IPC_DIR_LINUX, is_pid_running
import mpv_session
from utils import url_analyzer, native_host_handlers

# Prevent bytecode generation
sys.dont_write_bytecode = True
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'

class Janitor:
    def __init__(self, data_dir, temp_dir):
        self.data_dir = data_dir
        self.temp_dir = temp_dir
        # Log paths are now managed by RotatingFileHandler in native_host.py

    def clean_temp_dir(self):
        """
        Smart cleanup for temp playlists and cookies.
        - Removes files for dead PIDs immediately.
        - Removes files older than 7 days even if PID is alive (prevents zombie accumulation).
        - Removes unmatched temp files older than 24 hours.
        """
        if not os.path.exists(self.temp_dir):
            os.makedirs(self.temp_dir, exist_ok=True)
            return

        logging.info(f"Janitor: Running smart cleanup for {self.temp_dir}")
        now = time.time()
        one_day_ago = now - (24 * 3600)
        seven_days_ago = now - (7 * 24 * 3600)

        # Import patterns from source modules to avoid duplication
        # Patterns are now (regex_pattern, extension)
        
        # mpv_cookies_PID_uuid.txt
        cookie_re = re.compile(re.escape(url_analyzer.COOKIE_PREFIX) + r'(?P<pid>\d+)_')
        
        # delta_PID_uuid.m3u
        delta_re = re.compile(re.escape(mpv_session.DELTA_PREFIX) + r'(?P<pid>\d+)_')
        
        # server_PID.m3u
        server_re = re.compile(re.escape(native_host_handlers.SERVER_PREFIX) + r'(?P<pid>\d+)' + re.escape(native_host_handlers.SERVER_EXT) + r'$')

        PATTERNS = [
            (cookie_re, url_analyzer.COOKIE_EXT),
            (delta_re, mpv_session.DELTA_EXT),
            (server_re, native_host_handlers.SERVER_EXT) # This regex already includes the extension check in the pattern but let's keep it consistent
        ]

        # Use topdown=False to allow cleaning empty directories after their content
        for root, dirs, files in os.walk(self.temp_dir, topdown=False):
            for filename in files:
                file_path = os.path.join(root, filename)
                matched = False
                
                for pattern, ext in PATTERNS:
                    if not filename.lower().endswith(ext): continue
                    
                    match = pattern.match(filename)
                    if match:
                        matched = True
                        try:
                            pid = int(match.group('pid'))
                            is_running = is_pid_running(pid)
                            file_mtime = os.path.getmtime(file_path)

                            if not is_running:
                                logging.info(f"Janitor: Removing stale {ext} file for dead PID {pid}: {filename}")
                                os.remove(file_path)
                            elif file_mtime < seven_days_ago:
                                logging.info(f"Janitor: Removing ancient {ext} file (PID {pid} alive but file > 7 days old): {filename}")
                                os.remove(file_path)

                        except (ValueError, OSError) as e:
                            logging.warning(f"Janitor: Error removing stale file {filename}: {e}")
                        break # Found match, move to next file
                
                # Fallback: only delete known extensions if older than 24 hours
                if not matched and any(filename.lower().endswith(e) for e in ['.m3u', '.json', '.txt', '.flag']):
                    try:
                        if os.path.getmtime(file_path) < one_day_ago:
                            logging.info(f"Janitor: Removing old temporary file (no PID match): {filename}")
                            os.remove(file_path)
                    except OSError as e:
                        logging.warning(f"Janitor: Error removing old file {filename}: {e}")

            # Clean up empty subdirectories
            for d in dirs:
                dir_path = os.path.join(root, d)
                try:
                    if not os.listdir(dir_path):
                        os.rmdir(dir_path)
                except Exception:
                    pass

    def cleanup_stale_ipc(self):
        """
        Scans for stale IPC sockets and directories using shared constants.
        """
        # Windows named pipes are managed by the kernel; we can't "delete" them from the FS easily
        # and they disappear when the process dies. So we only clean up on Unix-like systems.
        if platform.system() == "Windows":
            return

        if not os.path.exists(IPC_DIR_LINUX):
            return

        logging.info(f"Janitor: Checking for stale IPC resources in {IPC_DIR_LINUX}")
        
        # Exact pattern for sockets and flags
        socket_re = re.compile(r'^mpv-socket-(?P<pid>\d+)$')
        flag_re = re.compile(r'^mpv_natural_completion_(?P<pid>\d+)\.flag$')
        
        try:
            for item in os.listdir(IPC_DIR_LINUX):
                item_path = os.path.join(IPC_DIR_LINUX, item)
                
                # Check sockets
                s_match = socket_re.match(item)
                if s_match:
                    try:
                        pid = int(s_match.group('pid'))
                        if not is_pid_running(pid):
                            logging.info(f"Janitor: Removing stale socket for dead PID {pid}: {item}")
                            os.remove(item_path)
                    except (ValueError, OSError) as e:
                        logging.warning(f"Janitor: Error removing stale socket {item}: {e}")
                    continue

                # Check flags
                f_match = flag_re.match(item)
                if f_match:
                    try:
                        pid = int(f_match.group('pid'))
                        if not is_pid_running(pid):
                            logging.info(f"Janitor: Removing stale flag for dead PID {pid}: {item}")
                            os.remove(item_path)
                    except (ValueError, OSError) as e:
                        logging.warning(f"Janitor: Error removing stale flag {item}: {e}")
                    continue

        except Exception as e:
            logging.warning(f"Janitor: Error during IPC cleanup: {e}")

    def cleanup_pycache(self, root_path):
        """
        Removes __pycache__ directories recursively starting from root_path.
        """
        if not root_path or not os.path.exists(root_path):
            return

        logging.info(f"Janitor: Cleaning up __pycache__ in {root_path}")
        for root, dirs, files in os.walk(root_path):
            if "__pycache__" in dirs:
                pycache_path = os.path.join(root, "__pycache__")
                try:
                    shutil.rmtree(pycache_path)
                    logging.info(f"Janitor: Removed {pycache_path}")
                    # Remove from dirs so os.walk doesn't try to go into it
                    dirs.remove("__pycache__")
                except Exception as e:
                    logging.warning(f"Janitor: Failed to remove {pycache_path}: {e}")

    def run_startup_sweep(self, extension_root=None):
        """Executes a full cleanup suite on startup."""
        self.clean_temp_dir()
        self.cleanup_stale_ipc()
        if extension_root:
            self.cleanup_pycache(extension_root)