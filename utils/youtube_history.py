import subprocess
import shutil
import logging
import threading
import sys
import os

# Path correction to find file_io and handle standalone execution
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
sys.path.insert(0, PROJECT_ROOT)

# Prevent __pycache__ generation
sys.dont_write_bytecode = True
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'

import file_io

def mark_video_as_watched(url, cookies_info, user_agent=None, timeout=30):
    """
    Uses yt-dlp to mark a YouTube video as watched.
    cookies_info can be a path to a file OR a browser name (e.g., 'chrome').
    """
    try:
        settings = file_io.get_settings()
        if not settings.get('yt_mark_watched', True):
            return True, "Disabled in settings"
    except: pass

    if not url or not cookies_info:
        return False, "Missing URL or cookies info"

    ytdlp_path = shutil.which("yt-dlp") or "yt-dlp"
    
    cmd = [
        ytdlp_path,
        "--ignore-config",
        "--simulate",
        "--mark-watched",
        "--no-playlist",
        "--quiet",
        "--no-warnings"
    ]

    # Check if cookies_info is a file or a browser name
    if os.path.exists(cookies_info):
        cmd.extend(["--cookies", cookies_info])
    else:
        # Assume it's a browser name for --cookies-from-browser
        cmd.extend(["--cookies-from-browser", cookies_info])
    
    if user_agent:
        cmd.extend(["--user-agent", user_agent])
    
    cmd.append(url)
    
    try:
        logging.info(f"[History] Executing mark-watched for: {url} (Using: {cookies_info})")
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        
        if result.returncode == 0:
            return True, "Success"
        else:
            stderr_msg = result.stderr.strip() if result.stderr else "Unknown error"
            return False, f"yt-dlp error: {stderr_msg}"
            
    except subprocess.TimeoutExpired:
        return False, "Timeout"
    except Exception as e:
        return False, str(e)

def mark_video_as_watched_threaded(url, cookies_info, user_agent=None, on_done=None):
    """
    Helper to launch the mark-watched process in a daemon thread.
    on_done callback receives (success, message).
    """
    def run():
        success, msg = mark_video_as_watched(url, cookies_info, user_agent)
        if on_done:
            on_done(success, msg)

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    return thread

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python youtube_history.py <url> <cookies_info> [user_agent]")
        sys.exit(1)
    
    target_url = sys.argv[1]
    cookies = sys.argv[2]
    ua = sys.argv[3] if len(sys.argv) > 3 else None
    
    print(f"Marking {target_url} as watched using {cookies}...")
    success, msg = mark_video_as_watched(target_url, cookies, ua)
    if success:
        print(f"Success: {msg}")
        sys.exit(0)
    else:
        print(f"Failed: {msg}")
        sys.exit(1)
