import sys
import json
import subprocess
import os
import re
import platform
import logging
import file_io
import uuid

# Constants for file patterns
COOKIE_PREFIX = "mpv_cookies_"
COOKIE_EXT = ".txt"

os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
sys.dont_write_bytecode = True

# Regular Expressions for URL detection
YOUTUBE_RE = re.compile(r"(youtube\.com|youtu\.be)")
# Flexible regex for Animepahe/owocdn vault links (allows query params)
VAULT_RE = re.compile(r"vault-\d+\.owocdn\.top/stream/.*uwu\.m3u8")
# Common direct stream extensions
DIRECT_STREAM_RE = re.compile(r"\.(m3u8|mp4|mkv|webm|avi|mov)(\?.*)?$", re.IGNORECASE)

# Global cache for the cookies file to avoid re-extracting for every item in a playlist
_COOKIES_CACHE = {
    "path": None,
    "browser": None,
    "timestamp": 0
}

def sanitize_url(url):
    """Sanitizes a URL by removing potentially dangerous characters for shell commands."""
    return file_io.sanitize_string(url, is_filename=False)

def get_cookies_file(browser, url, ignore_config=True):
    """Extracts cookies once and caches the path."""
    global _COOKIES_CACHE
    import time
    import shutil
    
    # Sanitize the URL before using it in a command
    url = sanitize_url(url)
    
    now = time.time()
    # Cache for 10 minutes
    if _COOKIES_CACHE["path"] and _COOKIES_CACHE["browser"] == browser and (now - _COOKIES_CACHE["timestamp"] < 600):
        if os.path.exists(_COOKIES_CACHE["path"]) and os.path.getsize(_COOKIES_CACHE["path"]) > 0:
            return _COOKIES_CACHE["path"]

    try:
        # Use a dedicated directory for cookies within the app data dir
        cookies_dir = os.path.join(file_io.DATA_DIR, "temp_playlists", "cookies")
        os.makedirs(cookies_dir, exist_ok=True)
        
        # Include PID in the filename for smart cleanup: mpv_cookies_PID_uuid.txt
        pid = os.getpid()
        unique_id = uuid.uuid4().hex[:8]
        temp_filename = f"{COOKIE_PREFIX}{pid}_{unique_id}{COOKIE_EXT}"
        temp_path = os.path.join(cookies_dir, temp_filename)
        
        ytdlp_path = shutil.which("yt-dlp") or "yt-dlp"
        
        # Run a separate yt-dlp call just to dump cookies
        cookie_cmd = [
            ytdlp_path,
            '--cookies-from-browser', browser,
            '--cookies', temp_path,
            '--simulate',
            '--quiet',
            url
        ]
        
        if ignore_config:
            cookie_cmd.insert(1, '--ignore-config')
        
        logging.info(f"Extracting cookies from {browser} using command: {' '.join(cookie_cmd)}")
        result = subprocess.run(cookie_cmd, capture_output=True, text=True, check=False, timeout=30)
        
        if result.returncode != 0:
            logging.error(f"yt-dlp cookie extraction failed (Code {result.returncode})")
            if result.stdout: logging.error(f"STDOUT: {result.stdout.strip()}")
            if result.stderr: logging.error(f"STDERR: {result.stderr.strip()}")

        if os.path.exists(temp_path) and os.path.getsize(temp_path) > 0:
            _COOKIES_CACHE["path"] = temp_path
            _COOKIES_CACHE["browser"] = browser
            _COOKIES_CACHE["timestamp"] = now
            logging.info(f"Successfully extracted {os.path.getsize(temp_path)} bytes of cookies to {temp_path}")
            return temp_path
        else:
            logging.warning(f"Extracted cookie file is empty or missing: {temp_path}")
            if not result.stderr and not result.stdout:
                logging.warning("yt-dlp exited silently with no cookies found. Check if the browser profile is correct.")
            return None
    except Exception as e:
        logging.warning(f"Failed to extract cookies for MPV: {e}")
        return None

def run_bypass_logic(url, browser, youtube_enabled, user_agent_str, yt_use_cookies=True, yt_mark_watched=True, yt_ignore_config=True, other_sites_use_cookies=True, ytdl_quality='best'):
    """
    Runs bypass logic to extract direct URLs or provide options for MPV's internal handlers.
    """
    # First line of defense inside analyzer: sanitize the URL
    url = sanitize_url(url)
    
    # Use provided UA or a reasonable Chrome-like default
    effective_user_agent = user_agent_str if user_agent_str else "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    
    is_yt_enabled = str(youtube_enabled).lower() == "true"
    is_yt_cookies_enabled = str(yt_use_cookies).lower() == "true"
    is_mark_watched_enabled = str(yt_mark_watched).lower() == "true"
    is_yt_ignore_config_enabled = str(yt_ignore_config).lower() == "true"
    is_other_cookies_enabled = str(other_sites_use_cookies).lower() == "true"

    # Determine format for external resolution with strict sanitization
    ytdl_format = 'best'
    if ytdl_quality and ytdl_quality != 'best':
        q = str(ytdl_quality)
        if q in ['2160', '1440', '1080', '720', '480']:
            ytdl_format = f"bestvideo[height<={q}]+bestaudio/best[height<={q}]"
        else:
            logging.warning(f"URL Analyzer Sanitization: Ignored invalid quality '{q}'")

    # --- Case 1: Animepahe-like URLs (VAULT_RE) ---
    if VAULT_RE.search(url):
        # Based on stuff.py, these should NOT use yt-dlp, but require specific headers.
        return {
            "success": True,
            "url": url, # MPV will play the original URL directly
            "headers": {
                "User-Agent": effective_user_agent,
                "Referer": "https://kwik.cx/",
                "Origin": "https://kwik.cx/",
                "X-Requested-With": "XMLHttpRequest"
            },
            "ytdl_raw_options": None,
            "use_ytdl_mpv": False,
            "is_youtube": False,
            "disable_http_persistent": True
        }

    # --- Case 1b: Generic Direct Stream Detection ---
    if DIRECT_STREAM_RE.search(url) and not YOUTUBE_RE.search(url):
        logging.info(f"Direct stream URL detected: {url}. Skipping yt-dlp resolution.")
        return {
            "success": True,
            "url": url,
            "headers": {"User-Agent": effective_user_agent},
            "ytdl_raw_options": None,
            "use_ytdl_mpv": False,
            "is_youtube": False
        }

    # --- Case 2: YouTube URLs ---
    is_yt = YOUTUBE_RE.search(url)

    if is_yt:
        # 2a. Handle Playlist Expansion
        if "list=" in url:
            try:
                logging.info(f"Expanding YouTube playlist: {url}")
                cmd = [
                    'yt-dlp',
                    '--flat-playlist',
                    '--print', '%(title)s|%(webpage_url)s'
                ]
                
                if is_yt_ignore_config_enabled:
                    cmd.insert(1, '--ignore-config')

                cookies_file = None
                # Expansion always tries to use browser cookies if possible for private playlists
                if browser and browser != "None":
                    cmd.extend(['--cookies-from-browser', browser])
                    if is_yt_enabled and is_yt_cookies_enabled:
                        cookies_file = get_cookies_file(browser, url, ignore_config=is_yt_ignore_config_enabled)

                cmd.append(url)

                result = subprocess.run(cmd, capture_output=True, text=True, check=True, timeout=30)
                lines = result.stdout.strip().split('\n')
                
                entries = []
                for line in lines:
                    if '|' in line:
                        title, webpage_url = line.split('|', 1)
                        # Sanitize extracted title
                        title = file_io.sanitize_string(title)
                        
                        ytdl_opts = []
                        if is_yt_enabled:
                            if cookies_file:
                                ytdl_opts.append(f"cookies={cookies_file}")

                        entries.append({
                            "title": title,
                            "url": webpage_url,
                            "is_youtube": True,
                            "use_ytdl_mpv": True, 
                            "disable_http_persistent": True,
                            "headers": {"User-Agent": effective_user_agent},
                            "ytdl_raw_options": ",".join(ytdl_opts) if ytdl_opts else None,
                            "cookies_file": cookies_file,
                            "mark_watched": is_mark_watched_enabled and is_yt_cookies_enabled
                        })
                
                if entries:
                    return {
                        "success": True,
                        "is_playlist": True,
                        "entries": entries,
                        "url": url,
                        "use_ytdl_mpv": False,
                        "is_youtube": True,
                        "headers": {"User-Agent": effective_user_agent}
                    }
            except Exception as e:
                logging.warning(f"Failed to expand YouTube playlist: {e}")

        # 2b. Handle Single YouTube Video
        if not is_yt_enabled:
            logging.info(f"YouTube resolution disabled in settings. Passing original URL to MPV: {url}")
            return {
                "success": True,
                "url": url,
                "headers": {"User-Agent": effective_user_agent},
                "use_ytdl_mpv": True,
                "is_youtube": True,
                "disable_http_persistent": True
            }

        try:
            cookies_file = None
            if is_yt_cookies_enabled and browser and browser != "None":
                cookies_file = get_cookies_file(browser, url, ignore_config=is_yt_ignore_config_enabled)

            logging.info(f"YouTube resolution enabled. Using original URL with cookies for MPV: {url}")

            ytdl_opts = []
            if cookies_file:
                ytdl_opts.append(f"cookies={cookies_file}")

            return {
                "success": True,
                "url": url,
                "headers": {"User-Agent": effective_user_agent},
                "ytdl_raw_options": ",".join(ytdl_opts) if ytdl_opts else None,
                "use_ytdl_mpv": True,
                "is_youtube": True,
                "disable_http_persistent": True,
                "cookies_file": cookies_file,
                "original_url": url,
                "mark_watched": is_mark_watched_enabled and is_yt_cookies_enabled
            }
        except Exception as e:
            logging.warning(f"YouTube cookie extraction failed: {e}. Falling back to original URL.")
            return {
                "success": True,
                "url": url,
                "headers": {"User-Agent": effective_user_agent},
                "use_ytdl_mpv": True,
                "is_youtube": True
            }

    # --- Case 3: Other URLs (External resolution as fallback) ---
    try:
        cmd = [
            'yt-dlp',
            '--force-ipv4',
            '--format', ytdl_format,
            '--get-url',
            '--geo-bypass-country', 'US',
            '--default-search', 'auto',
            '--user-agent', effective_user_agent,
            url
        ]
        
        if is_yt_ignore_config_enabled: 
            cmd.insert(1, '--ignore-config')

        if is_other_cookies_enabled and browser and browser != "None":
            cmd.extend(['--cookies-from-browser', browser])
        
        logging.info(f"Resolving non-YouTube URL externally: {url} with format {ytdl_format}")
        result = subprocess.run(cmd, capture_output=True, text=True, check=True, timeout=30)
        resolved_url = result.stdout.strip()

        if not resolved_url:
            raise ValueError("yt-dlp returned no URL.")

        return {
            "success": True,
            "url": resolved_url,
            "headers": {"User-Agent": effective_user_agent},
            "ytdl_raw_options": None,
            "use_ytdl_mpv": False,
            "is_youtube": False,
            "disable_http_persistent": False,
            "cookies_file": None
        }

    except subprocess.CalledProcessError as e:
        return {"success": False, "error": f"yt-dlp error: {e.stderr.strip()}"}
    except Exception as e:
        return {"success": False, "error": f"Bypass script error: {str(e)}"}

if __name__ == "__main__":
    if len(sys.argv) < 5:
        print(json.dumps({"success": False, "error": "Missing arguments."}), file=sys.stderr)
        sys.exit(1)

    url = sys.argv[1]
    browser = sys.argv[2]
    youtube_enabled = sys.argv[3]
    user_agent = sys.argv[4]

    result = run_bypass_logic(url, browser, youtube_enabled, user_agent)
    print(json.dumps(result))
    
    if not result.get("success"):
        sys.exit(1)