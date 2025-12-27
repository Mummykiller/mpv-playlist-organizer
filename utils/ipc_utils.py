import os
import json
import time
import platform
import logging
import socket
import collections

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

    def is_connected(self):
        return self._sock is not None

    def connect(self, ipc_path, timeout=5.0):
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
                else: # Linux/macOS
                    self._sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                    self._sock.connect(ipc_path)
                    self._sock_file = self._sock.makefile('rb')
                
                logging.info(f"Successfully connected to MPV IPC: {ipc_path}")
                return True
            except (FileNotFoundError, ConnectionRefusedError, OSError) as e:
                logging.debug(f"IPC connection failed (will retry): {e}")
                if self._sock: # Only close if a socket was actually opened
                    self.close() 
                time.sleep(0.1) # Short delay before next attempt
            except Exception as e:
                logging.error(f"Unexpected error during IPC connection attempt: {e}")
                self.close()
                return False
        
        logging.error(f"Failed to connect to MPV IPC at {ipc_path} after {timeout} seconds.")
        return False

    def send(self, command_dict, timeout=1.0, expect_response=True):
        """
        Sends a JSON command to the connected MPV IPC server.
        Returns the JSON response on success, or None on failure (e.g., disconnected).
        """
        if not self._sock:
            logging.warning(f"Attempted to send command '{command_dict.get('command')}' but IPC socket is not connected.")
            return None
        
        logging.info(f"IPC SEND: {json.dumps(command_dict)}")
        command_str = json.dumps(command_dict) + '\n'

        try:
            encoded = command_str.encode('utf-8')
            if self._system == "Windows":
                # For Windows named pipes, writing and flushing is the way to send.
                self._sock.write(encoded)
                self._sock.flush()
                if expect_response:
                    try:
                        while True:
                            response_line = self._sock.readline()
                            if not response_line:
                                self.close()
                                return None
                            response = json.loads(response_line.decode('utf-8').strip())
                            logging.info(f"IPC RECV: {json.dumps(response)}")
                            if "event" not in response:
                                return response
                            logging.debug(f"Received event '{response.get('event')}' while waiting for command response. Buffering.")
                            self._event_buffer.append(response)
                    except Exception as e:
                        logging.error(f"Error reading response on Windows: {e}")
                        self.close()
                        return None
                time.sleep(0.05) # Small delay to allow pipe to process
                return {"error": "success"}
            else: # Linux/macOS
                self._sock.settimeout(timeout)
                self._sock.sendall(encoded)

                if not expect_response:
                    return {"error": "success"} # Command sent, no response expected

                # Read response. MPV sends one line per response.
                # We need to use makefile for reliable line-by-line reading from a socket.
                start_read_time = time.time()
                # Use the send timeout for reading as well, or a specific read timeout
                while (time.time() - start_read_time) < timeout:
                    response_line = self._sock_file.readline()
                    if not response_line: # No data, might be a timeout or connection closed
                        logging.warning("IPC socket closed (EOF) while waiting for response.")
                        self.close()
                        break
                    try:
                        response = json.loads(response_line.decode('utf-8').strip())
                        logging.info(f"IPC RECV: {json.dumps(response)}")
                        if "event" not in response: # Found a command response
                            return response
                        # It's an event, log it and continue reading for a command response
                        logging.debug(f"Received event '{response.get('event')}' while waiting for command response. Buffering.")
                        self._event_buffer.append(response)
                    except json.JSONDecodeError:
                        logging.error(f"Failed to decode JSON response: {response_line.decode('utf-8', errors='ignore')}")
                        return None # Malformed JSON, give up on this response
                logging.warning(f"Timed out waiting for command response after {timeout} seconds, or connection closed.")
                return None # No valid command response received within timeout
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
        Listens for a single event from the MPV IPC server on the persistent socket.
        Returns the JSON event on success, or None on timeout/failure.
        """
        if self._event_buffer:
            return self._event_buffer.popleft()

        if not self._sock:
            # logging.warning("Attempted to receive event but IPC socket is not connected.")
            return None
        
        try:
            if self._system == "Windows":
                # Reading events from named pipes requires specific Windows API calls
                # or a separate reading thread, not directly supported by this simple 'open' approach.
                logging.warning("Event receiving for Windows named pipes not fully implemented in receive_event method.")
                return None
            else:
                self._sock.settimeout(timeout)
                response_line = self._sock_file.readline()
                if response_line:
                    event = json.loads(response_line.decode('utf-8').strip())
                    logging.info(f"IPC EVENT: {json.dumps(event)}")
                    return event
                else:
                    # EOF detected (socket closed by MPV)
                    self.close()
                    return None
        except socket.timeout:
            return None
        except (ConnectionResetError, BrokenPipeError) as e:
            logging.debug(f"IPC receive event error (connection likely lost): {e}")
            self.close()
            return None
        except Exception as e:
            logging.error(f"Unexpected error during IPC event reception: {e}")
            self.close()
            return None
        return None

    def close(self):
        """Closes the IPC socket handle and marks it as disconnected."""
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
    ipc_response = temp_manager.send({"command": ["get_property", "pid"]}, expect_response=True)
    temp_manager.close() # Always close the temporary connection.

    if ipc_response and ipc_response.get("error") == "success" and ipc_response.get("data") == pid:
        return True
            
    return False


def get_ipc_path():
    """Generates a unique, platform-specific path for the mpv IPC socket/pipe."""
    # Use the process ID of the *current* python process
    # This ensures a unique path for each native_host instance.
    pid = os.getpid() 
    
    # Use a more specific temporary directory to avoid conflicts
    temp_base_dir = os.path.join(os.path.expanduser("~"), ".mpv_playlist_organizer_ipc")
    os.makedirs(temp_base_dir, exist_ok=True)

    if platform.system() == "Windows":
        # Named pipes on Windows are global names.
        # Format: \\.\pipe\<PipeName>
        return f"\\\\.\\pipe\\mpv-playlist-organizer-ipc-{pid}"
    else: # Linux/macOS
        # Unix domain sockets are file-system based.
        return os.path.join(temp_base_dir, f"mpv-socket-{pid}")
