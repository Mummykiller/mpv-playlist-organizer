import subprocess
import shutil
import threading
import sys
import os
import logging
import time

# Attempt to import cli_base to setup environment
try:
    import cli_base  # type: ignore[import-not-found]
except ImportError:
    # Fallback for when running from root or if utils is a package
    from utils import cli_base

cli_base.setup_script_env()

from utils.cli_base import BaseCLI
from utils import security
import file_io

def mark_video_as_watched(url, cookies_info, user_agent=None, timeout=30):
    """Uses yt-dlp to mark a YouTube video as watched."""
    if not url or not cookies_info:
        return False, "Missing URL or cookies info"
    if not security.is_safe_web_url(str(url)):
        return False, "Invalid or unsafe URL for mark-watched"

    settings = file_io.get_settings()
    ytdlp_path = settings.get("ytdlp_path") or shutil.which("yt-dlp") or "yt-dlp"
    if not security.is_safe_executable_path(ytdlp_path, setting_key="ytdlp_path"):
        logging.warning(f"[PY][Sync] Rejected unsafe yt-dlp executable path: {ytdlp_path}")
        return False, "Unsafe or invalid yt-dlp executable path"

    logging.info(f"[PY][Sync] Marking watched using {ytdlp_path} for URL: {url}")

    cmd = [
        ytdlp_path, "--ignore-config", "--simulate", "--mark-watched",
        "--no-playlist", "--quiet", "--no-warnings",
        "--ignore-no-formats-error"
    ]

    if os.path.exists(cookies_info):
        if not security.is_safe_cookie_file(cookies_info):
            logging.warning(f"[PY][Sync] Rejected unvalidated cookies file path: {cookies_info}")
            return False, "Unsafe cookies file path"
        cmd.extend(["--cookies", cookies_info])
    else:
        if not security.is_safe_cookie_browser(cookies_info):
            logging.warning(f"[PY][Sync] Rejected unapproved cookie browser: {cookies_info}")
            return False, "Invalid cookie browser name"
        cmd.extend(["--cookies-from-browser", cookies_info.strip()])

    if user_agent:
        cmd.extend(["--user-agent", user_agent])

    cmd.extend(["--", url])

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=security.get_scrubbed_env()
        )
        return (result.returncode == 0), ("Success" if result.returncode == 0 else result.stderr)
    except Exception as e:
        return False, str(e)

def sync_state(folder_id, item_id, resume_time=None, mark_watched=False, update_last_played=False, url=None, cookies=None, ua=None):
    """Updates the local folders database using sharded I/O."""
    if not folder_id or not item_id:
        return False, "Missing IDs"

    # 1. Validation & Pre-Sync Operations (No file locks yet)
    index = file_io.get_index()
    canonical_id = file_io._get_canonical_folder_id(folder_id, index)

    if canonical_id not in index:
        return False, f"Aborted: Folder '{folder_id}' not found in index.json"

    settings = file_io.get_settings()

    # 2. Check if already marked EXTERNALLY to avoid slow network call
    is_already_marked_externally = False
    playlist = file_io.get_playlist_shard(canonical_id)
    if playlist:
        for item in playlist:
            if item.get("id") == item_id:
                is_already_marked_externally = item.get("marked_as_watched", False)
                break

    watched_success = True # Default to true if not marking
    mark_watched_error = None

    # 3. Slow Network Call (ONLY if not already marked EXTERNALLY)
    if mark_watched and not is_already_marked_externally and settings.get('yt_mark_watched', True):
        watched_success, mark_watched_error = mark_video_as_watched(url, cookies, ua)
        if not watched_success:
            logging.error(f"YouTube Mark-Watched Error: {mark_watched_error}")

    # 4. Atomic Read-Modify-Write
    def _apply_sync(playlist, index_entry):
        if not playlist and not update_last_played:
            return None
        needs_shard_save = False
        if update_last_played and index_entry is not None:
            index_entry["last_played_id"] = item_id
            needs_shard_save = True
            logging.info(f"Disk: Updated last played item to {item_id}.")
        for item in playlist:
            if item.get("id") == item_id:
                # Update Watched Status
                if mark_watched and watched_success:
                    if not item.get("marked_as_watched") or not item.get("watched"):
                        item["marked_as_watched"] = True
                        item["watched"] = True
                        item["last_modified"] = int(time.time() * 1000)
                        needs_shard_save = True
                        logging.info("Disk: Updated marked_as_watched and watched.")
                elif mark_watched and not settings.get('yt_mark_watched', True):
                    # Manual override/fallback case (marking locally only)
                    if not item.get("watched"):
                        item["watched"] = True
                        item["last_modified"] = int(time.time() * 1000)
                        needs_shard_save = True

                # Update Resume Time
                if resume_time is not None and settings.get('enable_smart_resume', True):
                    time_val = int(float(resume_time))
                    current_stored = item.get("resume_time", 0)

                    # PROTECTION: If we are trying to set to 0, ensure it's not overwriting
                    # a significant progress unless we are reasonably sure it's intentional.
                    # (e.g. if the caller provided it explicitly or it's a minor drift)
                    is_reset = (time_val == 0 and current_stored > 10)

                    # For now, we trust the caller (Tracker) because we added guards there,
                    # but we'll add a log for visibility.
                    if is_reset:
                        logging.info(f"[PY][Sync] Resetting progress for {item_id} from {current_stored}s to 0s.")

                    if abs(current_stored - time_val) > 2 or time_val == 0:
                        item["resume_time"] = time_val
                        item["last_modified"] = int(time.time() * 1000)
                        needs_shard_save = True
                        logging.info(f"Disk: Updated resume time to {time_val}s.")
                break
        return True if needs_shard_save else None

    file_io.update_shard(canonical_id, _apply_sync, update_index=bool(update_last_played))

    if mark_watched and not watched_success:
        return False, mark_watched_error or "Failed to mark YouTube video as watched."

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
