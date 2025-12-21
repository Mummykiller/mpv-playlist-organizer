#!/bin/bash
set -x # Enable shell debugging

# Check if any URLs were provided as arguments
if [ "$#" -eq 0 ]; then
  echo "Usage: $0 <M3U8_URL_1> [M3U8_URL_2] ..."
  exit 1
fi

# Define the expected URL pattern
# This regex checks for URLs like: https://vault-XX.owocdn.top/stream/XX/YY/.../uwu.m3u8
# where XX and YY are numbers, and the long hash is a 64-character hexadecimal string.
URL_PATTERN="^https://vault-[0-9]+\.owocdn\.top/stream/[0-9]+/[0-9]+/[a-f0-9]{64}/uwu\.m3u8$"

# Validate that at least one of the provided URLs matches the pattern
# This is to prevent the bypass from being used for completely unrelated sites
BYPASS_REQUIRED=false
for URL_ARG in "$@"; do
  if [[ "$URL_ARG" =~ $URL_PATTERN ]]; then
    BYPASS_REQUIRED=true
    break
  fi
done

if [ "$BYPASS_REQUIRED" = false ]; then
  echo "Error: None of the provided URLs match the expected owocdn.top pattern."
  echo "Expected format: https://vault-XX.owocdn.top/stream/XX/YY/.../uwu.m3u8"
  echo "Received URLs: $@"
  exit 1
fi

# Execute yt-dlp to get direct URLs for all provided M3U8 URLs,
# then pipe these direct URLs as a playlist to mpv.
echo "Executing yt-dlp and mpv pipeline..."
yt-dlp --referer "https://kwik.cx/" \
       --user-agent "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36" \
       --cookies-from-browser brave \
       --print-url "$@" | mpv --playlist /dev/stdin
echo "yt-dlp and mpv pipeline finished."
 
