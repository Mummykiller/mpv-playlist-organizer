import os
import shutil
import subprocess
import platform
import time
import logging
import file_io

# Prevent __pycache__ generation
import sys
sys.dont_write_bytecode = True
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'

# Global cache for dependency status to avoid redundant shell calls
_DEPENDENCY_STATUS_CACHE = {
    "data": None,
    "timestamp": 0
}
CACHE_EXPIRY_SECONDS = 300 # 5 minutes

def _find_ytdlp_executable():
    """Finds the yt-dlp executable in the system's PATH."""
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
    """Checks if write access is denied for ytdlp_path on Linux and finds a sudo tool."""
    if platform.system() == "Linux" and not os.access(ytdlp_path, os.W_OK):
        send_message_func({"log": {"text": "[yt-dlp]: Write access denied. Attempting to run with administrator privileges...", "type": "info"}})
        for tool in ["pkexec", "gksu", "kdesu"]:
            if shutil.which(tool):
                send_message_func({"log": {"text": f"[yt-dlp]: Please enter your password in the dialog to update yt-dlp.", "type": "info"}})
                return [tool]
        send_message_func({"log": {"text": "[yt-dlp]: No graphical sudo tool found. Please run `sudo yt-dlp -U` in a terminal.", "type": "error"}})
    return []

def _run_update_command(command, send_message_func):
    """Runs the yt-dlp update command and streams output to the sender."""
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
        success_msg = f"Successfully updated yt-dlp from {version_before} to {version_after}." if version_after != version_before else f"yt-dlp is already at the latest version ({version_after})."
        
        global _DEPENDENCY_STATUS_CACHE
        _DEPENDENCY_STATUS_CACHE["data"] = None
        _DEPENDENCY_STATUS_CACHE["timestamp"] = 0

        send_message_func({"log": {"text": f"[yt-dlp]: {success_msg}", "type": "info"}})
        return {"success": True, "message": success_msg}

    except Exception as e:
        error_msg = f"An unexpected error occurred during yt-dlp update: {e}"
        send_message_func({"log": {"text": f"[yt-dlp]: {error_msg}", "type": "error"}})
        return {"success": False, "error": error_msg}

def check_mpv_and_ytdlp_status(get_mpv_executable_func, send_message_func, force_refresh=False):
    """Checks for the presence and version of mpv, yt-dlp, and ffmpeg executables."""
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

    mpv_exe_name = "mpv.exe" if system == "Windows" else "mpv"
    # Defensive: Ensure get_mpv_executable_func() returns a string before calling os.path.exists
    mpv_candidate = get_mpv_executable_func()
    mpv_path = shutil.which(mpv_exe_name) or (mpv_candidate if mpv_candidate and os.path.exists(mpv_candidate) else None)

    if mpv_path:
        mpv_status["found"] = True
        mpv_status["path"] = mpv_path
    else:
        mpv_status["error"] = f"'{mpv_exe_name}' not found in system PATH or config."

    ytdlp_exe_name = "yt-dlp.exe" if system == "Windows" else "yt-dlp"
    ytdlp_path = shutil.which(ytdlp_exe_name)
    
    # NEW: On Windows, check the same folder as mpv.exe if not found in PATH
    if not ytdlp_path and system == "Windows" and mpv_status["found"]:
        mpv_dir = os.path.dirname(mpv_status["path"])
        ytdlp_candidate = os.path.join(mpv_dir, ytdlp_exe_name)
        if os.path.exists(ytdlp_candidate):
            ytdlp_path = ytdlp_candidate

    if ytdlp_path:
        ytdlp_status["found"] = True
        ytdlp_status["path"] = ytdlp_path
        ytdlp_version = _get_ytdlp_version(ytdlp_path, send_message_func)
        if ytdlp_version: ytdlp_status["version"] = ytdlp_version
        else: ytdlp_status["error"] = "Could not retrieve yt-dlp version."
    else:
        ytdlp_status["error"] = f"'{ytdlp_exe_name}' not found in system PATH."

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
        ffmpeg_status["error"] = "FFmpeg not found. Required for 1440p/4K resolution."

    node_exe_name = "node.exe" if system == "Windows" else "node"
    node_candidate = config.get("node_path")
    node_path = shutil.which(node_exe_name) or (node_candidate if node_candidate and os.path.exists(node_candidate) else None)
    if node_path:
        node_status["found"] = True
        node_status["path"] = node_path
        if node_path != config.get("node_path"):
            file_io.set_settings({"node_path": node_path})
        node_ver = _get_node_version(node_path)
        if node_ver: node_status["version"] = node_ver
    else:
        node_status["error"] = "Node.js not found. Highly recommended for 1440p+ YouTube playback."

    result = {"success": True, "mpv": mpv_status, "ytdlp": ytdlp_status, "ffmpeg": ffmpeg_status, "node": node_status}
    _DEPENDENCY_STATUS_CACHE["data"] = result
    _DEPENDENCY_STATUS_CACHE["timestamp"] = now
    return result
