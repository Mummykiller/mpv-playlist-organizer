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
VAULT_RE = re.compile(r"vault-\d+\.owocdn\.top/stream/.*uwu\.m3u8$")

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
            "is_youtube": False
        }

    # --- Case 2: YouTube URLs (YOUTUBE_RE) ---
    if YOUTUBE_RE.search(url):
        # Detect if it's a playlist or a video with a playlist attached
        if "list=" in url:
            try:
                logging.info(f"Expanding YouTube playlist: {url}")
                cmd = [
                    'yt-dlp',
                    '--flat-playlist',
                    '--print', '%(title)s|%(webpage_url)s',
                    '--no-warnings'
                ]
                if browser and browser != "None":
                    cmd.extend(['--cookies-from-browser', browser])
                cmd.append(url)

                result = subprocess.run(cmd, capture_output=True, text=True, check=True)
                lines = result.stdout.strip().split('\n')
                
                entries = []
                for line in lines:
                    if '|' in line:
                        title, webpage_url = line.split('|', 1)
                        entries.append({
                            "title": title,
                            "url": webpage_url,
                            "is_youtube": True,
                            "use_ytdl_mpv": False,
                            "disable_http_persistent": True,
                            "headers": {"User-Agent": effective_user_agent} # Pass UA to children
                        })
                
                if entries:
                    return {
                        "success": True,
                        "is_playlist": True,
                        "entries": entries,
                        "url": url,
                        "use_ytdl_mpv": False,
                        "headers": {"User-Agent": effective_user_agent} # Pass UA
                    }
            except Exception as e:
                logging.warning(f"Failed to expand YouTube playlist: {e}")

        # Fall through to Case 3 for external resolution
        pass

    # --- Case 3: Other URLs (use yt-dlp --get-url to resolve direct URL) ---
    try:
        # Detect if this is a YouTube URL that fell through
        is_yt = YOUTUBE_RE.search(url)
        
        # We can go back to best quality because we are going to fix the cookie issue
        ytdl_format = 'best' if is_yt else 'best[ext=mp4]/best'

        cmd = [
            'yt-dlp',
            '--format', ytdl_format,
            '--get-url',
            '--no-warnings',
            '--geo-bypass-country', 'US',
            '--default-search', 'auto',
            '--user-agent', effective_user_agent,
            url
        ]

        cookies_file_path = None
        if browser and browser != "None":
            cmd.extend(['--cookies-from-browser', browser])
            
            # For YouTube, we also want to extract the cookies to a file for MPV
            if is_yt:
                try:
                    import tempfile
                    # Create a temporary file for cookies
                    # We use a semi-predictable name based on URL to reuse it or just let it be random
                    fd, temp_path = tempfile.mkstemp(suffix='.txt', prefix='mpv_cookies_')
                    os.close(fd)
                    
                    # Run a separate yt-dlp call just to dump cookies
                    cookie_cmd = [
                        'yt-dlp',
                        '--cookies-from-browser', browser,
                        '--cookies', temp_path,
                        '--simulate',
                        url
                    ]
                    subprocess.run(cookie_cmd, capture_output=True, check=False)
                    cookies_file_path = temp_path
                except Exception as e:
                    logging.warning(f"Failed to extract cookies for MPV: {e}")

        # Add mark-watched for YouTube if enabled (since we disabled Case 2)
        if youtube_enabled.lower() == 'true' and is_yt:
            cmd.append('--mark-watched')
        
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        resolved_url = result.stdout.strip()

        if not resolved_url:
            raise ValueError("yt-dlp returned no URL.")

        return {
            "success": True,
            "url": resolved_url,
            "headers": {"User-Agent": effective_user_agent},
            "ytdl_raw_options": None,
            "use_ytdl_mpv": False,
            "is_youtube": is_yt is not None,
            "disable_http_persistent": is_yt is not None,
            "cookies_file": cookies_file_path # Return the path to the cookies file
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