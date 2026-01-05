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
        self._buffer_lock = threading.Lock()
        self._event_reader_thread = None # Added for background reader thread
        self._event_reader_running = False # Flag to control reader thread
        self._request_id_counter = 0

    def is_connected(self):
        return self._sock is not None

    def connect(self, ipc_path, timeout=15.0):
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
        while self._event_reader_running:
            if not self._sock or not self._sock_file:
                time.sleep(0.1)
                continue

            try:
                if self._system != "Windows":
                    # Use select to check for data availability with a timeout on Unix
                    readable, _, _ = select.select([self._sock], [], [], 0.1)
                    if self._sock not in readable:
                        continue

                # On Windows, named pipes are blocking by default. readline() will block until data arrives.
                # This is why we use a separate thread.
                response_line = self._sock_file.readline()

                if response_line:
                    line_str = response_line.decode('utf-8').strip()
                    if not line_str: continue # Skip empty lines
                    
                    event = json.loads(line_str)
                    
                    # Filter out noisy thumbnail script events
                    if event.get("event") == "client-message":
                        args = event.get("args", [])
                        if args and isinstance(args[0], str) and args[0].startswith("mpv_thumbnail_script"):
                            continue

                    ipc_logger.info(f"IPC EVENT (Reader Thread): {json.dumps(event)}")
                    with self._buffer_lock:
                        self._event_buffer.append(event)
                else:
                    # EOF detected, connection closed by MPV or remote end
                    ipc_logger.info("IPC event reader detected EOF. Signaling connection closure.")
                    self._event_reader_running = False 
            except (ConnectionResetError, BrokenPipeError, OSError) as e:
                logging.debug(f"IPC event reader thread connection error: {e}. Stopping.")
                self._event_reader_running = False 
            except json.JSONDecodeError as e:
                logging.error(f"IPC event reader thread failed to decode JSON. Error: {e}")
            except Exception as e:
                logging.error(f"IPC event reader thread unexpected error: {e}. Stopping.")
                self._event_reader_running = False
        logging.debug("IPC event reader thread stopped.")


    def send(self, command_dict, timeout=1.0, expect_response=True):
        """
        Sends a JSON command to the connected MPV IPC server.
        Returns the JSON response on success, or None on failure (e.g., disconnected).
        """
        if not self._sock:
            logging.warning(f"Attempted to send command '{command_dict.get('command')}' but IPC socket is not connected.")
            return None
        
        # Assign a unique request_id to ensure we match the correct response
        if "request_id" not in command_dict:
            self._request_id_counter = (self._request_id_counter + 1) % 100000
            req_id = self._request_id_counter
            command_dict["request_id"] = req_id
        else:
            req_id = command_dict["request_id"]

        ipc_logger.info(f"IPC SEND: {json.dumps(command_dict)}")
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

            start_read_time = time.time()
            while (time.time() - start_read_time) < timeout:
                # Check internal buffer for a command response (matching request_id)
                with self._buffer_lock:
                    for i in range(len(self._event_buffer)):
                        item = self._event_buffer[i]
                        if item.get("request_id") == req_id or ("event" not in item and "request_id" not in item):
                            del self._event_buffer[i] 
                            response = item
                            ipc_logger.info(f"IPC RECV (from buffer): {json.dumps(response)}")
                            return response
                
                time.sleep(0.01) # Small sleep
            
            logging.warning(f"Timed out waiting for command response for id {req_id} after {timeout} seconds.")
            return None 
        except (BrokenPipeError, ConnectionResetError, socket.timeout, OSError) as e:
            logging.debug(f"IPC send error (connection likely lost): {e}")
            self.close() 
            return None
        except Exception as e:
            logging.error(f"Unexpected error during IPC send command: {e}")
            self.close()
            return None
        except (BrokenPipeError, ConnectionResetError, socket.timeout, OSError) as e:
            logging.debug(f"IPC send/receive error (connection likely lost): {e}")
            self.close() # Connection is broken, close it.
            return None
        except Exception as e:
            logging.error(f"Unexpected error during IPC send command '{command_dict.get('command')}': {e}")
            self.close()
            return None

    def receive_event(self, timeout=None):
        """
        Retrieves a single event from the internal buffer.
        Returns the JSON event on success, or None if buffer is empty within timeout.
        """
        # If the reader thread is not running and buffer is empty, it means no events are coming.
        if not self._event_reader_running and not self._event_buffer:
            if not self.is_connected(): # Check if main socket is also dead
                return None # Truly disconnected

        start_time = time.time()
        while True:
            with self._buffer_lock:
                if self._event_buffer:
                    event = self._event_buffer.popleft()
                    ipc_logger.info(f"IPC EVENT (from buffer): {json.dumps(event)}")
                    return event
            
            if timeout is not None and (time.time() - start_time) > timeout:
                return None # Timeout reached
            
            # Avoid busy-waiting, let other threads run
            time.sleep(0.01) # Small sleep
            
            # If reader thread stopped and buffer is empty, then no more events will arrive
            if not self._event_reader_running and not self._event_buffer:
                logging.debug("Event reader thread stopped and buffer empty. No more events expected.")
                return None

    def close(self):
        """Closes the IPC socket handle and marks it as disconnected."""
        # Stop the reader thread first if it's running
        if self._event_reader_running:
            self._event_reader_running = False
            if self._event_reader_thread and self._event_reader_thread.is_alive():
                self._event_reader_thread.join(timeout=1.0) # Give thread a moment to shut down
                if self._event_reader_thread.is_alive():
                    logging.warning("IPC event reader thread did not terminate gracefully.")
            self._event_reader_thread = None

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
                    self._sock.shutdown(socket.SHUT_RDWR)
                    self._sock.close()
                    # Do NOT delete the socket file here. 
                    # The socket file belongs to the MPV process and should only be deleted when MPV exits.
                logging.info(f"Closed MPV IPC connection to {self._ipc_path}")
            except Exception as e:
                logging.debug(f"Error closing IPC socket: {e}")
            finally:
                self._sock = None
                self._ipc_path = None
        
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
    
    # We use a temporary manager to test connectivity without interfering with an active session.
    temp_manager = IPCSocketManager()
    if not temp_manager.connect(ipc_path, timeout=2.0): # Increased timeout for a more robust check
        return False

    # If connected, send a command to verify the PID.
    ipc_response = temp_manager.send({"command": ["get_property", "pid"]}, expect_response=True, timeout=1.0) # Added timeout
    temp_manager.close() # Always close the temporary connection.

    if ipc_response and ipc_response.get("error") == "success" and ipc_response.get("data") == pid:
        return True
            
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
