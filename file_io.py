import os
import json
import logging
import platform
import shutil
import sys

# Prevent __pycache__ generation
sys.dont_write_bytecode = True
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'

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
    Removes dangerous flags that could lead to RCE or arbitrary file writes.
    """
    if not options_str or not isinstance(options_str, str):
        return ""

    # Dangerous keys that should never be passed to MPV -> yt-dlp
    # Normalized to lowercase for comparison.
    BLOCKED_KEYS = {
        'exec', 'exec-before-download', 'exec_before_download',
        'output', 'o',
        'paths', 'P',
        'batch-file', 'batch_file', 'a',
        'config-location', 'config_location',
        'load-info-json', 'load_info_json',
        'write-description', 'write_description',
        'write-info-json', 'write_info_json',
        'write-annotations', 'write_annotations',
        'write-thumbnail', 'write_thumbnail',
        'write-subs', 'write_subs',
        'write-auto-subs', 'write_auto_subs',
        'external-downloader', 'downloader',
        'external-downloader-args', 'downloader-args',
        'ffmpeg-location', 'python-interpreter',
        'plugin-dirs', 'netrc-location', 'netrc'
    }

    safe_options = []
    
    # Split by comma, respecting that values might contain commas (though mpv format makes this hard)
    # MPV simplistic parser splits by comma. We will do the same.
    parts = options_str.split(',')
    
    for part in parts:
        part = part.strip()
        if not part: continue
        
        # Split key=value
        if '=' in part:
            key, value = part.split('=', 1)
        else:
            key = part
            value = ""
            
        clean_key = key.strip().lower()
        
        # Check against blocklist
        if clean_key in BLOCKED_KEYS:
            logging.warning(f"Security: Removed dangerous yt-dlp option '{key}' from command.")
            continue
            
        safe_options.append(part) # Keep original case/format
        
    return ",".join(safe_options)

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

def write_export_file(filename, data):
    """Helper to write data to a file in the export directory."""
    try:
        os.makedirs(EXPORT_DIR, exist_ok=True)
        safe_basename = os.path.basename(filename)

        if not safe_basename.lower().endswith('.json'):
            final_filename = f"{safe_basename}.json"
        else:
            final_filename = safe_basename

        filepath = os.path.join(EXPORT_DIR, final_filename)

        if _atomic_json_dump(data, filepath):
            logging.info(f"[PY][IO] Data exported to {filepath}")
            return {"success": True, "message": f"Data exported to '{final_filename}' in the 'exported' folder."}
        else:
            return {"success": False, "error": "Atomic write failed during export."}
    except Exception as e:
        error_msg = f"[PY][IO] Failed to export data: {e}"
        logging.error(error_msg)
        return {"success": False, "error": error_msg}

def write_folders_file(data):
    """Writes the provided data to the main folders.json file."""
    if _atomic_json_dump(data, FOLDERS_FILE):
        logging.info(f"[PY][IO] Data synced to {FOLDERS_FILE}")
        return {"success": True, "message": "Data successfully synced to file."}
    else:
        error_msg = f"[PY][IO] Failed to write to {FOLDERS_FILE}"
        logging.error(error_msg)
        return {"success": False, "error": error_msg}

def list_import_files():
    """Lists all .json files in the export directory."""
    try:
        if not os.path.isdir(EXPORT_DIR):
            return {"success": True, "files": []}
        else:
            files = sorted([f for f in os.listdir(EXPORT_DIR) if f.endswith('.json')], reverse=True)
            return {"success": True, "files": files}
    except Exception as e:
        error_msg = f"[PY][IO] Failed to list import files: {e}"
        logging.error(error_msg)
        return {"success": False, "error": error_msg}

def get_settings():
    """Reads settings from config.json, providing default values for new keys."""
    default_settings = {
        "mpv_path": None, # Will be filled by installer or found in PATH
        "enable_url_analysis": False,
        "browser_for_url_analysis": "chrome", # Default browser for UA/cookies
        "enable_youtube_analysis": False,
        "user_agent_string": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36", # Default UA
        "enable_smart_resume": True,
        "enable_active_item_highlight": True,
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