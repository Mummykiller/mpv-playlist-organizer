import os
import shutil
import time
import sys
import subprocess
import signal
import logging

# Optional watchdog import with graceful fallback to standard-library polling
try:
    from watchdog.observers import Observer  # type: ignore[import-not-found]
    from watchdog.events import FileSystemEventHandler  # type: ignore[import-not-found]
    HAS_WATCHDOG = True
except ImportError:
    HAS_WATCHDOG = False

# Add root to path so we can import file_io
root_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if root_dir not in sys.path:
    sys.path.insert(0, root_dir)

try:
    import file_io
    LOCK_FILE = os.path.join(file_io.DATA_DIR, ".pycache_watchdog.pid")
except Exception:
    LOCK_FILE = os.path.join(root_dir, "data", ".pycache_watchdog.pid")


def delete_pycache_dir(path):
    """Safely delete a __pycache__ directory with retries."""
    for attempt in range(3):
        try:
            if os.path.exists(path):
                shutil.rmtree(path, ignore_errors=True)
                if not os.path.exists(path):
                    return True
            time.sleep(0.1 * (attempt + 1))
        except (OSError, PermissionError) as e:
            logging.debug(f"[WATCHDOG] Failed attempt {attempt} to delete {path}: {e}")
    return False


if HAS_WATCHDOG:
    class PycacheHandler(FileSystemEventHandler):
        def __init__(self, target_dir):
            super().__init__()
            self.target_dir = target_dir

        def on_created(self, event):
            path = event.src_path.rstrip(os.sep)
            if event.is_directory and os.path.basename(path) == "__pycache__":
                time.sleep(0.1)
                delete_pycache_dir(path)

        def on_modified(self, event):
            if event.is_directory:
                try:
                    for item in os.listdir(event.src_path):
                        if item == "__pycache__":
                            full_path = os.path.join(event.src_path, item)
                            if os.path.isdir(full_path):
                                time.sleep(0.1)
                                delete_pycache_dir(full_path)
                except OSError as e:
                    logging.debug(f"[WATCHDOG] on_modified error on {event.src_path}: {e}")


def initial_sweep(target_dir):
    """Clean all __pycache__ folders and stray .pyc/.pyo files."""
    count = 0
    for root, dirs, files in os.walk(target_dir):
        if "__pycache__" in dirs:
            pycache_path = os.path.join(root, "__pycache__")
            if delete_pycache_dir(pycache_path):
                count += 1
        for file in files:
            if file.endswith((".pyc", ".pyo")):
                try:
                    os.remove(os.path.join(root, file))
                    count += 1
                except OSError as e:
                    logging.debug(f"[WATCHDOG] Could not remove stray bytecode file {file}: {e}")
    return count


def is_already_running():
    """Checks the lock file to see if a watchdog process is currently alive."""
    if not os.path.exists(LOCK_FILE):
        return None

    try:
        with open(LOCK_FILE, "r") as f:
            pid = int(f.read().strip())

        # Cross-platform alive check: signal 0 does not terminate the process
        os.kill(pid, 0)
        return pid
    except (ValueError, OSError, ProcessLookupError):
        # Process does not exist or lock file is stale
        try:
            if os.path.exists(LOCK_FILE):
                os.remove(LOCK_FILE)
        except OSError as e:
            logging.debug(f"[WATCHDOG] Could not remove stale lock file {LOCK_FILE}: {e}")
        return None


def set_process_name(name):
    """Sets the process name for Linux systems."""
    try:
        import ctypes
        import ctypes.util
        libc_path = ctypes.util.find_library('c')
        if libc_path:
            libc = ctypes.CDLL(libc_path)
            # PR_SET_NAME = 15
            libc.prctl(15, name.encode('utf-8'), 0, 0, 0)
    except (OSError, AttributeError) as e:
        logging.debug(f"[WATCHDOG] Failed to set process name: {e}")


def run_watchdog():
    """
    The background monitoring daemon loop.
    Runs persistently until explicit termination (SIGTERM/SIGINT) or system reboot.
    """
    set_process_name("pycache_clear")
    os.makedirs(os.path.dirname(LOCK_FILE), exist_ok=True)
    with open(LOCK_FILE, "w") as f:
        f.write(str(os.getpid()))

    # Ignore SIGHUP so closing terminals or session disconnections don't kill the worker
    if hasattr(signal, "SIGHUP"):
        signal.signal(signal.SIGHUP, signal.SIG_IGN)

    def _handle_exit(signum, frame):
        if os.path.exists(LOCK_FILE):
            try:
                os.remove(LOCK_FILE)
            except OSError as e:
                logging.debug(f"[WATCHDOG] Failed to remove lock file on exit: {e}")
        sys.exit(0)

    signal.signal(signal.SIGTERM, _handle_exit)
    signal.signal(signal.SIGINT, _handle_exit)

    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    initial_sweep(project_root)

    try:
        if HAS_WATCHDOG:
            event_handler = PycacheHandler(project_root)
            observer = Observer()
            observer.schedule(event_handler, project_root, recursive=True)
            observer.start()
            while True:
                try:
                    time.sleep(5)
                except Exception:
                    time.sleep(1.0)
            observer.join()
        else:
            while True:
                try:
                    time.sleep(5.0)
                    for root, dirs, _ in os.walk(project_root):
                        if "__pycache__" in dirs:
                            delete_pycache_dir(os.path.join(root, "__pycache__"))
                except Exception:
                    time.sleep(1.0)
    except KeyboardInterrupt:
        logging.debug("[WATCHDOG] Interrupted by user.")
    finally:
        if os.path.exists(LOCK_FILE):
            try:
                os.remove(LOCK_FILE)
            except OSError as e:
                logging.debug(f"[WATCHDOG] Failed to remove lock file on cleanup: {e}")


def stop_watchdog():
    """Stops the running watchdog process."""
    pid = is_already_running()
    if not pid:
        print("ℹ️  No Pycache Watchdog process is currently running.")
        return

    try:
        print(f"[*] Stopping Pycache Watchdog (PID: {pid})...")
        os.kill(pid, signal.SIGTERM)

        for _ in range(15):
            try:
                os.kill(pid, 0)
                time.sleep(0.1)
            except (ProcessLookupError, OSError):
                break

        if os.path.exists(LOCK_FILE):
            os.remove(LOCK_FILE)
        print("✅ Watchdog stopped.")
    except Exception as e:
        print(f"❌ Failed to stop process {pid}: {e}")
        if os.path.exists(LOCK_FILE):
            os.remove(LOCK_FILE)


SCRIPT_PATH = os.path.abspath(__file__)

def ensure_running(silent=False):
    """Verifies that the watchdog is running. Starts it in background if not."""
    existing_pid = is_already_running()
    if existing_pid:
        if not silent:
            print(f"✅ Pycache Watchdog is active and running (PID: {existing_pid}).")
            print(f"   Runs persistently until system reboot or manual termination ('{sys.executable} {SCRIPT_PATH} kill').")
        return existing_pid

    project_root = os.path.dirname(os.path.dirname(SCRIPT_PATH))
    initial_sweep(project_root)

    proc = subprocess.Popen(
        [sys.executable, SCRIPT_PATH, "--worker"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True
    )
    time.sleep(0.3)
    active_pid = is_already_running() or proc.pid
    engine_str = "inotify/watchdog" if HAS_WATCHDOG else "standard polling fallback"
    print(f"🚀 Pycache Watchdog started in background (PID: {active_pid}, engine: {engine_str}).")
    print(f"   Monitoring: {project_root}")
    print(f"   Runs persistently until system reboot or manual termination ('{sys.executable} {SCRIPT_PATH} kill').")
    return active_pid


if __name__ == "__main__":
    action = sys.argv[1].lower() if len(sys.argv) > 1 else ""

    if action in ("--worker", "-w"):
        run_watchdog()
    elif action in ("--foreground", "-f"):
        print("🚀 Running Pycache Watchdog in foreground. Press Ctrl+C to stop.")
        run_watchdog()
    elif action in ("kill", "stop"):
        stop_watchdog()
    elif action in ("clean", "sweep", "purge"):
        project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        count = initial_sweep(project_root)
        print(f"[*] Sweep complete. Removed {count} bytecode artifact(s).")
    elif action in ("status", "check"):
        pid = is_already_running()
        if pid:
            print(f"✅ Pycache Watchdog is active (PID: {pid}).")
        else:
            print("ℹ️  Pycache Watchdog is not running.")
    else:
        # Default / ensure: verify running or start in background
        ensure_running()
