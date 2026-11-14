import errno
import logging
import os
import platform
import threading
import time

if platform.system() == "Windows":
    import msvcrt
else:
    import fcntl


class FileLock:
    """
    A robust cross-process file locking mechanism using OS-level advisory locks
    (fcntl.flock on POSIX, msvcrt.locking on Windows) on a .lock file.
    Includes per-path thread-level RLock synchronization.
    """
    _locks = {}
    _global_lock = threading.Lock()
    _held_locks = threading.local()

    def __init__(self, filepath, timeout=5.0, delay=0.05):
        # Normalize path for the lock dictionary key (case-insensitive on Windows)
        self.filepath = os.path.abspath(filepath)
        self.lock_key = self.filepath
        if platform.system() == "Windows":
            self.lock_key = self.lock_key.lower()

        self.lockfile = f"{self.filepath}.lock"
        self.timeout = timeout
        self.delay = delay
        self.is_file_locked = False
        self._fd = None

        # Get or create a thread-level RLock for this specific path
        with FileLock._global_lock:
            if self.lock_key not in FileLock._locks:
                FileLock._locks[self.lock_key] = threading.RLock()
            self.thread_lock = FileLock._locks[self.lock_key]

    def _remove_lock_file(self):
        """Attempts to remove the lock file with a robust retry loop (needed on Windows/AV)."""
        if not os.path.exists(self.lockfile):
            return True

        # Aggressive retry loop: Anti-Virus often holds a handle for 100-500ms
        for i in range(10):  # 1 second total
            try:
                os.remove(self.lockfile)
                return True
            except (OSError, PermissionError):
                if i < 9:
                    time.sleep(0.1)
        return False

    def __enter__(self):
        # 1. Acquire thread-level RLock (prevents internal process contention)
        if not self.thread_lock.acquire(timeout=self.timeout):
            raise RuntimeError(f"Could not acquire thread lock for {self.filepath} after {self.timeout}s")

        # Initialize thread-local storage for recursion counting
        if not hasattr(FileLock._held_locks, 'counters'):
            FileLock._held_locks.counters = {}

        count = FileLock._held_locks.counters.get(self.lock_key, 0)
        if count > 0:
            # Recursion: already held by this thread
            FileLock._held_locks.counters[self.lock_key] = count + 1
            return self

        # 2. Acquire cross-process OS advisory file lock
        start_time = time.time()
        is_windows = platform.system() == "Windows"

        while True:
            fd = None
            try:
                fd = os.open(self.lockfile, os.O_CREAT | os.O_RDWR, 0o600)
            except OSError as err:
                lock_dir = os.path.dirname(self.lockfile)
                if lock_dir and not os.path.exists(lock_dir):
                    try:
                        os.makedirs(lock_dir, exist_ok=True)
                        continue
                    except OSError:
                        logging.warning(f"[PY][IO] Lock directory {lock_dir} cannot be created: {err}. Falling back to thread lock.")
                        self.is_file_locked = False
                        FileLock._held_locks.counters[self.lock_key] = 1
                        return self

                if getattr(err, 'errno', None) in (errno.EROFS, errno.EACCES) and not os.path.exists(self.lockfile):
                    logging.warning(f"[PY][IO] Filesystem for {self.lockfile} is not writable: {err}. Falling back to thread lock.")
                    self.is_file_locked = False
                    FileLock._held_locks.counters[self.lock_key] = 1
                    return self

                if time.time() - start_time >= self.timeout:
                    break
                time.sleep(self.delay)
                continue

            acquired = False
            try:
                if is_windows:
                    os.lseek(fd, 0, os.SEEK_SET)
                    msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                    acquired = True
                else:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    # Verify the lockfile path still points to the same inode we locked
                    try:
                        stat_fd = os.fstat(fd)
                        stat_path = os.stat(self.lockfile)
                        if stat_fd.st_ino != stat_path.st_ino or stat_fd.st_dev != stat_path.st_dev:
                            fcntl.flock(fd, fcntl.LOCK_UN)
                        else:
                            acquired = True
                    except FileNotFoundError:
                        fcntl.flock(fd, fcntl.LOCK_UN)
            except (BlockingIOError, OSError):
                acquired = False

            if acquired:
                try:
                    os.ftruncate(fd, 0)
                    os.lseek(fd, 0, os.SEEK_SET)
                    os.write(fd, str(os.getpid()).encode())
                except OSError as write_err:
                    logging.debug(f"[PY][IO] Could not write PID to lockfile {self.lockfile}: {write_err}")
                self._fd = fd
                self.is_file_locked = True
                FileLock._held_locks.counters[self.lock_key] = 1
                return self

            try:
                os.close(fd)
            except OSError as close_err:
                logging.debug(f"[PY][IO] Could not close contended lockfile fd: {close_err}")

            if time.time() - start_time >= self.timeout:
                break
            time.sleep(self.delay)

        # Failed to acquire lock within timeout
        self.thread_lock.release()
        holder_pid = "unknown"
        try:
            with open(self.lockfile, 'r') as f:
                holder_pid = f.read().strip() or "unknown"
        except (OSError, UnicodeDecodeError) as e:
            logging.debug(f"[PY][IO] Could not read lock holder PID from {self.lockfile}: {e}")
        raise RuntimeError(f"Could not acquire lock for {self.filepath} after {self.timeout}s. Held by PID: {holder_pid}")

    def __exit__(self, exc_type, exc_val, exc_tb):
        try:
            count = FileLock._held_locks.counters.get(self.lock_key, 0)
            if count > 1:
                FileLock._held_locks.counters[self.lock_key] = count - 1
            else:
                if self.is_file_locked and self._fd is not None:
                    fd = self._fd
                    self._fd = None
                    if platform.system() == "Windows":
                        try:
                            os.lseek(fd, 0, os.SEEK_SET)
                            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
                        except OSError as e:
                            logging.debug(f"[PY][IO] Error unlocking {self.lockfile}: {e}")
                        finally:
                            try:
                                os.close(fd)
                            except OSError as e:
                                logging.debug(f"[PY][IO] Error closing {self.lockfile}: {e}")
                        self._remove_lock_file()
                    else:
                        try:
                            fcntl.flock(fd, fcntl.LOCK_UN)
                        except OSError as e:
                            logging.debug(f"[PY][IO] Error unlocking {self.lockfile}: {e}")
                        finally:
                            try:
                                os.close(fd)
                            except OSError as e:
                                logging.debug(f"[PY][IO] Error closing {self.lockfile}: {e}")
                    self.is_file_locked = False
                FileLock._held_locks.counters[self.lock_key] = 0
        finally:
            self.thread_lock.release()
