import json
import logging
import os
import platform
import shutil
import ssl
import subprocess
import sys

# Prevent __pycache__ generation
sys.dont_write_bytecode = True
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'

import time
import urllib.request
import shlex
import re
from utils import ipc_utils
from utils import url_analyzer
import file_io # <--- Added this import

# A set of mpv flags that are considered safe to be passed from the extension.
# This is a security measure to prevent argument injection vulnerabilities.
SAFE_MPV_FLAGS_ALLOWLIST = {
    # Playback
    '--start',
    '--end',
    '--speed',
    '--loop',
    '--pause',

    # Window
    '--fullscreen',
    '--ontop',
    '--border',
    '--title',
    '--geometry',
    '--autofit',
    '--autofit-larger',
    '--autofit-smaller',
    '--keep-open',

    # Video
    '--aspect',
    '--correct-pts',
    '--fps',
    '--deinterlace',
    '--hwdec',

    # Audio
    '--volume',
    '--mute',
    '--audio-device',
    '--audio-channels',

    # Subtitles
    '--sub-visibility',
    '--sub-pos',
    '--sub-scale',
    '--sub-font',
    '--sub-font-size',

    # Miscellaneous
    '--no-audio',
    '--no-video',
    '--force-window',
    '--cursor-autohide',
    '--terminal',
}


# --- Dependency Checking & Updating ---

def _find_ytdlp_executable():
    """
    Finds the yt-dlp executable in the system's PATH.
    Returns the absolute path to the executable or None if not found.
    """
    system = platform.system()
    exe_name = "yt-dlp.exe" if system == "Windows" else "yt-dlp"
    return shutil.which(exe_name)

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

    send_message_func({"log": {"text": f"[yt-dlp]: {error_msg}", "type": "error"}})
    return None

def _get_linux_sudo_command_prefix(ytdlp_path, send_message_func):
    """
    Checks if write access is denied for ytdlp_path on Linux and finds a suitable
    graphical sudo tool. Returns a list of command prefixes (e.g., ["pkexec"])
    or an empty list if not needed or no tool found.
    """
    if platform.system() == "Linux" and not os.access(ytdlp_path, os.W_OK):
        send_message_func({"log": {"text": "[yt-dlp]: Write access denied. Attempting to run with administrator privileges...", "type": "info"}})
        if shutil.which("pkexec"):
            send_message_func({"log": {"text": "[yt-dlp]: Please enter your password in the dialog to update yt-dlp.", "type": "info"}})
            return ["pkexec"]
        elif shutil.which("gksu"):
            send_message_func({"log": {"text": "[yt-dlp]: Please enter your password in the dialog to update yt-dlp.", "type": "info"}})
            return ["gksu"]
        elif shutil.which("kdesu"):
            send_message_func({"log": {"text": "[yt-dlp]: Please enter your password in the dialog to update yt-dlp.", "type": "info"}})
            return ["kdesu"]
        else:
            send_message_func({"log": {"text": "[yt-dlp]: No graphical sudo tool found. Please run `sudo yt-dlp -U` in a terminal.", "type": "error"}})
            return []
    return []

    return []

def _run_update_command(command, send_message_func):
    """
    Runs the yt-dlp update command and streams output to the sender.
    Returns the process's return code.
    """
    system = platform.system()
    popen_kwargs = {'stdout': subprocess.PIPE, 'stderr': subprocess.STDOUT, 'universal_newlines': True, 'encoding': 'utf-8', 'errors': 'ignore'}
    if system == "Windows":
        popen_kwargs['creationflags'] = subprocess.CREATE_NO_WINDOW

    send_message_func({"log": {"text": f"[yt-dlp]: Executing: {' '.join(command)}", "type": "info"}})
    process = subprocess.Popen(command, **popen_kwargs)

    for line in iter(process.stdout.readline, ''):
        send_message_func({"log": {"text": f"[yt-dlp]: {line.strip()}", "type": "info"}})
    
    process.stdout.close()
    return process.wait()

def update_ytdlp(send_message_func):
    """Downloads the latest yt-dlp binary and replaces the existing one."""
    send_message_func({"log": {"text": "[yt-dlp]: Starting manual update process...", "type": "info"}})
    try:
        current_path = _find_ytdlp_executable()
        if not current_path:
            error_msg = "'yt-dlp' not found in your system's PATH. Cannot update."
            send_message_func({"log": {"text": f"[yt-dlp]: {error_msg}", "type": "error"}})
            return {"success": False, "error": error_msg}

        send_message_func({"log": {"text": f"[yt-dlp]: Found at '{current_path}'.", "type": "info"}})
        version_before = _get_ytdlp_version(current_path, send_message_func)
        if version_before:
            send_message_func({"log": {"text": f"[yt-dlp]: Current version: {version_before}", "type": "info"}})

        # Determine if sudo prefix is needed for Linux
        command_prefix = _get_linux_sudo_command_prefix(current_path, send_message_func)
        
        full_command = command_prefix + [current_path, '-U']

        return_code = _run_update_command(full_command, send_message_func)

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

# --- MPV Command Construction ---

class MpvCommandBuilder:
    def __init__(self, mpv_exe, use_ytdl_mpv=False, is_youtube_override=False):
        self.mpv_exe = mpv_exe
        self.mpv_args = [
            mpv_exe,
            '--cache=yes',
            '--demuxer-max-bytes=1G',
            '--demuxer-max-back-bytes=500M',
            '--cache-secs=300',
            '--demuxer-readahead-secs=300',
            '--stream-buffer-size=5M'
        ]
        self.has_terminal_flag = False
        self.is_forced_terminal = False
        self.url = None
        self.headers_from_bypass = None # This is still kept for legacy/specific cases if needed
        self.ytdl_raw_options_from_bypass = None # This is still kept for legacy/specific cases if needed
        self.use_ytdl_mpv = use_ytdl_mpv # Now directly initialized
        self.is_youtube_override = is_youtube_override # Now directly initialized

    def with_ipc_path(self, ipc_path):
        if ipc_path:
            self.mpv_args.append(f'--input-ipc-server={ipc_path}')
        return self

    def with_url(self, url):
        if url:
            self.url = url
        return self

    def with_completion_script(self, script_dir):
        if script_dir:
            lua_script_path = os.path.join(script_dir, "data", "on_completion.lua")
            if os.path.exists(lua_script_path):
                self.mpv_args.append(f'--script={lua_script_path}')
                logging.info(f"MPV will load completion script: {lua_script_path}")
            else:
                logging.warning(f"Completion script not found at {lua_script_path}. MPV will not use it.")
        return self

    def with_adaptive_headers_script(self, script_dir):
        if script_dir:
            lua_script_path = os.path.join(script_dir, "mpv_scripts", "adaptive_headers.lua")
            if os.path.exists(lua_script_path):
                self.mpv_args.append(f'--script={lua_script_path}')
                logging.info(f"MPV will load adaptive headers script: {lua_script_path}")
        return self

    def with_fix_thumbnailer_script(self, script_dir):
        if script_dir:
            lua_script_path = os.path.join(script_dir, "mpv_scripts", "fix_thumbnailer_playlist.lua")
            if os.path.exists(lua_script_path):
                self.mpv_args.append(f'--script={lua_script_path}')
                logging.info(f"MPV will load thumbnailer fix script: {lua_script_path}")
        return self

    def with_title(self, title):
        if title:
            # Set the initial title for the first file loaded
            self.mpv_args.append(f'--force-media-title={title}')
        return self

    def with_automatic_flags(self, automatic_mpv_flags):
        if automatic_mpv_flags:
            for flag_info in automatic_mpv_flags:
                if flag_info.get('enabled'):
                    if flag_info.get('flag') == '--terminal':
                        self.has_terminal_flag = True
                    elif flag_info.get('flag'):
                        self.mpv_args.append(flag_info.get('flag'))
        return self

    def with_force_terminal(self, force):
        if force:
            self.has_terminal_flag = True
            self.is_forced_terminal = True
        return self

    def with_headers(self, headers):
        effective_headers = self.headers_from_bypass if self.headers_from_bypass else headers
        if effective_headers:
            header_list = [f"{k}: {v.replace(',', '')}" for k, v in effective_headers.items()]
            self.mpv_args.append(f'--http-header-fields={",".join(header_list)}')
            if 'User-Agent' in effective_headers:
                self.mpv_args.append(f'--user-agent={effective_headers["User-Agent"]}')
            if 'Referer' in effective_headers:
                self.mpv_args.append(f'--referrer={effective_headers["Referer"]}')
        return self

    def with_disable_http_persistent(self, disable_http_persistent):
        if disable_http_persistent:
            self.mpv_args.append('--demuxer-lavf-o=http_persistent=0')
        return self

    def with_start_paused(self, start_paused):
        if start_paused and '--pause' not in self.mpv_args:
            self.mpv_args.append('--pause')
        return self

    def with_custom_flags(self, custom_mpv_flags):
        if custom_mpv_flags:
            try:
                self.mpv_args.extend(shlex.split(custom_mpv_flags))
            except Exception as e:
                logging.error(f"Could not parse custom MPV flags '{custom_mpv_flags}'. Error: {e}")
        return self

    def with_geometry(self, geometry, custom_width, custom_height):
        if custom_width and custom_height:
            self.mpv_args.append(f'--geometry={custom_width}x{custom_height}')
        elif geometry:
            self.mpv_args.append(f'--geometry={geometry}')
        return self
    
    def with_idle(self, idle=True):
        if isinstance(idle, str):
            self.mpv_args.append(f'--idle={idle}')
        elif idle:
            self.mpv_args.append('--idle=yes')
        return self
    
    def with_youtube_options(self, original_is_youtube, ytdl_raw_options):
        # The use_ytdl_mpv and is_youtube_override flags are now set directly in the constructor
        # from the result of url_analyzer, so we use those directly.
        # ONLY enable ytdl if we actually want MPV to do the resolution.
        if self.use_ytdl_mpv:
            self.mpv_args.append('--ytdl=yes')
            effective_ytdl_opts = ytdl_raw_options or self.ytdl_raw_options_from_bypass
            
            if effective_ytdl_opts:
                self.mpv_args.append(f'--ytdl-raw-options={effective_ytdl_opts}')
        # Original is_youtube flag is only used if not overridden by url_analyzer result
        elif original_is_youtube and not self.is_youtube_override:
            # This is for the case where analyzer didn't run or didn't override
            self.mpv_args.append('--ytdl=yes')
            if ytdl_raw_options:
                self.mpv_args.append(f'--ytdl-raw-options={ytdl_raw_options}')
        return self

    def build(self):
        # Detect if --terminal was added via custom flags or automatic flags
        if '--terminal' in self.mpv_args or 'terminal' in self.mpv_args:
            self.has_terminal_flag = True
            # Remove the literal flag from the args list as we'll use a wrapper instead
            self.mpv_args = [arg for arg in self.mpv_args if arg != '--terminal' and arg != 'terminal']

        # Only add the separator and URL if a URL is actually provided
        if self.url:
            full_command = self.mpv_args + ['--'] + [self.url]
        else:
            full_command = self.mpv_args
            
        logging.info(f"Constructed MPV command: {' '.join(shlex.quote(arg) for arg in full_command)}")

        if platform.system() != "Windows" and self.has_terminal_flag:
            # We use a shell wrapper inside the terminal to ensure it stays open 
            # if the terminal emulator itself forks and exits immediately.
            inner_cmd_str = ' '.join(shlex.quote(arg) for arg in full_command)
            
            if self.is_forced_terminal:
                # Forced terminal stays open for 10s or requires manual close (hold)
                wrapped_cmd_str = f"{inner_cmd_str}; echo ''; echo '--- Process Finished. Closing in 10s... ---'; sleep 10"
            else:
                # Standard terminal flag closes immediately
                wrapped_cmd_str = f"{inner_cmd_str}"
            
            term_cmd = []
            
            # 1. Try modern/generic wrappers first
            if shutil.which('xdg-terminal-exec'):
                logging.info("Terminal Wrapper: Using xdg-terminal-exec")
                term_cmd = ['xdg-terminal-exec', 'sh', '-c', wrapped_cmd_str]
            elif shutil.which('x-terminal-emulator'):
                logging.info("Terminal Wrapper: Using x-terminal-emulator")
                term_cmd = ['x-terminal-emulator', '-e', 'sh', '-c', wrapped_cmd_str]
            
            # 2. Modern Terminals (Modern Konsole, Gnome, Kitty, Alacritty, etc. all support --)
            if not term_cmd:
                modern_terminals = ['gnome-terminal', 'kitty', 'alacritty', 'tilix', 'foot', 'wezterm']
                for t in modern_terminals:
                    t_path = shutil.which(t)
                    if t_path:
                        logging.info(f"Terminal Wrapper: Using modern terminal syntax for {t} at {t_path}")
                        term_cmd = [t_path, '--', 'sh', '-c', wrapped_cmd_str]
                        break
            
            # 3. Classic Terminals (Legacy/X11 style using -e)
            if not term_cmd:
                classic_terminals = ['konsole', 'xfce4-terminal', 'urxvt', 'rxvt', 'termit', 'terminology', 'xterm']
                for t in classic_terminals:
                    t_path = shutil.which(t)
                    if t_path:
                        logging.info(f"Terminal Wrapper: Using classic terminal syntax for {t} at {t_path}")
                        if t == 'konsole':
                            if self.is_forced_terminal:
                                # Forced Konsole uses native --hold
                                term_cmd = [t_path, '--hold', '-e'] + full_command
                            else:
                                # Standard Konsole closes on exit
                                term_cmd = [t_path, '-e'] + full_command
                        elif t == 'xfce4-terminal':
                            term_cmd = [t_path, '--disable-server', '-x', 'sh', '-c', wrapped_cmd_str]
                        else:
                            term_cmd = [t_path, '-e', 'sh', '-c', wrapped_cmd_str]
                        break
            
            if term_cmd:
                full_command = term_cmd
            else:
                logging.warning("Terminal Wrapper: No supported terminal emulator found in PATH. Launching without terminal.")

        return full_command, self.has_terminal_flag

def construct_mpv_command(
    mpv_exe,
    ipc_path=None,
    url=None,
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
    load_on_completion_script=False,
    title=None,
    use_ytdl_mpv=False,
    is_youtube_override=False,
    idle=False, # Added parameter
    force_terminal=False
):
    """Constructs the MPV command line arguments using MpvCommandBuilder."""
    builder = MpvCommandBuilder(
        mpv_exe=mpv_exe,
        use_ytdl_mpv=use_ytdl_mpv,
        is_youtube_override=is_youtube_override
    ) \
        .with_ipc_path(ipc_path) \
        .with_url(url) \
        .with_idle(idle) \
        .with_force_terminal(force_terminal) \
        .with_completion_script(script_dir if load_on_completion_script else None) \
        .with_adaptive_headers_script(script_dir) \
        .with_fix_thumbnailer_script(script_dir) \
        .with_title(title) \
        .with_automatic_flags(automatic_mpv_flags) \
        .with_headers(headers) \
        .with_disable_http_persistent(disable_http_persistent) \
        .with_start_paused(start_paused) \
        .with_custom_flags(custom_mpv_flags) \
        .with_geometry(geometry, custom_width, custom_height) \
        .with_youtube_options(is_youtube, ytdl_raw_options)
        
    return builder.build()

def get_mpv_popen_kwargs(has_terminal_flag):
    """Returns the subprocess arguments for launching MPV."""
    popen_kwargs = {
        'stdout': subprocess.PIPE,
        'stderr': subprocess.STDOUT,
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

def apply_bypass_script(url_item, send_message_func):
    """
    Applies URL analysis logic if enabled in settings.
    Returns a tuple of (processed_url, headers_dict, ytdl_raw_options, use_ytdl_mpv_flag, is_youtube_flag).
    """
    if not isinstance(url_item, dict):
        url_item = {'url': url_item if url_item else "", 'settings': {}}

    original_url = url_item['url']
    
    # Load URL analysis settings from config
    settings = file_io.get_settings()
    enable_url_analysis = settings.get("enable_url_analysis", False)
    browser_for_analysis = settings.get("browser_for_url_analysis", "chrome")
    enable_youtube_analysis = settings.get("enable_youtube_analysis", False)
    user_agent_string = settings.get("user_agent_string", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

    # The default fallback return values
    is_youtube = "youtube.com/" in original_url or "youtu.be/" in original_url
    default_return_tuple = (original_url, None, None, False, is_youtube, None, False, None)

    if not enable_url_analysis:
        return default_return_tuple

    # is_youtube for bypass script is driven by enable_youtube_analysis setting
    youtube_enabled_for_script = "true" if enable_youtube_analysis else "false"

    try:
        logging.info(f"Executing URL analysis for URL: {original_url}")
        send_message_func({"action": "log_from_native_host", "log": {"text": f"Running URL analysis for: {original_url}", "type": "info"}})
        
        # Directly call the run_bypass_logic function from url_analyzer
        result = url_analyzer.run_bypass_logic(original_url, browser_for_analysis, youtube_enabled_for_script, user_agent_string)

        if not result.get("success", False):
            error_message = result.get("error", "Unknown error from URL analyzer.")
            logging.error(f"URL analysis indicated failure: {error_message}")
            send_message_func({"action": "log_from_native_host", "log": {"text": f"URL analysis failed: {error_message}. Playing original URL.", "type": "error"}})
            return default_return_tuple

        processed_url = result.get("url", original_url)
        headers_for_mpv = result.get("headers")
        ytdl_raw_options_for_mpv = result.get("ytdl_raw_options")
        use_ytdl_mpv_flag = result.get("use_ytdl_mpv", False)
        # FORCE is_youtube to False if we are not using internal ytdl hook, 
        # to prevent mpv from trying to use it anyway.
        is_youtube_flag_from_script = result.get("is_youtube", False) if use_ytdl_mpv_flag else False
        entries = result.get("entries")
        disable_http_persistent = result.get("disable_http_persistent", False)
        cookies_file = result.get("cookies_file")

        return (processed_url, headers_for_mpv, ytdl_raw_options_for_mpv, use_ytdl_mpv_flag, is_youtube_flag_from_script, entries, disable_http_persistent, cookies_file)

    except Exception as e:
        logging.error(f"Error during URL analysis: {e}")
        send_message_func({"action": "log_from_native_host", "log": {"text": f"URL analysis failed with exception: {e}. Playing original URL.", "type": "error"}})
        return (original_url, None, None, False, is_youtube, None, False, None) # Return 8-tuple here too
# --- AniList Service ---

class AniListCache:
    def __init__(self, cache_file, script_dir, send_message_func):
        self.cache_file = cache_file
        self.script_dir = script_dir
        self.send_message = send_message_func
        self.CACHE_DURATION_S = 30 * 60 # 30 minutes

    def _fetch_from_anilist_script(self, is_ping):
        """Helper function to execute the anilist_releases.py script."""
        try:
            script_path = os.path.join(self.script_dir, 'anilist_releases.py')
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

    def _load_cache(self):
        """Loads cache data from the cache file."""
        if os.path.exists(self.cache_file):
            try:
                with open(self.cache_file, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except (json.JSONDecodeError, IOError) as e:
                logging.warning(f"Could not read {self.cache_file}: {e}. Will perform a full fetch.")
        return None

    def _save_cache(self, cache_data):
        """Saves cache data to the cache file."""
        try:
            with open(self.cache_file, 'w', encoding='utf-8') as f:
                json.dump(cache_data, f, indent=4)
            logging.info(f"{self.cache_file} updated with new data.")
        except (IOError) as e:
            logging.error(f"Failed to write new {self.cache_file}: {e}")

def get_anilist_releases_with_cache(force_refresh, delete_cache, is_cache_disabled, cache_file, script_dir, send_message_func):
    """Handles fetching AniList releases with a file-based caching mechanism."""
    
    anilist_cache = AniListCache(cache_file, script_dir, send_message_func)
    now = time.time()

    if is_cache_disabled:
        logging.info("AniList cache is disabled. Fetching directly from API.")
        send_message_func({"log": {"text": "[AniList]: Cache disabled. Fetching new data from API.", "type": "info"}})
        return anilist_cache._fetch_from_anilist_script(is_ping=False)

    if delete_cache and os.path.exists(anilist_cache.cache_file):
        try:
            os.remove(anilist_cache.cache_file)
            logging.info("Deleted anilist_cache.json as requested.")
            send_message_func({"log": {"text": "[AniList]: Cache file deleted.", "type": "info"}})
        except OSError as e:
            logging.error(f"Failed to delete anilist_cache.json: {e}")

    if force_refresh:
        logging.info("Forcing a full refresh of AniList data.")
        send_message_func({"log": {"text": "[AniList]: Manual refresh requested. Fetching new data...", "type": "info"}})
        return anilist_cache._fetch_from_anilist_script(is_ping=False)

    cache = anilist_cache._load_cache()

    if cache and 'timestamp' in cache and 'data' in cache:
        from datetime import datetime
        is_expired_by_timer = (now - cache['timestamp'] > anilist_cache.CACHE_DURATION_S)
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
        
        ping_response = anilist_cache._fetch_from_anilist_script(is_ping=True)
        
        if ping_response['success']:
            try:
                ping_data = json.loads(ping_response['output'])
                ping_airing_ats = ping_data.get('airingAt_list', [])
                cached_airing_ats = cache.get('sorted_airing_ats', [])

                if sorted(ping_airing_ats) == cached_airing_ats:
                    logging.info("No change in release timestamps. Serving from local file and updating timestamp.")
                    send_message_func({"log": {"text": "[AniList]: Loaded from local file (no new releases found).", "type": "info"}})
                    
                    cache['timestamp'] = now
                    anilist_cache._save_cache(cache)
                    
                    return {"success": True, "output": json.dumps(cache['data'])}
            except (json.JSONDecodeError, KeyError) as e:
                logging.warning(f"Failed to process ping response: {e}. Proceeding with full fetch.")
        else:
            logging.warning("AniList ping failed. Proceeding with full fetch.")

    logging.info("Performing a full fetch of AniList data.")
    send_message_func({"log": {"text": "[AniList]: Fetching new data from AniList API...", "type": "info"}})
    full_fetch_response = anilist_cache._fetch_from_anilist_script(is_ping=False)
    
    if full_fetch_response['success'] and not is_cache_disabled:
        try:
            full_data = json.loads(full_fetch_response['output'])
            sorted_ats = sorted([s['airingAt'] for s in full_data.get('raw_schedules_for_cache', [])])
            new_cache = {"timestamp": now, "data": full_data, "sorted_airing_ats": sorted_ats}
            anilist_cache._save_cache(new_cache)
            logging.info("AniList file cache updated with new data.")
        except (json.JSONDecodeError, IOError) as e:
            logging.error(f"Failed to write new AniList cache file: {e}")

    return full_fetch_response
