#!/usr/bin/env python3

import os
import re
import subprocess
import sys

os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
sys.dont_write_bytecode = True

PLAYLIST_FILE = "playlist.m3u8"

# Updated User Agent (Chrome 143)
BRAVE_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/143.0.0.0 Safari/537.36"
)

# Regular Expressions for URL detection
YOUTUBE_RE = re.compile(r"(youtube\.com|youtu\.be)")
VAULT_RE = re.compile(r"vault-\d+\.owocdn\.top/stream/.*uwu\.m3u8$")

def init_playlist():
    """Initializes/Overwrites the M3U8 file to start fresh."""
    with open(PLAYLIST_FILE, "w", encoding="utf-8") as f:
        f.write("#EXTM3U\n\n")

def write_entry(url, title):
    """Writes a single entry with specific headers based on the URL type."""
    lines = []
    lines.append(f"#EXTINF:-1,{title}")

    if VAULT_RE.search(url):
        # Using comma-separated headers for the playlist entry to prevent 'file not found' errors
        header_fields = "Origin:https://kwik.cx,Referer:https://kwik.cx/,X-Requested-With:XMLHttpRequest"
        lines.extend([
            f"#EXTVLCOPT:http-user-agent={BRAVE_UA}",
            "#EXTVLCOPT:http-referrer=https://kwik.cx/",
            f"#EXTVLCOPT:http-header-fields={header_fields}",
            "#EXTVLCOPT:ytdl=no"
        ])

    if YOUTUBE_RE.search(url):
        # Ensure ytdl is enabled for YouTube links and set format
        lines.extend([
            "#EXTVLCOPT:ytdl=yes",
            "#EXTVLCOPT:ytdlp-format=bestvideo+bestaudio",
            "#EXTVLCOPT:ytdl-raw-options=mark-watched=,cookies-from-browser=brave"
        ])

    lines.append(url)
    lines.append("")

    with open(PLAYLIST_FILE, "a", encoding="utf-8") as f:
        f.write("\n".join(lines))

def main():
    init_playlist()

    print("--- M3U8 Playlist Generator ---")
    print(f"Creating new playlist: {PLAYLIST_FILE}\n")

    while True:
        url = input("URL (empty to quit): ").strip()
        if not url:
            break

        title = input("Title: ").strip()
        if not title:
            print("Title is required.")
            continue

        write_entry(url, title)
        print("Added to playlist.\n")

    print(f"\nPlaylist saved to: {PLAYLIST_FILE}")

    try:
        print("Launching mpv...")

        # Consistent comma-separated header fields for the command line call
        header_fields = "Origin:https://kwik.cx,Referer:https://kwik.cx/,X-Requested-With:XMLHttpRequest"

        cmd = [
            "mpv",
            f"--playlist={PLAYLIST_FILE}",
            f"--http-header-fields={header_fields}",
            "--referrer=https://kwik.cx/",
            "--user-agent=" + BRAVE_UA,
            "--cache=yes",
            "--demuxer-max-bytes=500M",
            "--no-resume-playback",
            "--ytdl-raw-options=mark-watched=,cookies-from-browser=brave"
        ]

        subprocess.run(cmd, check=True)

    except FileNotFoundError:
        print("\nError: 'mpv' command not found.")
    except KeyboardInterrupt:
        print("\nPlayback stopped.")
    except subprocess.CalledProcessError:
        print("\nmpv exited with an error. Check if the link has expired (403).")

if __name__ == "__main__":
    main()
