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
    
    is_alive = False
    if platform.system() == "Windows":
        # On Windows, we check both process existence and pipe availability.
        try:
            # Check if the process ID exists. This throws OSError if not.
            os.kill(pid, 0)
            time.sleep(0.05) # Small delay to allow OS to clean up pipes if process just died.
            # Try to connect to the named pipe. This will fail if MPV is hung or has closed the pipe.
            # We open and immediately close it.
            with open(ipc_path, 'w') as pipe:
                pass
            is_alive = True # Both checks passed.
        except (OSError, IOError):
            # Either the PID doesn't exist, we don't have permission, or the pipe is not available.
            is_alive = False
    else: # Linux/macOS
        try:
            # On Unix-like systems, we can reliably query the IPC socket.
            ipc_response = send_ipc_command(ipc_path, {"command": ["get_property", "pid"]}, timeout=0.5, expect_response=True)
            # We also verify that the PID from the socket matches our stored PID.
            if ipc_response and ipc_response.get("error") == "success" and ipc_response.get("data") == pid:
                is_alive = True
        except Exception:
            is_alive = False # Any exception means it's not running or responsive.
            
    return is_alive

def send_ipc_command(ipc_path, command_dict, timeout=2.0, expect_response=True):
    """
    Sends a JSON command to the mpv IPC server.
    On Linux/macOS, it can return a response.
    On Windows, this implementation can only send commands, not receive responses.
    """
    command_str = json.dumps(command_dict) + '\n'

    try:
        if platform.system() == "Windows":
            if expect_response:
                logging.warning("Receiving data from MPV on Windows is not supported by this script's simple IPC. Sync will fail.")
                return None # Signal failure to receive response.

            # Fire-and-forget for commands like 'loadfile' or 'quit'
            with open(ipc_path, 'w', encoding='utf-8') as pipe:
                pipe.write(command_str)
            return {"error": "success"} # Assume success

        else: # Linux/macOS
            encoded_command = command_str.encode('utf-8')
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
                sock.settimeout(timeout)
                sock.connect(ipc_path)
                sock.sendall(encoded_command)

                if not expect_response:
                    return {"error": "success"}

                # Read the response. A single JSON object terminated by a newline is expected.
                with sock.makefile('rb') as sock_file:
                    response_line = sock_file.readline()

                if not response_line:
                    logging.warning("No response from MPV IPC.")
                    return None

                return json.loads(response_line.decode('utf-8').strip())
    except (FileNotFoundError, ConnectionRefusedError):
        logging.error(f"IPC connection failed. Is MPV running? Path: {ipc_path}")
        raise RuntimeError("IPC connection failed.")
    except Exception as e:
        logging.error(f"An unexpected error occurred during IPC command: {e}")
        raise

def get_ipc_path():
    """Generates a unique, platform-specific path for the mpv IPC socket/pipe."""
    pid = os.getpid()
    temp_dir = os.path.join(os.path.expanduser("~"), ".mpv_playlist_organizer_ipc")
    os.makedirs(temp_dir, exist_ok=True)

    if platform.system() == "Windows":
        return f"\\\\.\\pipe\\mpv-ipc-{pid}"
    else:
        return os.path.join(temp_dir, f"mpv-socket-{pid}")