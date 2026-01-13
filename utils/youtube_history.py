import subprocess
import shutil
import logging
import threading
import sys
import os

# Prevent __pycache__ generation
sys.dont_write_bytecode = True
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'

def mark_video_as_watched(url, cookies_path, user_agent=None, timeout=30):
    """
    Uses yt-dlp to mark a YouTube video as watched.
    Returns (success, message).
    """
    if not url or not cookies_path or not os.path.exists(cookies_path):
        msg = f"Missing URL or cookies file at {cookies_path}"
        logging.warning(f"[History] Cannot mark as watched: {msg}")
        return False, "Missing cookies/URL"

    ytdlp_path = shutil.which("yt-dlp") or "yt-dlp"
    
    cmd = [
        ytdlp_path,
        "--ignore-config",
        "--simulate",
        "--cookies", cookies_path,
        "--mark-watched",
        "--no-playlist",
        "--quiet",
        "--no-warnings"
    ]
    
    if user_agent:
        cmd.extend(["--user-agent", user_agent])
    
    cmd.append(url)
    
    try:
        logging.info(f"[History] Executing mark-watched for: {url} (Using cookies: {cookies_path})")
        # Run process
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        
        if result.returncode == 0:
            logging.info(f"[History] Successfully marked as watched: {url}")
            return True, "Success"
        else:
            stderr_msg = result.stderr.strip() if result.stderr else "No error message"
            logging.error(f"[History] yt-dlp failed to mark as watched (Code {result.returncode}): {stderr_msg}")
            
            # User-friendly error mapping
            if "unavailable" in stderr_msg.lower():
                return False, "Video unavailable"
            elif "sign in" in stderr_msg.lower():
                return False, "Auth failed (Sign-in required)"
            
            return False, "yt-dlp error (Check logs)"
            
    except subprocess.TimeoutExpired:
        logging.error(f"[History] Timeout while marking as watched: {url}")
        return False, "Timeout"
    except Exception as e:
        logging.error(f"[History] Unexpected error marking as watched: {e}")
        return False, f"Error: {str(e)[:20]}"

def mark_video_as_watched_threaded(url, cookies_path, user_agent=None, on_done=None):
    """
    Helper to launch the mark-watched process in a daemon thread.
    on_done callback receives (success, message).
    """
    def run():
        success, msg = mark_video_as_watched(url, cookies_path, user_agent)
        if on_done:
            on_done(success, msg)

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    return thread

if __name__ == "__main__":
    # Minimal CLI wrapper for the script
    if len(sys.argv) < 3:
        print("Usage: python youtube_history.py <url> <cookies_path> [user_agent]")
        sys.exit(1)
    
    target_url = sys.argv[1]
    cookies = sys.argv[2]
    ua = sys.argv[3] if len(sys.argv) > 3 else None
    
    print(f"Marking {target_url} as watched...")
    if mark_video_as_watched(target_url, cookies, ua):
        print("Success.")
        sys.exit(0)
    else:
        print("Failed.")
        sys.exit(1)
