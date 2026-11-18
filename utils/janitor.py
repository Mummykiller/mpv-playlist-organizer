import os
import logging
import platform
import sys
import time
import re
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
        - Removes cookie files older than 24 hours.
        - Removes other temp files older than 72 hours.
        - Even if older, it preserves files for PIDs that are still running.
        """
        if not os.path.exists(self.temp_dir):
            os.makedirs(self.temp_dir, exist_ok=True)
            return

        logging.info(f"Janitor: Running smart cleanup for {self.temp_dir}")
        now = time.time()
        three_days_ago = now - (72 * 3600)
        one_day_ago = now - (24 * 3600)

        # mpv_cookies_PID_uuid.txt or mpv_cookies_browser_hex.txt
        cookie_re = re.compile(re.escape(url_analyzer.COOKIE_PREFIX) + r'(?:(?P<pid>\d+)_|[a-zA-Z0-9_-]+)')

        # delta_PID_uuid.m3u
        delta_re = re.compile(re.escape(mpv_session.DELTA_PREFIX) + r'(?P<pid>\d+)_')

        # server_PID.m3u
        server_re = re.compile(re.escape(m3u_server.SERVER_PREFIX) + r'(?P<pid>\d+)' + re.escape(m3u_server.SERVER_EXT) + r'$')

        PATTERNS = [
            (cookie_re, url_analyzer.COOKIE_EXT, one_day_ago),
            (delta_re, mpv_session.DELTA_EXT, three_days_ago),
            (server_re, m3u_server.SERVER_EXT, three_days_ago)
        ]

        scan_dirs = [self.temp_dir]
        try:
            volatile_dir = url_analyzer.VolatileCookieManager.get_volatile_dir()
            if volatile_dir and os.path.exists(volatile_dir) and volatile_dir not in scan_dirs:
                scan_dirs.append(volatile_dir)
        except (AttributeError, OSError) as e:
            logging.debug(f"Janitor: Could not get volatile dir: {e}")

        # Use topdown=False to allow cleaning empty directories after their content
        for scan_dir in scan_dirs:
            for root, dirs, files in os.walk(scan_dir, topdown=False):
                for filename in files:
                    file_path = os.path.join(root, filename)
                    matched = False

                    for pattern, ext, threshold in PATTERNS:
                        if not filename.lower().endswith(ext):
                            continue

                        match = pattern.match(filename)
                        if match:
                            matched = True
                            try:
                                file_mtime = os.path.getmtime(file_path)
                                # ONLY consider files older than the threshold
                                if file_mtime < threshold:
                                    pid_str = match.groupdict().get('pid')
                                    if pid_str:
                                        pid = int(pid_str)
                                        is_running = is_pid_running(pid)
                                    else:
                                        pid = None
                                        is_running = False

                                    # Only delete if the associated process is also dead
                                    if not is_running:
                                        logging.info(f"Janitor: Removing stale {ext} file: {filename}")
                                        os.remove(file_path)
                                    else:
                                        logging.debug(f"Janitor: Preserving old {ext} file because PID {pid} is still alive: {filename}")

                            except FileNotFoundError as e:
                                logging.debug(f"Janitor: Stale file already removed {file_path}: {e}")
                            except (ValueError, OSError) as e:
                                logging.warning(f"Janitor: Error removing stale file {filename}: {e}")
                            break

                    # Fallback: delete known temp extensions older than 72 hours if they didn't match a PID pattern
                    if not matched and any(filename.lower().endswith(e) for e in ['.m3u', '.json', '.txt', '.flag']):
                        try:
                            if os.path.getmtime(file_path) < three_days_ago:
                                logging.info(f"Janitor: Removing old temporary file (no PID match/older than 72h): {filename}")
                                os.remove(file_path)
                        except FileNotFoundError as e:
                            logging.debug(f"Janitor: Temp file already removed {file_path}: {e}")
                        except OSError as e:
                            logging.warning(f"Janitor: Error removing old file {filename}: {e}")

    def cleanup_stale_ipc(self):
        """
        Scans for stale IPC sockets and flags.
        Checks both the standard Linux IPC dir and the home-directory fallback.
        """
        if platform.system() == "Windows":
            return

        targets = [IPC_DIR_LINUX]
        fallback_ipc_dir = os.path.realpath(os.path.join(os.path.expanduser("~"), ".mpv_playlist_organizer_ipc"))
        if os.path.exists(fallback_ipc_dir):
            targets.append(fallback_ipc_dir)

        for ipc_dir in targets:
            if not os.path.exists(ipc_dir) or not os.access(ipc_dir, os.R_OK | os.W_OK):
                continue

            logging.info(f"Janitor: Checking for stale IPC resources in {ipc_dir} (72h threshold)")
            now = time.time()
            three_days_ago = now - (72 * 3600)

            socket_re = re.compile(r'^mpv-socket-(?P<pid>\d+)$')
            flag_re = re.compile(re.escape(mpv_session.NATURAL_COMPLETION_FLAG) + r'(?P<pid>\d+)\.flag$')

            try:
                for item in os.listdir(ipc_dir):
                    item_path = os.path.join(ipc_dir, item)

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
                                        mpv_pid = manager.get_property("pid", timeout=0.5)
                                        manager.close()
                                        if mpv_pid and is_pid_running(mpv_pid):
                                            is_socket_responsive = True
                                except (OSError, ValueError, TimeoutError) as e:
                                    logging.debug(f"Janitor: Socket unresponsive or check failed for {item_path}: {e}")

                                if not is_socket_responsive:
                                    logging.info(f"Janitor: Removing stale socket older than 72h: {item}")
                                    os.remove(item_path)
                        except FileNotFoundError as e:
                            logging.debug(f"Janitor: Socket already removed {item_path}: {e}")
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
                        except FileNotFoundError as e:
                            logging.debug(f"Janitor: Temp file already removed {item_path}: {e}")
                        except OSError as e:
                            logging.warning(f"Janitor: Error removing stale flag {item}: {e}")
                        continue

                # Cleanup the directory itself if it's the fallback and now empty
                if ipc_dir == fallback_ipc_dir and not os.listdir(ipc_dir):
                    os.rmdir(ipc_dir)
                    logging.info(f"Janitor: Removed empty fallback IPC directory: {ipc_dir}")

            except Exception as e:
                logging.warning(f"Janitor: Error during IPC cleanup in {ipc_dir}: {e}")

    def cleanup_flags(self):
        """Scans for stale natural completion flags and handshake files in the dedicated flags directory."""
        flag_dir = os.path.join(self.data_dir, "flags")
        if not os.path.exists(flag_dir):
            return

        logging.info(f"Janitor: Checking for stale flags in {flag_dir} (72h threshold)")
        now = time.time()
        three_days_ago = now - (72 * 3600)
        one_hour_ago = now - 3600

        flag_re = re.compile(r'^mpv_natural_completion_(?P<pid>\d+)\.flag$')
        handshake_re = re.compile(r'^handshake_.*\.json$')

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
                    except FileNotFoundError as e:
                        logging.debug(f"Janitor: Flag already removed {item_path}: {e}")
                    except OSError as e:
                        logging.warning(f"Janitor: Error removing stale flag {item}: {e}")
                    continue

                if handshake_re.match(item):
                    try:
                        if os.path.getmtime(item_path) < one_hour_ago:
                            logging.info(f"Janitor: Removing stale handshake file older than 1h: {item}")
                            os.remove(item_path)
                    except FileNotFoundError as e:
                        logging.debug(f"Janitor: Handshake file already removed {item_path}: {e}")
                    except OSError as e:
                        logging.warning(f"Janitor: Error removing stale handshake file {item}: {e}")
        except Exception as e:
            logging.warning(f"Janitor: Error during flag cleanup: {e}")

    def run_startup_sweep(self):
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
        except Exception as e:
            logging.warning(f"Janitor: Startup sweep encountered an error: {e}")
        finally:
            if os.path.exists(lock_file):
                try:
                    os.remove(lock_file)
                except OSError as e:
                    logging.debug(f"Janitor: Could not remove lock file {lock_file}: {e}")
