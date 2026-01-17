import os
import json
import logging
import platform
import shutil
import sys
import re

# Prevent __pycache__ generation
sys.dont_write_bytecode = True
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'

import time
import threading

# --- Security Constants ---
YTDLP_SAFE_FLAGS_ALLOWLIST = {
    'cookies', 'cookies-from-browser', 'user-agent', 'referer', 'add-header',
    'format', 'f', 'concurrent-fragments', 'N', 'limit-rate', 'r', 'retries', 'R',
    'fragment-retries', 'skip-unavailable-fragments', 'keep-fragments',
    'buffer-size', 'http-chunk-size', 'playlist-start', 'playlist-end',
    'playlist-items', 'match-filter', 'no-playlist', 'yes-playlist', 'age-limit',
    'min-filesize', 'max-filesize', 'date', 'datebefore', 'dateafter',
    'min-views', 'max-views', 'min-downloads', 'max-downloads', 'min-likes',
    'max-likes', 'min-dislikes', 'max-dislikes', 'match-title', 'reject-title',
    'id', 'I', 'proxy', 'socket-timeout', 'source-address', 'force-ipv4', '4',
    'force-ipv6', '6', 'geo-verification-proxy', 'geo-bypass',
    'geo-bypass-country', 'geo-bypass-ip-block', 'flat-playlist',
    'no-flat-playlist', 'live-from-start', 'wait-for-video', 'no-wait-for-video',
    'ignore-config', 'no-ignore-config', 'compat-options', 'alias', 'print',
    'no-warnings', 'dump-user-agent', 'version', 'update', 'verbose', 'v',
    'quiet', 'q', 'no-check-certificate', 'prefer-insecure', 'ffmpeg-location',
    'remote-components', 'js-runtimes'
}

# --- Concurrency & Locking ---

class FileLock:
    """
    A robust cross-process file locking mechanism using a .lock file.
    Includes per-path thread-level synchronization and stale lock detection.
    """
    _locks = {}
    _global_lock = threading.Lock()
    _held_locks = threading.local()

    def __init__(self, filepath, timeout=5.0, delay=0.05):
        self.filepath = os.path.abspath(filepath)
        self.lockfile = f"{self.filepath}.lock"
        self.timeout = timeout
        self.delay = delay
        self.is_file_locked = False
        
        # Get or create a thread-level RLock for this specific path
        with FileLock._global_lock:
            if self.filepath not in FileLock._locks:
                FileLock._locks[self.filepath] = threading.RLock()
            self.thread_lock = FileLock._locks[self.filepath]

    def _is_pid_running(self, pid):
        """Checks if a process ID is currently running on the system."""
        if pid <= 0: return False
        try:
            if platform.system() == "Windows":
                import ctypes
                # 0x1000 = PROCESS_QUERY_LIMITED_INFORMATION
                h_process = ctypes.windll.kernel32.OpenProcess(0x1000, 0, pid)
                if h_process:
                    ctypes.windll.kernel32.CloseHandle(h_process)
                    return True
                return ctypes.windll.kernel32.GetLastError() == 5 # Access Denied means it exists
            else:
                os.kill(pid, 0)
                return True
        except (OSError, ImportError):
            return False

    def __enter__(self):
        # 1. Acquire thread-level RLock (prevents internal process contention)
        if not self.thread_lock.acquire(timeout=self.timeout):
            raise RuntimeError(f"Could not acquire thread lock for {self.filepath} after {self.timeout}s")
        
        # Initialize thread-local storage for recursion counting
        if not hasattr(FileLock._held_locks, 'counters'):
            FileLock._held_locks.counters = {}
        
        count = FileLock._held_locks.counters.get(self.filepath, 0)
        if count > 0:
            # Recursion: already held by this thread
            FileLock._held_locks.counters[self.filepath] = count + 1
            return self

        # 2. Acquire cross-process file lock
        start_time = time.time()
        my_pid = str(os.getpid())
        
        while time.time() - start_time < self.timeout:
            try:
                # Attempt atomic creation of lock file
                fd = os.open(self.lockfile, os.O_CREAT | os.O_EXCL | os.O_RDWR)
                try:
                    os.write(fd, my_pid.encode())
                finally:
                    os.close(fd)
                
                self.is_file_locked = True
                FileLock._held_locks.counters[self.filepath] = 1
                return self
            except OSError:
                # Lock file exists. Check if it is stale.
                try:
                    if os.path.exists(self.lockfile):
                        with open(self.lockfile, 'r') as f:
                            content = f.read().strip()
                            if content:
                                locked_pid = int(content)
                                # Check if PID is dead OR if it matches our own PID (orphaned file from this process)
                                # Since we hold thread_lock, no other thread in this process owns the file lock.
                                if locked_pid == int(my_pid) or not self._is_pid_running(locked_pid):
                                    logging.warning(f"[PY][IO] Removing stale lock for {self.filepath} (PID {locked_pid} {'matches current' if locked_pid == int(my_pid) else 'dead'})")
                                    try: os.remove(self.lockfile)
                                    except: pass
                                    continue # Try acquiring again immediately
                            else:
                                # Lock file is empty. Check if it's old enough to be considered stale/crashed.
                                try:
                                    if time.time() - os.path.getmtime(self.lockfile) > 1.0:
                                        logging.warning(f"[PY][IO] Removing stale empty lock file for {self.filepath}")
                                        os.remove(self.lockfile)
                                        continue
                                except OSError:
                                    pass # File might have been removed by another process
                except:
                    pass
                
                # Still locked, wait and retry
                time.sleep(self.delay)
        
        # Failed to acquire lock within timeout
        self.thread_lock.release()
        holder_pid = "unknown"
        try:
             with open(self.lockfile, 'r') as f:
                holder_pid = f.read().strip()
        except: pass
        raise RuntimeError(f"Could not acquire lock for {self.filepath} after {self.timeout}s. Held by PID: {holder_pid}")

    def __exit__(self, exc_type, exc_val, exc_tb):
        try:
            count = FileLock._held_locks.counters.get(self.filepath, 0)
            if count > 1:
                FileLock._held_locks.counters[self.filepath] = count - 1
            else:
                # Final release for this thread
                if self.is_file_locked:
                    try:
                        # Verify we still own the lock before deleting
                        if os.path.exists(self.lockfile):
                            with open(self.lockfile, 'r') as f:
                                if f.read().strip() == str(os.getpid()):
                                    os.remove(self.lockfile)
                    except:
                        pass
                    self.is_file_locked = False
                FileLock._held_locks.counters[self.filepath] = 0
        finally:
            self.thread_lock.release()

# --- Path Definitions ---

def get_user_data_dir():
    """Returns a platform-specific, user-writable directory for app data."""
    app_name = "MPVPlaylistOrganizer"
    system = platform.system()
    if system == "Windows":
        return os.path.join(os.environ.get('APPDATA', os.path.expanduser('~\\AppData\\Roaming')), app_name)
    elif system == "Darwin": # macOS
        return os.path.join(os.path.expanduser('~/Library/Application Support'), app_name)
    else: # Linux and other Unix-like systems
        xdg_data_home = os.getenv('XDG_DATA_HOME')
        if xdg_data_home:
            return os.path.join(xdg_data_home, app_name)
        return os.path.join(os.path.expanduser('~/.local/share'), app_name)

SCRIPT_DIR = os.path.dirname(os.path.abspath(sys.argv[0]))
DATA_DIR = get_user_data_dir()
import tempfile
TEMP_DIR = os.path.join(tempfile.gettempdir(), "mpv_playlist_organizer")
try:
    os.makedirs(TEMP_DIR, exist_ok=True)
except: pass

FOLDERS_FILE = os.path.join(DATA_DIR, "folders.json")
INDEX_FILE = os.path.join(DATA_DIR, "index.json")
PLAYLISTS_DIR = os.path.join(DATA_DIR, "playlists")
CONFIG_FILE = os.path.join(DATA_DIR, "config.json")
EXPORT_DIR = os.path.join(DATA_DIR, "exported")

try:
    os.makedirs(PLAYLISTS_DIR, exist_ok=True)
except: pass

def migrate_to_shards():
    """
    Safely migrates from the monolithic folders.json to a sharded index/playlists structure.
    """
    if not os.path.exists(FOLDERS_FILE):
        return

    # 1. Safety Backup
    bak_file = f"{FOLDERS_FILE}.bak_migration_{int(time.time())}"
    try:
        shutil.copy2(FOLDERS_FILE, bak_file)
        logging.info(f"[PY][IO] Created migration backup: {bak_file}")
    except Exception as e:
        logging.error(f"[PY][IO] Migration failed: Could not create backup. {e}")
        return

    with FileLock(FOLDERS_FILE):
        raw_folders = _safe_json_load(FOLDERS_FILE)
        if not raw_folders:
            return

        index_data = {}
        os.makedirs(PLAYLISTS_DIR, exist_ok=True)

        for folder_id, folder_data in raw_folders.items():
            playlist = folder_data.pop("playlist", [])
            
            # Index gets metadata
            index_data[folder_id] = {
                **folder_data,
                "item_count": len(playlist)
            }
            
            # Shard gets the content
            shard_path = os.path.join(PLAYLISTS_DIR, f"{folder_id}.json")
            _atomic_json_dump({"playlist": playlist}, shard_path)
            logging.info(f"[PY][IO] Created shard for folder: {folder_id}")

        # Save the new index
        if _atomic_json_dump(index_data, INDEX_FILE):
            logging.info("[PY][IO] Sharded migration complete. Index saved.")
            # We keep the old folders.json for a short period or rename it
            try:
                os.rename(FOLDERS_FILE, f"{FOLDERS_FILE}.migrated")
            except: pass

def get_index():
    """Loads the folder index (metadata only)."""
    if not os.path.exists(INDEX_FILE):
        # Fallback to migration if old file exists
        if os.path.exists(FOLDERS_FILE):
            migrate_to_shards()
        else:
            return {}
            
    with FileLock(INDEX_FILE):
        return _safe_json_load(INDEX_FILE)

def save_index(index_data):
    """Saves the folder index atomically."""
    with FileLock(INDEX_FILE):
        return _atomic_json_dump(index_data, INDEX_FILE)

def get_playlist_shard(folder_id):
    """Loads a specific playlist shard (Lazy Loading)."""
    shard_path = os.path.join(PLAYLISTS_DIR, f"{folder_id}.json")
    if not os.path.exists(shard_path):
        return []
    
    with FileLock(shard_path):
        data = _safe_json_load(shard_path)
        return data.get("playlist", [])

def save_playlist_shard(folder_id, playlist, update_index=True):
    """Saves a specific playlist shard and optionally updates the index count."""
    shard_path = os.path.join(PLAYLISTS_DIR, f"{folder_id}.json")
    
    # 1. Save the Shard
    with FileLock(shard_path):
        success = _atomic_json_dump({"playlist": playlist}, shard_path)
    
    if success and update_index:
        # 2. Update Index Metadata (Item Count)
        index = get_index()
        if folder_id in index:
            index[folder_id]["item_count"] = len(playlist)
            save_index(index)
            
    return success

def validate_safe_path(path, allow_user_content=False):
    """
    Validates that a path is safe for usage in flags (configuration/scripts).
    Resolves symlinks (realpath) and ensures it resides in allowed directories.
    
    If allow_user_content is True, allows arbitrary paths (use for media files).
    For flags, keep it False.
    """
    if not path: return None
    
    try:
        # Special case for Windows named pipes used for IPC
        if platform.system() == "Windows" and path.startswith("\\\\.\\pipe\\"):
            return path

        resolved = os.path.realpath(os.path.abspath(path))
        
        # Allowed bases for configuration/flags
        allowed_prefixes = [
            os.path.realpath(DATA_DIR),
            os.path.realpath(SCRIPT_DIR),
            os.path.realpath(TEMP_DIR)
        ]

        if platform.system() == "Linux":
            if os.path.exists("/dev/shm"):
                allowed_prefixes.append(os.path.realpath("/dev/shm"))
            
            xdg_runtime = os.environ.get("XDG_RUNTIME_DIR")
            if xdg_runtime:
                allowed_prefixes.append(os.path.realpath(xdg_runtime))
            
            # Allow the fallback IPC directory in user home
            allowed_prefixes.append(os.path.realpath(os.path.join(os.path.expanduser("~"), ".mpv_playlist_organizer_ipc")))
        
        # Check if path starts with any allowed prefix
        is_allowed = any(resolved.startswith(prefix) for prefix in allowed_prefixes)
        
        if not is_allowed and not allow_user_content:
            logging.warning(f"Security: Path validation failed. {resolved} is not in allowed directories.")
            return None
            
        return resolved
    except Exception as e:
        logging.error(f"Path validation error: {e}")
        return None

# --- Atomic Write & Safe Load Helpers ---

def _atomic_json_dump(data, filepath):
    """Writes JSON data to a file atomically using a .tmp file and os.replace."""
    tmp_file = f"{filepath}.tmp"
    bak_file = f"{filepath}.bak"
    
    try:
        os.makedirs(os.path.dirname(filepath), exist_ok=True)
        
        # 1. Write to temporary file
        with open(tmp_file, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=4)
            f.flush()
            os.fsync(f.fileno()) # Force write to disk
            
        # 2. Create backup of existing file if it exists
        if os.path.exists(filepath):
            shutil.copy2(filepath, bak_file)
            
        # 3. Atomic swap
        os.replace(tmp_file, filepath)
        return True
    except Exception as e:
        logging.error(f"[PY][IO] Atomic write failed for {filepath}: {e}")
        if os.path.exists(tmp_file):
            try: os.remove(tmp_file)
            except: pass
        return False

def _safe_json_load(filepath, default_factory=dict):
    """Loads JSON data with a fallback to .bak if the primary file is corrupted."""
    bak_file = f"{filepath}.bak"
    
    def try_load(path):
        if not os.path.exists(path):
            return None
        try:
            with open(path, 'r', encoding='utf-8') as f:
                content = f.read()
                if not content.strip():
                    return None
                return json.loads(content)
        except (json.JSONDecodeError, IOError) as e:
            logging.error(f"[PY][IO] Failed to load JSON from {path}: {e}")
            return None

    # Try primary
    data = try_load(filepath)
    if data is not None:
        return data

    # Try backup
    logging.warning(f"[PY][IO] Primary file {filepath} corrupted or missing. Attempting backup restore...")
    data = try_load(bak_file)
    if data is not None:
        logging.info(f"[PY][IO] Successfully restored data from {bak_file}")
        # Optionally restore the primary file immediately
        _atomic_json_dump(data, filepath)
        return data

    logging.error(f"[PY][IO] Both primary and backup for {filepath} are invalid. Returning default.")
    return default_factory()

# --- File I/O Functions ---

def get_mpv_executable():
    """Gets the path to the mpv executable by prioritizing PATH then config."""
    current_platform = platform.system()
    mpv_default_name = "mpv.exe" if current_platform == "Windows" else "mpv"

    # 1. Prioritize System PATH
    found_in_path = shutil.which(mpv_default_name)
    if found_in_path:
        return found_in_path

    # 2. Fallback to Configured Path
    config = _safe_json_load(CONFIG_FILE)
    configured_mpv_path = config.get("mpv_path")
    if configured_mpv_path and os.path.exists(configured_mpv_path):
        return configured_mpv_path
    
    return mpv_default_name

def sanitize_string(s, is_filename=False):
    """Sanitizes a string. preserves URL integrity while preventing shell/M3U issues."""
    if not isinstance(s, str):
        return s
    
    if is_filename:
        # Strict blacklist for folder names / filenames used in filesystem paths.
        # Strips: / \ : * ? " < > | $ ; & ` and newlines.
        restricted = ['/', '\\', ':', '*', '?', '"', '<', '>', '|', '$', ';', '&', '`', '\n', '\r', '\t']
        for char in restricted:
            s = s.replace(char, '')
    else:
        # Minimal destruction for URLs and Titles.
        # Only remove characters that are strictly illegal in M3U or break our JSON/logging.
        # We allow $, &, ;, |, and others because they are functional in many stream URLs.
        # We rely on list-based subprocess calls for shell safety.
        restricted = ['"', '`', '\n', '\r', '\t']
        for char in restricted:
            s = s.replace(char, '')
            
    return s.strip()

def sanitize_folder_name(name):
    """Specific strict sanitization for folder names used in filesystem paths."""
    return sanitize_string(name, is_filename=True)

def is_youtube_url(url):
    """Returns True if the URL is a recognized YouTube video or playlist URL."""
    if not url or not isinstance(url, str): return False
    return "youtube.com/" in url or "youtu.be/" in url

def get_youtube_id(url):
    """Extracts the video or playlist ID from a YouTube URL."""
    if not url: return None
    # Video ID
    video_match = re.search(r"(?:v=|\/v\/|embed\/|youtu\.be\/|\/shorts\/)([a-zA-Z0-9_-]{11})", url)
    if video_match: return video_match.group(1)
    # Playlist ID
    list_match = re.search(r"list=([a-zA-Z0-9_-]+)", url)
    if list_match: return list_match.group(1)
    return None

def sanitize_ytdlp_options(options_str):
    """
    Sanitizes a comma-separated string of yt-dlp options (key=value).
    Enforces a strict whitelist of safe flags.
    Handles escaped commas correctly.
    """
    if not options_str or not isinstance(options_str, str):
        return ""

    safe_options = []
    # Split by comma NOT preceded by backslash
    parts = re.split(r'(?<!\\),', options_str)
    
    for part in parts:
        part = part.strip()
        if not part: continue
        
        if '=' in part:
            key, value = part.split('=', 1)
        else:
            key = part
            value = ""
            
        clean_key = key.strip().lower()
        # Remove leading dashes for lookup
        lookup_key = clean_key.lstrip('-')
        
        if lookup_key in YTDLP_SAFE_FLAGS_ALLOWLIST:
            # Ensure boolean flags or empty values have exactly one trailing '='
            if value == "":
                safe_options.append(f"{clean_key}=")
            else:
                safe_options.append(f"{clean_key}={value}")
        else:
            logging.warning(f"Security: Removed unauthorized yt-dlp option '{key}' (not in whitelist)")
        
    return ",".join(safe_options)

def merge_ytdlp_options(*args):
    """Merges multiple ytdl-raw-options strings into one, deduplicating keys. Handles escaped commas."""
    merged_map = {}
    for options_str in args:
        if not options_str: continue
        # Split by comma NOT preceded by backslash
        parts = re.split(r'(?<!\\),', options_str)
        for part in parts:
            part = part.strip()
            if not part: continue
            if '=' in part:
                key, value = part.split('=', 1)
                merged_map[key.strip().lower()] = value
            else:
                merged_map[part.strip().lower()] = ""
    
    final_parts = []
    for k, v in merged_map.items():
        if v == "":
            final_parts.append(f"{k}=")
        else:
            final_parts.append(f"{k}={v}")
    
    merged_str = ",".join(final_parts)
    return sanitize_ytdlp_options(merged_str)

def _migrate_legacy_data(raw_folders):
    """
    Normalizes folder data structures, converting legacy formats if necessary.
    Returns a tuple (normalized_folders, was_modified).
    """
    converted_folders = {}
    needs_resave = False
    
    for folder_id, folder_content in raw_folders.items():
        # Sanitize the folder ID itself if it's new/changed
        clean_folder_id = sanitize_folder_name(folder_id)
        if clean_folder_id != folder_id:
            needs_resave = True

        # Standard format: {"playlist": [{"url": "...", "title": "..."}, ...]}
        if isinstance(folder_content, dict) and "playlist" in folder_content:
            playlist = folder_content.get("playlist", [])
            sanitized_playlist = []
            
            for item in playlist:
                if isinstance(item, str):
                    # Legacy list-of-strings inside "playlist"
                    needs_resave = True
                    sanitized_playlist.append({"url": sanitize_string(item), "title": sanitize_string(item)})
                elif isinstance(item, dict) and "url" in item:
                    # Standard dict format
                    original_url = item["url"]
                    original_title = item.get("title", "")
                    
                    sanitized_url = sanitize_string(original_url)
                    sanitized_title = sanitize_string(original_title)
                    
                    if sanitized_url != original_url or sanitized_title != original_title:
                        item["url"] = sanitized_url
                        item["title"] = sanitized_title
                        needs_resave = True
                    sanitized_playlist.append(item)
                else:
                    sanitized_playlist.append(item)
            
            # Preserve all existing keys (like last_played_id) and update playlist
            converted_folders[clean_folder_id] = folder_content
            converted_folders[clean_folder_id]["playlist"] = sanitized_playlist
            
        # Legacy format: List of strings directly
        elif isinstance(folder_content, list):
            logging.info(f"Converting old format (list) for folder '{folder_id}' to new format.")
            converted_folders[clean_folder_id] = {"playlist": [{"url": sanitize_string(url), "title": sanitize_string(url)} for url in folder_content]}
            needs_resave = True
            
        # Legacy format: Dict with "urls" key
        elif isinstance(folder_content, dict) and "urls" in folder_content:
            logging.info(f"Converting old format (dict with 'urls') for folder '{folder_id}' to new format.")
            converted_folders[clean_folder_id] = {"playlist": [{"url": sanitize_string(url), "title": sanitize_string(url)} for url in folder_content.get("urls", [])]}
            needs_resave = True
            
        else:
            logging.warning(f"Skipping malformed folder data for '{folder_id}' during load: {folder_content}")
            
    return converted_folders, needs_resave

def get_all_folders_from_file():
    """
    Reconstructs the full folder structure for compatibility.
    In performance-critical paths, use get_index() or get_playlist_shard() instead.
    Uses parallel reading for faster reconstruction of large libraries.
    """
    index = get_index()
    if not index:
        return {}
    
    full_data = {}
    from concurrent.futures import ThreadPoolExecutor
    
    # Use ThreadPoolExecutor for parallel file reading
    # Since this is I/O bound, more threads than cores can be beneficial.
    with ThreadPoolExecutor(max_workers=10) as executor:
        def fetch_shard(f_id, metadata):
            playlist = get_playlist_shard(f_id)
            return f_id, {**metadata, "playlist": playlist}
        
        results = list(executor.map(lambda x: fetch_shard(x[0], x[1]), index.items()))
        full_data = dict(results)
    
    return full_data

def get_folder_data(folder_id):
    """Retrieves metadata and playlist for a single folder efficiently."""
    index = get_index()
    meta = index.get(folder_id)
    if not meta:
        return None
    
    playlist = get_playlist_shard(folder_id)
    return {**meta, "playlist": playlist}

def write_folders_file(data):
    """
    Distributes the provided full data structure back into shards and the index.
    """
    index_data = {}
    for folder_id, folder_content in data.items():
        # Use .get to avoid modifying the input dictionary
        playlist = folder_content.get("playlist", [])
        
        # Update Shard without updating index (we'll do it once at the end)
        save_playlist_shard(folder_id, playlist, update_index=False)
        
        # Prepare Index Metadata
        # Create a copy of metadata without the playlist
        meta = {k: v for k, v in folder_content.items() if k != "playlist"}
        index_data[folder_id] = {
            **meta,
            "item_count": len(playlist)
        }
        
    return {"success": save_index(index_data)}

def write_export_file(filename, data, subfolder=None):
    """Helper to write data to a file in the export directory, optionally in a subfolder."""
    try:
        target_dir = EXPORT_DIR
        if subfolder:
            target_dir = os.path.join(EXPORT_DIR, subfolder)
            
        os.makedirs(target_dir, exist_ok=True)
        
        # Remove .json extension if user provided it, we'll add it back
        base = filename
        if base.lower().endswith('.json'):
            base = base[:-5]
            
        safe_basename = os.path.basename(base)
        # Enforce strict filename sanitization
        safe_basename = sanitize_string(safe_basename, is_filename=True)
        
        final_filename = f"{safe_basename}.json"
        filepath = os.path.join(target_dir, final_filename)

        # Automatic suffixing if file exists
        counter = 1
        while os.path.exists(filepath):
            final_filename = f"{safe_basename} ({counter}).json"
            filepath = os.path.join(target_dir, final_filename)
            counter += 1

        if _atomic_json_dump(data, filepath):
            logging.info(f"[PY][IO] Data exported to {filepath}")
            display_name = os.path.join(subfolder, final_filename) if subfolder else final_filename
            return {"success": True, "message": f"Data exported to '{display_name}' in the 'exported' folder."}
        else:
            return {"success": False, "error": "Atomic write failed during export."}
    except Exception as e:
        error_msg = f"[PY][IO] Failed to export data: {e}"
        logging.error(error_msg)
        return {"success": False, "error": error_msg}

def list_import_files():
    """Lists all .json files in the export directory and its subdirectories."""
    try:
        if not os.path.isdir(EXPORT_DIR):
            return {"success": True, "files": []}
        
        json_files = []
        for root, dirs, files in os.walk(EXPORT_DIR):
            for file in files:
                if file.endswith('.json'):
                    # Get path relative to EXPORT_DIR
                    rel_path = os.path.relpath(os.path.join(root, file), EXPORT_DIR)
                    # Normalize to forward slashes for the browser UI
                    json_files.append(rel_path.replace(os.sep, '/'))
        
        return {"success": True, "files": sorted(json_files, reverse=True)}
    except Exception as e:
        error_msg = f"[PY][IO] Failed to list import files: {e}"
        logging.error(error_msg)
        return {"success": False, "error": error_msg}

def get_settings():
    """Reads settings from config.json, providing default values for new keys."""
    default_settings = {
        "os_platform": platform.system(),
        "mpv_path": None, # Will be filled by installer or found in PATH
        "ffmpeg_path": None,
        "node_path": None,
        "enable_url_analysis": True,
        "browser_for_url_analysis": "chrome", # Default browser for UA/cookies
        "enable_youtube_analysis": False,
        "user_agent_string": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36", # Default UA
        "enable_smart_resume": True,
        "enable_precise_resume": True,
        "enable_active_item_highlight": True,
        "yt_use_cookies": True,
        "yt_mark_watched": True,
        "yt_ignore_config": True,
        "other_sites_use_cookies": True,
        "disable_network_overrides": False,
        "targeted_defaults": "all-none-yt",
        "enable_cache": True,
        "http_persistence": "auto",
        "demuxer_max_bytes": "1G",
        "demuxer_max_back_bytes": "500M",
        "cache_secs": 500,
        "demuxer_readahead_secs": 500,
        "stream_buffer_size": "10M",
        "ytdlp_concurrent_fragments": 4,
        "ytdl_quality": "best",
        "performance_profile": "default",
        "ultra_scalers": True,
        "ultra_video_sync": True,
        "ultra_interpolation": "oversample",
        "ultra_deband": True,
        "ultra_fbo": True,
        "enable_reconnect": True,
        "reconnect_delay": 4,
        "mpv_decoder": "auto",
        "automatic_mpv_flags": [
            {"flag": "--pause", "description": "Start MPV paused.", "enabled": False},
            {"flag": "--terminal", "description": "Show a terminal window.", "enabled": False},
            {"flag": "--save-position-on-quit", "description": "Remember playback position on exit.", "enabled": True},
            {"flag": "--loop-playlist=inf", "description": "Loop the entire playlist indefinitely.", "enabled": False},
            {"flag": "--ontop", "description": "Keep the player window on top of other windows.", "enabled": False},
            {"flag": "--force-window=immediate", "description": "Open the window immediately when starting.", "enabled": False}
        ],
        "enable_per_item_mark_watched": True
    }

    with FileLock(CONFIG_FILE):
        current_settings = _safe_json_load(CONFIG_FILE)
    
    # Merge current settings with defaults, prioritizing current_settings
    settings = {**default_settings, **current_settings}

    # --- NEW: Auto-sync Automatic MPV Flags ---
    if "automatic_mpv_flags" in current_settings:
        current_flags = {f["flag"]: f for f in current_settings["automatic_mpv_flags"]}
        updated_flags = []
        
        for default_f in default_settings["automatic_mpv_flags"]:
            if default_f["flag"] in current_flags:
                updated_flags.append(current_flags[default_f["flag"]])
            else:
                updated_flags.append(default_f)
        
        settings["automatic_mpv_flags"] = updated_flags

    # Ensure mpv_path default is platform-appropriate
    if settings["mpv_path"] is None:
        settings["mpv_path"] = "mpv.exe" if platform.system() == "Windows" else "mpv"

    return settings

def set_settings(settings_dict):
    """Writes the provided settings to config.json, merging with existing settings."""
    try:
        with FileLock(CONFIG_FILE):
            current_settings = get_settings()

            if 'ytdl_quality' in settings_dict:
                valid_qualities = ['best', '2160', '1440', '1080', '720', '480']
                if str(settings_dict['ytdl_quality']) not in valid_qualities:
                    logging.warning(f"[PY][SEC] Invalid ytdl_quality '{settings_dict['ytdl_quality']}' ignored.")
                    del settings_dict['ytdl_quality']

            # --- NEW: Normalize Buffer Settings & Align Cache/Readahead ---
            
            # 1. Align demuxer_readahead_secs with cache_secs if one is updated
            if 'cache_secs' in settings_dict:
                settings_dict['demuxer_readahead_secs'] = settings_dict['cache_secs']
            elif 'demuxer_readahead_secs' in settings_dict:
                 settings_dict['cache_secs'] = settings_dict['demuxer_readahead_secs']

            # 2. Append 'M' suffix to buffer settings if they are purely numeric
            buffer_keys = ['demuxer_max_bytes', 'demuxer_max_back_bytes', 'stream_buffer_size']
            for key in buffer_keys:
                if key in settings_dict:
                    val = str(settings_dict[key]).strip().upper()
                    if val and val.isdigit():
                        settings_dict[key] = f"{val}M"
                        logging.info(f"[PY][IO] Normalized {key} to {settings_dict[key]}")

            merged_settings = {**current_settings, **settings_dict}

            if _atomic_json_dump(merged_settings, CONFIG_FILE):
                logging.info(f"[PY][IO] Settings successfully written to {CONFIG_FILE}.")
                return {"success": True, "message": "Settings saved."}
            else:
                return {"success": False, "error": "Atomic write for settings failed."}
    except Exception as e:
        error_msg = f"[PY][IO] Failed to write settings to {CONFIG_FILE}: {e}"
        logging.error(error_msg)
        return {"success": False, "error": error_msg}