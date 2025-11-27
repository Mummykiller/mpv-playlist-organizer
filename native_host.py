#!/usr/bin/env python3
import sys
import os
import traceback
from datetime import datetime

# --- Failsafe Crash Handler ---
# This block is added to catch any startup errors and log them to a file.
FAILSAFE_LOG_PATH = None
try:
    # This logic is duplicated from get_user_data_dir to be completely standalone.
    app_name = "MPVPlaylistOrganizer"
    system = sys.platform
    if system.startswith("win"):
        data_dir_path = os.path.join(os.environ['APPDATA'], app_name)
    elif system.startswith("darwin"):
        data_dir_path = os.path.join(os.path.expanduser('~/Library/Application Support'), app_name)
    else:
        xdg_data_home = os.getenv('XDG_DATA_HOME')
        if xdg_data_home:
            data_dir_path = os.path.join(xdg_data_home, app_name)
        else:
            data_dir_path = os.path.join(os.path.expanduser('~/.local/share'), app_name)
    
    os.makedirs(data_dir_path, exist_ok=True)
    FAILSAFE_LOG_PATH = os.path.join(data_dir_path, "native_host_crash.log")
except Exception:
    # If creating the data directory fails, fall back to the script's directory.
    FAILSAFE_LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(sys.argv[0])), "native_host_crash.log")

try:
    # --- Windows pythonw.exe Guard ---
    # If this script is started with pythonw.exe, sys.stdin will be None,
    # which breaks native messaging. This guard detects that case and re-launches
    # the script using the standard python.exe interpreter.
    if sys.platform == "win32" and sys.executable.endswith("pythonw.exe"):
        import subprocess
        # Re-launch with python.exe in a new console window for debugging.
        # The DETACHED_PROCESS flag is removed, and CREATE_NEW_CONSOLE is added.
        si = subprocess.STARTUPINFO()
        si.dwFlags = subprocess.STARTF_USESHOWWINDOW
        si.wShowWindow = subprocess.SW_SHOW
        # Use sys.argv[0] which is more reliable than __file__ in some contexts
        script_path = os.path.abspath(sys.argv[0])
        
        subprocess.Popen([sys.executable.replace("pythonw.exe", "python.exe"), script_path] + sys.argv[1:], creationflags=subprocess.CREATE_NEW_CONSOLE)
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
    if platform.system() != "Windows":
        import socket


    # --- Function to get the appropriate user data directory ---
    def get_user_data_dir():
        """Returns a platform-specific, user-writable directory for app data."""
        app_name = "MPVPlaylistOrganizer"
        system = platform.system()
        if system == "Windows":
            # %APPDATA%\MPVPlaylistOrganizer
            return os.path.join(os.environ['APPDATA'], app_name)
        elif system == "Darwin": # macOS
            # ~/Library/Application Support/MPVPlaylistOrganizer
            return os.path.join(os.path.expanduser('~/Library/Application Support'), app_name)
        else: # Linux and other Unix-like systems
            # ~/.local/share/MPVPlaylistOrganizer
            return os.path.join(os.path.expanduser('~/.local/share'), app_name)

    # --- Configuration ---
    # Determine the script's directory. sys.argv[0] is more reliable than __file__
    # when the script is executed in different ways (e.g., via a batch file).
    SCRIPT_DIR = os.path.dirname(os.path.abspath(sys.argv[0]))

    DATA_DIR = get_user_data_dir() # Use user-specific data directory
    LOG_FILE = os.path.join(DATA_DIR, "native_host.log")
    MAX_LOG_LINES = 200
    FOLDERS_FILE = os.path.join(DATA_DIR, "folders.json")
    SESSION_FILE = os.path.join(DATA_DIR, "session.json")
    EXPORT_DIR = os.path.join(DATA_DIR, "exported")
    ANILIST_CACHE_FILE = os.path.join(DATA_DIR, "anilist_cache.json")
    CONFIG_FILE = os.path.join(DATA_DIR, "config.json") # For Windows mpv_path

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

    def _write_export_file(filename, data):
        """Helper to write data to a file in the export directory."""
        try:
            os.makedirs(EXPORT_DIR, exist_ok=True)

            # Sanitize filename to prevent path traversal (e.g., '../malicious.txt').
            # os.path.basename strips any directory parts.
            safe_basename = os.path.basename(filename)

            # Ensure the filename ends with .json
            if not safe_basename.lower().endswith('.json'):
                final_filename = f"{safe_basename}.json"
            else:
                final_filename = safe_basename

            filepath = os.path.join(EXPORT_DIR, final_filename)

            with open(filepath, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=4)

            logging.info(f"Data exported to {filepath}")
            return {"success": True, "message": f"Data exported to '{final_filename}' in the 'exported' folder."}
        except Exception as e:
            error_msg = f"Failed to export data: {e}"
            logging.error(error_msg)
            return {"success": False, "error": error_msg}

    def _get_ytdlp_version(path_to_exe):
        """Runs 'yt-dlp --version' and returns the output."""
        try:
            # Use a short timeout to prevent hanging if yt-dlp is unresponsive.
            result = subprocess.run(
                [path_to_exe, '--version'],
                capture_output=True,
                text=True,
                check=True,
                timeout=10,
                encoding='utf-8',
                errors='ignore'
            )
            return result.stdout.strip()
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError) as e:
            error_msg = f"Could not get yt-dlp version: {e}"
            logging.error(error_msg)
            send_message({"log": {"text": f"[yt-dlp]: {error_msg}", "type": "error"}})
            return None

    def update_ytdlp():
        """
        Downloads the latest yt-dlp binary and replaces the existing one.
        """
        send_message({"log": {"text": "[yt-dlp]: Starting manual update process...", "type": "info"}})
        try:
            system = platform.system()
            if system == "Windows":
                exe_name = "yt-dlp.exe"
            elif system == "Linux":
                exe_name = "yt-dlp"
            elif system == "Darwin": # macOS
                exe_name = "yt-dlp"
            else:
                return {"success": False, "error": f"Unsupported OS for update: {system}"}

            send_message({"log": {"text": f"[Native Host]: Searching for '{exe_name}' in PATH...", "type": "info"}})
            current_path = shutil.which(exe_name)
            if not current_path:
                error_msg = f"'{exe_name}' not found in your system's PATH. Cannot update."
                send_message({"log": {"text": f"[yt-dlp]: {error_msg}", "type": "error"}})
                return {"success": False, "error": error_msg}

            send_message({"log": {"text": f"[yt-dlp]: Found at '{current_path}'.", "type": "info"}})

            # Get version before update
            version_before = _get_ytdlp_version(current_path)
            if version_before:
                send_message({"log": {"text": f"[yt-dlp]: Current version: {version_before}", "type": "info"}})
            send_message({"log": {"text": "[yt-dlp]: Preparing update command...", "type": "info"}})

            # Use the built-in updater `yt-dlp -U`. This is more robust than manual replacement.
            command = [current_path, '-U']
            popen_kwargs = {
                'stdout': subprocess.PIPE,
                'stderr': subprocess.STDOUT, # Redirect stderr to stdout
                'universal_newlines': True,
                'encoding': 'utf-8',
                'errors': 'ignore'
            }
            if system == "Windows":
                popen_kwargs['creationflags'] = subprocess.CREATE_NO_WINDOW

            # On Linux, updating yt-dlp in a system directory (e.g., /usr/local/bin) requires sudo.
            # We use a graphical sudo tool to ask for the user's password.
            if system == "Linux" and not os.access(current_path, os.W_OK):
                send_message({"log": {"text": "[yt-dlp]: Write access denied. Attempting to run with administrator privileges...", "type": "info"}})
                
                # Find a graphical sudo tool
                if shutil.which("pkexec"):
                    command = ["pkexec"] + command
                elif shutil.which("gksu"):
                    command = ["gksu"] + command
                elif shutil.which("kdesu"):
                    command = ["kdesu"] + command
                else:
                    error_msg = "No graphical sudo tool (pkexec, gksu, kdesu) found. Please run 'yt-dlp -U' manually in a terminal with sudo."
                    send_message({"log": {"text": f"[yt-dlp]: {error_msg}", "type": "error"}})
                    return {"success": False, "error": error_msg}
                
                send_message({"log": {"text": "[yt-dlp]: Please enter your password in the dialog to update yt-dlp.", "type": "info"}})

            send_message({"log": {"text": f"[yt-dlp]: Executing: {' '.join(command)}", "type": "info"}})
            process = subprocess.Popen(command, **popen_kwargs)

            # Stream the output line by line to the extension log
            for line in iter(process.stdout.readline, ''):
                send_message({"log": {"text": f"[yt-dlp]: {line.strip()}", "type": "info"}})
            
            process.stdout.close()
            return_code = process.wait()

            if return_code != 0:
                # Check for specific error codes or conditions
                if return_code == 126 or return_code == 127: # pkexec authentication cancelled by user
                    error_msg = f"Update cancelled. You may have closed the password dialog. (code: {return_code})"
                else:
                    error_msg = f"yt-dlp update process failed with exit code {return_code}. You may need to run it with administrator privileges."
                
                send_message({"log": {"text": f"[yt-dlp]: {error_msg}", "type": "error"}})
                return {"success": False, "error": error_msg}
            
            # If update command succeeded, verify by checking version again
            send_message({"log": {"text": "[yt-dlp]: Update command finished. Verifying new version...", "type": "info"}})
            version_after = _get_ytdlp_version(current_path)
            if not version_after:
                return {"success": False, "error": "Could not verify yt-dlp version after update."}

            send_message({"log": {"text": f"[yt-dlp]: New version: {version_after}", "type": "info"}})

            if version_after != version_before:
                success_msg = f"Successfully updated yt-dlp from {version_before} to {version_after}."
                send_message({"log": {"text": f"[yt-dlp]: {success_msg}", "type": "info"}})
                return {"success": True, "message": success_msg}
            else:
                # This can happen if yt-dlp was already up to date.
                success_msg = f"yt-dlp is already at the latest version ({version_after})."
                send_message({"log": {"text": f"[yt-dlp]: {success_msg}", "type": "info"}})
                return {"success": True, "message": success_msg}

        except Exception as e:
            error_msg = f"An unexpected error occurred during yt-dlp update: {e}"
            send_message({"log": {"text": f"[yt-dlp]: {error_msg}", "type": "error"}})
            return {"success": False, "error": error_msg}

    def get_anilist_releases_with_cache(force_refresh, delete_cache, is_cache_disabled):
        """
        Handles fetching AniList releases with a file-based caching mechanism.
        The native host is now the single source of truth for the cache.
        """
        CACHE_DURATION_S = 30 * 60  # 30 minutes
        now = time.time()

        # If the user has disabled caching entirely, bypass all cache logic.
        # Fetch directly from the API and do not write to the cache file.
        if is_cache_disabled:
            logging.info("AniList cache is disabled by user setting. Fetching directly from API.")
            send_message({"log": {"text": "[AniList]: Cache disabled. Fetching new data from API.", "type": "info"}})
            # The delete_cache flag is handled separately below, but we go straight to fetching.
            return _fetch_from_anilist_script(is_ping=False, is_cache_disabled=True)

        # If the user has 'disable cache' checked, the extension will tell us to delete it.
        if delete_cache and os.path.exists(ANILIST_CACHE_FILE):
            try:
                os.remove(ANILIST_CACHE_FILE)
                logging.info("Deleted anilist_cache.json as requested by user setting.")
                send_message({"log": {"text": "[AniList]: Cache file deleted due to 'Disable Cache' setting.", "type": "info"}})
            except OSError as e:
                logging.error(f"Failed to delete anilist_cache.json: {e}")
                send_message({"log": {"text": f"[AniList]: Failed to delete cache file: {e}", "type": "error"}})

        # If the user forces a refresh, skip all cache checks.
        if force_refresh:
            logging.info("Forcing a full refresh of AniList data as requested by user.")
            send_message({"log": {"text": "[AniList]: Manual refresh requested. Fetching new data from API.", "type": "info"}})
            return _fetch_from_anilist_script(is_ping=False, is_cache_disabled=is_cache_disabled)

        # --- Step 1: Read from cache file ---
        cache = None
        if os.path.exists(ANILIST_CACHE_FILE):
            try:
                with open(ANILIST_CACHE_FILE, 'r', encoding='utf-8') as f:
                    cache = json.load(f)
            except (json.JSONDecodeError, IOError) as e:
                error_msg = f"Could not read or parse anilist_cache.json: {e}. Will perform a full fetch."
                logging.warning(error_msg)
                send_message({"log": {"text": f"[Native Host]: {error_msg}", "type": "error"}})
                cache = None

        # --- Step 2: Check if cache is fresh ---
        if cache and 'timestamp' in cache and 'data' in cache:
            is_expired_by_timer = (now - cache['timestamp'] > CACHE_DURATION_S)

            # New check: Invalidate cache if the day has changed since the last cache write.
            # This handles the edge case where the last release of a day has passed,
            # `next_airing_at` is null, and we enter a new day.
            is_new_day = False
            if 'timestamp' in cache:
                from datetime import datetime
                cache_date = datetime.fromtimestamp(cache['timestamp']).date()
                is_new_day = datetime.fromtimestamp(now).date() != cache_date
            
            next_airing_at = cache['data'].get('next_airing_at')
            is_expired_by_release = False
            if next_airing_at and now > next_airing_at:
                is_expired_by_release = True
                logging.info("AniList cache is stale because a new episode has aired.")
                send_message({"log": {"text": "[AniList]: A new episode has aired. Refreshing data...", "type": "info"}})

            if is_new_day:
                logging.info("AniList cache is from a previous day. Forcing refresh.")
                send_message({"log": {"text": "[AniList]: New day detected. Refreshing data...", "type": "info"}})


            # If not expired by either condition, serve from cache.
            if not is_expired_by_timer and not is_expired_by_release and not is_new_day:
                logging.info("Serving AniList data from fresh local file cache.")
                send_message({"log": {"text": "[AniList]: Loaded from local file (cache is fresh).", "type": "info"}})
                return {"success": True, "output": json.dumps(cache['data'])}


        # --- Step 3: Cache is stale. Perform a lightweight "ping" to check for changes before a full fetch. ---
        if cache and 'data' in cache and 'total' in cache['data']:
            logging.info("AniList file cache is stale. Pinging API for release timestamps...")
            send_message({"log": {"text": "[AniList]: Cache is stale. Pinging for changes...", "type": "info"}})
            
            # is_ping=True now makes a request for the list of 'airingAt' timestamps.
            ping_response = _fetch_from_anilist_script(is_ping=True, is_cache_disabled=is_cache_disabled)
            
            if ping_response['success']:
                try:
                    ping_data = json.loads(ping_response['output'])
                    ping_airing_ats = ping_data.get('airingAt_list', [])
                    
                    # Get the pre-sorted list of timestamps from the cache.
                    cached_airing_ats = cache.get('sorted_airing_ats', [])

                    # If the list of timestamps from the ping matches our cached list, we assume no changes.
                    if sorted(ping_airing_ats) == cached_airing_ats:
                        logging.info("No change in release timestamps detected via ping. Serving from local file and updating timestamp.")
                        send_message({"log": {"text": "[AniList]: Loaded from local file (no new releases found).", "type": "info"}})
                        
                        # Update the timestamp of the existing cache to make it fresh again.
                        cache['timestamp'] = now
                        with open(ANILIST_CACHE_FILE, 'w', encoding='utf-8') as f:
                            json.dump(cache, f, indent=4)
                        
                        # Serve the old data, since it's still valid. This avoids a full fetch.
                        return {"success": True, "output": json.dumps(cache['data'])}
                except (json.JSONDecodeError, KeyError) as e:
                    logging.warning(f"Failed to process ping response: {e}. Proceeding with full fetch.")
            elif not ping_response['success']:
                # If the ping itself fails, we should also proceed to a full fetch as a fallback.
                logging.warning(f"AniList ping failed. Proceeding with full fetch.")

        # --- Step 4: Perform a full fetch ---
        logging.info("Performing a full fetch of AniList data.")
        send_message({"log": {"text": "[AniList]: Fetching new data from AniList API...", "type": "info"}})
        # We need to store the raw schedules to be able to compare airingAt timestamps later.
        full_fetch_response = _fetch_from_anilist_script(is_ping=False, is_cache_disabled=is_cache_disabled)
        if full_fetch_response['success']:
            # Only write to the cache if it's not disabled.
            if not is_cache_disabled:
                try:
                    full_data = json.loads(full_fetch_response['output'])
                    # Pre-sort and store the list of timestamps for efficient future comparisons.
                    # The full_data from anilist_releases.py contains the 'releases' list, and each release has an 'airingAt_utc' timestamp.
                    # We need to extract these timestamps for the ping comparison.
                    # The anilist_releases.py script was already providing the full schedule, so we just need to process it.
                    # The `full_data` object contains a `raw_schedules_for_cache` key with the raw data.
                    sorted_ats = sorted([s['airingAt'] for s in full_data.get('raw_schedules_for_cache', [])])

                    new_cache = {"timestamp": now, "data": full_data, "sorted_airing_ats": sorted_ats}
                    with open(ANILIST_CACHE_FILE, 'w', encoding='utf-8') as f:
                        json.dump(new_cache, f, indent=4)
                    logging.info("AniList file cache updated with new data.")
                except (json.JSONDecodeError, IOError) as e:
                    logging.error(f"Failed to write new AniList cache file: {e}")

        return full_fetch_response # Return the result of the fetch

    def _fetch_from_anilist_script(is_ping, is_cache_disabled=False):
        """Helper function to execute the anilist_releases.py script."""
        try:
            # Use sys.executable to ensure we're using the same Python interpreter that's running the host
            script_path = os.path.join(os.path.dirname(os.path.abspath(sys.argv[0])), 'anilist_releases.py')
            script_args = [sys.executable, script_path]
            if is_ping:
                script_args.append('--ping')
            result = subprocess.run(script_args, capture_output=True, text=True, check=True, encoding='utf-8')
            return {"success": True, "output": result.stdout}
        except subprocess.CalledProcessError as e:
            # Log the actual error from the script for better debugging
            logging.error(f"Error running anilist_releases.py: {e.stderr}")
            send_message({"log": {"text": f"[AniList]: Script failed: {e.stderr}", "type": "error"}})
            return {"success": False, "error": f"Error fetching AniList releases: {e.stderr}"}
        except FileNotFoundError:
            error_msg = "anilist_releases.py not found in the script directory."
            logging.error(error_msg)
            send_message({"log": {"text": f"[AniList]: {error_msg}", "type": "error"}})
            return {"success": False, "error": error_msg}


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

    def get_ipc_path():
        """Generates a unique, platform-specific path for the mpv IPC socket/pipe."""
        pid = os.getpid()
        # Use a temporary directory that's user-specific and secure.
        # This is better than the global /tmp on Linux.
        temp_dir = os.path.join(os.path.expanduser("~"), ".mpv_playlist_organizer_ipc")
        os.makedirs(temp_dir, exist_ok=True)

        if platform.system() == "Windows":
            # Named pipes on Windows have a specific format.
            return f"\\\\.\\pipe\\mpv-ipc-{pid}"
        else:
            # Use the secure, user-specific temporary directory for Unix sockets.
            return os.path.join(temp_dir, f"mpv-socket-{pid}")


    def get_mpv_executable():
        """Gets the path to the mpv executable based on OS and config."""
        if platform.system() == "Windows":
            if os.path.exists(CONFIG_FILE):
                try:
                    with open(CONFIG_FILE, 'r') as f:
                        config = json.load(f)
                    return config.get("mpv_path", "mpv.exe") # Use configured path
                except (IOError, json.JSONDecodeError):
                     # If config is unreadable, fall back to default
                    return "mpv.exe"
            return "mpv.exe" # Fallback
        return "mpv" # For Linux/macOS

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
                # Try to connect to the named pipe. This will fail if MPV is hung or has closed the pipe.
                # We open and immediately close it.
                pipe = open(ipc_path, 'w')
                pipe.close()
                is_alive = True # Both checks passed.
            except (OSError, IOError):
                # Either the PID doesn't exist or the pipe is not available.
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

    class MpvSessionManager:
        """Manages the state and lifecycle of a single MPV instance."""

        def __init__(self, session_file_path):
            self.process = None
            self.ipc_path = None
            self.playlist = None
            self.pid = None
            self.owner_folder_id = None
            self.session_file = session_file_path
            # Add a lock to prevent race conditions during playlist syncing.
            self.sync_lock = threading.Lock()

        def clear(self):
            """Clears the session state and removes the session file."""
            if self.pid:
                logging.info(f"Clearing session state for PID: {self.pid}")

            self.process = None
            self.ipc_path = None
            self.playlist = None
            self.pid = None
            self.owner_folder_id = None
            if os.path.exists(self.session_file):
                try:
                    os.remove(self.session_file)
                    logging.info(f"Cleaned up session file: {self.session_file}")
                except OSError as e:
                    logging.warning(f"Failed to remove session file during cleanup: {e}")

        def _persist_session(self):
            """Saves the current session information to a file."""
            session_data = {
                "pid": self.pid,
                "ipc_path": self.ipc_path,
                "owner_folder_id": self.owner_folder_id
            }
            with open(self.session_file, 'w', encoding='utf-8') as f:
                json.dump(session_data, f, indent=4)
            logging.info(f"MPV session info saved to {self.session_file}")

        def restore(self):
            """Checks for a persisted session file and restores state if the process is still alive."""
            if not os.path.exists(self.session_file):
                return None # No session to restore

            logging.info(f"Found session file: {self.session_file}. Checking for live process.")
            try:
                with open(self.session_file, 'r', encoding='utf-8') as f:
                    session_data = json.load(f)

                pid = session_data.get("pid")
                ipc_path = session_data.get("ipc_path")
                owner_folder_id = session_data.get("owner_folder_id")

                if not all([pid, ipc_path, owner_folder_id]):
                    raise ValueError("Session file is malformed.")

                if is_process_alive(pid, ipc_path):
                    # The process is alive. Restore the playlist from the source of truth: folders.json
                    all_folders = get_all_folders_from_file()
                    folder_data = all_folders.get(owner_folder_id)
                    if not folder_data or "playlist" not in folder_data:
                        raise RuntimeError(f"Could not find playlist data for restored folder '{owner_folder_id}'.")

                    # We can't restore the self.process object, so it will be None.
                    # This is fine, as 'close' will fall back to other methods.
                    self.pid = pid
                    self.ipc_path = ipc_path
                    # Make sure the playlist is a list of strings for mpv
                    self.playlist = [item['url'] if isinstance(item, dict) else item for item in folder_data["playlist"]]
                    self.owner_folder_id = owner_folder_id
                    logging.info(f"Successfully restored session for MPV process (PID: {pid}) owned by folder '{owner_folder_id}'.")
                    return {"was_stale": False}
                else:
                    # Process is not alive, this is a stale session.
                    logging.warning(f"Stale session for PID {pid} found. Cleaning up.")
                    try:
                        os.remove(self.session_file)
                    except OSError: pass
                    # Return info so the background script can trigger cleanup logic.
                    return {"was_stale": True, "folderId": owner_folder_id, "returnCode": -1}

            except Exception as e:
                logging.warning(f"Could not restore session due to an error: {e}. Cleaning up.")
                try: os.remove(self.session_file)
                except OSError: pass
                return None

        def _sync(self, playlist):
            """Attempts to append new URLs to an already running MPV instance."""
            # Acquire the lock to ensure only one sync operation happens at a time.
            with self.sync_lock:
                logging.info(f"MPV is running for the same folder. Attempting to sync playlist.")
                known_urls = set(self.playlist) if self.playlist else set()
                urls_to_add = [url for url in playlist if url not in known_urls]

                if not urls_to_add:
                    logging.info("Playlist is already in sync or only contains removals (which are not handled live).")
                    self.playlist = playlist # Still update the playlist in case of removals
                    return {"success": True, "message": "Playlist is already up to date."}

                try:
                    logging.info(f"Appending {len(urls_to_add)} new item(s) to the playlist.")
                    for url in urls_to_add:
                        append_command = {"command": ["loadfile", url, "append-play"]}
                        send_ipc_command(self.ipc_path, append_command, expect_response=False)

                    # This state update is now protected by the lock.
                    self.playlist = playlist
                    return {"success": True, "message": f"Added {len(urls_to_add)} new item(s) to the MPV playlist."}
                except Exception as e:
                    logging.warning(f"Live playlist append failed unexpectedly: {e}. Clearing state to allow a restart.")
                    self.clear()
                    return None # Signal to the caller to fall back to launching a new instance.

        def _launch(self, playlist, folder_id, geometry, custom_width, custom_height, custom_mpv_flags, start_paused, clear_on_completion):
            """Launches a new instance of MPV with the given playlist and settings."""
            logging.info("Starting a new MPV instance.")
            mpv_exe = get_mpv_executable()
            ipc_path = get_ipc_path()
            on_completion_script_path = os.path.join(SCRIPT_DIR, "on_completion.lua")

            try:            
                mpv_args = [
                    mpv_exe, '--force-window=yes', '--save-position-on-quit', '--write-filename-in-watch-later-config',
                    f'--input-ipc-server={ipc_path}',
                ]

                # Add the script to detect natural playlist completion.
                if os.path.exists(on_completion_script_path):
                    mpv_args.append(f'--script={on_completion_script_path}')
                else:
                    logging.warning(f"Completion script not found at {on_completion_script_path}. 'Clear on Completion' may not work as expected.")

                if start_paused: # This flag is for starting paused, not related to the end of playlist.
                    logging.info("Applying --pause flag.")
                    mpv_args.append('--pause')

                if custom_mpv_flags:
                    import shlex
                    try:
                        parsed_flags = shlex.split(custom_mpv_flags)
                        logging.info(f"Applying custom MPV flags: {parsed_flags}")
                        mpv_args.extend(parsed_flags)
                    except Exception as e:
                        logging.error(f"Could not parse custom MPV flags '{custom_mpv_flags}'. Error: {e}")

                if custom_width and custom_height:
                    logging.info(f"Applying custom geometry: {custom_width}x{custom_height}")
                    mpv_args.append(f'--geometry={custom_width}x{custom_height}')
                elif geometry:
                    logging.info(f"Applying geometry: {geometry}")
                    mpv_args.append(f'--geometry={geometry}')
                
                # The full command now includes the terminal wrapper, the mpv command, and the playlist.
                full_command = mpv_args + ['--'] + playlist

                popen_kwargs = {
                    'stderr': subprocess.PIPE,
                    'stdout': subprocess.DEVNULL,
                    'universal_newlines': False
                }
                if platform.system() == "Windows":
                    popen_kwargs['creationflags'] = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
                else: # For Linux/macOS
                    popen_kwargs['start_new_session'] = True


                process = subprocess.Popen(full_command, **popen_kwargs)
                self.process = process
                self.ipc_path = ipc_path
                self.playlist = playlist
                self.pid = process.pid
                self.owner_folder_id = folder_id

                # Start threads to monitor stderr for logging
                stderr_thread = threading.Thread(target=log_stream, args=(self.process.stderr, logging.warning, folder_id))
                stderr_thread.daemon = True
                stderr_thread.start()

                self._persist_session()

                # On Windows, proc.wait() can have a delay, creating race conditions.
                # A polling loop in a thread is more reliable for capturing the exit code promptly.
                if platform.system() == "Windows":
                    def process_poller(proc, f_id):
                        while proc.poll() is None:
                            time.sleep(0.2) # Poll every 200ms
                        return_code = proc.returncode
                        logging.info(f"MPV process for folder '{f_id}' exited with code {return_code}.")
                        send_message({"action": "mpv_exited", "folderId": f_id, "returnCode": return_code})

                    waiter_thread = threading.Thread(target=process_poller, args=(self.process, folder_id))
                    waiter_thread.daemon = True
                    waiter_thread.start()
                else:
                    # On Linux/macOS, proc.wait() is reliable and more efficient than polling.
                    def process_waiter(proc, f_id):
                        return_code = proc.wait()
                        logging.info(f"MPV process for folder '{f_id}' exited with code {return_code}.")
                        send_message({"action": "mpv_exited", "folderId": f_id, "returnCode": return_code})

                    waiter_thread = threading.Thread(target=process_waiter, args=(self.process, folder_id))
                    waiter_thread.daemon = True
                    waiter_thread.start()

                # Associate the waiter thread with the session for potential cleanup
                self.process.waiter_thread = waiter_thread
                logging.info(f"MPV process launched (PID: {process.pid}) with {len(playlist)} items.")
                return {"success": True, "message": "MPV playback initiated."}
            except FileNotFoundError:
                logging.error(f"Failed to launch mpv. Make sure '{mpv_exe}' is installed and in your system's PATH or configured correctly.")
                return {"success": False, "error": f"Error: '{mpv_exe}' executable not found."}
            except Exception as e:
                logging.error(f"An error occurred while trying to launch mpv: {e}")
                return {"success": False, "error": f"Error launching mpv: {e}"}

        def start(self, playlist, folder_id, geometry=None, custom_width=None, custom_height=None, custom_mpv_flags=None, start_paused=False, clear_on_completion=False):
            """Starts a new mpv process, or syncs the playlist with a running one."""
            if self.pid and not is_process_alive(self.pid, self.ipc_path):
                logging.info("Detected a stale MPV session. Clearing state before proceeding.")
                self.clear()

            if self.pid:
                if folder_id == self.owner_folder_id:
                    sync_result = self._sync(playlist)
                    if sync_result is not None:
                        return sync_result
                else:
                    error_message = f"An MPV instance is already running for folder '{self.owner_folder_id}'. Please close it to play from '{folder_id}'."
                    logging.warning(error_message)
                    return {"success": False, "error": error_message}
            
            return self._launch(playlist, folder_id, geometry, custom_width, custom_height, custom_mpv_flags, start_paused, clear_on_completion)

        def close(self):
            """Closes the currently running mpv process, if any."""
            pid_to_close, ipc_path_to_use, process_object = None, None, None

            # Prioritize the live process object if available
            if self.process and self.process.poll() is None:
                pid_to_close, ipc_path_to_use, process_object = self.pid, self.ipc_path, self.process
            # Fallback to restored session info if no live process object
            elif self.pid and is_process_alive(self.pid, self.ipc_path):
                 pid_to_close, ipc_path_to_use = self.pid, self.ipc_path

            if not pid_to_close:
                logging.info("Received 'close_mpv' command, but no active MPV process was found.")
                # Clear any potentially stale session data
                self.clear()
                return {"success": True, "message": "No running MPV instance was found."}

            try:
                # First, try to close gracefully via IPC command
                if ipc_path_to_use:
                    try:
                        logging.info(f"Attempting to close MPV (PID: {pid_to_close}) via IPC: {ipc_path_to_use}")
                        send_ipc_command(ipc_path_to_use, {"command": ["quit"]}, expect_response=False)
                        # Give it a moment to shut down
                        if process_object: process_object.wait(timeout=3)
                        else: time.sleep(1)
                        
                        # Re-check if it's alive. If it's gone, we're done.
                        if not is_process_alive(pid_to_close, ipc_path_to_use):
                            logging.info(f"MPV process (PID: {pid_to_close}) closed gracefully via IPC.")
                            return {"success": True, "message": "MPV instance has been closed."}
                    except Exception as e:
                        logging.warning(f"IPC command to close MPV failed: {e}. Falling back to signal method.")

                # If IPC fails or isn't available, fall back to terminating the process
                logging.info(f"Attempting to close MPV process (PID: {pid_to_close}) via signal fallback.")
                if process_object:
                    if platform.system() == "Windows": process_object.send_signal(signal.CTRL_C_EVENT)
                    else: process_object.terminate()
                    process_object.wait(timeout=5)
                else: # If we don't have the process object (restored session), use os.kill
                    if platform.system() == "Windows":
                        # On Windows, os.kill with SIGTERM is an alias for terminate
                        os.kill(pid_to_close, signal.SIGTERM)
                    else:
                        os.kill(pid_to_close, signal.SIGTERM)
                    time.sleep(2) # Wait for process to terminate

                # Final check to see if it was terminated
                if not is_process_alive(pid_to_close, ipc_path_to_use):
                    logging.info(f"MPV process (PID: {pid_to_close}) terminated successfully via signal.")
                    return {"success": True, "message": "MPV instance has been closed."}
                else: # If it's still alive, force kill it
                    raise subprocess.TimeoutExpired(None, timeout=0)

            except subprocess.TimeoutExpired:
                logging.warning(f"MPV process (PID: {pid_to_close}) did not terminate in time, forcing kill.")
                if process_object: process_object.kill()
                else: os.kill(pid_to_close, signal.SIGKILL)
                return {"success": True, "message": "MPV instance was forcefully closed."}
            except Exception as e:
                error_msg = f"An error occurred while closing MPV process (PID: {pid_to_close}): {e}"
                logging.error(error_msg)
                return {"success": False, "error": error_msg}
            finally:
                self.clear()

    # --- Global Instance ---
    # A single instance of the session manager to handle the MPV state.
    mpv_session = MpvSessionManager(session_file_path=SESSION_FILE)

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


    def get_all_folders_from_file(): # Modified to handle new structure
        """Reads all folders data from folders.json, ensuring new format."""
        if not os.path.exists(FOLDERS_FILE):
            # If the main folders file doesn't exist, try to copy it from the project directory
            # as a one-time fallback. This helps with fresh installations where the user
            # data directory is new but a default `folders.json` exists in the source.
            source_folders_file = os.path.join(SCRIPT_DIR, "data", "folders.json")
            if os.path.exists(source_folders_file):
                try:
                    logging.info(f"No folders file found in {DATA_DIR}. Copying default from {source_folders_file}.")
                    shutil.copy2(source_folders_file, FOLDERS_FILE)
                except Exception as e:
                    logging.error(f"Failed to copy default folders.json: {e}")
                    return {} # Return empty if copy fails
            else:
                return {} # Return empty if no source file to copy

        try:
            with open(FOLDERS_FILE, 'r', encoding='utf-8') as f:
                # Handle empty or malformed file
                content = f.read()
                if not content:
                    return {}
                raw_folders = json.loads(content)
            
            converted_folders = {}
            needs_resave = False
            for folder_id, folder_content in raw_folders.items():
                if isinstance(folder_content, dict) and "playlist" in folder_content:
                    playlist = folder_content.get("playlist", [])
                    # New: Migrate string playlists within the new format
                    if playlist and isinstance(playlist[0], str):
                         needs_resave = True
                         playlist = [{"url": url, "title": url} for url in playlist]
                    converted_folders[folder_id] = {"playlist": playlist}
                elif isinstance(folder_content, list):
                    # Old format: a raw list of URLs
                    logging.info(f"Converting old format (list) for folder '{folder_id}' to new format.")
                    converted_folders[folder_id] = {"playlist": [{"url": url, "title": url} for url in folder_content]}
                    needs_resave = True
                elif isinstance(folder_content, dict) and "urls" in folder_content:
                    # Old format: a dict with a 'urls' key
                    logging.info(f"Converting old format (dict with 'urls') for folder '{folder_id}' to new format.")
                    converted_folders[folder_id] = {"playlist": [{"url": url, "title": url} for url in folder_content.get("urls", [])]}
                    needs_resave = True
                else:
                    logging.warning(f"Skipping malformed folder data for '{folder_id}' during load: {folder_content}")
            
            if needs_resave:
                logging.info("Resaving folders file after converting old data formats.")
                with open(FOLDERS_FILE, 'w') as f:
                    json.dump(converted_folders, f, indent=4)

            return converted_folders
        except Exception as e:
            logging.error(f"Failed to read or process folders from file: {e}")
            return {}

    def _cli_list_folders(args):
        """CLI command to list all available folders and their item counts."""
        folders_data = get_all_folders_from_file()
        if not folders_data:
            print("No folders found. Please add an item in the extension first to create the data file.")
            logging.warning("CLI 'list' command: No folders found or data file missing.")
            return

        print("Available folders:")
        # List folders alphabetically for consistent output.
        for folder_id, folder_info in sorted(folders_data.items()):
            playlist = folder_info.get("playlist", [])
            item_count = len(playlist)
            print(f"  - {folder_id} ({item_count} item{'s' if item_count != 1 else ''})")

    def _cli_play_folder(args):
        """CLI command to play a specific folder."""
        folder_id = args.folder_id
        folders_data = get_all_folders_from_file()
        folder_info = folders_data.get(folder_id)

        if not folders_data:
             print(f"Error: Data file not found or is empty. Please add an item in the extension first to create it.", file=sys.stderr)
             logging.error(f"CLI Error: Data file not found or empty.")
             sys.exit(1)

        if folder_info is None or not isinstance(folder_info, dict) or "playlist" not in folder_info:
            print(f"Error: Folder '{folder_id}' not found.", file=sys.stderr)
            logging.error(f"CLI Error: Folder '{folder_id}' not found.")
            # Be helpful and list available folders.
            if folders_data:
                print("\nAvailable folders are:")
                for available_folder_id in sorted(folders_data.keys()):
                    print(f"  - {available_folder_id}")
            sys.exit(1)
        
        # The playlist items can be strings or dicts, but mpv just needs the URLs.
        playlist_items = folder_info.get("playlist", [])
        playlist_urls = [item['url'] if isinstance(item, dict) else item for item in playlist_items]

        if not playlist_urls:
            print(f"Playlist for folder '{folder_id}' is empty. Nothing to play.")
            logging.info(f"CLI: Playlist for '{folder_id}' is empty. Aborting.")
            sys.exit(0)

        logging.info(f"Found folder '{folder_id}' with {len(playlist_urls)} item(s). Starting mpv...")
        print(f"Starting mpv for folder '{folder_id}' with {len(playlist_urls)} item(s)...")
        mpv_session.start(playlist_urls, folder_id)


    def handle_cli():
        """Handles command-line invocation using argparse for a more robust CLI."""
        # The browser will call the script with an origin argument, not a valid command.
        # We can distinguish a CLI call by checking if the first argument is one of our commands.
        if len(sys.argv) < 2 or sys.argv[1] not in ['play', 'list', '-h', '--help']:
            return False # Not a CLI call, proceed to browser messaging mode.

        logging.info(f"Native host started in CLI mode with args: {sys.argv}")

        parser = argparse.ArgumentParser(
            description="Command-line interface for MPV Playlist Organizer.",
            formatter_class=argparse.RawTextHelpFormatter # For better help text formatting
        )
        subparsers = parser.add_subparsers(dest='command', required=True, help='Available commands')

        # --- Play Command ---
        play_parser = subparsers.add_parser('play', help='Play a playlist from a specified folder.')
        play_parser.add_argument('folder_id', help='The name of the folder to play.')
        play_parser.set_defaults(func=_cli_play_folder)

        # --- List Command ---
        list_parser = subparsers.add_parser('list', help='List all available folders and their item counts.')
        list_parser.set_defaults(func=_cli_list_folders)

        try:
            args = parser.parse_args()
            args.func(args)
        except SystemExit:
            # Argparse calls sys.exit() on --help or errors, which is fine. We just pass.
            pass
        except Exception as e:
            # This will catch errors from the command functions (e.g., file not found).
            print(f"An unexpected CLI error occurred: {e}", file=sys.stderr)
            logging.error(f"Unexpected CLI Error: {e}", exc_info=True)
            sys.exit(1)
        
        return True # Indicates that a CLI command was successfully handled.

    def launch_unmanaged_mpv(playlist, geometry, custom_width, custom_height, custom_mpv_flags):
        """Launches a new, unmanaged instance of MPV."""
        logging.info("Launching a new, unmanaged MPV instance.")
        mpv_exe = get_mpv_executable()
        # This instance will not have a persistent IPC server, so it's fire-and-forget.
        # We don't need to generate a unique IPC path.
        
        try:
            mpv_args = [
                mpv_exe, '--no-terminal', '--force-window=yes',
                '--save-position-on-quit',
                '--write-filename-in-watch-later-config',
                # No --input-ipc-server, so it's unmanaged
            ]

            if custom_mpv_flags:
                import shlex
                try:
                    parsed_flags = shlex.split(custom_mpv_flags)
                    logging.info(f"Applying custom MPV flags: {parsed_flags}")
                    mpv_args.extend(parsed_flags)
                except Exception as e:
                    logging.error(f"Could not parse custom MPV flags '{custom_mpv_flags}'. Error: {e}")

            if custom_width and custom_height:
                logging.info(f"Applying custom geometry: {custom_width}x{custom_height}")
                mpv_args.append(f'--geometry={custom_width}x{custom_height}')
            elif geometry:
                logging.info(f"Applying geometry: {geometry}")
                mpv_args.append(f'--geometry={geometry}')

            mpv_args.extend(['--'] + playlist)

            popen_kwargs = {
                'stderr': subprocess.PIPE,
                'stdout': subprocess.DEVNULL,
                'universal_newlines': False
            }
            if platform.system() == "Windows":
                popen_kwargs['creationflags'] = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP

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
                    clear_on_completion = message.get('clear_on_completion', False)
                    start_paused = message.get('start_paused', False)
                    if not folder_id:
                        response = {"success": False, "error": "No folderId provided for play action."}
                    else:
                        response = mpv_session.start(playlist, folder_id, geometry=geometry, custom_width=custom_width, custom_height=custom_height, custom_mpv_flags=custom_mpv_flags, start_paused=start_paused, clear_on_completion=clear_on_completion)

                elif command == 'play_new_instance':
                    playlist = message.get('playlist', [])
                    geometry = message.get('geometry')
                    custom_width = message.get('custom_width')
                    custom_height = message.get('custom_height')
                    custom_mpv_flags = message.get('custom_mpv_flags')
                    response = launch_unmanaged_mpv(playlist, geometry, custom_width, custom_height, custom_mpv_flags)

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
                        try:
                            with open(FOLDERS_FILE, 'w') as f:
                                json.dump(data_to_export, f, indent=4)
                            logging.info(f"Data exported to {FOLDERS_FILE}")
                            response = {"success": True, "message": "Data successfully synced to file."}
                        except Exception as e:
                            error_msg = f"Failed to write to {FOLDERS_FILE}: {e}"
                            logging.error(error_msg)
                            response = {"success": False, "error": error_msg}
                    else:
                        response = {"success": False, "error": "No data provided for export."}
                
                elif command == 'export_playlists':
                    data_to_export = message.get('data')
                    custom_filename = message.get('filename')
                    if data_to_export is not None and custom_filename:
                        response = _write_export_file(custom_filename, data_to_export)
                    elif not custom_filename:
                        response = {"success": False, "error": "No filename provided for export."}
                    else:
                        response = {"success": False, "error": "No data provided for export."}

                elif command == 'export_all_playlists_separately':
                    folders_to_export = message.get('data')
                    if not folders_to_export:
                        response = {"success": False, "error": "No folder data provided for export."}
                    else:
                        exported_count = 0
                        for folder_id, folder_data in folders_to_export.items():
                            playlist = folder_data.get('playlist')
                            if playlist is None:
                                logging.warning(f"Skipping folder '{folder_id}' during batch export: 'playlist' key not found.")
                                continue

                            # Sanitize folder_id to create a safe filename
                            safe_filename_base = "".join(c if c.isalnum() or c in ('-', '_') else '_' for c in folder_id).rstrip()
                            result = _write_export_file(safe_filename_base, playlist)
                            if result["success"]:
                                exported_count += 1
                        
                        logging.info(f"Batch exported {exported_count} playlists.")
                        response = {"success": True, "message": f"Successfully exported {exported_count} playlists to separate files."}

                elif command == 'list_import_files':
                    try:
                        if not os.path.isdir(EXPORT_DIR):
                            response = {"success": True, "files": []}
                        else:
                            files = sorted([f for f in os.listdir(EXPORT_DIR) if f.endswith('.json')], reverse=True)
                            response = {"success": True, "files": files}
                    except Exception as e:
                        error_msg = f"Failed to list import files: {e}"
                        logging.error(error_msg)
                        response = {"success": False, "error": error_msg}

                elif command == 'import_from_file':
                    filename = message.get('filename')
                    if filename:
                        try:
                            filepath = os.path.abspath(os.path.join(EXPORT_DIR, filename))
                            if not filepath.startswith(os.path.abspath(EXPORT_DIR)):
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
                        # Ensure the directory exists before trying to open it.
                        os.makedirs(EXPORT_DIR, exist_ok=True)
                        abs_path = os.path.abspath(EXPORT_DIR)

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
                    # The new function handles all caching and fetching logic.
                    response = get_anilist_releases_with_cache(force_refresh, delete_cache, is_cache_disabled)

                elif command == 'run_ytdlp_update':
                    response = update_ytdlp()

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
        if not handle_cli():
            # Otherwise, assume native messaging mode for the browser.
            main()

except Exception as e:
    # This is the failsafe block that catches any error during script initialization or execution.
    if FAILSAFE_LOG_PATH:
        try:
            with open(FAILSAFE_LOG_PATH, "a", encoding="utf-8") as f:
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