import os
import sys
import json
import time
import logging
import subprocess
from datetime import datetime

# Prevent __pycache__ generation
sys.dont_write_bytecode = True
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'

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
            
        if os.path.exists(cache_file):
            try:
                os.remove(cache_file)
            except Exception:
                pass
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

    is_today_expired = False
    if day_key == "0" and day_cache:
        is_expired_by_timer = (now - day_cache['timestamp'] > anilist_cache.CACHE_DURATION_S)
        next_airing_at = day_cache['data'].get('next_airing_at')
        is_expired_by_release = next_airing_at and now > next_airing_at
        
        if is_expired_by_timer or is_expired_by_release or force_refresh:
            is_today_expired = True
            if is_expired_by_timer:
                logging.info("AniList Cache: Today expired by timer.")
            if is_expired_by_release:
                send_message_func({"log": {"text": "[AniList]: New episode aired. Refreshing...", "type": "info"}})
            full_cache = {}
            offsets = {}
            day_cache = None

    if not force_refresh and day_cache:
        if day_key != "0" or not is_today_expired:
            if now - LAST_ANILIST_FRESH_LOG_TIME > 300:
                send_message_func({"log": {"text": f"[AniList]: Loaded from local cache (Day Offset: {days}).", "type": "info"}})
                LAST_ANILIST_FRESH_LOG_TIME = now
            return {"success": True, "output": json.dumps(day_cache['data'])}

    logging.info(f"AniList Cache: Fetching fresh data for offset {days}.")
    return perform_full_fetch_and_cache(days)
