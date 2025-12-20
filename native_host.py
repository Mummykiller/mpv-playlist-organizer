#!/usr/bin/env python3
import sys
import os
import traceback
from datetime import datetime

# --- Path Correction for CLI Usage ---
# This ensures that if the script is run from a different directory (e.g., via PATH),
# it can still find its own modules like 'file_io' and 'cli'.
SCRIPT_DIR_FOR_PATH = os.path.dirname(os.path.abspath(sys.argv[0]))
sys.path.insert(0, SCRIPT_DIR_FOR_PATH)
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'

# --- Standalone Function for Failsafe Path ---
# This is intentionally self-contained to avoid import errors if dependencies are missing.
def _get_failsafe_data_dir():
    """A simple, dependency-free function to get the user data directory path."""
    app_name = "MPVPlaylistOrganizer"
    system = sys.platform
    if system.startswith("win"):
        return os.path.join(os.environ.get('APPDATA', ''), app_name)
    elif system.startswith("darwin"):
        return os.path.join(os.path.expanduser('~/Library/Application Support'), app_name)
    else: # Linux and other Unix-like systems
        xdg_data_home = os.getenv('XDG_DATA_HOME')
        if xdg_data_home:
            return os.path.join(xdg_data_home, app_name)
        else:
            return os.path.join(os.path.expanduser('~/.local/share'), app_name)

# --- Failsafe Crash Handler ---
# This block is added to catch any startup errors and log them to a file.
FAILSAFE_LOG_PATH = None
try:
    data_dir_path = _get_failsafe_data_dir()
    os.makedirs(data_dir_path, exist_ok=True)
    FAILSAFE_LOG_PATH = os.path.join(data_dir_path, "native_host_crash.log")
except Exception:
    # If creating the data directory fails, fall back to the script's directory.
    FAILSAFE_LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(sys.argv[0])), "native_host_crash.log")
    # As a last resort, try to use the main log file name in the same fallback directory.
    LOG_FILE = os.path.join(os.path.dirname(os.path.abspath(sys.argv[0])), "native_host.log")

try:
    # --- Windows pythonw.exe Guard ---
    # If this script is started by the browser on Windows, it might be launched with
    # an executable that has no console (like pythonw.exe), which makes sys.stdin `None`.
    # This breaks native messaging. This guard detects that situation and re-launches
    # the script with the standard python.exe, which has the necessary I/O streams.
    # This check is skipped if CLI arguments are present, assuming it's an interactive session.
    if sys.platform == "win32" and sys.stdin is None and len(sys.argv) == 1:
        import subprocess
        # Re-launch with python.exe. CREATE_NO_WINDOW prevents a console from flashing.
        si = subprocess.STARTUPINFO()
        si.dwFlags = subprocess.STARTF_USESTDHANDLES
        creation_flags = subprocess.CREATE_NO_WINDOW
        # Use sys.executable to find the python.exe corresponding to the current pythonw.exe
        script_path = os.path.abspath(sys.argv[0])
        
        subprocess.Popen([sys.executable.replace("pythonw.exe", "python.exe"), script_path] + sys.argv[1:], creationflags=creation_flags, startupinfo=si)
        sys.exit(0)

    import json
    import struct
    import subprocess
    import atexit
    import logging
    import time
    import signal
    import threading
    import argparse
    import shutil
    import urllib.request
    import platform
    # socket is only used on non-windows platforms for IPC
    from mpv_session import MpvSessionManager
    import file_io
    import cli
    import services
    if platform.system() != "Windows":
        import socket


    # --- Function to get the appropriate user data directory ---
    def get_user_data_dir():
        """Returns a platform-specific, user-writable directory for app data."""
        return file_io.get_user_data_dir()

    # --- Configuration ---
    DATA_DIR = file_io.DATA_DIR
    LOG_FILE = os.path.join(DATA_DIR, "native_host.log")
    MAX_LOG_LINES = 200
    SESSION_FILE = os.path.join(DATA_DIR, "session.json")
    ANILIST_CACHE_FILE = os.path.join(DATA_DIR, "anilist_cache.json")

    class TrimmingFileHandler(logging.FileHandler):
        """
        A logging handler that keeps the log file trimmed to a maximum number of lines.
        When a new line is added, if the line count exceeds the max, the oldest
        line is removed from the top of the file.
        """
        def __init__(self, filename, max_lines=200, mode='a', encoding=None, delay=False):
            self._max_lines = max_lines
            super().__init__(filename, mode, encoding, delay)
            # Trim on initialization in case the file is already too long from a previous run
            self._trim()

        def emit(self, record):
            """Emit a record and then trim the log file if necessary."""
            super().emit(record)
            self._trim()

        def _trim(self):
            """Trims the log file to the specified maximum number of lines."""
            if not os.path.exists(self.baseFilename):
                return # Nothing to trim
            try:
                with open(self.baseFilename, 'r', encoding=self.encoding) as f:
                    lines = f.readlines()
                if len(lines) > self._max_lines:
                    with open(self.baseFilename, 'w', encoding=self.encoding) as f:
                        f.writelines(lines[-self._max_lines:])
            except Exception:
                # We can't log an error here as it would cause a recursion loop.
                # We'll just let the default handler error mechanism work.
                self.handleError(None)

    # Setup logging
    # Ensure the data directory exists before setting up the logger
    os.makedirs(DATA_DIR, exist_ok=True)
    root_logger = logging.getLogger()
    if root_logger.hasHandlers():
        root_logger.handlers.clear()
    root_logger.setLevel(logging.INFO)
    handler = TrimmingFileHandler(LOG_FILE, max_lines=MAX_LOG_LINES, encoding='utf-8')
    formatter = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')
    handler.setFormatter(formatter)
    root_logger.addHandler(handler)
    SCRIPT_DIR = file_io.SCRIPT_DIR
    SCRIPT_DIR = os.path.dirname(os.path.abspath(sys.argv[0]))

    def log_stream(stream, log_level, owner_folder_id):
        """Reads from a stream line by line and logs it."""
        # Keywords that suggest yt-dlp is outdated for YouTube.
        YTDLP_FAILURE_KEYWORDS = [
            "HTTP Error 410", # "HTTP Error 410: Gone" is a classic sign.
            "This video is unavailable",
            "unable to extract video data"
        ]
        ytdlp_failure_detected = False

        # The `for line in iter(...)` construct is a standard way to read
        # from a stream until it's closed.
        for line in iter(stream.readline, b''):
            decoded_line = line.decode('utf-8', errors='ignore').strip()
            # Filter out the noisy and irrelevant 'uname' warning on Windows.
            if "'uname' is not recognized" not in decoded_line:
                log_level(f"[MPV Process]: {decoded_line}")
                if not ytdlp_failure_detected and any(keyword in decoded_line for keyword in YTDLP_FAILURE_KEYWORDS):
                    ytdlp_failure_detected = True # Prevent multiple triggers
                    logging.warning("Detected a potential yt-dlp failure. Notifying extension.")
                    # Send a message to the extension to check if auto-update is enabled
                    send_message({
                        "action": "ytdlp_update_check", 
                        "folderId": owner_folder_id,
                        "log": {
                            "text": "[Native Host]: YouTube playback failed. This may be due to an outdated yt-dlp. Checking for auto-update...",
                            "type": "error"
                        }
                    })
        stream.close()

    def get_message():
        """Reads a message from stdin and decodes it."""
        raw_length = sys.stdin.buffer.read(4)
        if len(raw_length) == 0:
            sys.exit(0)
        message_length = struct.unpack('@I', raw_length)[0]
        message = sys.stdin.buffer.read(message_length).decode('utf-8')
        return json.loads(message)

    def send_message(message_content):
        """Encodes and sends a message to stdout."""
        encoded_content = json.dumps(message_content).encode('utf-8')
        message_length = struct.pack('@I', len(encoded_content))
        sys.stdout.buffer.write(message_length)
        sys.stdout.buffer.write(encoded_content)
        sys.stdout.buffer.flush()

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
                pipe = open(ipc_path, 'w')
                pipe.close()
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
        On Windows, this implementation can only send commands, not receive responses,
        due to the complexity of non-blocking named pipe I/O without extra libraries.
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

    # --- Global Instance ---
    # A single instance of the session manager to handle the MPV state.
    mpv_session = MpvSessionManager(session_file_path=SESSION_FILE, dependencies={
        'is_process_alive': is_process_alive,
        'send_ipc_command': send_ipc_command,
        'get_all_folders_from_file': file_io.get_all_folders_from_file,
        'get_mpv_executable': file_io.get_mpv_executable,
        'get_ipc_path': get_ipc_path,
        'log_stream': log_stream,
        'send_message': send_message,
        'SCRIPT_DIR': SCRIPT_DIR
    })


    def cleanup_ipc_socket():
        """Remove the IPC socket file on exit, if it exists (non-Windows)."""
        # Access the ipc_path from the global session manager instance
        if mpv_session.ipc_path and platform.system() != "Windows":
            ipc_dir = os.path.dirname(mpv_session.ipc_path)
            if os.path.exists(mpv_session.ipc_path):
                try:
                    os.remove(mpv_session.ipc_path)
                    logging.info(f"Cleaned up IPC socket: {mpv_session.ipc_path}")
                except OSError as e:
                    logging.warning(f"Error removing IPC socket file {mpv_session.ipc_path}: {e}")
            # Clean up the containing directory if it's empty
            if os.path.exists(ipc_dir) and not os.listdir(ipc_dir):
                try:
                    os.rmdir(ipc_dir)
                    logging.info(f"Cleaned up empty IPC directory: {ipc_dir}")
                except OSError as e:
                     logging.warning(f"Error removing IPC directory {ipc_dir}: {e}")

    def launch_unmanaged_mpv(playlist, geometry, custom_width, custom_height, custom_mpv_flags, automatic_mpv_flags):
        """Launches a new, unmanaged instance of MPV."""
        logging.info("Launching a new, unmanaged MPV instance.")
        mpv_exe = file_io.get_mpv_executable()
        # This instance will not have a persistent IPC server, so it's fire-and-forget.
        # We don't need to generate a unique IPC path.
        
        try:
            mpv_args = [mpv_exe]

            has_terminal_flag = False
            if automatic_mpv_flags:
                enabled_flags = []
                for flag_info in automatic_mpv_flags:
                    if flag_info.get('enabled'):
                        if flag_info.get('flag') == 'terminal':
                            has_terminal_flag = True
                        else:
                            if flag_info.get('flag'):
                                enabled_flags.append(flag_info.get('flag'))
                mpv_args.extend(enabled_flags)

            if custom_mpv_flags:
                import shlex
                try:
                    parsed_flags = shlex.split(custom_mpv_flags)
                    logging.info(f"Applying custom MPV flags for unmanaged instance: {parsed_flags}")
                    mpv_args.extend(parsed_flags)
                except Exception as e:
                    logging.error(f"Could not parse custom MPV flags '{custom_mpv_flags}'. Error: {e}")

            if custom_width and custom_height:
                logging.info(f"Applying custom geometry for unmanaged instance: {custom_width}x{custom_height}")
                mpv_args.append(f'--geometry={custom_width}x{custom_height}')
            elif geometry:
                logging.info(f"Applying geometry for unmanaged instance: {geometry}")
                mpv_args.append(f'--geometry={geometry}')

            mpv_args.extend(['--'] + playlist)

            popen_kwargs = {
                'stderr': subprocess.PIPE,
                'stdout': subprocess.DEVNULL,
                'universal_newlines': False
            }
            if platform.system() == "Windows":
                creation_flags = subprocess.CREATE_NEW_PROCESS_GROUP
                if not has_terminal_flag:
                    creation_flags |= subprocess.CREATE_NO_WINDOW
                popen_kwargs['creationflags'] = creation_flags
            else:
                # For non-windows, if terminal is requested, we add the --terminal flag
                if has_terminal_flag:
                    # Insert it early in the arg list
                    mpv_args.insert(1, '--terminal')

            # Re-assign the final command list to mpv_args before Popen
            process = subprocess.Popen(mpv_args, **popen_kwargs)
            
            stderr_thread = threading.Thread(target=log_stream, args=(process.stderr, logging.warning, None))
            stderr_thread.daemon = True
            stderr_thread.start()

            logging.info(f"Unmanaged MPV process launched (PID: {process.pid}) with {len(playlist)} items.")
            return {"success": True, "message": "New MPV instance launched."}
        except Exception as e:
            logging.error(f"An error occurred while trying to launch unmanaged mpv: {e}")
            return {"success": False, "error": f"Error launching new mpv instance: {e}"}

    def main():
        """Main message loop for native messaging from the browser."""
        logging.info("Native host started in messaging mode.")
        # On startup, try to restore a session. The result will be handled by the
        # background script, which might trigger cleanup for a stale session.
        restore_result = mpv_session.restore()
        if restore_result:
            send_message({"action": "session_restored", "result": restore_result})

        while True:
            try:
                message = get_message()  # This will block or sys.exit() on disconnect
                command = message.get('action')

                logging.info(f"Received message (ID: {message.get('request_id')}): {json.dumps(message)}")

                response = {}
                if command == 'play':
                    playlist = message.get('playlist', [])
                    folder_id = message.get('folderId')
                    geometry = message.get('geometry')
                    custom_width = message.get('custom_width')
                    custom_height = message.get('custom_height')
                    custom_mpv_flags = message.get('custom_mpv_flags')
                    automatic_mpv_flags = message.get('automatic_mpv_flags')
                    clear_on_completion = message.get('clear_on_completion', False)
                    start_paused = message.get('start_paused', False)
                    if not folder_id:
                        response = {"success": False, "error": "No folderId provided for play action."}
                    else:
                        response = mpv_session.start(playlist, folder_id, geometry=geometry, custom_width=custom_width, custom_height=custom_height, custom_mpv_flags=custom_mpv_flags, automatic_mpv_flags=automatic_mpv_flags, start_paused=start_paused, clear_on_completion=clear_on_completion)

                elif command == 'play_new_instance':
                    playlist = message.get('playlist', [])
                    geometry = message.get('geometry')
                    custom_width = message.get('custom_width')
                    custom_height = message.get('custom_height')
                    custom_mpv_flags = message.get('custom_mpv_flags')
                    automatic_mpv_flags = message.get('automatic_mpv_flags')
                    response = launch_unmanaged_mpv(playlist, geometry, custom_width, custom_height, custom_mpv_flags, automatic_mpv_flags)

                elif command == 'close_mpv':
                    response = mpv_session.close()

                elif command == 'is_mpv_running':
                    is_running = is_process_alive(mpv_session.pid, mpv_session.ipc_path)

                    # If the check fails, clear the stale state.
                    if not is_running and mpv_session.pid:
                        mpv_session.clear()

                    logging.info(f"MPV running status check: {is_running} (Path: {mpv_session.ipc_path})")
                    response = {"success": True, "is_running": is_running}
                elif command == 'export_data':
                    data_to_export = message.get('data')
                    if data_to_export is not None:
                        response = file_io.write_folders_file(data_to_export)
                    else:
                        response = {"success": False, "error": "No data provided for export."}
                
                elif command == 'export_playlists':
                    data_to_export = message.get('data')
                    custom_filename = message.get('filename')
                    if not data_to_export: response = {"success": False, "error": "No data provided for export."}
                    elif not custom_filename: response = {"success": False, "error": "No filename provided for export."}
                    else: response = file_io.write_export_file(custom_filename, data_to_export)

                elif command == 'export_all_playlists_separately':
                    folders_to_export = message.get('data')
                    if not folders_to_export: response = {"success": False, "error": "No folder data provided for export."}
                    else:
                        exported_count = 0
                        for folder_id, folder_data in folders_to_export.items():
                            playlist = folder_data.get('playlist')
                            if playlist is None:
                                logging.warning(f"Skipping folder '{folder_id}' during batch export: 'playlist' key not found.")
                                continue

                            # Sanitize folder_id to create a safe filename
                            safe_filename_base = "".join(c if c.isalnum() or c in ('-', '_') else '_' for c in folder_id).rstrip()
                            result = file_io.write_export_file(safe_filename_base, playlist)
                            if result["success"]:
                                exported_count += 1
                        
                        logging.info(f"Batch exported {exported_count} playlists.")
                        response = {"success": True, "message": f"Successfully exported {exported_count} playlists to separate files."}

                elif command == 'list_import_files':
                    response = file_io.list_import_files()

                elif command == 'import_from_file':
                    filename = message.get('filename')
                    if filename:
                        try:
                            filepath = os.path.abspath(os.path.join(file_io.EXPORT_DIR, filename))
                            if not filepath.startswith(os.path.abspath(file_io.EXPORT_DIR)):
                                logging.error(f"Security violation: Attempted to access file outside of export directory: {filepath}")
                                response = {"success": False, "error": "Access denied."}
                            else:
                                with open(filepath, 'r', encoding='utf-8') as f:
                                    content = f.read()
                                response = {"success": True, "data": content}
                        except Exception as e:
                            response = {"success": False, "error": f"Failed to read import file: {e}"}

                elif command == 'open_export_folder':
                    try:
                        os.makedirs(file_io.EXPORT_DIR, exist_ok=True)
                        abs_path = os.path.abspath(file_io.EXPORT_DIR)

                        system = platform.system()
                        if system == "Windows":
                            # os.startfile() can be unreliable when called from a non-interactive
                            # context like a native messaging host. Using subprocess.Popen to
                            # call explorer.exe directly is more robust. os.path.normpath
                            # ensures the path uses the correct backslashes for Windows.
                            subprocess.Popen(['explorer', os.path.normpath(abs_path)])
                        elif system == "Darwin":  # macOS
                            subprocess.run(['open', abs_path], check=True)
                        else:  # Linux and other Unix-like systems
                            subprocess.run(['xdg-open', abs_path], check=True)

                        logging.info(f"Successfully issued command to open export folder at: {abs_path}")
                        response = {"success": True, "message": "Opening export folder."}
                    except FileNotFoundError:
                        error_msg = "Could not open file explorer. Command not found (e.g., 'xdg-open' on Linux)."
                        logging.error(error_msg)
                        response = {"success": False, "error": error_msg}
                    except Exception as e:
                        error_msg = f"An unexpected error occurred while opening the folder: {e}"
                        logging.error(error_msg)
                        response = {"success": False, "error": error_msg}

                elif command == 'get_anilist_releases':
                    force_refresh = message.get('force', False)
                    delete_cache = message.get('delete_cache', False)
                    is_cache_disabled = message.get('is_cache_disabled', False)
                    response = services.get_anilist_releases_with_cache(
                        force_refresh, delete_cache, is_cache_disabled, ANILIST_CACHE_FILE, SCRIPT_DIR, send_message
                    )

                elif command == 'run_ytdlp_update':
                    response = services.update_ytdlp(send_message)

                elif command == 'check_dependencies':
                    response = services.check_mpv_and_ytdlp_status(file_io.get_mpv_executable, send_message)

                elif command == 'get_default_automatic_flags':
                    default_flags = [
                        {
                            "flag": "--pause",
                            "description": "Start MPV paused. This is overridden if 'start_paused' is explicitly requested.",
                            "enabled": False
                        },
                        {
                            "flag": "terminal", # Use a special keyword instead of the raw flag
                            "description": "Show a terminal window for MPV (useful for debugging).",
                            "enabled": False
                        }
                    ]
                    response = {"success": True, "flags": default_flags}

                else:
                    response = {"success": False, "error": "Unknown command"}

                # Add the request_id to the response so the extension can match it
                request_id = message.get('request_id')
                if request_id:
                    response['request_id'] = request_id
                send_message(response)

            except Exception as e:
                logging.error(f"Error in main loop: {e}", exc_info=True)
                try:
                    error_response = {"success": False, "error": f"An unexpected error occurred in the native host: {str(e)}"}
                    # Check if 'message' was successfully assigned before the error
                    if 'message' in locals() and isinstance(message, dict) and message.get('request_id'):
                        error_response['request_id'] = message.get('request_id')
                    send_message(error_response)
                except Exception as send_e:
                    logging.error(f"Could not send error message back to extension: {send_e}")

    # Register a cleanup function to run when the script exits.
    atexit.register(cleanup_ipc_socket)

    if __name__ == '__main__':
        # handle_cli() will parse arguments and execute the command if it's a CLI call.
        # It returns True if it was a CLI call, and False otherwise.
        try:
            # Inject dependencies into the CLI module before handling any commands.
            cli.inject_dependencies({
                'file_io': file_io,
                'mpv_session': mpv_session
            })
            if not cli.handle_cli():
                # If it wasn't a CLI call, start the main message loop for the browser.
                main()
        except SystemExit:
            # Argparse calls sys.exit() on --help or on input errors. This is normal.
            pass
        except Exception as cli_error:
            # Catch any other unexpected errors during CLI execution.
            logging.error(f"An unexpected CLI error occurred: {cli_error}", exc_info=True)
            print(f"Error: {cli_error}", file=sys.stderr)
            sys.exit(1)

except Exception as e:
    # This is the failsafe block that catches any error during script initialization or execution.
    # Use the main LOG_FILE path if it was defined, otherwise use the crash-specific path.
    log_path_to_use = 'LOG_FILE' in locals() and LOG_FILE or FAILSAFE_LOG_PATH
    if log_path_to_use:
        try:
            with open(log_path_to_use, "a", encoding="utf-8") as f:
                f.write(f"---\n--- Native Host Crashed ---\n")
                f.write(f"Timestamp: {datetime.now().isoformat()}\n")
                f.write(f"Error: {str(e)}\n\n")
                f.write(traceback.format_exc())
                f.write("\n---------------------------\n\n")
        except Exception:
            # If even the failsafe logger fails, there's nothing more we can do.
            pass
    # It's critical to re-raise the exception so the process still exits with an error,
    # which is the behavior the user is observing.
    raise