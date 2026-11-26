import os
import sys
import json
import time
import logging
import subprocess
from datetime import datetime
import file_io
from utils import security
from utils.file_lock import FileLock

# Prevent __pycache__ generation
sys.dont_write_bytecode = True
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'

# Global variable to track the last time a "cache is fresh" message was sent to the UI
LAST_ANILIST_FRESH_LOG_TIME = 0

class AniListCache:
    def __init__(self, cache_file, script_dir, send_message_func, file_io_mod=None):
        self.cache_file = cache_file
        self.script_dir = script_dir
        self.send_message = send_message_func
        self.file_io = file_io_mod or file_io
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
            result = subprocess.run(
                script_args,
                capture_output=True,
                text=True,
                check=True,
                encoding='utf-8',
                timeout=30,
                env=security.get_scrubbed_env()
            )
            return {"success": True, "output": result.stdout}
        except subprocess.TimeoutExpired as e:
            logging.error(f"Timeout running anilist_releases.py: {e}")
            return {"success": False, "error": "Timeout fetching AniList releases."}
        except subprocess.CalledProcessError as e:
            logging.error(f"Error running anilist_releases.py: {e.stderr}")
            return {"success": False, "error": f"Error fetching AniList releases: {e.stderr}"}
        except FileNotFoundError:
            error_msg = "anilist_releases.py not found in the script directory."
            logging.error(error_msg)
            return {"success": False, "error": error_msg}

    def _read_cache_unlocked(self):
        """Reads cache JSON without acquiring FileLock (caller must hold FileLock)."""
        if os.path.exists(self.cache_file):
            try:
                with open(self.cache_file, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    if isinstance(data, dict):
                        return data
            except (json.JSONDecodeError, IOError) as e:
                logging.warning(f"Could not read {self.cache_file}: {e}. Will perform a full fetch.")
        return {}

    def _load_cache(self):
        """Loads cache data from the cache file."""
        if os.path.exists(self.cache_file):
            try:
                with FileLock(self.cache_file):
                    return self._read_cache_unlocked()
            except (json.JSONDecodeError, IOError) as e:
                logging.warning(f"Could not read {self.cache_file}: {e}. Will perform a full fetch.")
        return {}

    def _save_cache(self, cache_data):
        """Saves cache data to the cache file."""
        try:
            with FileLock(self.cache_file):
                if self.file_io._atomic_json_dump(cache_data, self.cache_file):
                    logging.info(f"{self.cache_file} updated with new data.")
        except IOError as e:
            logging.error(f"Failed to write new {self.cache_file}: {e}")

    def _update_cache_atomic(self, day_key, entry=None, remove=False, today_timestamp=None):
        """Re-reads, merges updated offsets[day_key]/today_timestamp, and atomically saves under one FileLock."""
        try:
            with FileLock(self.cache_file):
                disk_cache = self._read_cache_unlocked()
                disk_offsets = disk_cache.get("offsets")
                if not isinstance(disk_offsets, dict):
                    disk_offsets = {}
                if remove:
                    disk_offsets.pop(day_key, None)
                elif entry is not None:
                    disk_offsets[day_key] = entry
                disk_cache["offsets"] = disk_offsets
                if today_timestamp is not None:
                    disk_cache["today_timestamp"] = today_timestamp
                if self.file_io._atomic_json_dump(disk_cache, self.cache_file):
                    logging.info(f"{self.cache_file} updated with new data.")
                return disk_cache
        except IOError as e:
            logging.error(f"Failed to write new {self.cache_file}: {e}")
            return None

def get_anilist_releases_with_cache(force_refresh, delete_cache, is_cache_disabled, days, cache_file, script_dir, send_message_func):
    """Handles fetching AniList releases with a multi-day file-based caching mechanism."""
    global LAST_ANILIST_FRESH_LOG_TIME
    anilist_cache = AniListCache(cache_file, script_dir, send_message_func)
    now = time.time()

    full_cache = anilist_cache._load_cache()
    today_ts = full_cache.get("today_timestamp", 0)

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

        try:
            with FileLock(cache_file):
                if os.path.exists(cache_file):
                    os.remove(cache_file)
        except OSError as e:
            logging.debug(f"[AniList] Failed to remove cache file {cache_file}: {e}")
        full_cache = {}
        today_ts = 0

    if is_cache_disabled:
        res = anilist_cache._fetch_from_anilist_script(is_ping=False, days=days)
        if res.get('success') and isinstance(res.get('output'), str):
            try:
                parsed = json.loads(res['output'])
                if isinstance(parsed, dict):
                    parsed.pop('raw_schedules_for_cache', None)
                res['output'] = parsed
            except (json.JSONDecodeError, ValueError) as e:
                logging.debug(f"[AniList] Output is not valid JSON: {e}")
        return res

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
                raw_schedules = parsed_data.pop('raw_schedules_for_cache', []) if isinstance(parsed_data, dict) else []
                entry = {
                    "timestamp": now,
                    "data": parsed_data,
                    "sorted_airing_ats": sorted([s['airingAt'] for s in raw_schedules if isinstance(s, dict) and 'airingAt' in s])
                }
                res['output'] = parsed_data
                anilist_cache._update_cache_atomic(
                    str(target_days),
                    entry=entry,
                    today_timestamp=now if target_days == 0 else None,
                )
            except Exception as e:
                logging.error(f"Failed to process AniList fetch for cache: {e}")
        return res

    is_today_expired = False
    if day_cache:
        is_expired_by_timer = (now - day_cache['timestamp'] > anilist_cache.CACHE_DURATION_S)
        next_airing_at = day_cache['data'].get('next_airing_at')
        is_expired_by_release = (day_key == "0" and next_airing_at and now > next_airing_at)

        if is_expired_by_timer or is_expired_by_release or force_refresh:
            if day_key == "0":
                is_today_expired = True
                if is_expired_by_timer:
                    logging.info("AniList Cache: Today expired by timer.")
                if is_expired_by_release:
                    send_message_func({"log": {"text": "[AniList]: New episode aired. Refreshing...", "type": "info"}})
            else:
                logging.info(f"AniList Cache: Offset {days} expired by timer.")
            anilist_cache._update_cache_atomic(day_key, remove=True)
            offsets.pop(day_key, None)
            day_cache = None

    if not force_refresh and day_cache:
        if day_key != "0" or not is_today_expired:
            if now - LAST_ANILIST_FRESH_LOG_TIME > 300:
                send_message_func({"log": {"text": f"[AniList]: Loaded from local cache (Day Offset: {days}).", "type": "info"}})
                LAST_ANILIST_FRESH_LOG_TIME = now
            return {"success": True, "output": day_cache['data']}

    logging.info(f"AniList Cache: Fetching fresh data for offset {days}.")
    res = perform_full_fetch_and_cache(days)
    if res['success'] and isinstance(res['output'], str):
        try:
            res['output'] = json.loads(res['output'])
        except (json.JSONDecodeError, ValueError) as e:
            logging.debug(f"[AniList] Output is not valid JSON: {e}")
    return res
