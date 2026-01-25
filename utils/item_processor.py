import uuid
import logging
from concurrent.futures import ThreadPoolExecutor
from . import native_link

class ItemProcessor:
    def __init__(self, services, send_message, file_io):
        self.services = services
        self.send_message = send_message
        self.file_io = file_io

    def ensure_id(self, item):
        """Ensures an item has a unique ID."""
        if not item.get('id'):
            item['id'] = str(uuid.uuid4())
        return item

    def enrich_single_item(self, item, folder_id=None, session_cookies=None, sync_lock=None, settings=None, session=None):
        """
        Enriches a single item using bypass scripts and sanitization.
        Returns a list of items (can be more than one if it's a playlist expansion).
        """
        if item.get('enriched'):
            return [item]
        
        if session and getattr(session, 'launch_cancelled', False):
            raise RuntimeError("Launch cancelled by user.")

        self.ensure_id(item)
        
        # Ensure it has an original URL
        if not item.get('original_url'):
            item['original_url'] = item.get('url')

        if settings is None:
            settings = self.file_io.get_settings()

        # Run bypass analysis
        res = self.services.apply_bypass_script(item, self.send_message, settings=settings, session=session)
        (
            processed_url, headers, ytdl_opts, use_ytdl, is_yt, entries, 
            disable_http, cookies_file, mark_watched, ytdl_fmt, cookies_browser
        ) = res

        if entries:
            processed_entries = []
            for entry in entries:
                self.ensure_id(entry)
                if not entry.get('original_url'):
                    entry['original_url'] = entry.get('url')
                entry['is_youtube'] = True
                entry.setdefault('use_ytdl_mpv', False)
                if cookies_browser: entry['cookies_browser'] = cookies_browser
                if cookies_file: entry['cookies_file'] = cookies_file
                processed_entries.append(entry)
            return processed_entries

        # Update item with results
        item['url'] = processed_url
        item['original_url'] = item.get('original_url') or item.get('url')
        item['ytdl_format'] = ytdl_fmt
        
        if headers:
            if not item.get('headers'):
                item['headers'] = headers
            else:
                item['headers'] = {**headers, **item['headers']}

        if ytdl_opts:
            item['ytdl_raw_options'] = self.file_io.merge_ytdlp_options(item.get('ytdl_raw_options'), ytdl_opts)

        item['use_ytdl_mpv'] = use_ytdl
        item['is_youtube'] = is_yt
        item['disable_http_persistent'] = disable_http
        item['cookies_file'] = cookies_file
        item['cookies_browser'] = cookies_browser
        item['mark_watched'] = mark_watched
        
        if cookies_file and session_cookies is not None:
            if sync_lock:
                with sync_lock:
                    session_cookies.add(cookies_file)
            else:
                session_cookies.add(cookies_file)
                
        item['enriched'] = True
        return [item]

    def process_batch(self, items, folder_id, settings, session=None, max_workers=5):
        """Enriches a batch of items in parallel."""
        final_items = []
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = [executor.submit(self.enrich_single_item, item, folder_id, settings=settings, session=session) for item in items]
            for future in futures:
                try:
                    final_items.extend(future.result())
                except Exception as e:
                    logging.error(f"Error enriching item in batch: {e}")
        return final_items

    def resolve_input_items(self, url_items_or_m3u, enriched_items_list, headers):
        """Resolves raw input (URL, Path, M3U content, or List) into a list of items."""
        if enriched_items_list is not None:
            return enriched_items_list, False

        if isinstance(url_items_or_m3u, list):
            return url_items_or_m3u, True
        if isinstance(url_items_or_m3u, dict):
            return [url_items_or_m3u], True
        
        if not isinstance(url_items_or_m3u, str):
            return [], False

        # String-based input (URL, Path, or raw M3U)
        from urllib.parse import urlparse
        from .m3u_parser import parse_m3u
        from .url_analyzer import is_safe_url
        import os

        # 1. YouTube Playlist Check
        if "youtube.com/playlist" in url_items_or_m3u or ("youtube.com/watch" in url_items_or_m3u and "list=" in url_items_or_m3u):
            logging.info(f"Expanding YouTube playlist: {url_items_or_m3u}")
            res = self.services.apply_bypass_script({'url': url_items_or_m3u}, self.send_message)
            entries = res[5] # entries index
            if entries:
                return entries, True
            return [{'url': url_items_or_m3u}], True

        # 2. File Path Check
        if os.path.exists(url_items_or_m3u):
            with open(url_items_or_m3u, 'r', encoding='utf-8') as f:
                return parse_m3u(f.read()), True

        # 3. URL Check
        if urlparse(url_items_or_m3u).scheme in ['http', 'https']:
            if not is_safe_url(url_items_or_m3u):
                logging.error(f"SSRF Protection: Blocked access to {url_items_or_m3u}")
                return None, False
            
            m3u_content = self._fetch_remote_m3u(url_items_or_m3u, headers)
            if m3u_content:
                return parse_m3u(m3u_content), True
            return [{'url': url_items_or_m3u}], True

        # 4. Raw M3U fallback
        return parse_m3u(url_items_or_m3u), True

    def _fetch_remote_m3u(self, url, headers):
        """Fetches M3U content from a remote URL."""
        from urllib.request import urlopen, Request
        from .url_analyzer import is_safe_url
        
        if not is_safe_url(url):
            logging.error(f"SSRF Protection: Blocked fetch of unsafe M3U URL: {url}")
            return None

        try:
            fetch_headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'}
            if headers:
                fetch_headers.update(headers)
            req = Request(url, headers=fetch_headers)
            with urlopen(req, timeout=10) as response:
                return response.read().decode('utf-8')
        except Exception as e:
            logging.error(f"Failed to fetch remote M3U: {e}")
            return None
