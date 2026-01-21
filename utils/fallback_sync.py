import subprocess
import shutil
import threading
import sys
import os
import argparse

# Path correction to find file_io and handle standalone execution
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
sys.path.insert(0, PROJECT_ROOT)

# Prevent __pycache__ generation
sys.dont_write_bytecode = True
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'

import file_io

def mark_video_as_watched(url, cookies_info, user_agent=None, timeout=30):
    """Uses yt-dlp to mark a YouTube video as watched."""
    if not url or not cookies_info:
        return False, "Missing URL or cookies info"

    ytdlp_path = shutil.which("yt-dlp") or "yt-dlp"
    cmd = [
        ytdlp_path, "--ignore-config", "--simulate", "--mark-watched",
        "--no-playlist", "--quiet", "--no-warnings"
    ]

    if os.path.exists(cookies_info):
        cmd.extend(["--cookies", cookies_info])
    else:
        cmd.extend(["--cookies-from-browser", cookies_info])
    
    if user_agent:
        cmd.extend(["--user-agent", user_agent])
    
    cmd.append(url)
    
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return (result.returncode == 0), ("Success" if result.returncode == 0 else result.stderr)
    except Exception as e:
        return False, str(e)

def sync_state(folder_id, item_id, resume_time=None, mark_watched=False, update_last_played=False, url=None, cookies=None, ua=None):
    """Updates the local folders database using sharded I/O."""
    if not folder_id or not item_id:
        return False, "Missing IDs"

    # Security Check: Ensure the folder is officially registered in index.json
    # This prevents 'ghost' folders (like lowercase 'default') from being updated/created.
    index = file_io.get_index()
    if folder_id not in index:
        return False, f"Aborted: Folder '{folder_id}' not found in index.json"

    settings = file_io.get_settings()
    
    # 1. Load the specific shard
    playlist = file_io.get_playlist_shard(folder_id)
    if not playlist and not update_last_played:
        return False, f"Playlist shard {folder_id} not found or empty"

    needs_shard_save = False
    
    # 2. Update the specific item in the shard
    for item in playlist:
        if item.get("id") == item_id:
            if mark_watched and not item.get("marked_as_watched"):
                if settings.get('yt_mark_watched', True):
                    # Perform the slow YouTube network call OUTSIDE of any file locks
                    success, msg = mark_video_as_watched(url, cookies, ua)
                    if success:
                        item["marked_as_watched"] = True
                        needs_shard_save = True
                        print("YouTube: Marked as watched.")
                    else:
                        print(f"YouTube Error: {msg}")
                else:
                    item["marked_as_watched"] = True
                    needs_shard_save = True
            
            if resume_time is not None and settings.get('enable_smart_resume', True):
                time_val = int(float(resume_time))
                if abs(item.get("resume_time", 0) - time_val) > 2 or time_val == 0:
                    item["resume_time"] = time_val
                    needs_shard_save = True
                    print(f"Disk: Updated resume time to {time_val}s.")
            break

    # 3. Handle Saves
    if needs_shard_save:
        file_io.save_playlist_shard(folder_id, playlist, update_index=False)

    if update_last_played:
        index = file_io.get_index()
        if folder_id in index:
            index[folder_id]["last_played_id"] = item_id
            file_io.save_index(index)
            print(f"Disk: Updated last played item to {item_id}.")

    return True, "Sync complete"

# Legacy support for existing threaded calls in other parts of the app
def mark_video_as_watched_threaded(url, cookies_info, user_agent=None, folder_id=None, item_id=None, on_done=None):
    def run():
        success, msg = sync_state(folder_id, item_id, mark_watched=True, url=url, cookies=cookies_info, ua=user_agent)
        if on_done:
            on_done(success, msg)
    t = threading.Thread(target=run, daemon=True)
    t.start()
    return t

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Fallback sync worker for MPV.")
    parser.add_argument("--folder", required=True, help="Folder ID")
    parser.add_argument("--item", required=True, help="Item UUID")
    parser.add_argument("--time", type=float, help="Current playback time to save")
    parser.add_argument("--mark-watched", action="store_true", help="Trigger YouTube watch mark")
    parser.add_argument("--last-played", action="store_true", help="Set this item as last played")
    parser.add_argument("--url", help="YouTube URL (required for mark-watched)")
    parser.add_argument("--cookies", help="Cookies file or browser (required for mark-watched)")
    parser.add_argument("--ua", help="User Agent (optional for mark-watched)")
    
    args = parser.parse_args()
    success, msg = sync_state(args.folder, args.item, args.time, args.mark_watched, args.last_played, args.url, args.cookies, args.ua)
    if success:
        sys.exit(0)
    else:
        print(f"Sync Failed: {msg}")
        sys.exit(1)
