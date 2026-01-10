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
FOLDERS_FILE = os.path.join(DATA_DIR, "folders.json")
CONFIG_FILE = os.path.join(DATA_DIR, "config.json")
EXPORT_DIR = os.path.join(DATA_DIR, "exported")

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
    """Gets the path to the mpv executable based on OS and config."""
    current_platform = platform.system()
    mpv_default_name = "mpv.exe" if current_platform == "Windows" else "mpv"

    config = _safe_json_load(CONFIG_FILE)
    configured_mpv_path = config.get("mpv_path")
    if configured_mpv_path:
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
    Removes dangerous flags and ensures boolean flags have a trailing '='.
    Handles escaped commas correctly.
    """
    if not options_str or not isinstance(options_str, str):
        return ""

    BLOCKED_KEYS = {
        'exec', 'exec-before-download', 'exec_before_download',
        'output', 'o', 'paths', 'P', 'batch-file', 'batch_file', 'a',
        'config-location', 'config_location', 'load-info-json', 'load_info_json',
        'write-description', 'write_description', 'write-info-json', 'write_info_json',
        'write-annotations', 'write_annotations', 'write-thumbnail', 'write_thumbnail',
        'write-subs', 'write_subs', 'write-auto-subs', 'write_auto_subs',
        'external-downloader', 'downloader', 'external-downloader-args', 'downloader-args',
        'python-interpreter', 'plugin-dirs', 'netrc-location', 'netrc'
    }

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
        if clean_key in BLOCKED_KEYS:
            logging.warning(f"Security: Removed dangerous yt-dlp option '{key}'")
            continue
            
        # Ensure boolean flags or empty values have exactly one trailing '='
        if value == "":
            safe_options.append(f"{clean_key}=")
        else:
            safe_options.append(f"{clean_key}={value}")
        
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
    return ",".join(final_parts)

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
    """Reads all folders data from folders.json, ensuring new format."""
    with FileLock(FOLDERS_FILE):
        if not os.path.exists(FOLDERS_FILE):
            source_folders_file = os.path.join(SCRIPT_DIR, "data", "folders.json")
            if os.path.exists(source_folders_file):
                try:
                    logging.info(f"[PY][IO] No folders file found in {DATA_DIR}. Copying default from {source_folders_file}.")
                    shutil.copy2(source_folders_file, FOLDERS_FILE)
                except Exception as e:
                    logging.error(f"[PY][IO] Failed to copy default folders.json: {e}")
                    return {}
            else:
                return {}

        raw_folders = _safe_json_load(FOLDERS_FILE)
        if not raw_folders:
            return {}
        
        converted_folders, needs_resave = _migrate_legacy_data(raw_folders)
        
        if needs_resave:
            logging.info("[PY][IO] Resaving folders file after converting old data formats.")
            _atomic_json_dump(converted_folders, FOLDERS_FILE)

        return converted_folders

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

def write_folders_file(data):
    """Writes the provided data to the main folders.json file."""
    with FileLock(FOLDERS_FILE):
        if _atomic_json_dump(data, FOLDERS_FILE):
            logging.info(f"[PY][IO] Data synced to {FOLDERS_FILE}")
            return {"success": True, "message": "Data successfully synced to file."}
        else:
            error_msg = f"[PY][IO] Failed to write to {FOLDERS_FILE}"
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
        ]
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