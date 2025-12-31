import sys
import json
import subprocess
import os
import re # Add re import
import platform # Add platform import
import logging

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

def get_cookies_file(browser, url):
    """Extracts cookies once and caches the path."""
    global _COOKIES_CACHE
    import time
    import tempfile
    
    now = time.time()
    # Cache for 10 minutes
    if _COOKIES_CACHE["path"] and _COOKIES_CACHE["browser"] == browser and (now - _COOKIES_CACHE["timestamp"] < 600):
        if os.path.exists(_COOKIES_CACHE["path"]) and os.path.getsize(_COOKIES_CACHE["path"]) > 0:
            return _COOKIES_CACHE["path"]

    try:
        fd, temp_path = tempfile.mkstemp(suffix='.txt', prefix='mpv_cookies_')
        os.close(fd)
        
        # Run a separate yt-dlp call just to dump cookies
        cookie_cmd = [
            'yt-dlp',
            '--force-ipv4',
            '--cookies-from-browser', browser,
            '--cookies', temp_path,
            '--simulate',
            url
        ]
        # Use a reasonable timeout for cookie extraction
        logging.info(f"Extracting cookies from {browser} to {temp_path}...")
        subprocess.run(cookie_cmd, capture_output=True, check=False, timeout=20)
        
        if os.path.exists(temp_path) and os.path.getsize(temp_path) > 0:
            _COOKIES_CACHE["path"] = temp_path
            _COOKIES_CACHE["browser"] = browser
            _COOKIES_CACHE["timestamp"] = now
            logging.info(f"Successfully extracted cookies to {temp_path}")
            return temp_path
        else:
            logging.warning(f"Extracted cookie file is empty or missing: {temp_path}")
            return None
    except Exception as e:
        logging.warning(f"Failed to extract cookies for MPV: {e}")
        return None

def run_bypass_logic(url, browser, youtube_enabled, user_agent_str):
    """
    Runs bypass logic to extract direct URLs or provide options for MPV's internal handlers.
    """
    # Use provided UA or a reasonable Chrome-like default
    effective_user_agent = user_agent_str if user_agent_str else "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

    # --- Case 1: Animepahe-like URLs (VAULT_RE) ---
    if VAULT_RE.search(url):
        # Based on stuff.py, these should NOT use yt-dlp, but require specific headers.
        return {
            "success": True,
            "url": url, # MPV will play the original URL directly
            "headers": {
                "User-Agent": effective_user_agent,
                "Referer": "https://kwik.cx/",
                "Origin": "https://kwik.cx/", # Added from stuff.py
                "X-Requested-With": "XMLHttpRequest" # Added from stuff.py
            },
            "ytdl_raw_options": None, # No yt-dlp options needed
            "use_ytdl_mpv": False, # Explicitly set to False as per stuff.py
            "is_youtube": False,
            "disable_http_persistent": True # Added to fix 'End of file' errors
        }

    # --- Case 1b: Generic Direct Stream Detection ---
    # Catch already-resolved URLs to avoid the slow yt-dlp fallback in Case 3.
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

    # --- Case 2: YouTube URLs (YOUTUBE_RE) ---
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
                if browser and browser != "None":
                    cmd.extend(['--cookies-from-browser', browser])
                cmd.append(url)

                result = subprocess.run(cmd, capture_output=True, text=True, check=True, timeout=30)
                lines = result.stdout.strip().split('\n')
                
                entries = []
                for line in lines:
                    if '|' in line:
                        title, webpage_url = line.split('|', 1)
                        entries.append({
                            "title": title,
                            "url": webpage_url,
                            "is_youtube": True,
                            "use_ytdl_mpv": True, # Allow MPV to handle if played before background resolution
                            "disable_http_persistent": True,
                            "headers": {"User-Agent": effective_user_agent}
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

        # 2b. External Resolution for Single YouTube Video
        try:
            cookies_file = None
            if browser and browser != "None":
                cookies_file = get_cookies_file(browser, url)

            # Resolve the direct stream URL in Python
            # We use a combined format to ensure it works without EDL
            ytdl_format = 'best[ext=mp4]/best'
            cmd = [
                'yt-dlp',
                '--force-ipv4',
                '--format', ytdl_format,
                '--get-url',
                '--user-agent', effective_user_agent,
                url
            ]
            if cookies_file:
                cmd.extend(['--cookies', cookies_file])
            
            logging.info(f"Resolving YouTube URL externally: {url} with format {ytdl_format}")
            result = subprocess.run(cmd, capture_output=True, text=True, check=True, timeout=30)
            resolved_url = result.stdout.strip()

            if not resolved_url:
                raise ValueError("yt-dlp returned no URL.")

            logging.info(f"Successfully resolved YouTube URL to: {resolved_url[:50]}...")

            return {
                "success": True,
                "url": resolved_url,
                "headers": {"User-Agent": effective_user_agent},
                "ytdl_raw_options": None,
                "use_ytdl_mpv": False, # MPV will NOT use ytdl hook
                "is_youtube": False, # Set to False since it's already a direct stream
                "disable_http_persistent": True,
                "cookies_file": cookies_file,
                "original_url": url
            }
        except Exception as e:
            logging.warning(f"External YouTube resolution failed: {e}. Falling back to original URL.")
            # Fallback to original URL if resolution fails for some reason
            return {
                "success": True,
                "url": url,
                "headers": {"User-Agent": effective_user_agent},
                "use_ytdl_mpv": True, # Last resort: let MPV try
                "is_youtube": True
            }

    # --- Case 3: Other URLs (External resolution as fallback) ---
    try:
        ytdl_format = 'best[ext=mp4]/best'

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

        if browser and browser != "None":
            cmd.extend(['--cookies-from-browser', browser])
        
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
    if len(sys.argv) < 5: # Expect 5 arguments now (script, url, browser, youtube_enabled, user_agent)
        print(json.dumps({"success": False, "error": "Missing arguments. Usage: _bypass_logic.py <url> <browser> <youtube_enabled> <user_agent>"}), file=sys.stderr)
        sys.exit(1)

    url = sys.argv[1]
    browser = sys.argv[2] # e.g., 'chrome', 'brave', 'firefox'
    youtube_enabled = sys.argv[3] # 'true' or 'false'
    user_agent = sys.argv[4] # User-Agent string

    result = run_bypass_logic(url, browser, youtube_enabled, user_agent)
    print(json.dumps(result))
    
    if not result.get("success"):
        sys.exit(1) # Indicate failure to the shell script