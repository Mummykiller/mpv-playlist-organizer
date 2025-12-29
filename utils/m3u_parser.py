import re
from typing import List, Dict, Optional

def parse_m3u(m3u_content: str) -> List[Dict]:
    """
    Parses M3U content, extracting URLs, titles, and custom per-item headers
    and yt-dlp options based on custom EXT-X- tags.

    Args:
        m3u_content: The full content of the M3U file as a string.

    Returns:
        A list of dictionaries, where each dictionary represents a url_item
        with keys like 'url', 'title', 'headers', 'ytdl_raw_options', etc.
    """
    lines = m3u_content.strip().split('\n')
    url_items = []
    
    current_title: Optional[str] = None
    current_headers: Dict[str, str] = {}
    current_ytdl_options: List[str] = [] # Use list to store multiple key=value pairs

    for line in lines:
        line = line.strip()
        if not line or line.startswith('#EXTM3U'):
            # Skip empty lines or the M3U header
            continue
        
        if line.startswith('#EXTINF:'):
            # Extract title from #EXTINF tag
            match = re.search(r'#EXTINF:[-0-9]+,(.*)', line)
            if match:
                current_title = match.group(1).strip()
            else:
                current_title = "Unknown Title"
        elif line.startswith('#EXT-X-HEADERS:'):
            # Parse custom headers
            headers_str = line[len('#EXT-X-HEADERS:'):].strip()
            for pair in headers_str.split('|'):
                if '=' in pair:
                    key, value = pair.split('=', 1)
                    current_headers[key.strip()] = value.strip()
        elif line.startswith('#EXT-X-YTDL-OPTIONS:'):
            # Parse custom yt-dlp options
            options_str = line[len('#EXT-X-YTDL-OPTIONS:'):].strip()
            # We'll store them as a list of strings, then join with spaces later
            # to form the --ytdl-raw-options string
            for pair in options_str.split('|'):
                if pair:
                    # Assuming key=value format for ytdl-raw-options, convert to --key=value
                    # Handle cases where value might be empty or just a flag
                    if '=' in pair:
                        key, value = pair.split('=', 1)
                        current_ytdl_options.append(f"--{key.strip()}={value.strip()}")
                    else: # For boolean flags like --no-warnings
                        current_ytdl_options.append(f"--{pair.strip()}")
        elif not line.startswith('#'):
            # This is a URL, so create a url_item
            url_item = {
                'url': line,
                'title': current_title if current_title else line, # Use URL as title fallback
                'headers': current_headers if current_headers else None,
                'ytdl_raw_options': ' '.join(current_ytdl_options) if current_ytdl_options else None,
                # Default values, adjust if needed by other custom EXT-X tags
                'use_ytdl_mpv': False, # Default to False, can be overridden by logic
                'is_youtube': 'youtube.com/' in line or 'youtu.be/' in line # Basic check
            }
            url_items.append(url_item)

            # Reset for the next item
            current_title = None
            current_headers = {}
            current_ytdl_options = []

    return url_items

if __name__ == '__main__':
    # Simple test case for the parser
    test_m3u_content = """
    #EXTM3U

    #EXTINF:-1,My Awesome Stream with Headers and YTDL Options
    #EXT-X-HEADERS:User-Agent=CustomPlayer/1.0|Referer=https://some-streaming-site.com
    #EXT-X-YTDL-OPTIONS:cookies-from-browser=brave|playlist-items=1-5
    https://www.youtube.com/watch?v=dQw4w9WgXcQ

    #EXTINF:-1,Another Stream with Only Headers
    #EXT-X-HEADERS:User-Agent=AnotherAgent/2.0
    https://example.com/another_stream.mp4

    #EXTINF:-1,Simple Stream
    https://example.com/simple_stream.mp4
    """
    
    parsed_items = parse_m3u(test_m3u_content)
    for i, item in enumerate(parsed_items):
        print(f"--- Item {i+1} ---")
        for key, value in item.items():
            print(f"{key}: {value}")
        print()

    # Test with empty M3U
    print("--- Empty M3U Test ---")
    empty_m3u = "#EXTM3U"
    print(parse_m3u(empty_m3u))

    # Test with only URLs
    print("--- URLs Only M3U Test ---")
    urls_only_m3u = """
    #EXTM3U
    http://test.com/1.m3u8
    http://test.com/2.mp4
    """
    parsed_urls_only = parse_m3u(urls_only_m3u)
    for i, item in enumerate(parsed_urls_only):
        print(f"--- Item {i+1} ---")
        for key, value in item.items():
            print(f"{key}: {value}")
        print()
