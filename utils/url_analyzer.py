import sys
import json
import subprocess
import os
import re
import platform
import logging
import file_io
import uuid
import socket
import ipaddress
from urllib.parse import urlparse

# Constants for file patterns
COOKIE_PREFIX = "mpv_cookies_"
COOKIE_EXT = ".txt"

os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
sys.dont_write_bytecode = True

# Regular Expressions for URL detection
YOUTUBE_RE = re.compile(r"(youtube\.com|youtu\.be)")
# Flexible regex for Animepahe/owocdn vault links (allows query params)
VAULT_RE = re.compile(r"(vault-\d+|na-\d+|cdn-\d+)\.(owocdn|uwucdn)\.top/stream/.*uwu\.m3u8")
# Common direct stream extensions
DIRECT_STREAM_RE = re.compile(r"\.(m3u8|mp4|mkv|webm|avi|mov)(\?.*)?$", re.IGNORECASE)
KWIK_RE = re.compile(r"kwik\.cx/(f|e)/[a-zA-Z0-9]+")

# Global cache for the cookies file to avoid re-extracting for every item in a playlist
_COOKIES_CACHE = {
    "path": None,
    "browser": None,
    "timestamp": 0
}

def is_safe_url(url):
    """
    Validates a URL against SSRF attacks by resolving the hostname 
    and checking against private IP ranges.
    """
    try:
        parsed = urlparse(url)
        hostname = parsed.hostname
        if not hostname:
            return True # No hostname (e.g. file path), let protocol check handle it

        # Resolve hostname to IP
        try:
            ip_str = socket.gethostbyname(hostname)
        except socket.gaierror:
            return False # DNS failure

        ip = ipaddress.ip_address(ip_str)
        
        # Block Private IPs (10.x, 192.168.x, 172.16.x, 127.x)
        if ip.is_private or ip.is_loopback or ip.is_link_local:
            logging.warning(f"SSRF Protection: Blocked access to private IP {ip_str} ({hostname})")
            return False
            
        return True
    except Exception as e:
        logging.error(f"SSRF Check Failed: {e}")
        return False

class VolatileCookieManager:
    """Manages cookie extraction to volatile memory (RAM) to avoid disk writes."""
    
    @staticmethod
    def get_volatile_dir():
        """Returns a path to a RAM-backed directory if available."""
        # Linux: /dev/shm is standard for shared memory (RAM)
        if platform.system() == "Linux" and os.path.exists("/dev/shm"):
            base_dir = "/dev/shm"
        else:
            # Fallback for Windows/Other: Standard temp dir
            base_dir = file_io.TEMP_DIR
            
        cookie_dir = os.path.join(base_dir, "mpv_organizer_cookies")
        os.makedirs(cookie_dir, exist_ok=True)
        return cookie_dir

    @staticmethod
    def cleanup_volatile_dir():
        """Securely removes the volatile cookie directory."""
        v_dir = VolatileCookieManager.get_volatile_dir()
        if os.path.exists(v_dir):
            try:
                import shutil
                shutil.rmtree(v_dir, ignore_errors=True)
                logging.info(f"Cleaned up volatile cookie directory: {v_dir}")
            except Exception as e:
                logging.warning(f"Failed to cleanup volatile cookies: {e}")

    @staticmethod
    def extract_with_shadow_copy(browser, url, target_path, ignore_config=True):
        """
        Creates a shadow copy of the browser DB to bypass lock errors,
        extracts cookies, then cleans up the shadow copy.
        """
        import shutil
        
        system = platform.system()
        user_home = os.path.expanduser("~")
        
        # Determine the database path based on OS and browser
        db_rel_path = None
        if system == "Linux":
            base = os.path.join(user_home, ".config")
            mapping = {
                "chrome": "google-chrome/Default/Cookies",
                "brave": "BraveSoftware/Brave-Browser/Default/Cookies",
                "edge": "microsoft-edge/Default/Cookies",
                "chromium": "chromium/Default/Cookies",
                "vivaldi": "vivaldi/Default/Cookies",
                "opera": "opera/Cookies"
            }
            db_rel_path = os.path.join(base, mapping.get(browser.lower(), ""))
        elif system == "Windows":
            base = os.environ.get('LOCALAPPDATA', "")
            mapping = {
                "chrome": "Google/Chrome/User Data/Default/Network/Cookies",
                "brave": "BraveSoftware/Brave-Browser/User Data/Default/Network/Cookies",
                "edge": "Microsoft/Edge/User Data/Default/Network/Cookies",
                "vivaldi": "Vivaldi/User Data/Default/Network/Cookies"
            }
            db_rel_path = os.path.join(base, mapping.get(browser.lower(), ""))

        if not db_rel_path or not os.path.exists(db_rel_path):
            logging.debug(f"Shadow Copy: Could not locate database for {browser} at {db_rel_path}")
            return False

        # Create shadow copy in volatile storage
        shadow_path = f"{target_path}.shadow"
        try:
            logging.info(f"Shadow Copy: Duplicating locked database to {shadow_path}")
            shutil.copy2(db_rel_path, shadow_path)
            
            # Use yt-dlp to read from the shadow copy
            # Note: yt-dlp doesn't have a direct "read from this file" for browser DBs,
            # but we can use the --cookies-from-browser BROWSER:PATH syntax.
            ytdlp_path = shutil.which("yt-dlp") or "yt-dlp"
            cmd = [
                ytdlp_path,
                '--cookies-from-browser', f"{browser}:{os.path.dirname(os.path.dirname(db_rel_path)) if system == 'Windows' else os.path.dirname(db_rel_path)}",
                '--cookies', target_path,
                '--skip-download', '--quiet', '--no-warnings', url
            ]
            if ignore_config: cmd.insert(1, '--ignore-config')
            
            subprocess.run(cmd, capture_output=True, text=True, check=False, timeout=20)
            
            return os.path.exists(target_path) and os.path.getsize(target_path) > 0
        except Exception as e:
            logging.warning(f"Shadow Copy failed: {e}")
            return False
        finally:
            if os.path.exists(shadow_path):
                try: os.remove(shadow_path)
                except: pass

def sanitize_url(url):
    """Sanitizes a URL by removing potentially dangerous characters for shell commands."""
    return file_io.sanitize_string(url, is_filename=False)

def get_cookies_file(browser, url, ignore_config=True, force_refresh=False):
    """
    Extracts cookies to a VOLATILE (RAM-based) file.
    Only used when:
    1. Playlist expansion (Python needs to read the page).
    2. Fallback (Direct browser access failed).
    """
    global _COOKIES_CACHE
    import time
    import shutil
    
    url = sanitize_url(url)
    now = time.time()
    
    # Layer 1: In-memory cache check (1 hour)
    if not force_refresh and _COOKIES_CACHE["path"] and _COOKIES_CACHE["browser"] == browser and (now - _COOKIES_CACHE["timestamp"] < 3600):
        if os.path.exists(_COOKIES_CACHE["path"]) and os.path.getsize(_COOKIES_CACHE["path"]) > 0:
            return _COOKIES_CACHE["path"]

    try:
        # Use VOLATILE directory
        cookies_dir = VolatileCookieManager.get_volatile_dir()
        
        # Use UUID to prevent collisions and ensure privacy per-session if needed
        temp_filename = f"{COOKIE_PREFIX}{browser}_{uuid.uuid4().hex[:6]}{COOKIE_EXT}"
        temp_path = os.path.join(cookies_dir, temp_filename)
        
        # Layer 3: Hard Refresh via yt-dlp
        ytdlp_path = shutil.which("yt-dlp") or "yt-dlp"
        
        cookie_cmd = [
            ytdlp_path,
            '--cookies-from-browser', browser,
            '--cookies', temp_path,
            '--skip-download',
            '--quiet',
            '--no-warnings',
            url
        ]
        
        if ignore_config:
            cookie_cmd.insert(1, '--ignore-config')
        
        logging.info(f"Extracting cookies to RAM ({temp_path}) for {browser}...")
        result = subprocess.run(cookie_cmd, capture_output=True, text=True, check=False, timeout=30)
        
        # --- Check for success or trigger Shadow Copy Fallback ---
        success = os.path.exists(temp_path) and os.path.getsize(temp_path) > 0
        
        if not success:
            logging.info(f"Primary extraction failed. Triggering Shadow Copy fallback for {browser}...")
            success = VolatileCookieManager.extract_with_shadow_copy(browser, url, temp_path, ignore_config=ignore_config)

        if success:
            try:
                os.chmod(temp_path, 0o600) # Read/Write for owner only
            except Exception: pass

            _COOKIES_CACHE["path"] = temp_path
            _COOKIES_CACHE["browser"] = browser
            _COOKIES_CACHE["timestamp"] = now
            logging.info(f"Cookies extracted to volatile storage: {temp_path}")
            return temp_path
        else:
            logging.warning(f"All cookie extraction methods failed for {browser}.")
            return None
    except Exception as e:
        logging.warning(f"Failed to extract cookies for MPV: {e}")
        return None

def run_bypass_logic(url, browser, youtube_enabled, user_agent_str, yt_use_cookies=True, yt_mark_watched=True, yt_ignore_config=True, other_sites_use_cookies=True, ytdl_quality='best'):
    """
    Runs bypass logic. Returns 'cookies_browser' string for direct MPV usage, 
    or 'cookies_file' path if extraction was forced (e.g. for Python-side expansion).
    """
    # First line of defense inside analyzer: sanitize the URL
    url = sanitize_url(url)
    
    # --- Protocol Validation ---
    # Must match services.ALLOWED_PROTOCOLS
    ALLOWED_PROTOCOLS = ('http://', 'https://', 'file://', 'udp://', 'rtmp://', 'rtsp://', 'mms://')
    if not url.lower().startswith(ALLOWED_PROTOCOLS):
        logging.warning(f"Security: Rejected URL with unsafe protocol: {url}")
        return {
            "success": False,
            "error": "Invalid URL protocol. Only http, https, file, udp, rtmp, rtsp, and mms schemes are allowed."
        }
    
    # --- SSRF Protection ---
    if url.lower().startswith(('http://', 'https://')) and not is_safe_url(url):
        return {
            "success": False,
            "error": "Security Block: Access to private/local networks is not allowed."
        }
    
    # Use provided UA or a reasonable Chrome-like default
    effective_user_agent = user_agent_str if user_agent_str else "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    
    is_yt_enabled = str(youtube_enabled).lower() == "true"
    is_yt_cookies_enabled = str(yt_use_cookies).lower() == "true"
    is_mark_watched_enabled = str(yt_mark_watched).lower() == "true"
    is_yt_ignore_config_enabled = str(yt_ignore_config).lower() == "true"
    is_other_cookies_enabled = str(other_sites_use_cookies).lower() == "true"

    # Determine format for external resolution with strict sanitization
    ytdl_format = 'bestvideo+bestaudio/best'
    if ytdl_quality and ytdl_quality != 'best':
        q = str(ytdl_quality)
        if q in ['2160', '1440', '1080', '720', '480']:
            if int(q) > 1080:
                ytdl_format = f"bv*[height<=?{q}][vcodec~='^vp0?9|^av01']+ba/bv*[height<=?{q}]+ba/best"
            else:
                ytdl_format = f"bv*[height<=?{q}]+ba/best"
        else:
            logging.warning(f"URL Analyzer Sanitization: Ignored invalid quality '{q}'")

    # --- Case 1: Animepahe-like URLs (VAULT_RE) ---
    if "owocdn" in url or "uwucdn" in url or "kwik.cx" in url or VAULT_RE.search(url) or KWIK_RE.search(url):
        # Header-First Direct: Stop extracting cookie files to RAM for Animepahe.
        # Instead, we pass the browser name to MPV and force ytdl=yes.
        # This allows MPV to handle the Kwik.cx decryption natively and faster.
        
        cookies_browser = None
        if is_other_cookies_enabled and browser and browser != "None":
            cookies_browser = browser

        return {
            "success": True,
            "url": url, 
            "headers": {
                "User-Agent": effective_user_agent,
                "Referer": "https://kwik.cx/",
                "Origin": "https://kwik.cx",
            },
            "ytdl_raw_options": None,
            "use_ytdl_mpv": True, # Force ytdl to use the native Kwik extractor
            "is_youtube": False,
            "disable_http_persistent": False,
            "cookies_file": None, # No more RAM files
            "cookies_browser": cookies_browser
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
        # 2a. Handle Playlist Expansion (REQUIRES COOKIES FILE for Python to read)
        if "list=" in url:
            if check_cancelled and check_cancelled():
                raise RuntimeError("Launch cancelled by user.")
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
                cookies_browser = None
                
                if browser and browser != "None":
                    if is_yt_enabled and is_yt_cookies_enabled:
                        # For expansion, we MUST extract to file so Python can use it
                        cookies_file = get_cookies_file(browser, url, ignore_config=is_yt_ignore_config_enabled)
                        if cookies_file:
                            cmd.extend(['--cookies', cookies_file])
                            # Also pass browser name for the entries themselves to use later
                            cookies_browser = browser 
                        else:
                            # Fallback if extraction fails
                            cmd.extend(['--cookies-from-browser', browser])
                            cookies_browser = browser

                cmd.append(url)

                result = subprocess.run(cmd, capture_output=True, text=True, check=True, timeout=30)
                lines = result.stdout.strip().split('\n')
                
                entries = []
                for line in lines:
                    if '|' in line:
                        title, webpage_url = line.split('|', 1)
                        title = file_io.sanitize_string(title)
                        
                        ytdl_opts = []
                        # NOTE: We do NOT append "cookies=" here. 
                        # We will pass cookies_browser to MPV instead.
                        
                        entries.append({
                            "title": title,
                            "url": webpage_url,
                            "original_url": webpage_url,
                            "is_youtube": True,
                            "use_ytdl_mpv": True, 
                            "disable_http_persistent": False,
                            "headers": {"User-Agent": effective_user_agent},
                            "ytdl_raw_options": ",".join(ytdl_opts) if ytdl_opts else None,
                            "cookies_file": None, # Prefer browser name
                            "cookies_browser": cookies_browser, # NEW
                            "mark_watched": is_mark_watched_enabled and is_yt_cookies_enabled,
                            "ytdl_format": ytdl_format
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
                "disable_http_persistent": False
            }

        try:
            cookies_file = None
            cookies_browser = None
            
            if is_yt_cookies_enabled and browser and browser != "None":
                # OPTIMIZATION: Do NOT extract cookies here.
                # Just pass the browser name.
                cookies_browser = browser
                # cookies_file remains None unless we hit a fallback logic later (handled by session)

            logging.info(f"YouTube resolution enabled. Using direct browser access ({cookies_browser or 'None'}) for MPV: {url}")

            return {
                "success": True,
                "url": url,
                "headers": {"User-Agent": effective_user_agent},
                "ytdl_raw_options": None,
                "use_ytdl_mpv": True,
                "is_youtube": True,
                "disable_http_persistent": False,
                "cookies_file": None, # We don't have a file yet!
                "cookies_browser": cookies_browser, # Pass the browser name
                "original_url": url,
                "mark_watched": is_mark_watched_enabled and is_yt_cookies_enabled,
                "ytdl_format": ytdl_format
            }
        except Exception as e:
            logging.warning(f"YouTube analysis failed: {e}. Falling back to original URL.")
            return {
                "success": True,
                "url": url,
                "headers": {"User-Agent": effective_user_agent},
                "use_ytdl_mpv": True,
                "is_youtube": True,
                "disable_http_persistent": False
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
            "cookies_file": None,
            "cookies_browser": None
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