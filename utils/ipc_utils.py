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
    if pid is None: return False
    try:
        pid = int(pid)
    except (ValueError, TypeError):
        return False
    if pid <= 0: return False
    system = platform.system()
    
    if system == "Windows":
        import ctypes
        # PROCESS_QUERY_LIMITED_INFORMATION is sufficient for existence check and works across users
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        kernel32 = ctypes.windll.kernel32
        h_process = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
        if h_process:
            kernel32.CloseHandle(h_process)
            return True
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
        except (OSError, ImportError):
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
                if self._sock: # Only close if a socket was actually opened
                    self.close() 
                time.sleep(0.2) # Small delay before next attempt
            except Exception as e:
                logging.error(f"Unexpected error during IPC connection attempt (will retry): {e}")
                if self._sock:
                    self.close()
                time.sleep(0.2)
        
        logging.error(f"Failed to connect to MPV IPC at {ipc_path} after {timeout} seconds.")
        return False

    def _event_reader_loop(self):
        """
        Continuously reads events from the IPC socket and appends them to the internal buffer.
        Runs in a separate thread to prevent mpv's output buffer from filling up.
        """
        while True:
            # 1. Thread-safe state check and handle capture
            with self._buffer_lock:
                if not self._event_reader_running:
                    break
                
                # Capture handle to local variable to avoid NoneType race condition
                reader_handle = self._sock_file
                if not reader_handle:
                    self._buffer_lock.wait(0.1)
                    continue

            try:
                if self._system != "Windows" and self._sock:
                    # Use select to check for data availability with a timeout on Unix
                    readable, _, _ = select.select([self._sock], [], [], 0.1)
                    if self._sock not in readable:
                        continue

                # 2. Use the LOCAL handle reference
                response_line = reader_handle.readline()

                if response_line:
                    line_str = response_line.decode('utf-8').strip()
                    if not line_str: continue # Skip empty lines
                    
                    try:
                        event = json.loads(line_str)
                    except json.JSONDecodeError:
                        continue
                    
                    # Check for script handlers
                    handled = False
                    if event.get("event") == "client-message":
                        args = event.get("args", [])
                        if args and len(args) > 0 and isinstance(args[0], str):
                            msg_name = args[0]
                            
                            # Filter out noisy thumbnail script events
                            if msg_name.startswith("mpv_thumbnail_script"):
                                continue

                            if msg_name in self._script_handlers:
                                try:
                                    # We invoke the handler directly. Handlers must be non-blocking!
                                    self._script_handlers[msg_name](args[1:])
                                    handled = True
                                except Exception as e:
                                    logging.error(f"Error in script handler for {msg_name}: {e}")

                    if not handled:
                        ipc_logger.info(f"IPC EVENT (Reader Thread): {json.dumps(event)}")
                        with self._buffer_lock:
                            self._event_buffer.append(event)
                            self._buffer_lock.notify_all() # Notify waiters that new data arrived
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

            logging.info(f"[PY][IPC] SEND: {json.dumps(command_dict)}")
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
                    while time.time() - start_wait < timeout:
                        try:
                            # Direct read from file handle
                            line = self._sock_file.readline()
                            if not line: break
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
                            if item.get("request_id") == req_id or ("event" not in item and "request_id" not in item):
                                del self._event_buffer[i] 
                                response = item
                                ipc_logger.info(f"IPC RECV (from buffer): {json.dumps(response)}")
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
                    ipc_logger.info(f"IPC EVENT (from buffer): {json.dumps(event)}")
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


    def close(self):
        """Closes the IPC socket handle and marks it as disconnected."""
        # 1. Stop the reader thread first if it's running
        with self._buffer_lock:
            if self._event_reader_running:
                self._event_reader_running = False
                self._buffer_lock.notify_all()

        # 2. Close handles to break any blocking readline() calls
        if self._sock:
            if self._sock_file:
                try:
                    self._sock_file.close()
                except Exception: pass
                self._sock_file = None
            try:
                if self._system == "Windows":
                    self._sock.close()
                else:
                    try: self._sock.shutdown(socket.AF_UNIX)
                    except: pass
                    self._sock.close()
                logging.info(f"Closed MPV IPC connection to {self._ipc_path}")
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

def is_process_alive(pid, ipc_path):
    """
    Checks if an MPV process is responsive at the given IPC path.
    Uses a temporary IPCSocketManager to test connectivity.
    """
    if not pid or not ipc_path:
        return False
    
    # We use a temporary manager to test connectivity without starting a background reader.
    # This avoids spawning threads for a simple one-shot check.
    temp_manager = IPCSocketManager()
    if not temp_manager.connect(ipc_path, timeout=2.0, start_event_reader=False): 
        return False

    # If connected, send a command to verify the PID.
    ipc_response = temp_manager.send({"command": ["get_property", "pid"]}, expect_response=True, timeout=1.0)
    temp_manager.close() # Always close the temporary connection.

    if ipc_response and ipc_response.get("error") == "success":
        actual_pid = ipc_response.get("data")
        if actual_pid == pid:
            return True
        else:
            logging.warning(f"[PY][IPC] is_process_alive: PID mismatch. Expected {pid}, got {actual_pid}. (Socket is alive)")
    else:
        logging.warning(f"[PY][IPC] is_process_alive: Failed to get PID from MPV. Response: {ipc_response}")
            
    return False


IPC_DIR_LINUX = os.path.join(os.path.expanduser("~"), ".mpv_playlist_organizer_ipc")
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
        return os.path.join(IPC_DIR_LINUX, f"mpv-socket-{pid}")
