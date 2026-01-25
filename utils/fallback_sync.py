import subprocess
import shutil
import threading
import sys
import os
import logging

# Attempt to import cli_base to setup environment
try:
    import cli_base
except ImportError:
    # Fallback for when running from root or if utils is a package
    from utils import cli_base

cli_base.setup_script_env()

from utils.cli_base import BaseCLI
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

    # 1. Validation & Pre-Sync Operations (No file locks yet)
    index = file_io.get_index()
    if folder_id not in index:
        return False, f"Aborted: Folder '{folder_id}' not found in index.json"

    settings = file_io.get_settings()
    watched_success = False
    
    # 2. Slow Network Call (OUTSIDE of any file locks)
    if mark_watched and settings.get('yt_mark_watched', True):
        # We check if it's already marked by reading the shard once (non-locking or short lock)
        # but the real check happens during the atomic write phase.
        watched_success, msg = mark_video_as_watched(url, cookies, ua)
        if not watched_success:
            logging.error(f"YouTube Error: {msg}")

    # 3. Atomic Read-Modify-Write
    # We load the shard only now, AFTER the slow network call.
    needs_shard_save = False
    playlist = file_io.get_playlist_shard(folder_id)
    
    if playlist:
        for item in playlist:
            if item.get("id") == item_id:
                # Update Watched Status
                if watched_success:
                    if not item.get("marked_as_watched"):
                        item["marked_as_watched"] = True
                        needs_shard_save = True
                        logging.info("Disk: Updated marked_as_watched.")
                elif mark_watched and not settings.get('yt_mark_watched', True):
                    # Manual override/fallback case
                    if not item.get("marked_as_watched"):
                        item["marked_as_watched"] = True
                        needs_shard_save = True
                
                # Update Resume Time
                if resume_time is not None and settings.get('enable_smart_resume', True):
                    time_val = int(float(resume_time))
                    if abs(item.get("resume_time", 0) - time_val) > 2 or time_val == 0:
                        item["resume_time"] = time_val
                        needs_shard_save = True
                        logging.info(f"Disk: Updated resume time to {time_val}s.")
                break

    # 4. Handle Saves
    if needs_shard_save:
        file_io.save_playlist_shard(folder_id, playlist, update_index=False)

    if update_last_played:
        # get_index/save_index are already atomic in file_io.py
        index = file_io.get_index()
        if folder_id in index:
            index[folder_id]["last_played_id"] = item_id
            file_io.save_index(index)
            logging.info(f"Disk: Updated last played item to {item_id}.")

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
    cli = BaseCLI(description="Fallback sync worker for MPV.")
    cli.add_argument("--folder", required=True, help="Folder ID")
    cli.add_argument("--item", required=True, help="Item UUID")
    cli.add_argument("--time", type=float, help="Current playback time to save")
    cli.add_argument("--mark-watched", action="store_true", help="Trigger YouTube watch mark")
    cli.add_argument("--last-played", action="store_true", help="Set this item as last played")
    cli.add_argument("--url", help="YouTube URL (required for mark-watched)")
    cli.add_argument("--cookies", help="Cookies file or browser (required for mark-watched)")
    cli.add_argument("--ua", help="User Agent (optional for mark-watched)")
    
    args = cli.parse_args()
    success, msg = sync_state(args.folder, args.item, args.time, args.mark_watched, args.last_played, args.url, args.cookies, args.ua)
    if success:
        sys.exit(0)
    else:
        logging.error(f"Sync Failed: {msg}")
        sys.exit(1)
