import json
import logging
import os
import platform
import shutil
import ssl
import subprocess
import sys
import time
import urllib.request
import shlex
import re
from utils import ipc_utils

# --- Dependency Checking & Updating ---

def _get_ytdlp_version(path_to_exe, send_message_func):
    """Runs 'yt-dlp --version' and returns the output."""
    try:
        result = subprocess.run(
            [path_to_exe, '--version'],
            capture_output=True, text=True, check=True, timeout=10,
            encoding='utf-8', errors='ignore'
        )
        return result.stdout.strip()
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError) as e:
        error_msg = f"Could not get yt-dlp version: {e}"
        logging.error(error_msg)
        send_message_func({"log": {"text": f"[yt-dlp]: {error_msg}", "type": "error"}})
        return None

def update_ytdlp(send_message_func):
    """Downloads the latest yt-dlp binary and replaces the existing one."""
    send_message_func({"log": {"text": "[yt-dlp]: Starting manual update process...", "type": "info"}})
    try:
        system = platform.system()
        exe_name = "yt-dlp.exe" if system == "Windows" else "yt-dlp"

        send_message_func({"log": {"text": f"[Native Host]: Searching for '{exe_name}' in PATH...", "type": "info"}})
        current_path = shutil.which(exe_name)
        if not current_path:
            error_msg = f"'{exe_name}' not found in your system's PATH. Cannot update."
            send_message_func({"log": {"text": f"[yt-dlp]: {error_msg}", "type": "error"}})
            return {"success": False, "error": error_msg}

        send_message_func({"log": {"text": f"[yt-dlp]: Found at '{current_path}'.", "type": "info"}})
        version_before = _get_ytdlp_version(current_path, send_message_func)
        if version_before:
            send_message_func({"log": {"text": f"[yt-dlp]: Current version: {version_before}", "type": "info"}})

        command = [current_path, '-U']
        popen_kwargs = {'stdout': subprocess.PIPE, 'stderr': subprocess.STDOUT, 'universal_newlines': True, 'encoding': 'utf-8', 'errors': 'ignore'}
        if system == "Windows":
            popen_kwargs['creationflags'] = subprocess.CREATE_NO_WINDOW

        if system == "Linux" and not os.access(current_path, os.W_OK):
            send_message_func({"log": {"text": "[yt-dlp]: Write access denied. Attempting to run with administrator privileges...", "type": "info"}})
            if shutil.which("pkexec"): command = ["pkexec"] + command
            elif shutil.which("gksu"): command = ["gksu"] + command
            elif shutil.which("kdesu"): command = ["kdesu"] + command
            else:
                error_msg = "No graphical sudo tool found. Please run `sudo yt-dlp -U` in a terminal."
                send_message_func({"log": {"text": f"[yt-dlp]: {error_msg}", "type": "error"}})
                return {"success": False, "error": error_msg}
            send_message_func({"log": {"text": "[yt-dlp]: Please enter your password in the dialog to update yt-dlp.", "type": "info"}})

        send_message_func({"log": {"text": f"[yt-dlp]: Executing: {' '.join(command)}", "type": "info"}})
        process = subprocess.Popen(command, **popen_kwargs)

        for line in iter(process.stdout.readline, ''):
            send_message_func({"log": {"text": f"[yt-dlp]: {line.strip()}", "type": "info"}})
        
        process.stdout.close()
        return_code = process.wait()

        if return_code != 0:
            error_msg = f"Update process failed with exit code {return_code}."
            send_message_func({"log": {"text": f"[yt-dlp]: {error_msg}", "type": "error"}})
            return {"success": False, "error": error_msg}
        
        version_after = _get_ytdlp_version(current_path, send_message_func)
        if not version_after:
            return {"success": False, "error": "Could not verify yt-dlp version after update."}

        send_message_func({"log": {"text": f"[yt-dlp]: New version: {version_after}", "type": "info"}})
        if version_after != version_before:
            success_msg = f"Successfully updated yt-dlp from {version_before} to {version_after}."
        else:
            success_msg = f"yt-dlp is already at the latest version ({version_after})."
        
        send_message_func({"log": {"text": f"[yt-dlp]: {success_msg}", "type": "info"}})
        return {"success": True, "message": success_msg}

    except Exception as e:
        error_msg = f"An unexpected error occurred during yt-dlp update: {e}"
        send_message_func({"log": {"text": f"[yt-dlp]: {error_msg}", "type": "error"}})
        return {"success": False, "error": error_msg}

def check_mpv_and_ytdlp_status(get_mpv_executable_func, send_message_func):
    """Checks for the presence and version of mpv and yt-dlp executables."""
    mpv_status = {"found": False, "path": None, "error": None}
    ytdlp_status = {"found": False, "path": None, "version": None, "error": None}
    system = platform.system()

    mpv_exe_name = "mpv.exe" if system == "Windows" else "mpv"
    mpv_path = get_mpv_executable_func()
    
    if os.path.isabs(mpv_path) and os.path.exists(mpv_path):
        mpv_status["found"] = True
        mpv_status["path"] = mpv_path
    else:
        found_mpv_in_path = shutil.which(mpv_exe_name)
        if found_mpv_in_path:
            mpv_status["found"] = True
            mpv_status["path"] = found_mpv_in_path
        else:
            mpv_status["error"] = f"'{mpv_exe_name}' not found in system PATH."
            if system == "Windows" and mpv_path != mpv_exe_name:
                mpv_status["error"] += f" Also not found at configured path: '{mpv_path}'."

    ytdlp_exe_name = "yt-dlp.exe" if system == "Windows" else "yt-dlp"
    ytdlp_path = shutil.which(ytdlp_exe_name)

    if ytdlp_path:
        ytdlp_status["found"] = True
        ytdlp_status["path"] = ytdlp_path
        ytdlp_version = _get_ytdlp_version(ytdlp_path, send_message_func)
        if ytdlp_version:
            ytdlp_status["version"] = ytdlp_version
        else:
            ytdlp_status["error"] = "Could not retrieve yt-dlp version."
    else:
        ytdlp_status["error"] = f"'{ytdlp_exe_name}' not found in system PATH."

    logging.info(f"Dependency check: MPV={mpv_status['found']}, YTDLP={ytdlp_status['found']}")
    return {"success": True, "mpv": mpv_status, "ytdlp": ytdlp_status}

# --- MPV Command Construction ---

def construct_mpv_command(
    mpv_exe,
    ipc_path=None,
    urls=None,
    is_youtube=False,
    ytdl_raw_options=None,
    geometry=None,
    custom_width=None,
    custom_height=None,
    custom_mpv_flags=None,
    automatic_mpv_flags=None,
    headers=None,
    disable_http_persistent=False,
    start_paused=False,
    script_dir=None,
    load_on_completion_script=False # NEW ARGUMENT
):
    """Constructs the MPV command line arguments."""
    mpv_args = [mpv_exe]
    if ipc_path:
        mpv_args.append(f'--input-ipc-server={ipc_path}')

    if load_on_completion_script and script_dir: # Check new argument
        lua_script_path = os.path.join(script_dir, "data", "on_completion.lua")
        if os.path.exists(lua_script_path):
            mpv_args.append(f'--script={lua_script_path}')
            logging.info(f"MPV will load completion script: {lua_script_path}")
        else:
            logging.warning(f"Completion script not found at {lua_script_path}. MPV will not use it.")

    has_terminal_flag = False
    if automatic_mpv_flags:
        for flag_info in automatic_mpv_flags:
            if flag_info.get('enabled'):
                if flag_info.get('flag') == 'terminal':
                    has_terminal_flag = True
                elif flag_info.get('flag'):
                    mpv_args.append(flag_info.get('flag'))

    if headers:
        header_list = []
        for k, v in headers.items():
            safe_v = v.replace(",", "")
            header_list.append(f"{k}: {safe_v}")
        header_string = ",".join(header_list)
        mpv_args.append(f'--http-header-fields={header_string}')

        if 'User-Agent' in headers:
            mpv_args.append(f'--user-agent={headers["User-Agent"]}')
        if 'Referer' in headers:
            mpv_args.append(f'--referrer={headers["Referer"]}')

    if disable_http_persistent:
        mpv_args.append('--demuxer-lavf-o=http_persistent=0')

    if start_paused and '--pause' not in mpv_args:
        mpv_args.append('--pause')

    if custom_mpv_flags:
        try:
            parsed_flags = shlex.split(custom_mpv_flags)
            mpv_args.extend(parsed_flags)
        except Exception as e:
            logging.error(f"Could not parse custom MPV flags '{custom_mpv_flags}'. Error: {e}")

    if '--terminal' in mpv_args:
        has_terminal_flag = True

    if custom_width and custom_height:
        mpv_args.append(f'--geometry={custom_width}x{custom_height}')
    elif geometry:
        mpv_args.append(f'--geometry={geometry}')
    
    if is_youtube:
        mpv_args.append('--ytdl=yes')
        mpv_args.append('--ytdl-format=bestvideo+bestaudio')
        if ytdl_raw_options:
            mpv_args.append(f'--ytdl-raw-options={ytdl_raw_options}')

    full_command = mpv_args + ['--'] + (urls if urls else [])

    if platform.system() != "Windows" and has_terminal_flag:
        if '--terminal' not in mpv_args:
             # Try to insert before '--'
             try:
                 idx = full_command.index('--')
                 full_command.insert(idx, '--terminal')
             except ValueError:
                 full_command.insert(1, '--terminal')

        term_cmd = []
        if shutil.which('x-terminal-emulator'): term_cmd = ['x-terminal-emulator', '-e']
        elif shutil.which('gnome-terminal'): term_cmd = ['gnome-terminal', '--wait', '--']
        elif shutil.which('konsole'): term_cmd = ['konsole', '-e']
        elif shutil.which('xfce4-terminal'): term_cmd = ['xfce4-terminal', '--disable-server', '-x']
        elif shutil.which('xterm'): term_cmd = ['xterm', '-e']
        
        if term_cmd:
             full_command = term_cmd + full_command

    return full_command, has_terminal_flag

def get_mpv_popen_kwargs(has_terminal_flag):
    """Returns the subprocess arguments for launching MPV."""
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
        popen_kwargs['start_new_session'] = True
    return popen_kwargs

# --- Bypass Script Logic ---

def apply_bypass_script(url_item, bypass_scripts, send_message_func, script_dir, mpv_session=None):
    """
    Applies a bypass script if specified in url_item settings and enabled globally.
    Returns a tuple of (processed_url, headers_dict, ytdl_raw_options).
    """
    if not isinstance(url_item, dict):
        url_item = {'url': url_item if url_item else "", 'settings': {}}

    original_url = url_item['url']
    
    # Check if a specific bypass script is enabled for this item
    item_bypass_script_id = url_item.get('settings', {}).get('use_bypass_script_id')
    script_path = None

    # URL-based auto-detection for bypass script
    is_youtube = "youtube.com/" in original_url or "youtu.be/" in original_url
    is_animepahe = re.match(r"^https://vault-\d+\.owocdn\.top/stream/.+/uwu\.m3u8", original_url)

    if item_bypass_script_id and bypass_scripts.get(item_bypass_script_id, {}).get('enabled'):
        script_config = bypass_scripts[item_bypass_script_id]
        script_path = os.path.join(script_dir, script_config.get('script_path', 'play_with_bypass.sh'))
    elif is_youtube or is_animepahe:
        script_name = "play_with_bypass.bat" if platform.system() == "Windows" else "play_with_bypass.sh"
        potential_path = os.path.join(script_dir, script_name)
        if os.path.exists(potential_path):
            logging.info(f"Auto-detected bypassable URL. Using {script_name}.")
            script_path = potential_path

    if script_path:


        if not os.path.exists(script_path):
            logging.error(f"Bypass script not found: {script_path}")
            send_message_func({
                "action": "log_from_native_host",
                "log": {"text": f"Bypass script not found: {script_path}. Playing original URL.", "type": "error"}
            })
            return original_url, None, None
        
        # Ensure the script is executable (Linux/macOS)
        if platform.system() != "Windows" and not os.access(script_path, os.X_OK):
            try:
                os.chmod(script_path, os.stat(script_path).st_mode | 0o100)
            except Exception as e:
                logging.error(f"Failed to make bypass script executable: {e}")
                return original_url, None, None

        try: # Outer try block starts here
            logging.info(f"Executing bypass script '{script_path}' for URL: {original_url}")
            send_message_func({"action": "log_from_native_host", "log": {"text": f"Running bypass script for: {original_url}", "type": "info"}})
            
            process = subprocess.run([script_path, original_url], capture_output=True, text=True, check=True, timeout=20)
            output = process.stdout.strip()
            error_output = process.stderr.strip() # NEW: Capture stderr

            if output: # Log stdout if present
                logging.info(f"Bypass script stdout: {output}")
            if error_output: # Log stderr if present
                logging.warning(f"Bypass script stderr: {error_output}")

            if not output:
                logging.error(f"Bypass script '{script_path}' returned no stdout for URL: {original_url}")
                send_message_func({"action": "log_from_native_host", "log": {"text": f"Bypass script '{script_path}' returned no stdout for URL: {original_url}. Playing original URL.", "type": "error"}})
                return original_url, None, None # Fallback to original URL

            try: # Inner try block
                data = json.loads(output)
                processed_url = data.get("url", original_url)
                if data.get("is_youtube"):
                    return processed_url, None, data.get("ytdl_raw_options")
                return processed_url, data.get("headers"), None
            except json.JSONDecodeError: # Inner except block
                # Fallback for older scripts returning raw URL
                return output.splitlines()[-1], None, None
        except Exception as e: # Outer except block
            logging.error(f"Error executing bypass script: {e}")
            send_message_func({"action": "log_from_native_host", "log": {"text": f"Bypass script failed: {e}. Playing original URL.", "type": "error"}})
            return original_url, None, None
    
    return original_url, None, None

# --- AniList Service ---

def _fetch_from_anilist_script(is_ping, script_dir):
    """Helper function to execute the anilist_releases.py script."""
    try:
        script_path = os.path.join(script_dir, 'anilist_releases.py')
        script_args = [sys.executable, script_path]
        if is_ping:
            script_args.append('--ping')
        result = subprocess.run(script_args, capture_output=True, text=True, check=True, encoding='utf-8')
        return {"success": True, "output": result.stdout}
    except subprocess.CalledProcessError as e:
        logging.error(f"Error running anilist_releases.py: {e.stderr}")
        return {"success": False, "error": f"Error fetching AniList releases: {e.stderr}"}
    except FileNotFoundError:
        error_msg = "anilist_releases.py not found in the script directory."
        logging.error(error_msg)
        return {"success": False, "error": error_msg}

def get_anilist_releases_with_cache(force_refresh, delete_cache, is_cache_disabled, cache_file, script_dir, send_message_func):
    """Handles fetching AniList releases with a file-based caching mechanism."""
    CACHE_DURATION_S = 30 * 60
    now = time.time()

    if is_cache_disabled:
        logging.info("AniList cache is disabled. Fetching directly from API.")
        send_message_func({"log": {"text": "[AniList]: Cache disabled. Fetching new data from API.", "type": "info"}})
        return _fetch_from_anilist_script(is_ping=False, script_dir=script_dir)

    if delete_cache and os.path.exists(cache_file):
        try:
            os.remove(cache_file)
            logging.info("Deleted anilist_cache.json as requested.")
            send_message_func({"log": {"text": "[AniList]: Cache file deleted.", "type": "info"}})
        except OSError as e:
            logging.error(f"Failed to delete anilist_cache.json: {e}")

    if force_refresh:
        logging.info("Forcing a full refresh of AniList data.")
        send_message_func({"log": {"text": "[AniList]: Manual refresh requested. Fetching new data...", "type": "info"}})
        return _fetch_from_anilist_script(is_ping=False, script_dir=script_dir)

    cache = None
    if os.path.exists(cache_file):
        try:
            with open(cache_file, 'r', encoding='utf-8') as f:
                cache = json.load(f)
        except (json.JSONDecodeError, IOError) as e:
            logging.warning(f"Could not read anilist_cache.json: {e}. Will perform a full fetch.")
            cache = None

    if cache and 'timestamp' in cache and 'data' in cache:
        from datetime import datetime
        is_expired_by_timer = (now - cache['timestamp'] > CACHE_DURATION_S)
        cache_date = datetime.fromtimestamp(cache['timestamp']).date()
        is_new_day = datetime.fromtimestamp(now).date() != cache_date
        next_airing_at = cache['data'].get('next_airing_at')
        is_expired_by_release = next_airing_at and now > next_airing_at

        if is_expired_by_release: send_message_func({"log": {"text": "[AniList]: A new episode has aired. Refreshing...", "type": "info"}})
        if is_new_day: send_message_func({"log": {"text": "[AniList]: New day detected. Refreshing data...", "type": "info"}})

        if not is_expired_by_timer and not is_expired_by_release and not is_new_day:
            logging.info("Serving AniList data from fresh local file cache.")
            send_message_func({"log": {"text": "[AniList]: Loaded from local file (cache is fresh).", "type": "info"}})
            return {"success": True, "output": json.dumps(cache['data'])}

    if cache and 'data' in cache and 'total' in cache['data']:
        logging.info("AniList cache is stale. Pinging API for changes...")
        send_message_func({"log": {"text": "[AniList]: Cache is stale. Pinging for changes...", "type": "info"}})
        
        ping_response = _fetch_from_anilist_script(is_ping=True, script_dir=script_dir)
        
        if ping_response['success']:
            try:
                ping_data = json.loads(ping_response['output'])
                ping_airing_ats = ping_data.get('airingAt_list', [])
                cached_airing_ats = cache.get('sorted_airing_ats', [])

                if sorted(ping_airing_ats) == cached_airing_ats:
                    logging.info("No change in release timestamps. Serving from local file and updating timestamp.")
                    send_message_func({"log": {"text": "[AniList]: Loaded from local file (no new releases found).", "type": "info"}})
                    
                    cache['timestamp'] = now
                    with open(cache_file, 'w', encoding='utf-8') as f:
                        json.dump(cache, f, indent=4)
                    
                    return {"success": True, "output": json.dumps(cache['data'])}
            except (json.JSONDecodeError, KeyError) as e:
                logging.warning(f"Failed to process ping response: {e}. Proceeding with full fetch.")
        else:
            logging.warning(f"AniList ping failed. Proceeding with full fetch.")

    logging.info("Performing a full fetch of AniList data.")
    send_message_func({"log": {"text": "[AniList]: Fetching new data from AniList API...", "type": "info"}})
    full_fetch_response = _fetch_from_anilist_script(is_ping=False, script_dir=script_dir)
    
    if full_fetch_response['success'] and not is_cache_disabled:
        try:
            full_data = json.loads(full_fetch_response['output'])
            sorted_ats = sorted([s['airingAt'] for s in full_data.get('raw_schedules_for_cache', [])])
            new_cache = {"timestamp": now, "data": full_data, "sorted_airing_ats": sorted_ats}
            with open(cache_file, 'w', encoding='utf-8') as f:
                json.dump(new_cache, f, indent=4)
            logging.info("AniList file cache updated with new data.")
        except (json.JSONDecodeError, IOError) as e:
            logging.error(f"Failed to write new AniList cache file: {e}")

    return full_fetch_response