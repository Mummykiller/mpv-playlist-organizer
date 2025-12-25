import os
import json
import time
import platform
import logging
import socket

def is_process_alive(pid, ipc_path):
    """Checks if an MPV process is responsive at the given IPC path."""
    if not pid or not ipc_path:
        return False
    
    # On non-Windows platforms, we query the IPC socket.
    # A successful command that returns the correct PID confirms it's alive.
    if platform.system() != "Windows":
        try:
            ipc_response = send_ipc_command(ipc_path, {"command": ["get_property", "pid"]}, timeout=0.2, expect_response=True)
            if ipc_response and ipc_response.get("error") == "success" and ipc_response.get("data") == pid:
                return True
        except Exception:
            # Any exception during the check means it's not alive.
            return False
    else: # Windows
        # On Windows, we check both process existence and pipe availability.
        try:
            os.kill(pid, 0) # Throws OSError if PID doesn't exist.
            time.sleep(0.05)
            # Try to connect to the named pipe.
            with open(ipc_path, 'w'):
                pass
            return True # Both checks passed.
        except (OSError, IOError):
            return False
            
    return False

def send_ipc_command(ipc_path, command_dict, timeout=2.0, expect_response=True, listen_for_event=None):
    """
    Sends a JSON command to the mpv IPC server and optionally listens for a specific event.
    Returns None on connection failure.
    """
    command_str = json.dumps(command_dict) + '\n'

    try:
        if platform.system() == "Windows":
            if expect_response or listen_for_event:
                logging.warning("Receiving data/events from MPV on Windows is not supported.")
                return None
            
            with open(ipc_path, 'w', encoding='utf-8') as pipe:
                pipe.write(command_str)
            return {"error": "success"}

        else: # Linux/macOS
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
                sock.settimeout(timeout)
                sock.connect(ipc_path)
                sock.sendall(command_str.encode('utf-8'))

                if not expect_response and not listen_for_event:
                    return {"error": "success"}

                with sock.makefile('rb') as sock_file:
                    while True:
                        response_line = sock_file.readline()
                        if not response_line:
                            break
                        
                        response = json.loads(response_line.decode('utf-8').strip())
                        
                        if listen_for_event:
                            if response.get("event") == listen_for_event:
                                return response
                        elif expect_response:
                            if "event" not in response:
                                return response
                return None
                
    except (FileNotFoundError, ConnectionRefusedError, BrokenPipeError, socket.timeout) as e:
        # These exceptions are expected if MPV is not running or closes the connection.
        # We return None to indicate failure without logging a scary error.
        return None
    except Exception as e:
        logging.error(f"An unexpected error occurred during IPC command '{command_dict.get('command')}': {e}")
        return None

def receive_ipc_event(ipc_path, timeout=None):
    """
    Listens for a single event from the mpv IPC server.
    """
    if platform.system() == "Windows":
        logging.warning("Receiving events from MPV on Windows is not supported.")
        return None

    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(timeout)
            sock.connect(ipc_path)
            with sock.makefile('rb') as sock_file:
                response_line = sock_file.readline()
                if response_line:
                    return json.loads(response_line.decode('utf-8').strip())
    except socket.timeout:
        return None
    except (FileNotFoundError, ConnectionRefusedError):
        # This is expected if mpv is closed
        raise
    except Exception as e:
        logging.error(f"An unexpected error occurred while receiving IPC event: {e}")
        return None
    return None

def get_ipc_path():
    """Generates a unique, platform-specific path for the mpv IPC socket/pipe."""
    pid = os.getpid()
    temp_dir = os.path.join(os.path.expanduser("~"), ".mpv_playlist_organizer_ipc")
    os.makedirs(temp_dir, exist_ok=True)

    if platform.system() == "Windows":
        return f"\\\\.\\pipe\\mpv-ipc-{pid}"
    else:
        return os.path.join(temp_dir, f"mpv-socket-{pid}")