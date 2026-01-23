import os
import logging
import platform
import sys
import time
import re
import shutil
from utils.ipc_utils import IPC_DIR_LINUX, is_pid_running, IPCSocketManager
import mpv_session
from utils import url_analyzer, m3u_server

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
        - Only removes files that are older than 72 hours.
        - Even if older than 72 hours, it preserves files for PIDs that are still running.
        """
        if not os.path.exists(self.temp_dir):
            os.makedirs(self.temp_dir, exist_ok=True)
            return

        logging.info(f"Janitor: Running smart cleanup for {self.temp_dir} (72h threshold)")
        now = time.time()
        three_days_ago = now - (72 * 3600)

        # mpv_cookies_PID_uuid.txt
        cookie_re = re.compile(re.escape(url_analyzer.COOKIE_PREFIX) + r'(?P<pid>\d+)_')
        
        # delta_PID_uuid.m3u
        delta_re = re.compile(re.escape(mpv_session.DELTA_PREFIX) + r'(?P<pid>\d+)_')
        
        # server_PID.m3u
        server_re = re.compile(re.escape(m3u_server.SERVER_PREFIX) + r'(?P<pid>\d+)' + re.escape(m3u_server.SERVER_EXT) + r'$')

        PATTERNS = [
            (cookie_re, url_analyzer.COOKIE_EXT),
            (delta_re, mpv_session.DELTA_EXT),
            (server_re, m3u_server.SERVER_EXT)
        ]

        # Use topdown=False to allow cleaning empty directories after their content
        for root, dirs, files in os.walk(self.temp_dir, topdown=False):
            for filename in files:
                file_path = os.path.join(root, filename)
                matched = False
                
                for pattern, ext in PATTERNS:
                    if not filename.lower().endswith(ext):
                        continue
                    
                    match = pattern.match(filename)
                    if match:
                        matched = True
                        try:
                            file_mtime = os.path.getmtime(file_path)
                            # ONLY consider files older than 72 hours
                            if file_mtime < three_days_ago:
                                pid = int(match.group('pid'))
                                is_running = is_pid_running(pid)

                                # Only delete if the associated process is also dead
                                if not is_running:
                                    logging.info(f"Janitor: Removing stale {ext} file for dead PID {pid}: {filename}")
                                    os.remove(file_path)
                                else:
                                    logging.debug(f"Janitor: Preserving old {ext} file because PID {pid} is still alive: {filename}")

                        except FileNotFoundError:
                            pass
                        except (ValueError, OSError) as e:
                            logging.warning(f"Janitor: Error removing stale file {filename}: {e}")
                        break
                
                # Fallback: delete known temp extensions older than 72 hours if they didn't match a PID pattern
                if not matched and any(filename.lower().endswith(e) for e in ['.m3u', '.json', '.txt', '.flag']):
                    try:
                        if os.path.getmtime(file_path) < three_days_ago:
                            logging.info(f"Janitor: Removing old temporary file (no PID match/older than 72h): {filename}")
                            os.remove(file_path)
                    except FileNotFoundError:
                        pass
                    except OSError as e:
                        logging.warning(f"Janitor: Error removing old file {filename}: {e}")

    def cleanup_stale_ipc(self):
        """
        Scans for stale IPC sockets and flags.
        Only deletes resources older than 72 hours that are confirmed to be dead.
        """
        if platform.system() == "Windows":
            return

        if not os.path.exists(IPC_DIR_LINUX):
            return

        if not os.access(IPC_DIR_LINUX, os.R_OK | os.W_OK):
            logging.debug(f"Janitor: Skipping IPC cleanup due to lack of permissions on {IPC_DIR_LINUX}")
            return

        logging.info(f"Janitor: Checking for stale IPC resources in {IPC_DIR_LINUX} (72h threshold)")
        now = time.time()
        three_days_ago = now - (72 * 3600)
        
        socket_re = re.compile(r'^mpv-socket-(?P<pid>\d+)$')
        flag_re = re.compile(re.escape(mpv_session.NATURAL_COMPLETION_FLAG) + r'(?P<pid>\d+)\.flag$')
        
        try:
            for item in os.listdir(IPC_DIR_LINUX):
                item_path = os.path.join(IPC_DIR_LINUX, item)
                
                # Sockets
                s_match = socket_re.match(item)
                if s_match:
                    try:
                        file_mtime = os.path.getmtime(item_path)
                        if file_mtime < three_days_ago:
                            # Smart check: even if > 72h, only delete if unresponsive
                            is_socket_responsive = False
                            try:
                                manager = IPCSocketManager()
                                if manager.connect(item_path, timeout=0.5):
                                    resp = manager.send({"command": ["get_property", "pid"]}, expect_response=True, timeout=0.5)
                                    manager.close()
                                    if resp and resp.get("error") == "success":
                                        mpv_pid = resp.get("data")
                                        if mpv_pid and is_pid_running(mpv_pid):
                                            is_socket_responsive = True
                            except Exception:
                                pass

                            if not is_socket_responsive:
                                logging.info(f"Janitor: Removing stale socket older than 72h: {item}")
                                os.remove(item_path)
                    except FileNotFoundError:
                        pass
                    except OSError as e:
                        logging.warning(f"Janitor: Error removing stale socket {item}: {e}")
                    continue

                # Flags
                f_match = flag_re.match(item)
                if f_match:
                    try:
                        if os.path.getmtime(item_path) < three_days_ago:
                            pid = int(f_match.group('pid'))
                            if not is_pid_running(pid):
                                logging.info(f"Janitor: Removing stale flag older than 72h: {item}")
                                os.remove(item_path)
                    except FileNotFoundError:
                        pass
                    except OSError as e:
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

        # Check for directory permissions before proceeding
        if not os.access(root_path, os.R_OK):
            logging.debug(f"Janitor: Skipping pycache cleanup due to lack of permissions on {root_path}")
            return

        logging.info(f"Janitor: Cleaning up __pycache__ in {root_path}")
        for root, dirs, files in os.walk(root_path):
            if "__pycache__" in dirs:
                pycache_path = os.path.join(root, "__pycache__")
                try:
                    # Double check we have permission to write/delete in this specific pycache dir
                    if os.access(pycache_path, os.W_OK):
                        shutil.rmtree(pycache_path)
                        logging.info(f"Janitor: Removed {pycache_path}")
                    # Remove from dirs so os.walk doesn't try to go into it
                    dirs.remove("__pycache__")
                except Exception as e:
                    logging.warning(f"Janitor: Failed to remove {pycache_path}: {e}")

    def cleanup_flags(self):
        """Scans for stale natural completion flags in the dedicated flags directory."""
        flag_dir = os.path.join(self.data_dir, "flags")
        if not os.path.exists(flag_dir):
            return

        logging.info(f"Janitor: Checking for stale flags in {flag_dir} (72h threshold)")
        now = time.time()
        three_days_ago = now - (72 * 3600)
        
        flag_re = re.compile(r'^mpv_natural_completion_(?P<pid>\d+)\.flag$')
        
        try:
            for item in os.listdir(flag_dir):
                item_path = os.path.join(flag_dir, item)
                match = flag_re.match(item)
                if match:
                    try:
                        if os.path.getmtime(item_path) < three_days_ago:
                            pid = int(match.group('pid'))
                            if not is_pid_running(pid):
                                logging.info(f"Janitor: Removing stale flag file older than 72h: {item}")
                                os.remove(item_path)
                    except FileNotFoundError:
                        pass
                    except OSError as e:
                        logging.warning(f"Janitor: Error removing stale flag {item}: {e}")
        except Exception as e:
            logging.warning(f"Janitor: Error during flag cleanup: {e}")

    def run_startup_sweep(self, extension_root=None):
        """Executes a full cleanup suite on startup with concurrency protection."""
        lock_file = os.path.join(self.data_dir, ".janitor.lock")
        try:
            # Simple lock: If lock file is older than 5 minutes, assume it's stale
            if os.path.exists(lock_file) and (time.time() - os.path.getmtime(lock_file)) < 300:
                logging.debug("Janitor: Another sweep is recently active. Skipping.")
                return

            with open(lock_file, 'w') as f:
                f.write(str(os.getpid()))

            self.clean_temp_dir()
            self.cleanup_stale_ipc()
            self.cleanup_flags()
            # We skip pycache cleanup on standard startup to avoid race conditions and unnecessary disk I/O.
        except Exception as e:
            logging.warning(f"Janitor: Startup sweep encountered an error: {e}")
        finally:
            if os.path.exists(lock_file):
                try:
                    os.remove(lock_file)
                except Exception:
                    pass