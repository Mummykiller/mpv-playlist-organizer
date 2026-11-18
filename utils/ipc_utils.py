import os
import sys

# Prevent __pycache__ generation
sys.dont_write_bytecode = True
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'

import json
import time
import platform
import logging
import socket
import collections
import threading # Added this import
import select

ipc_logger = logging.getLogger("ipc_events")

def is_pid_running(pid):
    """Checks if a process ID is currently running on the system using native APIs."""
    if pid is None:
        return False
    try:
        pid = int(pid)
    except (ValueError, TypeError):
        return False
    if pid <= 0:
        return False
    system = platform.system()
    
    if system == "Windows":
        import ctypes
        # PROCESS_QUERY_LIMITED_INFORMATION is sufficient for existence check and works across users
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        kernel32 = ctypes.windll.kernel32
        h_process = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
        if h_process:
            # Check if it's a zombie process (still exists but has exited)
            exit_code = ctypes.c_ulong()
            # STILL_ACTIVE = 259
            if kernel32.GetExitCodeProcess(h_process, ctypes.byref(exit_code)):
                is_active = (exit_code.value == 259)
                kernel32.CloseHandle(h_process)
                return is_active
            kernel32.CloseHandle(h_process)
            return True # Fallback to existence if exit code fails
        else:
            # ERROR_ACCESS_DENIED (5) means the process exists but we can't open it
            if kernel32.GetLastError() == 5:
                return True
            return False
    else:
        try:
            # os.kill(pid, 0) is the standard Unix way to check if a PID exists
            os.kill(pid, 0)
            return True
        except PermissionError:
            # If we get a PermissionError, the process exists but we can't signal it.
            return True
        except (OSError, ImportError) as err:
            logging.debug(f"is_pid_running check failed for {pid}: {err}")
            return False

def _pipe_has_data_windows(handle_or_file):
    """Checks if a Windows named pipe handle has data available using PeekNamedPipe."""
    if platform.system() != "Windows":
        return True
    try:
        import msvcrt
        import ctypes
        if hasattr(handle_or_file, "fileno"):
            fd = handle_or_file.fileno()
        else:
            fd = int(handle_or_file)
        osf = msvcrt.get_osfhandle(fd)
        bytes_avail = ctypes.c_ulong(0)
        res = ctypes.windll.kernel32.PeekNamedPipe(osf, None, 0, None, ctypes.byref(bytes_avail), None)
        if res:
            return bytes_avail.value > 0
        return False
    except Exception as e:
        logging.debug(f"PeekNamedPipe check note: {e}")
        return True

def verify_mpv_process(pid, ipc_path=None):
    """
    Verifies that a PID actually belongs to an MPV process and matches our session.
    Never relies solely on PID running check to prevent PID reuse attacks (PY-H3).
    """
    if pid is None:
        return False
    try:
        pid = int(pid)
    except (ValueError, TypeError):
        return False
    if pid <= 0 or not is_pid_running(pid):
        return False

    # 1. First Priority: Check IPC response if ipc_path is available
    if ipc_path:
        try:
            probe_mgr = IPCSocketManager()
            if probe_mgr.connect(ipc_path, timeout=0.4, start_event_reader=False):
                mpv_pid = probe_mgr.get_property("pid", timeout=0.4)
                probe_mgr.close()
                if mpv_pid is not None and int(mpv_pid) == pid:
                    return True
        except Exception as e:
            logging.debug(f"IPC probe during process verification for PID {pid} failed: {e}")

    # 2. Check process command line / name on Linux via /proc
    system = platform.system()
    if system == "Linux":
        proc_cmdline = f"/proc/{pid}/cmdline"
        try:
            if os.path.exists(proc_cmdline):
                with open(proc_cmdline, "rb") as f:
                    cmd_bytes = f.read(4096)
                if cmd_bytes:
                    cmd_str = cmd_bytes.decode("utf-8", errors="replace")
                    args = [a for a in cmd_str.split("\0") if a]
                    first_arg = os.path.basename(args[0]).lower() if args else ""
                    second_arg = os.path.basename(args[1]).lower() if len(args) > 1 else ""
                    is_mpv_bin = "mpv" in first_arg or "mpv" in second_arg
                    if is_mpv_bin:
                        if ipc_path:
                            ipc_basename = os.path.basename(ipc_path)
                            if ipc_basename in cmd_str or ipc_path in cmd_str or "--input-ipc-server" in cmd_str:
                                return True
                        else:
                            return True
        except Exception as e:
            logging.debug(f"Failed to inspect /proc/{pid}/cmdline: {e}")

    # 3. Check via psutil if installed
    try:
        import psutil
        p = psutil.Process(pid)
        name = p.name().lower()
        cmdline_list = []
        try:
            cmdline_list = p.cmdline() or []
        except Exception as e:
            logging.debug(f"psutil cmdline inspection failed for PID {pid}: {e}")
        first_base = os.path.basename(cmdline_list[0]).lower() if cmdline_list else ""
        second_base = os.path.basename(cmdline_list[1]).lower() if len(cmdline_list) > 1 else ""
        is_mpv_bin = "mpv" in name or "mpv" in first_base or "mpv" in second_base
        if is_mpv_bin:
            if ipc_path:
                if cmdline_list:
                    cmdline = " ".join(cmdline_list)
                    if os.path.basename(ipc_path) in cmdline or ipc_path in cmdline:
                        return True
                else:
                    return True
            else:
                return True
    except ImportError as e:
        logging.debug(f"psutil not available for process check: {e}")
    except Exception as e:
        logging.debug(f"psutil inspection failed for PID {pid}: {e}")

    # 4. Windows ctypes process image name check
    if system == "Windows":
        try:
            import ctypes
            from ctypes import wintypes
            PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
            kernel32 = ctypes.windll.kernel32
            h_proc = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
            if h_proc:
                try:
                    buf = ctypes.create_unicode_buffer(1024)
                    size = wintypes.DWORD(1024)
                    if hasattr(kernel32, "QueryFullProcessImageNameW") and kernel32.QueryFullProcessImageNameW(h_proc, 0, buf, ctypes.byref(size)):
                        exe_name = os.path.basename(buf.value).lower()
                        if "mpv" in exe_name:
                            return True
                finally:
                    kernel32.CloseHandle(h_proc)
        except Exception as e:
            logging.debug(f"Windows ctypes process image check failed for PID {pid}: {e}")

    # 5. Fallback for macOS / BSD via ps command
    if system in ("Darwin", "FreeBSD"):
        try:
            import subprocess
            res = subprocess.run(["ps", "-p", str(pid), "-o", "comm="], capture_output=True, text=True, timeout=0.5)
            if res.returncode == 0 and "mpv" in res.stdout.lower():
                return True
        except Exception as e:
            logging.debug(f"ps fallback inspection failed for PID {pid}: {e}")

    return False

class IPCSocketManager:
    """
    Manages a persistent IPC socket connection to an MPV instance.
    Opens and closes the socket once per session, improving efficiency and robustness.
    """

    def __init__(self):
        self._sock = None
        self._sock_file = None
        self._ipc_path = None
        self._system = platform.system()
        self._event_buffer = collections.deque()
        self._buffer_lock = threading.Condition() # Changed from Lock to Condition
        self._send_lock = threading.Lock() # NEW: Lock for sending commands
        self._event_reader_thread = None # Added for background reader thread
        self._event_reader_running = False # Flag to control reader thread
        self._request_id_counter = 0
        self._script_handlers = {} # Registry for script message handlers

    def is_connected(self):
        return self._sock is not None and self._event_reader_running

    def register_script_message_handler(self, name, handler):
        """Registers a callback function for a specific client-message name."""
        self._script_handlers[name] = handler

    def _cleanup_attempt_handles(self):
        """Closes socket/file handles from a failed connect() attempt without wiping _ipc_path or scanning all sockets."""
        if self._sock_file:
            try:
                self._sock_file.close()
            except (OSError, ValueError) as e:
                logging.debug(f"Error closing sock_file during connect retry: {e}")
            self._sock_file = None
        if self._sock:
            try:
                self._sock.close()
            except OSError as e:
                logging.debug(f"Error closing sock during connect retry: {e}")
            self._sock = None

    def connect(self, ipc_path, timeout=15.0, start_event_reader=True):
        """
        Connects to the MPV IPC server.
        Retries connection attempts for a specified timeout duration.
        Returns True on success, False on failure.
        """
        self._ipc_path = ipc_path
        start_time = time.time()
        
        logging.info(f"Attempting to connect to MPV IPC: {ipc_path}")

        while time.time() - start_time < timeout:
            try:
                if self._system == "Windows":
                    # On Windows, named pipes are opened like files.
                    # We open in r+b mode for reading and writing.
                    self._sock = open(ipc_path, "r+b", buffering=0)
                    self._sock_file = self._sock # On Windows, open() returns a file-like object directly
                else: # Linux/macOS
                    self._sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                    self._sock.connect(ipc_path)
                    self._sock_file = self._sock.makefile('rb')
                
                self._ipc_path = ipc_path
                logging.info(f"Successfully connected to MPV IPC: {ipc_path}")
                
                if start_event_reader:
                    with self._buffer_lock: # Ensure we set running flag under lock
                        self._event_reader_running = True
                    self._event_reader_thread = threading.Thread(target=self._event_reader_loop)
                    self._event_reader_thread.daemon = True # Allow program to exit even if thread is running
                    self._event_reader_thread.start()
                    logging.debug("IPC event reader thread started.")
                
                return True
            except (FileNotFoundError, ConnectionRefusedError, OSError) as e:
                logging.debug(f"IPC connection failed (will retry): {e}")
                self._cleanup_attempt_handles()
                time.sleep(0.2) # Small delay before next attempt
            except Exception as e:
                logging.error(f"Unexpected error during IPC connection attempt (will retry): {e}")
                self._cleanup_attempt_handles()
                time.sleep(0.2)
        
        logging.error(f"Failed to connect to MPV IPC at {ipc_path} after {timeout} seconds.")
        return False

    def _process_raw_ipc_line(self, raw_line):
        """Decodes and dispatches a single newline-delimited IPC JSON line."""
        line_str = raw_line.decode('utf-8', errors='replace').strip()
        if not line_str:
            return
        try:
            event = json.loads(line_str)
        except json.JSONDecodeError:
            return

        handled = False
        if event.get("event") == "client-message":
            args = event.get("args", [])
            if args and len(args) > 0 and isinstance(args[0], str):
                msg_name = args[0]

                # Filter out noisy thumbnail script events
                if msg_name.startswith("mpv_thumbnail_script"):
                    return

                if msg_name in self._script_handlers:
                    try:
                        # We invoke the handler directly. Handlers must be non-blocking!
                        self._script_handlers[msg_name](args[1:])
                        handled = True
                    except Exception as e:
                        logging.error(f"Error in script handler for {msg_name}: {e}")

        if not handled:
            ipc_logger.debug(f"IPC EVENT (Reader Thread): {json.dumps(event)}")
            with self._buffer_lock:
                self._event_buffer.append(event)
                # Limit buffer size to prevent memory leaks/performance degradation
                if len(self._event_buffer) > 1000:
                    self._event_buffer.popleft()
                self._buffer_lock.notify_all()

    def _event_reader_loop(self):
        """
        Continuously reads events from the IPC socket and appends them to the internal buffer.
        Runs in a separate thread to prevent mpv's output buffer from filling up.
        """
        raw_buffer = bytearray()
        while True:
            # 1. Process any complete lines already buffered before waiting on select()
            while b"\n" in raw_buffer:
                newline_idx = raw_buffer.find(b"\n")
                raw_line = bytes(raw_buffer[:newline_idx])
                del raw_buffer[:newline_idx + 1]
                self._process_raw_ipc_line(raw_line)

            # 2. Thread-safe state check and handle capture
            with self._buffer_lock:
                if not self._event_reader_running:
                    break
                
                sock_handle = self._sock
                reader_handle = self._sock_file
                if not sock_handle and not reader_handle:
                    self._buffer_lock.wait(0.1)
                    continue

            try:
                if self._system != "Windows" and sock_handle:
                    # Use select to check for data availability with a timeout on Unix
                    readable, _, _ = select.select([sock_handle], [], [], 0.1)
                    if sock_handle not in readable:
                        continue
                elif self._system == "Windows" and reader_handle:
                    if not _pipe_has_data_windows(reader_handle):
                        time.sleep(0.05)
                        continue

                # 3. Read raw bytes from Unix socket via recv(4096) to avoid BufferedReader stranding
                chunk = None
                used_recv = False
                if self._system != "Windows" and sock_handle is not None:
                    if isinstance(sock_handle, socket.socket):
                        chunk = sock_handle.recv(4096)
                        used_recv = True
                    elif hasattr(sock_handle, "recv"):
                        maybe_chunk = sock_handle.recv(4096)
                        if isinstance(maybe_chunk, (bytes, bytearray)):
                            chunk = maybe_chunk
                            used_recv = True

                if not used_recv:
                    if not reader_handle:
                        break
                    chunk = reader_handle.readline()

                if chunk:
                    raw_buffer.extend(chunk)
                    if not used_recv and b"\n" not in raw_buffer:
                        raw_buffer.extend(b"\n")
                    while b"\n" in raw_buffer:
                        newline_idx = raw_buffer.find(b"\n")
                        raw_line = bytes(raw_buffer[:newline_idx])
                        del raw_buffer[:newline_idx + 1]
                        self._process_raw_ipc_line(raw_line)
                else:
                    # EOF detected, connection closed by MPV or remote end
                    ipc_logger.info("IPC event reader detected EOF. Signaling connection closure.")
                    with self._buffer_lock:
                        self._event_reader_running = False 
                        self._buffer_lock.notify_all()
                    break
            except (ConnectionResetError, BrokenPipeError, OSError, ValueError) as e:
                # ValueError specifically happens if reader_handle is closed during readline()
                logging.debug(f"IPC event reader thread connection error: {e}. Stopping.")
                with self._buffer_lock:
                    self._event_reader_running = False 
                    self._buffer_lock.notify_all()
                break
            except Exception as e:
                logging.error(f"IPC event reader thread unexpected error: {e}. Stopping.")
                with self._buffer_lock:
                    self._event_reader_running = False
                    self._buffer_lock.notify_all()
                break
        logging.debug("IPC event reader thread stopped.")


    def send(self, command_dict, timeout=1.0, expect_response=True):
        """
        Sends a JSON command to the connected MPV IPC server.
        Returns the JSON response on success, or None on failure (e.g., disconnected).
        """
        if not self._sock:
            logging.warning(f"Attempted to send command '{command_dict.get('command')}' but IPC socket is not connected.")
            return None
        
        with self._send_lock:
            # Assign a unique request_id to ensure we match the correct response
            if "request_id" not in command_dict:
                self._request_id_counter = (self._request_id_counter + 1) % 100000
                req_id = self._request_id_counter
                command_dict["request_id"] = req_id
            else:
                req_id = command_dict["request_id"]

            ipc_logger.debug(f"[PY][IPC] SEND: {json.dumps(command_dict)}")
            command_str = json.dumps(command_dict) + '\n'

            try:
                encoded = command_str.encode('utf-8')
                if self._system == "Windows":
                    # For Windows named pipes, writing and flushing is the way to send.
                    self._sock.write(encoded)
                    self._sock.flush()
                else: # Linux/macOS
                    self._sock.sendall(encoded)

                if not expect_response:
                    return {"error": "success"} # Command sent, no response expected

                # --- Handle Synchronous Read if Reader Thread is Disabled ---
                if not self._event_reader_running:
                    start_wait = time.time()
                    sync_buffer = bytearray()
                    while time.time() - start_wait < timeout:
                        remaining_timeout = max(0.01, timeout - (time.time() - start_wait))
                        try:
                            if self._system != "Windows" and self._sock:
                                readable, _, _ = select.select([self._sock], [], [], remaining_timeout)
                                if not readable:
                                    break
                                if isinstance(self._sock, socket.socket):
                                    chunk = self._sock.recv(4096)
                                    if not chunk:
                                        break
                                    sync_buffer.extend(chunk)
                                    while b"\n" in sync_buffer:
                                        newline_idx = sync_buffer.find(b"\n")
                                        raw_line = bytes(sync_buffer[:newline_idx])
                                        del sync_buffer[:newline_idx + 1]
                                        if not raw_line.strip():
                                            continue
                                        try:
                                            resp = json.loads(raw_line.decode('utf-8'))
                                        except json.JSONDecodeError:
                                            continue
                                        if resp.get("request_id") == req_id or ("event" not in resp and "request_id" not in resp):
                                            return resp
                                    continue

                            # Direct read from file handle (Windows or mocked handle)
                            if self._system == "Windows" and self._sock_file:
                                if not _pipe_has_data_windows(self._sock_file):
                                    time.sleep(0.02)
                                    continue
                            line = self._sock_file.readline()
                            if not line:
                                break
                            resp = json.loads(line.decode('utf-8'))
                            # Check if this is the response we want
                            if resp.get("request_id") == req_id or ("event" not in resp and "request_id" not in resp):
                                return resp
                        except (OSError, json.JSONDecodeError):
                            break
                    return None

                # --- Regular Buffered Read (uses Reader Thread) ---
                start_read_time = time.time()
                with self._buffer_lock:
                    while True:
                        # Check internal buffer for a command response (matching request_id)
                        for i in range(len(self._event_buffer)):
                            item = self._event_buffer[i]
                            # NEW: Precise request_id matching only. 
                            # Non-command events are filtered out by the logic above.
                            if item.get("request_id") == req_id:
                                del self._event_buffer[i] 
                                response = item
                                ipc_logger.debug(f"IPC RECV (from buffer): {json.dumps(response)}")
                                return response
                        
                        elapsed = time.time() - start_read_time
                        if elapsed >= timeout:
                            logging.warning(f"Timed out waiting for command response for id {req_id} after {timeout} seconds.")
                            return None
                        
                        # Wait for notify from reader thread
                        if not self._buffer_lock.wait(timeout - elapsed):
                             # wait() returns False on timeout (Python 3.2+)
                             if time.time() - start_read_time >= timeout:
                                 logging.warning(f"Timed out (wait) for command response for id {req_id}")
                                 return None
                        
            except (BrokenPipeError, ConnectionResetError, socket.timeout, OSError) as e:
                logging.debug(f"IPC send error (connection likely lost): {e}")
                self.close() 
                return None
            except Exception as e:
                logging.error(f"Unexpected error during IPC send command: {e}")
                self.close()
                return None

    def receive_event(self, timeout=None):
        """
        Retrieves a single event from the internal buffer.
        Returns the JSON event on success, or None if buffer is empty within timeout.
        """
        start_time = time.time()
        with self._buffer_lock:
            while True:
                if self._event_buffer:
                    event = self._event_buffer.popleft()
                    ipc_logger.debug(f"IPC EVENT (from buffer): {json.dumps(event)}")
                    return event
                
                if not self._event_reader_running:
                    return None
                
                if timeout is not None:
                    elapsed = time.time() - start_time
                    if elapsed >= timeout:
                        return None
                    self._buffer_lock.wait(timeout - elapsed)
                else:
                    # Blocking wait
                    self._buffer_lock.wait()


    def get_property(self, name, timeout=1.0, default=None):
        """
        Queries an MPV property by name via IPC.
        Returns the property value from 'data' if error == 'success', otherwise default.
        """
        try:
            resp = self.send({"command": ["get_property", name]}, timeout=timeout, expect_response=True)
            if resp and resp.get("error") == "success":
                return resp.get("data", default)
        except Exception as e:
            logging.debug(f"Failed to get property '{name}': {e}")
        return default

    def log_to_mpv(self, message):
        """Sends a message to MPV to be printed in its terminal via script-message."""
        if self.is_connected():
            try:
                self.send({"command": ["script-message", "python_log", message]}, expect_response=False)
            except Exception as e:
                logging.debug(f"Failed to send log to mpv: {e}")

    @staticmethod
    def _is_socket_stale(path):
        """Returns True if the Unix socket file at path is stale/dead (cannot connect)."""
        if platform.system() == "Windows" or not path or not os.path.exists(path):
            return False
        test_sock = None
        try:
            test_sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            test_sock.settimeout(0.1)
            test_sock.connect(path)
            return False  # Actively listening
        except (socket.timeout, TimeoutError):
            # Busy MPV instance - definitely NOT stale!
            return False
        except (ConnectionRefusedError, FileNotFoundError):
            return True   # Refused or missing socket -> stale
        except OSError as e:
            import errno
            if e.errno in (errno.ECONNREFUSED, errno.ENOENT):
                return True
            if e.errno in (errno.EAGAIN, errno.EWOULDBLOCK, errno.EINPROGRESS, errno.ETIMEDOUT):
                return False
            logging.debug(f"Socket probe returned unexpected OSError {e.errno} for {path}: {e}")
            return False
        except Exception as e:
            logging.debug(f"Probe socket error for {path}: {e}")
            return False
        finally:
            if test_sock is not None:
                try:
                    test_sock.close()
                except Exception as e:
                    logging.debug(f"Error closing probe socket: {e}")

    @classmethod
    def cleanup_stale_sockets(cls):
        """
        Audits and unlinks stale socket files ONLY in our application's own IPC directory.
        Never scans /tmp or other hosts' sockets (PY-M1).
        """
        if platform.system() == "Windows":
            return
        
        import stat
        cdir = IPC_DIR_LINUX
        if not cdir or not os.path.isdir(cdir) or not os.access(cdir, os.R_OK | os.W_OK):
            return
        try:
            for entry in os.listdir(cdir):
                if entry.startswith("mpv-socket-") or entry.startswith("mpv_socket_") or entry.startswith("mpv_socket"):
                    full_path = os.path.join(cdir, entry)
                    try:
                        st = os.stat(full_path)
                        if stat.S_ISSOCK(st.st_mode) and cls._is_socket_stale(full_path):
                            os.unlink(full_path)
                            logging.info(f"Unlinked stale IPC socket: {full_path}")
                    except OSError as err:
                        logging.debug(f"Failed to inspect/unlink socket {full_path}: {err}")
        except Exception as e:
            logging.debug(f"Error scanning IPC directory {cdir} for stale sockets: {e}")

    def close(self, unlink_socket=None):
        """
        Closes the IPC socket handle, shuts down the reader thread, and ensures no
        socket descriptor or stale socket file leaks in /tmp/mpv_sockets, /dev/shm, etc.
        """
        # 1. Stop the reader thread first if it's running
        with self._buffer_lock:
            if self._event_reader_running:
                self._event_reader_running = False
                self._buffer_lock.notify_all()

        ipc_path = self._ipc_path

        # 2. Close handles to break any blocking readline() calls
        if self._sock_file:
            try:
                self._sock_file.close()
            except (OSError, ValueError) as e:
                logging.debug(f"Error closing sock_file: {e}")
            self._sock_file = None

        if self._sock:
            try:
                if self._system == "Windows":
                    self._sock.close()
                else:
                    try:
                        self._sock.shutdown(socket.SHUT_RDWR)
                    except (OSError, socket.error) as e:
                        logging.debug(f"Socket shutdown note (expected if already closed): {e}")
                    self._sock.close()
                logging.info(f"Closed MPV IPC connection to {ipc_path}")
            except Exception as e:
                logging.debug(f"Error closing IPC socket: {e}")
            finally:
                self._sock = None
                self._ipc_path = None

        if self._event_reader_thread and self._event_reader_thread.is_alive():
            # Join with timeout to avoid hanging if readline is still blocking
            self._event_reader_thread.join(timeout=1.0)
            if self._event_reader_thread.is_alive():
                logging.debug("IPC event reader thread did not terminate gracefully (likely blocked on I/O).")
        self._event_reader_thread = None
        
        # Clear any buffered events that were not processed
        with self._buffer_lock:
            self._event_buffer.clear()

        # 3. Socket file cleanup on Unix
        if self._system != "Windows" and ipc_path:
            should_unlink = False
            if unlink_socket is True:
                should_unlink = True
            elif unlink_socket is None and os.path.exists(ipc_path):
                should_unlink = self._is_socket_stale(ipc_path)

            if should_unlink and os.path.exists(ipc_path):
                try:
                    os.unlink(ipc_path)
                    logging.info(f"Cleaned up stale IPC socket file: {ipc_path}")
                except OSError as e:
                    logging.debug(f"Failed to unlink IPC socket file {ipc_path}: {e}")

        # 4. Audit and clean any orphaned/stale sockets in /tmp/mpv_sockets, /dev/shm, etc.
        self.cleanup_stale_sockets()

def is_process_alive(pid, ipc_path):
    """
    Checks if an MPV process is responsive at the given IPC path.
    Uses a temporary IPCSocketManager to test connectivity.
    """
    if not pid or not ipc_path:
        return False
    
    # Optimization: Check if the PID is even running before trying the socket.
    # This avoids a 2-second timeout if the process is completely gone.
    if not is_pid_running(pid):
        return False

    # We use a temporary manager to test connectivity without starting a background reader.
    # This avoids spawning threads for a simple one-shot check.
    temp_manager = IPCSocketManager()
    if not temp_manager.connect(ipc_path, timeout=1.0, start_event_reader=False): 
        return False

    # If connected, send a command to verify the PID.
    actual_pid = temp_manager.get_property("pid", timeout=1.0)
    temp_manager.close() # Always close the temporary connection.

    if actual_pid == pid:
        return True
    elif actual_pid is not None:
        ipc_logger.debug(f"[PY][IPC] is_process_alive: PID mismatch. Expected {pid}, got {actual_pid}. (Socket is alive)")
    else:
        ipc_logger.debug("[PY][IPC] is_process_alive: Failed to get PID from MPV.")
            
    return False


IPC_DIR_LINUX = os.environ.get("XDG_RUNTIME_DIR")
if not IPC_DIR_LINUX:
    IPC_DIR_LINUX = os.path.join(os.path.expanduser("~"), ".mpv_playlist_organizer_ipc")
else:
    IPC_DIR_LINUX = os.path.join(IPC_DIR_LINUX, "mpv_playlist_organizer_ipc")

PIPE_NAME_WINDOWS = "mpv-playlist-organizer-ipc"

def get_ipc_path():
    """Generates a unique, platform-specific path for the mpv IPC socket/pipe."""
    # Use the process ID of the *current* python process
    # This ensures a unique path for each native_host instance.
    pid = os.getpid() 
    
    if platform.system() == "Windows":
        # Named pipes on Windows are global names.
        # Format: \\.\pipe\<PipeName>
        return f"\\\\.\\pipe\\{PIPE_NAME_WINDOWS}-{pid}"
    else: # Linux/macOS
        # Unix domain sockets are file-system based.
        os.makedirs(IPC_DIR_LINUX, exist_ok=True)
        try:
            os.chmod(IPC_DIR_LINUX, 0o700)
        except OSError as e:
            logging.debug(f"Could not chmod IPC dir {IPC_DIR_LINUX}: {e}")
        return os.path.join(IPC_DIR_LINUX, f"mpv-socket-{pid}")
