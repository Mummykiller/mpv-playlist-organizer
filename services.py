import json
import logging
import os
import platform
import shutil
import subprocess
import sys
from datetime import datetime

# Prevent __pycache__ generation
sys.dont_write_bytecode = True
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'

import time
import urllib.request
import shlex
import re
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
    '--loop-playlist',
    '--loop-file',
    '--pause',
    '--save-position-on-quit',

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
    '--scale',
    '--cscale',
    '--dscale',
    '--dither-depth',
    '--deband',
    '--deband-iterations',
    '--deband-threshold',
    '--deband-range',
    '--fbo-format',
    '--profile',
    '--video-sync',
    '--interpolation',
    '--tscale',

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
    '--input-terminal',
}


def get_gpu_vendor():
    """Detects the GPU vendor (nvidia, intel, amd, or apple) for hardware decoding selection."""
    system = platform.system()
    try:
        if system == "Windows":
            # Use wmic to get GPU name on Windows
            cmd = ["wmic", "path", "win32_VideoController", "get", "name"]
            output = subprocess.check_output(cmd, stderr=subprocess.STDOUT, text=True, creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, 'CREATE_NO_WINDOW') else 0)
            output = output.lower()
        elif system == "Darwin":
            return "apple"
        else:
            # Use lspci on Linux
            if shutil.which("lspci"):
                output = subprocess.check_output(["lspci"], stderr=subprocess.STDOUT, text=True).lower()
            else:
                # Fallback for systems without lspci
                return "unknown"

        if "nvidia" in output:
            return "nvidia"
        elif "intel" in output:
            return "intel"
        elif "amd" in output or "radeon" in output:
            return "amd"
    except Exception as e:
        logging.debug(f"GPU detection failed: {e}")
    
    return "unknown"

def sanitize_url(url):
    """Sanitizes a URL by removing potentially dangerous characters for shell commands."""
    return file_io.sanitize_string(url, is_filename=False)

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

def _get_ffmpeg_version(path_to_exe, send_message_func):
    """Runs 'ffmpeg -version' and returns the first line of output."""
    try:
        result = subprocess.run(
            [path_to_exe, '-version'],
            capture_output=True, text=True, check=True, timeout=10,
            encoding='utf-8', errors='ignore'
        )
        first_line = result.stdout.splitlines()[0] if result.stdout else "Unknown version"
        return first_line
    except Exception as e:
        logging.error(f"Could not get FFmpeg version: {e}")
        return None

def _get_node_version(path_to_exe):
    """Runs 'node -v' and returns the output."""
    try:
        result = subprocess.run(
            [path_to_exe, '-v'],
            capture_output=True, text=True, check=True, timeout=10,
            encoding='utf-8', errors='ignore'
        )
        return result.stdout.strip()
    except Exception as e:
        logging.error(f"Could not get Node.js version: {e}")
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

# Global cache for dependency status to avoid redundant shell calls
_DEPENDENCY_STATUS_CACHE = {
    "data": None,
    "timestamp": 0
}
CACHE_EXPIRY_SECONDS = 300 # 5 minutes

def check_mpv_and_ytdlp_status(get_mpv_executable_func, send_message_func, force_refresh=False):
    """Checks for the presence and version of mpv, yt-dlp, and ffmpeg executables. Results are cached."""
    global _DEPENDENCY_STATUS_CACHE
    
    now = time.time()
    if not force_refresh and _DEPENDENCY_STATUS_CACHE["data"] and (now - _DEPENDENCY_STATUS_CACHE["timestamp"] < CACHE_EXPIRY_SECONDS):
        logging.debug("Using cached dependency status.")
        return _DEPENDENCY_STATUS_CACHE["data"]

    mpv_status = {"found": False, "path": None, "error": None}
    ytdlp_status = {"found": False, "path": None, "version": None, "error": None}
    ffmpeg_status = {"found": False, "path": None, "version": None, "error": None}
    node_status = {"found": False, "path": None, "version": None, "error": None}
    system = platform.system()

    # MPV Check
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

    # yt-dlp Check
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

    # ffmpeg Check (Critical for >1080p)
    ffmpeg_exe_name = "ffmpeg.exe" if system == "Windows" else "ffmpeg"
    
    # 1. Try Configured Path
    config = file_io._safe_json_load(file_io.CONFIG_FILE)
    ffmpeg_path = config.get("ffmpeg_path")
    
    if ffmpeg_path and not (os.path.exists(ffmpeg_path) and os.access(ffmpeg_path, os.X_OK)):
        ffmpeg_path = None # Invalid, reset to trigger search

    # 2. Aggressive Search Fallback
    if not ffmpeg_path:
        ffmpeg_path = shutil.which(ffmpeg_exe_name)
        
        if not ffmpeg_path:
            search_dirs = []
            if system == "Linux":
                search_dirs.extend([
                    "/usr/bin", "/usr/local/bin", "/usr/bin/ffmpeg-static",
                    os.path.expanduser("~/.local/bin"),
                    os.path.expanduser("~/bin")
                ])
            
            if mpv_status["found"] and os.path.isabs(mpv_status["path"]):
                search_dirs.append(os.path.dirname(mpv_status["path"]))

            for d in search_dirs:
                p = os.path.join(d, ffmpeg_exe_name)
                if os.path.exists(p) and os.access(p, os.X_OK):
                    ffmpeg_path = p
                    break
        
        # 3. Shell Fallback
        if not ffmpeg_path and system == "Linux":
            for cmd in [["which", "ffmpeg"], ["sh", "-c", "command -v ffmpeg"]]:
                try:
                    res = subprocess.check_output(cmd, text=True, stderr=subprocess.DEVNULL).strip()
                    if res and os.path.exists(res):
                        ffmpeg_path = res
                        break
                except: pass

    if ffmpeg_path:
        ffmpeg_status["found"] = True
        ffmpeg_status["path"] = ffmpeg_path
        # Auto-update config if this is a new discovery
        if ffmpeg_path != config.get("ffmpeg_path"):
            file_io.set_settings({"ffmpeg_path": ffmpeg_path})
            logging.info(f"Self-Healing: Updated FFmpeg path to {ffmpeg_path}")
            
        ffmpeg_ver = _get_ffmpeg_version(ffmpeg_path, send_message_func)
        if ffmpeg_ver:
            ffmpeg_status["version"] = ffmpeg_ver
    else:
        ffmpeg_status["error"] = "Not found. Required for 1440p/4K resolution."

    # Node.js Check (Critical for YouTube n-challenge/1440p+)
    node_exe_name = "node.exe" if system == "Windows" else "node"
    node_path = shutil.which(node_exe_name)
    if node_path:
        node_status["found"] = True
        node_status["path"] = node_path
        node_ver = _get_node_version(node_path)
        if node_ver:
            node_status["version"] = node_ver
    else:
        node_status["error"] = "Not found. Highly recommended for 1440p+ YouTube playback."

    logging.info(f"Dependency check: MPV={mpv_status['found']}, YTDLP={ytdlp_status['found']}, FFMPEG={ffmpeg_status['found']}, NODE={node_status['found']}")
    
    result = {"success": True, "mpv": mpv_status, "ytdlp": ytdlp_status, "ffmpeg": ffmpeg_status, "node": node_status}
    
    # Update cache
    _DEPENDENCY_STATUS_CACHE["data"] = result
    _DEPENDENCY_STATUS_CACHE["timestamp"] = now
    
    return result

# --- MPV Command Construction ---

# --- MPV Command Construction ---

class MpvCommandBuilder:
    def __init__(self, mpv_exe, use_ytdl_mpv=False, is_youtube_override=False, is_youtube=False, settings=None):
        self.mpv_exe = mpv_exe
        self.mpv_args = [mpv_exe]
        self.settings = settings
        
        if settings:
            # Apply dynamic networking and buffering flags from settings
            # Skip if user has requested to use MPV's native defaults
            if not settings.get('disable_network_overrides', False):
                cache_enabled = settings.get('enable_cache', True)
                self.mpv_args.append(f"--cache={'yes' if cache_enabled else 'no'}")
                
                if cache_enabled:
                    if settings.get('demuxer_max_bytes'):
                        self.mpv_args.append(f"--demuxer-max-bytes={settings['demuxer_max_bytes']}")
                    if settings.get('demuxer_max_back_bytes'):
                        self.mpv_args.append(f"--demuxer-max-back-bytes={settings['demuxer_max_back_bytes']}")
                    if settings.get('cache_secs'):
                        self.mpv_args.append(f"--cache-secs={settings['cache_secs']}")
                    if settings.get('demuxer_readahead_secs'):
                        self.mpv_args.append(f"--demuxer-readahead-secs={settings['demuxer_readahead_secs']}")
                    if settings.get('stream_buffer_size'):
                        self.mpv_args.append(f"--stream-buffer-size={settings['stream_buffer_size']}")

            # Apply Hardware Decoder
            decoder = settings.get('mpv_decoder', 'auto')
            if decoder:
                self.mpv_args.append(f"--hwdec={decoder}")

            # Apply Performance Profile
            profile = settings.get('performance_profile', 'default')
            if profile == 'low':
                self.mpv_args.append("--profile=fast")
            elif profile == 'medium':
                # Balanced quality: Spline36 is a good middle ground scaler
                self.mpv_args.append("--scale=spline36")
                self.mpv_args.append("--cscale=spline36")
                self.mpv_args.append("--vo=gpu")
            elif profile == 'high':
                self.mpv_args.append("--profile=gpu-hq")
            elif profile == 'ultra':
                # Enthusiast settings: Max quality scaling + Smooth Motion + High Precision
                self.mpv_args.append("--profile=gpu-hq")
                
                # Granular toggles for Ultra features (default to True)
                if settings.get('ultra_scalers', True):
                    self.mpv_args.append("--scale=ewa_lanczossharp")
                    self.mpv_args.append("--cscale=ewa_lanczossharp")
                
                if settings.get('ultra_video_sync', True):
                    self.mpv_args.append("--video-sync=display-resample")

                # Handle Interpolation Mode (String or Boolean legacy)
                interp_mode = settings.get('ultra_interpolation', 'oversample')
                
                # Backwards compatibility: convert booleans to defaults
                if interp_mode is True: interp_mode = 'oversample'
                if interp_mode is False: interp_mode = 'off'

                if interp_mode and interp_mode != 'off':
                    self.mpv_args.append("--interpolation=yes")
                    self.mpv_args.append(f"--tscale={interp_mode}")
                
                if settings.get('ultra_deband', True):
                    self.mpv_args.append("--deband=yes")
                    self.mpv_args.append("--deband-iterations=4")
                    self.mpv_args.append("--deband-threshold=48")
                    self.mpv_args.append("--deband-range=24")
                
                if settings.get('ultra_fbo', True):
                    self.mpv_args.append("--fbo-format=rgba16f") # High bit-depth processing
            # 'default' sends no flags, letting mpv.conf take over
            
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
            if isinstance(url, list):
                self.url = [sanitize_url(u) for u in url]
            else:
                self.url = sanitize_url(url)
        return self

    def with_completion_script(self, script_dir, flag_dir=None):
        if script_dir:
            lua_script_path = os.path.join(script_dir, "mpv_scripts", "on_completion.lua")
            if os.path.exists(lua_script_path):
                self.mpv_args.append(f'--script={lua_script_path}')
                if flag_dir:
                    self.mpv_args.append(f'--script-opts=on_completion-flag_dir={flag_dir}')
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

    def with_reanimator_script(self, script_dir):
        if script_dir:
            lua_script_path = os.path.join(script_dir, "mpv_scripts", "stream_reanimator.lua")
            if os.path.exists(lua_script_path):
                self.mpv_args.append(f'--script={lua_script_path}')
                logging.info(f"MPV will load stream reanimator script: {lua_script_path}")
        return self

    def with_title(self, title):
        if title:
            # Use --title instead of --force-media-title.
            # --title sets the window title, but doesn't override the per-file media title
            # displayed in the seek bar/OSD like --force-media-title does.
            clean_title = file_io.sanitize_string(title)
            self.mpv_args.append(f'--title={clean_title}')
        return self

    def with_automatic_flags(self, automatic_mpv_flags):
        if automatic_mpv_flags:
            for flag_info in automatic_mpv_flags:
                if flag_info.get('enabled'):
                    flag = flag_info.get('flag')
                    if not flag:
                        continue
                        
                    if flag == '--terminal':
                        self.has_terminal_flag = True
                    elif flag.startswith('--hwdec'):
                        # Skip hwdec flags in automatic flags to avoid conflicts with 
                        # the dedicated dropdown setting.
                        logging.debug(f"MpvCommandBuilder: Ignoring redundant hwdec flag in automatic flags: {flag}")
                        continue
                    else:
                        # --- SANITIZATION CHECK ---
                        # Extract flag name (left of '=')
                        flag_name = flag.split('=', 1)[0]
                        if flag_name in SAFE_MPV_FLAGS_ALLOWLIST:
                            self.mpv_args.append(flag)
                        else:
                            logging.warning(f"Security: Dropped automatic flag '{flag}' because '{flag_name}' is not in the allowlist.")
        return self

    def with_force_terminal(self, force):
        if force:
            self.has_terminal_flag = True
            self.is_forced_terminal = True
        return self

    def with_input_terminal(self, val):
        if val:
            self.mpv_args.append(f'--input-terminal={val}')
        return self

    def with_headers(self, headers):
        effective_headers = self.headers_from_bypass if self.headers_from_bypass else headers
        if effective_headers:
            header_list = []
            for k, v in effective_headers.items():
                # Sanitize value: remove dangerous characters and commas
                clean_v = file_io.sanitize_string(v).replace(',', '')
                header_list.append(f"{k}: {clean_v}")
                
            self.mpv_args.append(f'--http-header-fields={",".join(header_list)}')
            
            # Sanitize specific UA/Referer if they exist
            if 'User-Agent' in effective_headers:
                self.mpv_args.append(f'--user-agent={file_io.sanitize_string(effective_headers["User-Agent"])}')
            if 'Referer' in effective_headers:
                self.mpv_args.append(f'--referrer={file_io.sanitize_string(effective_headers["Referer"])}')
        return self

    def with_disable_http_persistent(self, disable_http_persistent):
        # Only apply if not overridden by global networking toggle
        if not (hasattr(self, 'settings') and self.settings and self.settings.get('disable_network_overrides', False)):
            mode = self.settings.get('http_persistence', 'auto') if self.settings else 'auto'
            
            if mode == 'on':
                # Force persistence ON (do not add the disable flag)
                pass 
            elif mode == 'off':
                # Force persistence OFF
                self.mpv_args.append('--demuxer-lavf-o=http_persistent=0')
            else:
                # 'auto': follow site-specific recommendation
                if disable_http_persistent:
                    self.mpv_args.append('--demuxer-lavf-o=http_persistent=0')
        return self

    def with_start_paused(self, start_paused):
        if start_paused and '--pause' not in self.mpv_args:
            self.mpv_args.append('--pause')
        return self

    def with_custom_flags(self, custom_mpv_flags):
        if custom_mpv_flags:
            parsed_args = []
            try:
                # Handle new format: List of objects [{flag: "--x", enabled: true}, ...]
                if isinstance(custom_mpv_flags, list):
                    for flag_info in custom_mpv_flags:
                        if isinstance(flag_info, dict) and flag_info.get('enabled', True):
                            flag = flag_info.get('flag')
                            if flag:
                                parsed_args.extend(shlex.split(flag))
                        elif isinstance(flag_info, str):
                            parsed_args.extend(shlex.split(flag_info))
                # Handle legacy format: Plain string
                elif isinstance(custom_mpv_flags, str):
                    parsed_args.extend(shlex.split(custom_mpv_flags))
            except Exception as e:
                logging.error(f"Could not parse custom MPV flags '{custom_mpv_flags}'. Error: {e}")
                return self

            # --- SANITIZATION STEP ---
            for arg in parsed_args:
                # 1. Enforce --flag=value syntax (no space-separated args)
                if not arg.startswith('--'):
                    logging.warning(f"Security: Dropped custom flag '{arg}' because it does not start with '--'. "
                                    f"Space-separated arguments are not allowed; use '--flag=value'.")
                    continue
                
                # 2. Extract flag name
                flag_name = arg.split('=', 1)[0]
                
                # 3. Allowlist check
                if flag_name in SAFE_MPV_FLAGS_ALLOWLIST:
                    self.mpv_args.append(arg)
                else:
                    logging.warning(f"Security: Dropped custom flag '{arg}' because '{flag_name}' is not in the allowlist.")

        return self

    def with_geometry(self, geometry, custom_width, custom_height):
        # Strict regex for geometry: digits, x, +, -, %
        # Prevents flag injection via geometry strings.
        GEOM_PATTERN = re.compile(r'^[0-9x+%+-]+$')

        if custom_width and custom_height:
            w_str, h_str = str(custom_width), str(custom_height)
            if GEOM_PATTERN.match(w_str) and GEOM_PATTERN.match(h_str):
                self.mpv_args.append(f'--geometry={w_str}x{h_str}')
        elif geometry:
            geom_str = str(geometry)
            if GEOM_PATTERN.match(geom_str):
                self.mpv_args.append(f'--geometry={geom_str}')
            else:
                logging.warning(f"Security: Dropped invalid geometry string: '{geom_str}'")
        return self
    
    def with_playlist_start(self, index):
        if index is not None and index > 0:
            self.mpv_args.append(f'--playlist-start={index}')
        return self
    
    def with_idle(self, idle=True):
        if isinstance(idle, str):
            self.mpv_args.append(f'--idle={idle}')
        elif idle:
            self.mpv_args.append('--idle=yes')
        return self
    
    def with_youtube_options(self, original_is_youtube, ytdl_raw_options):
        # Determine format for both flows
        ytdl_format = None
        q = None
        if self.settings and self.settings.get('ytdl_quality'):
            q = str(self.settings['ytdl_quality'])
            
        logging.info(f"MpvCommandBuilder: Determined ytdl_quality is '{q}'")

        # Global stability and responsiveness for all streaming content
        self.mpv_args.append("--force-seekable=yes")
        self.mpv_args.append("--demuxer-thread=yes")
        self.mpv_args.append("--cache-pause-initial=no")

        if q and q != 'best':
            if q in ['2160', '1440', '1080', '720', '480']:
                # For resolutions > 1080p, we MUST prefer VP9/AV1 as H264 stops at 1080p.
                if int(q) > 1080:
                    ytdl_format = f"bv*[height<=?{q}][vcodec~='^vp0?9|^av01']+ba/bv*[height<=?{q}]+ba/best"
                else:
                    ytdl_format = f"bv*[height<=?{q}]+ba/best"
        else:
            # Absolute best merged stream
            ytdl_format = "bv*+ba/best"
        
        logging.info(f"MpvCommandBuilder: Final ytdl_format string: '{ytdl_format}'")

        # --- Centralized Flag Collection ---
        essential_flags = "ignore-config=,remote-components=ejs:github,js-runtimes=node"
        config = file_io._safe_json_load(file_io.CONFIG_FILE)
        
        ffmpeg_path = config.get("ffmpeg_path")
        if ffmpeg_path and os.path.exists(ffmpeg_path):
            essential_flags = f"{essential_flags},ffmpeg-location={ffmpeg_path}"
            
        node_path = config.get("node_path")
        if node_path and os.path.exists(node_path):
            # yt-dlp uses --javascript-delay but for the runtime path it looks at PATH
            # or we can sometimes specify it. 
            # Actually, yt-dlp doesn't have a direct 'node-location' flag in ytdl-raw-options 
            # that is standard, but some versions/forks might.
            # The most reliable way is to ensure it's in PATH, which native_host.py does.
            # HOWEVER, we can also try to pass it if we use a specific yt-dlp wrapper.
            # For now, let's stick to the PATH injection in native_host.py but 
            # let's also ensure we don't have any conflicting 'no-check-certificate' or similar
            # that might be causing issues.
            pass

        if self.use_ytdl_mpv:
            self.mpv_args.append('--ytdl=yes')
            if ytdl_format:
                self.mpv_args.append(f"--ytdl-format={ytdl_format}")

            raw_opts = ytdl_raw_options or self.ytdl_raw_options_from_bypass or ""
            
            if self.settings and self.settings.get('ytdlp_concurrent_fragments', 1) > 1:
                frag_opt = f"concurrent-fragments={self.settings['ytdlp_concurrent_fragments']}"
                raw_opts = f"{raw_opts},{frag_opt}" if raw_opts else frag_opt
            
            # Merge with essential flags
            final_raw_opts = file_io.merge_ytdlp_options(raw_opts, essential_flags)
            if final_raw_opts:
                self.mpv_args.append(f'--ytdl-raw-options={final_raw_opts}')

        elif original_is_youtube and not self.is_youtube_override:
            self.mpv_args.append('--ytdl=yes')
            if ytdl_format:
                self.mpv_args.append(f"--ytdl-format={ytdl_format}")
            
            raw_opts = ytdl_raw_options or ""

            if self.settings and self.settings.get('ytdlp_concurrent_fragments', 1) > 1:
                frag_opt = f"concurrent-fragments={self.settings['ytdlp_concurrent_fragments']}"
                raw_opts = f"{raw_opts},{frag_opt}" if raw_opts else frag_opt

            # Merge with essential flags
            final_raw_opts = file_io.merge_ytdlp_options(raw_opts, essential_flags)
            if final_raw_opts:
                self.mpv_args.append(f'--ytdl-raw-options={final_raw_opts}')
        return self

    def build(self):
        # Detect if --terminal was added via custom flags or automatic flags
        if '--terminal' in self.mpv_args or 'terminal' in self.mpv_args:
            self.has_terminal_flag = True
            # Remove the literal flag from the args list as we'll use a wrapper instead
            self.mpv_args = [arg for arg in self.mpv_args if arg != '--terminal' and arg != 'terminal']

        # Only add the separator and URL if a URL is actually provided
        if self.url:
            if isinstance(self.url, list):
                full_command = self.mpv_args + ['--'] + self.url
            else:
                full_command = self.mpv_args + ['--'] + [self.url]
        else:
            full_command = self.mpv_args
            
        # Use configured platform for consistency
        platform_name = self.settings.get('os_platform', platform.system()) if self.settings else platform.system()

        if platform_name != "Windows" and self.has_terminal_flag:
            term_cmd = []
            modern_terminals = ['konsole', 'gnome-terminal', 'xfce4-terminal', 'kitty', 'alacritty', 'tilix', 'foot', 'wezterm']
            
            if self.is_forced_terminal:
                # FORCED MODE: Needs to stay open after MPV exits
                inner_cmd_str = ' '.join(shlex.quote(arg) for arg in full_command)
                
                # Try Konsole specifically first because it has a nice native --hold
                konsole_path = shutil.which('konsole')
                if konsole_path:
                    logging.info(f"Terminal Wrapper: Using Konsole native --hold at {konsole_path}")
                    term_cmd = [konsole_path, '--hold', '-e'] + full_command
                
                if not term_cmd:
                    # Fallback to sh -c "cmd; sleep" hack for other terminals
                    wrapped_cmd_str = f"{inner_cmd_str}; echo ''; echo '--- MPV Finished. Closing in 10s... ---'; sleep 10"
                    
                    if shutil.which('xdg-terminal-exec'):
                        term_cmd = ['xdg-terminal-exec', 'sh', '-c', wrapped_cmd_str]
                    
                    if not term_cmd:
                        for t in modern_terminals:
                            t_path = shutil.which(t)
                            if t_path:
                                term_cmd = [t_path, '--', 'sh', '-c', wrapped_cmd_str]
                                break
            else:
                # REGULAR MODE: Just launch MPV inside a terminal
                if shutil.which('xdg-terminal-exec'):
                    term_cmd = ['xdg-terminal-exec'] + full_command
                
                if not term_cmd:
                    # Prefer -e for general compatibility, as -- is handled differently
                    # across various versions of Konsole and other terminals.
                    for t in modern_terminals:
                        t_path = shutil.which(t)
                        if t_path:
                            term_cmd = [t_path, '-e'] + full_command
                            break
                
                if not term_cmd:
                    # Final desperate fallback
                    for t in ['x-terminal-emulator', 'xterm', 'urxvt']:
                        t_path = shutil.which(t)
                        if t_path:
                            term_cmd = [t_path, '-e'] + full_command
                            break
            
            if term_cmd:
                full_command = term_cmd
            else:
                logging.warning("Terminal Wrapper: No supported terminal emulator found. Launching without terminal.")

        logging.info(f"Constructed MPV command (Copy-Paste): {' '.join(shlex.quote(arg) for arg in full_command)}")
        logging.info("MPV Command Arguments (Detailed):\n" + "\n".join(f"  [{i}] {arg}" for i, arg in enumerate(full_command)))

        # Write to inspection file for easy user verification
        try:
            inspection_path = os.path.join(file_io.DATA_DIR, "last_mpv_command.txt")
            with open(inspection_path, 'w', encoding='utf-8') as f:
                f.write(f"Launch Timestamp: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
                f.write("="*60 + "\n")
                f.write("SHELL-QUOTED COMMAND (Copy-Paste into terminal):\n")
                f.write(" ".join(shlex.quote(arg) for arg in full_command) + "\n\n")
                f.write("DETAILED ARGUMENT LIST:\n")
                for i, arg in enumerate(full_command):
                    f.write(f"[{i:02d}] {arg}\n")
        except: pass

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
    idle=False,
    force_terminal=False,
    input_terminal=None,
    settings=None,
    flag_dir=None,
    playlist_start_index=None
):
    """Constructs the MPV command line arguments using MpvCommandBuilder."""
    builder = MpvCommandBuilder(
        mpv_exe=mpv_exe,
        use_ytdl_mpv=use_ytdl_mpv,
        is_youtube_override=is_youtube_override,
        is_youtube=is_youtube,
        settings=settings
    ) \
        .with_ipc_path(ipc_path) \
        .with_url(url) \
        .with_idle(idle) \
        .with_force_terminal(force_terminal) \
        .with_input_terminal(input_terminal) \
        .with_completion_script(script_dir if load_on_completion_script else None, flag_dir=flag_dir) \
        .with_adaptive_headers_script(script_dir) \
        .with_fix_thumbnailer_script(script_dir) \
        .with_title(title) \
        .with_automatic_flags(automatic_mpv_flags) \
        .with_headers(headers) \
        .with_disable_http_persistent(disable_http_persistent) \
        .with_start_paused(start_paused) \
        .with_custom_flags(custom_mpv_flags) \
        .with_geometry(geometry, custom_width, custom_height) \
        .with_playlist_start(playlist_start_index) \
        .with_youtube_options(is_youtube, ytdl_raw_options)
        
    return builder.build()

def get_mpv_popen_kwargs(has_terminal_flag):
    """Returns the subprocess arguments for launching MPV."""
    popen_kwargs = {
        'stdout': subprocess.PIPE if not has_terminal_flag else None,
        'stderr': subprocess.STDOUT if not has_terminal_flag else None,
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

def apply_bypass_script(url_item, send_message_func, settings=None):
    """
    Applies URL analysis logic if enabled in settings.
    Returns a tuple of (processed_url, headers_dict, ytdl_raw_options, use_ytdl_mpv_flag, is_youtube_flag).
    """
    if not isinstance(url_item, dict):
        url_item = {'url': url_item if url_item else "", 'settings': {}}

    original_url = sanitize_url(url_item['url'])
    
    # Use provided settings or load from config
    if settings is None:
        settings = file_io.get_settings()
    
    enable_url_analysis = settings.get("enable_url_analysis", False)
    browser_for_analysis = settings.get("browser_for_url_analysis", "chrome")
    enable_youtube_analysis = settings.get("enable_youtube_analysis", False)
    user_agent_string = settings.get("user_agent_string", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
    ytdl_quality = settings.get("ytdl_quality", "best")

    # The default fallback return values
    is_youtube = "youtube.com/" in original_url or "youtu.be/" in original_url
    default_return_tuple = (original_url, None, None, False, is_youtube, None, False, None, False, None)

    if not enable_url_analysis:
        return default_return_tuple

    # is_youtube for bypass script is driven by enable_youtube_analysis setting
    youtube_enabled_for_script = "true" if enable_youtube_analysis else "false"
    
    # Extract granular preferences from the message
    item_settings = url_item.get('settings', {})
    yt_use_cookies = item_settings.get('yt_use_cookies', True)
    yt_mark_watched = item_settings.get('yt_mark_watched', True)
    yt_ignore_config = item_settings.get('yt_ignore_config', True)
    other_sites_use_cookies = item_settings.get('other_sites_use_cookies', True)

    try:
        logging.info(f"Executing URL analysis for URL: {original_url}")
        send_message_func({"action": "log_from_native_host", "log": {"text": f"Running URL analysis for: {original_url}", "type": "info"}})
        
        # Directly call the run_bypass_logic function from url_analyzer
        result = url_analyzer.run_bypass_logic(
            original_url, 
            browser_for_analysis, 
            youtube_enabled_for_script, 
            user_agent_string,
            yt_use_cookies=yt_use_cookies,
            yt_mark_watched=yt_mark_watched,
            yt_ignore_config=yt_ignore_config,
            other_sites_use_cookies=other_sites_use_cookies,
            ytdl_quality=ytdl_quality
        )

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
        mark_watched = result.get("mark_watched", False)
        ytdl_format_result = result.get("ytdl_format")

        return (processed_url, headers_for_mpv, ytdl_raw_options_for_mpv, use_ytdl_mpv_flag, is_youtube_flag_from_script, entries, disable_http_persistent, cookies_file, mark_watched, ytdl_format_result)

    except Exception as e:
        logging.error(f"Error during URL analysis: {e}")
        send_message_func({"action": "log_from_native_host", "log": {"text": f"URL analysis failed with exception: {e}. Playing original URL.", "type": "error"}})
        return (original_url, None, None, False, is_youtube, None, False, None, False, None) # Return 10-tuple here too
# --- AniList Service ---

# Global variable to track the last time a "cache is fresh" message was sent to the UI
LAST_ANILIST_FRESH_LOG_TIME = 0

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
    global LAST_ANILIST_FRESH_LOG_TIME
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
            if now - LAST_ANILIST_FRESH_LOG_TIME > 300:
                send_message_func({"log": {"text": "[AniList]: Loaded from local file (cache is fresh).", "type": "info"}})
                LAST_ANILIST_FRESH_LOG_TIME = now
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
                    if now - LAST_ANILIST_FRESH_LOG_TIME > 300:
                        send_message_func({"log": {"text": "[AniList]: Loaded from local file (no new releases found).", "type": "info"}})
                        LAST_ANILIST_FRESH_LOG_TIME = now
                    
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
