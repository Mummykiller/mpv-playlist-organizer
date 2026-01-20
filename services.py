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
import shlex
import re
from utils import url_analyzer
import file_io

# A set of mpv flags that are considered safe to be passed from the extension.
ALLOWED_PROTOCOLS = ('http://', 'https://', 'file://', 'udp://', 'rtmp://', 'rtsp://', 'mms://')

SAFE_MPV_FLAGS_ALLOWLIST = {
    '--start', '--end', '--speed', '--loop', '--loop-playlist', '--loop-file', '--pause',
    '--save-position-on-quit', '--fullscreen', '--ontop', '--border', '--title',
    '--geometry', '--autofit', '--autofit-larger', '--autofit-smaller', '--keep-open',
    '--aspect', '--correct-pts', '--fps', '--deinterlace', '--hwdec', '--scale',
    '--cscale', '--dscale', '--dither-depth', '--deband', '--deband-iterations',
    '--deband-threshold', '--deband-range', '--fbo-format', '--profile', '--video-sync',
    '--interpolation', '--tscale', '--volume', '--mute', '--audio-device',
    '--audio-channels', '--sub-visibility', '--sub-pos', '--sub-scale', '--sub-font',
    '--sub-font-size', '--no-audio', '--no-video', '--force-window', '--cursor-autohide',
    '--terminal', '--input-terminal',
}

def sanitize_url(url):
    """Sanitizes a URL by removing potentially dangerous characters."""
    return file_io.sanitize_string(url, is_filename=False)

def get_gpu_vendor():
    system = platform.system()
    try:
        if system == "Windows":
            cmd = ["wmic", "path", "win32_VideoController", "get", "name"]
            output = subprocess.check_output(cmd, stderr=subprocess.STDOUT, text=True).lower()
        elif system == "Darwin": return "apple"
        else:
            if shutil.which("lspci"): output = subprocess.check_output(["lspci"], stderr=subprocess.STDOUT, text=True).lower()
            else: return "unknown"
        if "nvidia" in output: return "nvidia"
        elif "intel" in output: return "intel"
        elif "amd" in output or "radeon" in output: return "amd"
    except: pass
    return "unknown"

def get_mark_watched(item, settings):
    """Normalizes the mark_watched preference for an item."""
    val = item.get('mark_watched')
    if val is None:
        val = settings.get('yt_mark_watched', True)
    if isinstance(val, str):
        return val.lower() in ("true", "yes", "1")
    return bool(val)

def construct_lua_options(item, settings, script_dir, index=None):
    """
    Centralized helper to construct the options dictionary passed to adaptive_headers.lua.
    Ensures all metadata and networking overrides are consistent.
    """
    essential_flags = get_essential_ytdlp_flags(settings)
    raw_opts = item.get('ytdl_raw_options')
    
    # Support Direct Browser Access
    if item.get('cookies_browser'):
         browser_opt = f"cookies-from-browser={item['cookies_browser']}"
         raw_opts = f"{raw_opts},{browser_opt}" if raw_opts else browser_opt

    final_opts = file_io.merge_ytdlp_options(raw_opts, essential_flags)
    
    item_url = sanitize_url(item.get('original_url') or item.get('url'))
    
    lua_options = {
        "id": item.get('id'), 
        "title": item.get('title'),
        "headers": item.get('headers'),
        "ytdl_raw_options": final_opts,
        "use_ytdl_mpv": item.get('use_ytdl_mpv', False) or item.get('is_youtube', False),
        "ytdl_format": item.get('ytdl_format'),
        "ffmpeg_path": settings.get('ffmpeg_path'),
        "original_url": item_url,
        "cookies_file": item.get('cookies_file'),
        "cookies_browser": item.get('cookies_browser'),
        "disable_http_persistent": item.get('disable_http_persistent', False),
        "disable_network_overrides": settings.get('disable_network_overrides', False),
        "http_persistence": settings.get('http_persistence', 'auto'),
        "enable_reconnect": settings.get('enable_reconnect', True),
        "reconnect_delay": settings.get('reconnect_delay', 4),
        "demuxer_max_bytes": settings.get('demuxer_max_bytes', '1G'),
        "demuxer_max_back_bytes": settings.get('demuxer_max_back_bytes', '500M'),
        "cache_secs": settings.get('cache_secs', 500),
        "demuxer_readahead_secs": settings.get('demuxer_readahead_secs', 500),
        "stream_buffer_size": settings.get('stream_buffer_size', '10M'),
        "resume_time": item.get('resume_time'),
        "project_root": script_dir,
        "mark_watched": get_mark_watched(item, settings),
        "marked_as_watched": item.get('marked_as_watched', False),
        "targeted_defaults": settings.get('targeted_defaults', 'none')
    }
    
    # If precise resume is disabled globally, don't pass it to Lua
    if not settings.get('enable_precise_resume', True):
        lua_options["resume_time"] = None
        
    return lua_options, item_url

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
        
        # Clear the dependency cache so the new version is detected immediately
        global _DEPENDENCY_STATUS_CACHE
        _DEPENDENCY_STATUS_CACHE["data"] = None
        _DEPENDENCY_STATUS_CACHE["timestamp"] = 0

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

    # --- 1. MPV Check ---
    mpv_exe_name = "mpv.exe" if system == "Windows" else "mpv"
    mpv_path = shutil.which(mpv_exe_name)
    
    if not mpv_path:
        configured_path = get_mpv_executable_func()
        if os.path.isabs(configured_path) and os.path.exists(configured_path):
            mpv_path = configured_path

    if mpv_path:
        mpv_status["found"] = True
        mpv_status["path"] = mpv_path
    else:
        mpv_status["error"] = f"'{mpv_exe_name}' not found in system PATH or config."

    # --- 2. yt-dlp Check ---
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

    # --- 3. FFmpeg Check ---
    ffmpeg_exe_name = "ffmpeg.exe" if system == "Windows" else "ffmpeg"
    ffmpeg_path = shutil.which(ffmpeg_exe_name)
    config = file_io._safe_json_load(file_io.CONFIG_FILE)
    
    if not ffmpeg_path:
        ffmpeg_path = config.get("ffmpeg_path")
        if ffmpeg_path and not (os.path.exists(ffmpeg_path) and os.access(ffmpeg_path, os.X_OK)):
            ffmpeg_path = None

    if not ffmpeg_path:
        search_dirs = []
        if system == "Linux":
            search_dirs.extend(["/usr/bin", "/usr/local/bin", "/bin", "/usr/sbin", "/sbin", os.path.expanduser("~/.local/bin"), os.path.expanduser("~/bin")])
        if mpv_status["found"] and os.path.isabs(mpv_status["path"]):
            search_dirs.append(os.path.dirname(mpv_status["path"]))
        for d in search_dirs:
            p = os.path.join(d, ffmpeg_exe_name)
            if os.path.exists(p) and os.access(p, os.X_OK):
                ffmpeg_path = p
                break
    
    if ffmpeg_path:
        ffmpeg_status["found"] = True
        ffmpeg_status["path"] = ffmpeg_path
        if ffmpeg_path != config.get("ffmpeg_path"):
            file_io.set_settings({"ffmpeg_path": ffmpeg_path})
        ffmpeg_ver = _get_ffmpeg_version(ffmpeg_path, send_message_func)
        if ffmpeg_ver: ffmpeg_status["version"] = ffmpeg_ver
    else:
        ffmpeg_status["error"] = "Not found. Required for 1440p/4K resolution."

    # --- 4. Node.js Check ---
    node_exe_name = "node.exe" if system == "Windows" else "node"
    node_path = shutil.which(node_exe_name)
    if not node_path:
        node_path = config.get("node_path")
        if node_path and not (os.path.exists(node_path) and os.access(node_path, os.X_OK)):
            node_path = None
    if node_path:
        node_status["found"] = True
        node_status["path"] = node_path
        if node_path != config.get("node_path"): file_io.set_settings({"node_path": node_path})
        node_ver = _get_node_version(node_path)
        if node_ver: node_status["version"] = node_ver
    else:
        node_status["error"] = "Not found. Highly recommended for 1440p+ YouTube playback."

    logging.info(f"Dependency check: MPV={mpv_status['found']}, YTDLP={ytdlp_status['found']}, FFMPEG={ffmpeg_status['found']}, NODE={node_status['found']}")
    result = {"success": True, "mpv": mpv_status, "ytdlp": ytdlp_status, "ffmpeg": ffmpeg_status, "node": node_status}
    _DEPENDENCY_STATUS_CACHE["data"] = result
    _DEPENDENCY_STATUS_CACHE["timestamp"] = now
    return result

def get_essential_ytdlp_flags(settings=None, bypass=False):
    """Returns the baseline yt-dlp flags required for reliable streaming and security."""
    config = settings if settings else file_io._safe_json_load(file_io.CONFIG_FILE)
    
    # Base security and functionality flags
    flags_list = [
        "remote-components=ejs:github"
    ]
    
    # Handle JS Runtimes (Critical for YouTube)
    node_path = config.get("node_path")
    if node_path and os.path.exists(node_path):
        flags_list.append(f"js-runtimes=node:{node_path}")
    else:
        flags_list.append("js-runtimes=node")
    
    if config.get('yt_ignore_config', True):
        flags_list.insert(0, "ignore-config=")
    
    # Performance Injectors - SKIP IF BYPASS ACTIVE
    if not bypass:
        concurrent = config.get('ytdlp_concurrent_fragments', 4)
        if concurrent > 1:
            flags_list.append(f"concurrent-fragments={concurrent}")
        
        buf_size = config.get('stream_buffer_size', '10M')
        if buf_size:
            # Map MPV stream-buffer-size to yt-dlp buffer-size (approximate)
            flags_list.append(f"buffer-size={buf_size}")

    ffmpeg_path = config.get("ffmpeg_path")
    if ffmpeg_path and os.path.exists(ffmpeg_path):
        flags_list.append(f"ffmpeg-location={ffmpeg_path}")
    
    return ",".join(flags_list)

# --- MPV Command Construction ---

class MpvCommandBuilder:
    def __init__(self, mpv_exe, use_ytdl_mpv=False, is_youtube_override=False, is_youtube=False, settings=None, cookies_browser=None, force_bypass=False):
        self.mpv_exe = mpv_exe
        self.settings = settings or {}
        self.cookies_browser = cookies_browser
        self.use_ytdl_mpv = use_ytdl_mpv
        self.is_youtube_override = is_youtube_override
        self.is_youtube = is_youtube
        self.force_bypass_hint = force_bypass
        
        # State Storage
        self.url = None
        self.ipc_path = None
        self.scripts = []
        self.script_opts = []
        self.title = None
        self.geometry = None
        self.headers = None
        self.custom_flags = None
        self.automatic_flags = None
        self.playlist_start = None
        self.idle_val = None
        self.ytdl_raw_options = None
        self.disable_http_persistent_override = False
        self.input_terminal = None
        self.has_terminal_flag = False
        self.is_forced_terminal = False

    def _should_bypass_overrides(self):
        # 1. Force Bypass Hint (From Launcher)
        if self.force_bypass_hint: return True
        
        # 2. Global Kill-switch
        if self.settings.get('disable_network_overrides', False): return True
        
        # 3. Targeted Logic
        targeted = self.settings.get('targeted_defaults', 'none')
        if targeted == 'none': return False
        
        if targeted == 'animepahe':
            urls = self.url if isinstance(self.url, list) else [self.url]
            if any(u and ("kwik.cx" in u or "owocdn.top" in u or "uwucdn.top" in u) for u in urls): return True
            return False
        elif targeted == 'all-none-yt':
            return not self.is_youtube
            
        return False

    def with_ipc_path(self, ipc_path):
        self.ipc_path = file_io.validate_safe_path(ipc_path)
        return self

    def with_url(self, url):
        if url:
            if isinstance(url, list):
                self.url = [sanitize_url(u) for u in url if sanitize_url(u).lower().startswith(ALLOWED_PROTOCOLS)]
            else:
                sanitized = sanitize_url(url)
                if sanitized.lower().startswith(ALLOWED_PROTOCOLS): self.url = sanitized
        return self

    def with_completion_script(self, script_dir, flag_dir=None):
        if script_dir:
            p = os.path.join(script_dir, "mpv_scripts", "on_completion.lua")
            safe_p = file_io.validate_safe_path(p)
            if safe_p and os.path.exists(safe_p):
                self.scripts.append(safe_p)
                if flag_dir: 
                    safe_flag_dir = file_io.validate_safe_path(flag_dir)
                    if safe_flag_dir:
                         self.script_opts.append(f'on_completion-flag_dir={safe_flag_dir}')
        return self

    def with_adaptive_headers_script(self, script_dir):
        if script_dir:
            p = os.path.join(script_dir, "mpv_scripts", "adaptive_headers.lua")
            safe_p = file_io.validate_safe_path(p)
            if safe_p and os.path.exists(safe_p): self.scripts.append(safe_p)
        return self

    def with_python_interaction_script(self, script_dir):
        if script_dir:
            p = os.path.join(script_dir, "mpv_scripts", "python_loader.lua")
            safe_p = file_io.validate_safe_path(p)
            if safe_p and os.path.exists(safe_p): self.scripts.append(safe_p)
        return self

    def with_title(self, title):
        self.title = title
        return self

    def with_automatic_flags(self, flags):
        self.automatic_flags = flags
        return self

    def with_force_terminal(self, force):
        if force:
            self.has_terminal_flag = True
            self.is_forced_terminal = True
        return self

    def with_input_terminal(self, val):
        self.input_terminal = val
        return self

    def with_headers(self, headers):
        self.headers = headers
        return self

    def with_disable_http_persistent(self, val):
        self.disable_http_persistent_override = val
        return self

    def with_start_paused(self, paused):
        if paused:
            if not self.automatic_flags: self.automatic_flags = []
            self.automatic_flags.append({'flag': '--pause', 'enabled': True})
        return self

    def with_custom_flags(self, flags):
        self.custom_flags = flags
        return self

    def with_geometry(self, geometry, w, h):
        self.geometry = (geometry, w, h)
        return self

    def with_playlist_start(self, index):
        self.playlist_start = index
        return self

    def with_idle(self, idle):
        self.idle_val = idle
        return self

    def with_youtube_options(self, is_yt, raw_opts):
        self.ytdl_raw_options = raw_opts
        return self

    def build(self):
        args = [self.mpv_exe]

        # 1. Essential Plumbing (Always)
        if self.ipc_path: args.append(f'--input-ipc-server={self.ipc_path}')
        if self.idle_val: args.append(f'--idle={self.idle_val if isinstance(self.idle_val, str) else "yes"}')
        if self.input_terminal: args.append(f'--input-terminal={self.input_terminal}')
        for s in self.scripts: args.append(f'--script={s}')
        if self.script_opts: args.append(f"--script-opts={','.join(self.script_opts)}")
        if self.title: args.append(f'--title={file_io.sanitize_string(self.title)}')
        if self.playlist_start and self.playlist_start > 0: args.append(f'--playlist-start={self.playlist_start}')

        # 2. Authentication Headers (Always - Required for initial connection)
        if self.headers:
            if 'User-Agent' in self.headers: args.append(f'--user-agent={file_io.sanitize_string(str(self.headers["User-Agent"]))}')
            if 'Referer' in self.headers: args.append(f'--referrer={file_io.sanitize_string(str(self.headers["Referer"]))}')

        # 3. Hardware & Quality (Always - Local hardware, safe for native speed)
        decoder = self.settings.get('mpv_decoder', 'auto')
        if decoder: args.append(f"--hwdec={decoder}")
        
        profile = self.settings.get('performance_profile', 'default')
        if profile == 'low': args.append("--profile=fast")
        elif profile == 'medium': args.extend(["--scale=spline36", "--cscale=spline36", "--vo=gpu"])
        elif profile == 'high': args.append("--profile=gpu-hq")
        elif profile == 'ultra':
            args.append("--profile=gpu-hq")
            if self.settings.get('ultra_scalers', True): args.extend(["--scale=ewa_lanczossharp", "--cscale=ewa_lanczossharp"])
            if self.settings.get('ultra_video_sync', True): args.append("--video-sync=display-resample")
            interp = self.settings.get('ultra_interpolation', 'oversample')
            if interp not in ('off', False):
                args.append("--interpolation=yes")
                args.append(f"--tscale={interp if isinstance(interp, str) else 'oversample'}")
            if self.settings.get('ultra_deband', True): args.extend(["--deband=yes", "--deband-iterations=4", "--deband-threshold=48", "--deband-range=24"])
            if self.settings.get('ultra_fbo', True): args.append("--fbo-format=rgba16f")

        if self.geometry:
            geom, w, h = self.geometry
            GEOM_PATTERN = re.compile(r'^[0-9x+%+-]+$')
            if w and h and GEOM_PATTERN.match(str(w)) and GEOM_PATTERN.match(str(h)): args.append(f'--geometry={w}x{h}')
            elif geom and GEOM_PATTERN.match(str(geom)): args.append(f'--geometry={geom}')

        # 4. Networking & Buffering (STRIPPED - Now handled per-video in Lua)
        # This allows all videos to start at 100% native speed.
        # We only keep the ytdl format/activation flags.
        q = str(self.settings.get('ytdl_quality', 'best'))
        ytdl_format = "bv*+ba/best"
        if q != 'best' and q in ['2160', '1440', '1080', '720', '480']:
            if int(q) > 1080: ytdl_format = f"bv*[height<=?{q}][vcodec~='^vp0?9|^av01']+ba/bv*[height<=?{q}]+ba/best"
            else: ytdl_format = f"bv*[height<=?{q}]+ba/best"
        args.append(f"--ytdl-format={ytdl_format}")
        
        # Support Direct Browser Access
        if self.cookies_browser:
            browser_opt = f"cookies-from-browser={self.cookies_browser}"
            if self.ytdl_raw_options:
                self.ytdl_raw_options = f"{self.ytdl_raw_options},{browser_opt}"
            else:
                self.ytdl_raw_options = browser_opt
        
        if self.ytdl_raw_options:
            args.append(f"--ytdl-raw-options={self.ytdl_raw_options}")

        if self.use_ytdl_mpv or (self.is_youtube and not self.is_youtube_override):
            args.append('--ytdl=yes')

        # 5. Flags (Applied at end to allow manual overrides)
        if self.automatic_flags:
            for f_info in self.automatic_flags:
                if f_info.get('enabled'):
                    f = f_info.get('flag')
                    if f == '--terminal': self.has_terminal_flag = True
                    elif not f or f.startswith('--hwdec'): continue
                    elif f.split('=', 1)[0] in SAFE_MPV_FLAGS_ALLOWLIST: args.append(f)

        if self.custom_flags:
            try:
                parsed = []
                if isinstance(self.custom_flags, list):
                    for f in self.custom_flags:
                        if isinstance(f, dict) and f.get('enabled', True): parsed.extend(shlex.split(f.get('flag','')))
                        elif isinstance(f, str): parsed.extend(shlex.split(f))
                elif isinstance(self.custom_flags, str): parsed.extend(shlex.split(self.custom_flags))
                for a in parsed:
                    if a.startswith('--') and a.split('=', 1)[0] in SAFE_MPV_FLAGS_ALLOWLIST: args.append(a)
            except: pass

        # Terminal Wrapper Logic
        if self.has_terminal_flag: args = [a for a in args if a != '--terminal' and a != 'terminal']
        full_command = args + (['--'] + (self.url if isinstance(self.url, list) else [self.url]) if self.url else [])
        
        if self.settings.get('os_platform', platform.system()) != "Windows" and self.has_terminal_flag:
            term_cmd = []
            modern = ['konsole', 'gnome-terminal', 'xfce4-terminal', 'kitty', 'alacritty', 'tilix', 'foot', 'wezterm']
            if self.is_forced_terminal:
                inner = ' '.join(shlex.quote(a) for a in full_command)
                kp = shutil.which('konsole')
                if kp: term_cmd = [kp, '--hold', '-e'] + full_command
                else:
                    wrapped = f"{inner}; echo ''; echo '--- MPV Finished. Closing in 10s... ---'; sleep 10"
                    if shutil.which('xdg-terminal-exec'): term_cmd = ['xdg-terminal-exec', 'sh', '-c', wrapped]
                    else:
                        for t in modern:
                            tp = shutil.which(t)
                            if tp: term_cmd = [tp, '--', 'sh', '-c', wrapped]; break
            else:
                if shutil.which('xdg-terminal-exec'): term_cmd = ['xdg-terminal-exec'] + full_command
                else:
                    for t in modern:
                        tp = shutil.which(t)
                        if tp: term_cmd = [tp, '-e'] + full_command; break
            if term_cmd: full_command = term_cmd

        # 6. Command-Line Length Guard (Windows Safety)
        cmd_str = ' '.join(shlex.quote(a) for a in full_command)
        if self.settings.get('os_platform', platform.system()) == "Windows" and len(cmd_str) > 7500:
            logging.error(f"CRITICAL: Command line length ({len(cmd_str)}) exceeds Windows limit (8191). Launch aborted.")
            raise RuntimeError(f"Command too long for Windows ({len(cmd_str)} chars). Try playing fewer items at once.")

        logging.info(f"Constructed MPV command: {cmd_str}")
        try:
            p = os.path.join(file_io.DATA_DIR, "last_mpv_command.txt")
            with open(p, 'w', encoding='utf-8') as f:
                f.write(f"Launch Timestamp: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n" + "="*60 + "\nSHELL-QUOTED COMMAND:\n" + " ".join(shlex.quote(a) for a in full_command) + "\n\nDETAILED ARGUMENT LIST:\n")
                for i, a in enumerate(full_command): f.write(f"[{i:02d}] {a}\n")
        except: pass
        return full_command, self.has_terminal_flag

def construct_mpv_command(mpv_exe, ipc_path=None, url=None, is_youtube=False, ytdl_raw_options=None, geometry=None, custom_width=None, custom_height=None, custom_mpv_flags=None, automatic_mpv_flags=None, headers=None, disable_http_persistent=False, start_paused=False, script_dir=None, load_on_completion_script=False, title=None, use_ytdl_mpv=False, is_youtube_override=False, idle=False, force_terminal=False, input_terminal=None, settings=None, flag_dir=None, playlist_start_index=None, cookies_browser=None, force_bypass=False):
    b = MpvCommandBuilder(mpv_exe, use_ytdl_mpv, is_youtube_override, is_youtube, settings, cookies_browser, force_bypass=force_bypass)
    return b.with_ipc_path(ipc_path) \
        .with_url(url) \
        .with_idle(idle) \
        .with_force_terminal(force_terminal) \
        .with_input_terminal(input_terminal) \
        .with_completion_script(script_dir if load_on_completion_script else None, flag_dir) \
        .with_adaptive_headers_script(script_dir) \
        .with_python_interaction_script(script_dir) \
        .with_title(title) \
        .with_automatic_flags(automatic_mpv_flags) \
        .with_headers(headers) \
        .with_disable_http_persistent(disable_http_persistent) \
        .with_start_paused(start_paused) \
        .with_custom_flags(custom_mpv_flags) \
        .with_geometry(geometry, custom_width, custom_height) \
        .with_playlist_start(playlist_start_index) \
        .with_youtube_options(is_youtube, ytdl_raw_options) \
        .build()

def get_mpv_popen_kwargs(has_terminal_flag):
    kwargs = {'stdout': subprocess.PIPE if not has_terminal_flag else None, 'stderr': subprocess.STDOUT if not has_terminal_flag else None, 'universal_newlines': False}
    if platform.system() == "Windows":
        flags = subprocess.CREATE_NEW_PROCESS_GROUP
        if not has_terminal_flag: flags |= subprocess.CREATE_NO_WINDOW
        kwargs['creationflags'] = flags
    else: kwargs['start_new_session'] = True
    return kwargs

def apply_bypass_script(url_item, send_message_func, settings=None, session=None):
    """
    Applies URL analysis logic if enabled in settings.
    Returns a tuple of (processed_url, headers_dict, ytdl_raw_options, use_ytdl_mpv_flag, is_youtube_flag).
    """
    if session and getattr(session, 'launch_cancelled', False):
        raise RuntimeError("Launch cancelled by user.")

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
    default_return_tuple = (original_url, None, None, False, is_youtube, None, False, None, False, None, None)

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
            ytdl_quality=ytdl_quality,
            check_cancelled=lambda: session and getattr(session, 'launch_cancelled', False)
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
        cookies_browser = result.get("cookies_browser")
        mark_watched = result.get("mark_watched", False)
        ytdl_format_result = result.get("ytdl_format")

        return (processed_url, headers_for_mpv, ytdl_raw_options_for_mpv, use_ytdl_mpv_flag, is_youtube_flag_from_script, entries, disable_http_persistent, cookies_file, mark_watched, ytdl_format_result, cookies_browser)

    except Exception as e:
        logging.error(f"Error during URL analysis: {e}")
        send_message_func({"action": "log_from_native_host", "log": {"text": f"URL analysis failed with exception: {e}. Playing original URL.", "type": "error"}})
        return (original_url, None, None, False, is_youtube, None, False, None, False, None, None)

# --- AniList Service ---

# Global variable to track the last time a "cache is fresh" message was sent to the UI
LAST_ANILIST_FRESH_LOG_TIME = 0

class AniListCache:
    def __init__(self, cache_file, script_dir, send_message_func):
        self.cache_file = cache_file
        self.script_dir = script_dir
        self.send_message = send_message_func
        self.CACHE_DURATION_S = 30 * 60 # 30 minutes

    def _fetch_from_anilist_script(self, is_ping, days=0):
        """Helper function to execute the anilist_releases.py script."""
        try:
            script_path = os.path.join(self.script_dir, 'anilist_releases.py')
            script_args = [sys.executable, script_path]
            if is_ping:
                script_args.append('--ping')
            if days != 0:
                script_args.extend(['--days', str(days)])
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
        return {}

    def _save_cache(self, cache_data):
        """Saves cache data to the cache file."""
        try:
            with open(self.cache_file, 'w', encoding='utf-8') as f:
                json.dump(cache_data, f, indent=4)
            logging.info(f"{self.cache_file} updated with new data.")
        except (IOError) as e:
            logging.error(f"Failed to write new {self.cache_file}: {e}")

def get_anilist_releases_with_cache(force_refresh, delete_cache, is_cache_disabled, days, cache_file, script_dir, send_message_func):
    """Handles fetching AniList releases with a multi-day file-based caching mechanism."""
    from datetime import datetime
    global LAST_ANILIST_FRESH_LOG_TIME
    anilist_cache = AniListCache(cache_file, script_dir, send_message_func)
    now = time.time()
    
    # 1. Handle Master Cache Invalidation (Manual delete or New day)
    full_cache = anilist_cache._load_cache()
    today_ts = full_cache.get("today_timestamp", 0)
    
    # Only check for 'new day' if we have a cached Today to compare with
    is_new_day = False
    if today_ts > 0:
        cache_date = datetime.fromtimestamp(today_ts).date()
        is_new_day = datetime.fromtimestamp(now).date() != cache_date
    
    if delete_cache or is_new_day:
        if delete_cache:
            logging.info("AniList Cache: Manual deletion requested.")
            send_message_func({"log": {"text": "[AniList]: Cache file deleted.", "type": "info"}})
        elif is_new_day:
            logging.info("AniList Cache: New day detected. Wiping all offsets.")
            send_message_func({"log": {"text": "[AniList]: New day detected. Refreshing schedule...", "type": "info"}})
            
        if os.path.exists(cache_file):
            try: os.remove(cache_file)
            except: pass
        full_cache = {}
        today_ts = 0

    if is_cache_disabled:
        return anilist_cache._fetch_from_anilist_script(is_ping=False, days=days)

    offsets = full_cache.get("offsets", {})
    day_key = str(days)
    day_cache = offsets.get(day_key)

    def perform_full_fetch_and_cache(target_days):
        if target_days == 0:
            send_message_func({"log": {"text": "[AniList]: Fetching fresh data from API...", "type": "info"}})
        
        res = anilist_cache._fetch_from_anilist_script(is_ping=False, days=target_days)
        if res['success']:
            try:
                parsed_data = json.loads(res['output'])
                offsets[str(target_days)] = {
                    "timestamp": now,
                    "data": parsed_data,
                    "sorted_airing_ats": sorted([s['airingAt'] for s in parsed_data.get('raw_schedules_for_cache', [])])
                }
                if target_days == 0:
                    full_cache["today_timestamp"] = now
                
                full_cache["offsets"] = offsets
                anilist_cache._save_cache(full_cache)
            except Exception as e:
                logging.error(f"Failed to process AniList fetch for cache: {e}")
        return res

    # 2. Check Today's Specific Expiry (only offset 0 triggers a global refresh)
    is_today_expired = False
    if day_key == "0" and day_cache:
        is_expired_by_timer = (now - day_cache['timestamp'] > anilist_cache.CACHE_DURATION_S)
        next_airing_at = day_cache['data'].get('next_airing_at')
        is_expired_by_release = next_airing_at and now > next_airing_at
        
        if is_expired_by_timer or is_expired_by_release or force_refresh:
            is_today_expired = True
            if is_expired_by_timer: logging.info("AniList Cache: Today expired by timer.")
            if is_expired_by_release: send_message_func({"log": {"text": "[AniList]: New episode aired. Refreshing...", "type": "info"}})
            # Force global refresh
            full_cache = {}
            offsets = {}
            day_cache = None

    # 3. Serve from cache if valid
    if not force_refresh and day_cache:
        if day_key != "0" or not is_today_expired:
            if now - LAST_ANILIST_FRESH_LOG_TIME > 300:
                send_message_func({"log": {"text": f"[AniList]: Loaded from local cache (Day Offset: {days}).", "type": "info"}})
                LAST_ANILIST_FRESH_LOG_TIME = now
            return {"success": True, "output": json.dumps(day_cache['data'])}

    # 4. Fetch and Refresh
    logging.info(f"AniList Cache: Fetching fresh data for offset {days}.")
    return perform_full_fetch_and_cache(days)