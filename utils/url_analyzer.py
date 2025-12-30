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
                            "is_youtube": True
                        })
                
                if entries:
                    return {
                        "success": True,
                        "is_playlist": True,
                        "entries": entries,
                        "url": url, # Keep original URL as fallback
                        "use_ytdl_mpv": False
                    }
            except Exception as e:
                logging.warning(f"Failed to expand YouTube playlist: {e}")
                # Fall through to single video resolution

        # For single videos, we still want to resolve them externally to avoid edl:// errors
        # (Fall through to Case 3 logic below)
        pass

    # --- Case 3: Other URLs (use yt-dlp --get-url to resolve direct URL) ---
    try:
        cmd = [
            'yt-dlp',
            '--format', 'best[ext=mp4]/best', # Prioritize mp4, then best available
            '--get-url',
            '--no-warnings',
            '--geo-bypass-country', 'US', # Common geo-bypass for many services
            '--default-search', 'auto',
            '--user-agent', effective_user_agent, # Pass User-Agent to yt-dlp
            url
        ]

        if browser and browser != "None":
            cmd.extend(['--cookies-from-browser', browser])
            
        # Add mark-watched for YouTube if enabled (since we disabled Case 2)
        if youtube_enabled.lower() == 'true' and YOUTUBE_RE.search(url):
            cmd.append('--mark-watched')
        
        # Note: youtube_enabled and is_youtube are now handled in Case 2.

        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        resolved_url = result.stdout.strip()

        if not resolved_url:
            raise ValueError("yt-dlp returned no URL.")

        return {
            "success": True,
            "url": resolved_url,
            "headers": None,  # No specific headers for MPV needed for direct resolved URL
            "ytdl_raw_options": None,
            "use_ytdl_mpv": False, # No yt-dlp for MPV for these, as URL is pre-resolved
            "is_youtube": False
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