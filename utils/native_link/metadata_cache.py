import os
import json
import logging
import time
from urllib.parse import urlparse

class MetadataCache:
    """
    Global persistent metadata cache for URLs.
    Prevents redundant yt-dlp calls and API hits.
    """
    def __init__(self, data_dir, file_io):
        self.cache_dir = os.path.join(data_dir, "metadata_cache")
        self.file_io = file_io
        try:
            os.makedirs(self.cache_dir, exist_ok=True)
        except Exception as e:
            logging.warning(f"[MetadataCache] Could not create cache dir: {e}")

    def _get_cache_path(self, url):
        try:
            parsed = urlparse(url)
            domain = parsed.netloc or "unknown"
            # Sanitize domain for filename safety
            safe_domain = "".join([c if c.isalnum() or c in ".-" else "_" for c in domain])
            return os.path.join(self.cache_dir, f"{safe_domain}.json")
        except Exception:
            return os.path.join(self.cache_dir, "generic.json")

    def get(self, url):
        """Retrieves cached metadata for a URL."""
        if not url:
            return None
            
        path = self._get_cache_path(url)
        if not os.path.exists(path):
            return None
        
        try:
            # Use file_io for robust loading
            cache = self.file_io._safe_json_load(path)
            entry = cache.get(url)
            
            if entry:
                # Optional: check expiration (e.g. 7 days)
                if time.time() - entry.get("cached_at", 0) > 604800:
                    return None
                return entry
        except Exception as e:
            logging.debug(f"[MetadataCache] Load error for {url}: {e}")
        return None

    def set(self, url, metadata):
        """Saves metadata for a URL to the global cache."""
        if not url or not metadata:
            return
            
        path = self._get_cache_path(url)
        try:
            cache = self.file_io._safe_json_load(path)
            
            # Extract only stable metadata (no session-specific RAM paths)
            stable_meta = {
                "title": metadata.get("title"),
                "headers": metadata.get("headers"),
                "is_youtube": metadata.get("is_youtube"),
                "use_ytdl_mpv": metadata.get("use_ytdl_mpv"),
                "ytdl_format": metadata.get("ytdl_format"),
                "cookies_browser": metadata.get("cookies_browser"),
                "cached_at": time.time()
            }
            
            # Don't cache if no useful info
            if not stable_meta["title"] and not stable_meta["headers"]:
                return

            cache[url] = stable_meta
            
            # Limit cache size per domain shard (e.g. 1000 items)
            if len(cache) > 1000:
                # Remove oldest entries
                sorted_urls = sorted(cache.keys(), key=lambda x: cache[x].get("cached_at", 0))
                for i in range(len(cache) - 1000):
                    del cache[sorted_urls[i]]

            self.file_io._atomic_json_dump(cache, path)
        except Exception as e:
            logging.warning(f"[MetadataCache] Save error for {url}: {e}")

    def list_shards(self):
        """Returns a list of all available domain shards."""
        try:
            return [f[:-5] for f in os.listdir(self.cache_dir) if f.endswith(".json")]
        except Exception:
            return []

    def get_shard(self, shard_name):
        """Returns the full content of a specific shard."""
        path = os.path.join(self.cache_dir, f"{shard_name}.json")
        return self.file_io._safe_json_load(path)
