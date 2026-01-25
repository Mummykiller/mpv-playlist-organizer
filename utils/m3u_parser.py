import re
import sys
import os

# Prevent __pycache__ generation
sys.dont_write_bytecode = True
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'

from typing import List, Dict, Optional
import file_io

def parse_m3u(m3u_content: str) -> List[Dict]:
    """
    Parses M3U content, extracting URLs, titles, and custom per-item headers
    and yt-dlp options based on custom EXT-X- tags.
    """
    # Remove BOM if present
    if m3u_content.startswith('\ufeff'):
        m3u_content = m3u_content[1:]
        
    lines = m3u_content.strip().split('\n')
    url_items = []
    
    current_title: Optional[str] = None
    current_headers: Dict[str, str] = {}
    current_ytdl_options: List[str] = []

    def extract_pairs(s):
        """Extracts Key=Value or Key:Value pairs, supporting quoted values and pipes."""
        if not s:
            return []
            
        # If pipes are present, we use a simple split as they are considered safe delimiters
        if '|' in s:
            pairs = []
            for segment in s.split('|'):
                if '=' in segment:
                    pairs.append(segment.split('=', 1))
                elif ':' in segment:
                    pairs.append(segment.split(':', 1))
            return pairs

        # Otherwise, use regex to find pairs, supporting optional quotes for values
        # Pattern: Key followed by : or = followed by (quoted string OR non-comma string)
        pattern = r'([a-zA-Z0-9_-]+)\s*[:=]\s*("[^"]*"|[^,]+)'
        matches = re.findall(pattern, s)
        
        # Clean up quotes from values
        return [(k.strip(), v.strip().strip('"')) for k, v in matches]

    for line in lines:
        line = line.strip()
        if not line or line.startswith('#EXTM3U'):
            continue
        
        if line.startswith('#EXTINF:'):
            match = re.search(r'#EXTINF:[-0-9]+,(.*)', line)
            if match:
                raw_title = match.group(1).strip()
                current_title = file_io.sanitize_string(raw_title)
            else:
                current_title = "Unknown Title"
        elif line.startswith('#EXTHTTPHEADERS:') or line.startswith('#EXT-X-HEADERS:'):
            tag = '#EXTHTTPHEADERS:' if line.startswith('#EXTHTTPHEADERS:') else '#EXT-X-HEADERS:'
            headers_str = line[len(tag):].strip()
            for k, v in extract_pairs(headers_str):
                current_headers[k] = v
        elif line.startswith('#EXTYTDLOPTIONS:') or line.startswith('#EXT-X-YTDL-OPTIONS:'):
            tag = '#EXTYTDLOPTIONS:' if line.startswith('#EXTYTDLOPTIONS:') else '#EXT-X-YTDL-OPTIONS:'
            options_str = line[len(tag):].strip()
            for k, v in extract_pairs(options_str):
                current_ytdl_options.append(f"{k}={v}")
        elif not line.startswith('#'):
            # This is a URL - sanitize it
            sanitized_url = file_io.sanitize_string(line)
            
            # --- Basic Validation ---
            # Prevent "Ghost" items from malformed files (must have a scheme or look like a path)
            # We enforce that a URL must not contain spaces (unless it's a local path with quotes, 
            # but M3U URLs are typically encoded or plain) and must look like a resource.
            is_valid_url = re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*://', sanitized_url)
            is_valid_path = sanitized_url.startswith(('/', './', '../')) or (len(sanitized_url) > 2 and sanitized_url[1:3] == ':\\')
            
            if not (is_valid_url or is_valid_path) or ' ' in sanitized_url:
                logging.debug(f"M3U Parser: Skipping invalid URL/Path: {sanitized_url}")
                continue

            # --- ID Extraction ---
            # Look for the #mpv_organizer_id= fragment we inject in mpv_session.py
            extracted_id = None
            id_match = re.search(r"[#&]mpv_organizer_id=([^#&]+)", sanitized_url)
            if id_match:
                extracted_id = id_match.group(1)

            url_item = {
                'url': sanitized_url,
                'title': current_title if current_title else sanitized_url,
                'headers': current_headers if current_headers else None,
                'ytdl_raw_options': ','.join(current_ytdl_options) if current_ytdl_options else None,
                'use_ytdl_mpv': False,
                'is_youtube': 'youtube.com/' in sanitized_url or 'youtu.be/' in sanitized_url
            }
            if extracted_id:
                url_item['id'] = extracted_id

            url_items.append(url_item)
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
