import sys
import json
import subprocess
import os
import re # Add re import
import platform # Add platform import

def run_bypass_logic(url, browser, youtube_enabled, user_agent_str):
    """
    Runs yt-dlp to extract the direct URL or relevant info.
    """
    # Detect if it's an animepahe-like URL that requires MPV's internal yt-dlp
    is_animepahe_cdn = re.match(r"^https://vault-\d+\.owocdn\.top/stream/.+/uwu\.m3u8", url)

    if is_animepahe_cdn:
        # For animepahe-like URLs, we want MPV to run yt-dlp with specific options,
        # so _bypass_logic.py just returns these options for services.py to use.
        return {
            "success": True,
            "url": url, # MPV will process the original URL
            "headers": {
                "User-Agent": user_agent_str, # Use dynamic User-Agent
                "Referer": "https://kwik.cx/"
            },
            "ytdl_raw_options": 'cookies-from-browser='+browser+',referer="https://kwik.cx/"', # Use dynamic browser
            "use_ytdl_mpv": True, # Flag for services.py to tell MpvCommandBuilder
            "is_youtube": False
        }

    # Original yt-dlp --get-url logic for other URLs
    try:
        cmd = [
            'yt-dlp',
            '--format', 'best[ext=mp4]/best', # Prioritize mp4, then best available
            '--get-url',
            '--no-warnings',
            '--geo-bypass-country', 'US', # Common geo-bypass for many services
            '--default-search', 'auto',
            url
        ]

        if browser and browser != "None":
            cmd.extend(['--cookies-from-browser', browser])

        is_youtube = "youtube.com/" in url or "youtu.be/" in url
        if youtube_enabled.lower() == 'true' and is_youtube:
            cmd.extend(['--mark-watched'])

        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        resolved_url = result.stdout.strip()

        if not resolved_url:
            raise ValueError("yt-dlp returned no URL.")

        return {
            "success": True,
            "url": resolved_url,
            "headers": None,  # No specific headers for MPV needed for direct URL
            "ytdl_raw_options": None,
            "use_ytdl_mpv": False,
            "is_youtube": is_youtube
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
    user_agent = sys.argv[4] # NEW: User-Agent string

    result = run_bypass_logic(url, browser, youtube_enabled, user_agent)
    print(json.dumps(result))
    
    if not result.get("success"):
        sys.exit(1) # Indicate failure to the shell script