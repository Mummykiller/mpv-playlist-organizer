import os
import json
import logging
import platform
import shutil
import sys
import re
from dataclasses import dataclass
from utils import security
from utils.file_lock import FileLock

# Prevent __pycache__ generation
sys.dont_write_bytecode = True
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'

import time
import threading

DEFAULT_AUTOMATIC_MPV_FLAGS = [
    {"flag": "--pause", "description": "Start MPV paused.", "enabled": False},
    {"flag": "--terminal", "description": "Show a terminal window.", "enabled": False},
    {"flag": "--save-position-on-quit", "description": "Remember playback position on exit.", "enabled": True},
    {"flag": "--loop-playlist=inf", "description": "Loop the entire playlist indefinitely.", "enabled": False},
    {"flag": "--ontop", "description": "Keep the player window on top of other windows.", "enabled": False},
    {"flag": "--force-window=immediate", "description": "Open the window immediately when starting.", "enabled": False},
]

# --- Path Definitions ---

def get_user_data_dir():
    """Returns a platform-specific, user-writable directory for app data."""
    app_name = "MPVPlaylistOrganizer"
    system = platform.system()
    if system == "Windows":
        base = os.environ.get('APPDATA', os.path.expanduser('~\\AppData\\Roaming'))
    elif system == "Darwin": # macOS
        base = os.path.expanduser('~/Library/Application Support')
    else: # Linux and other Unix-like systems
        base = os.getenv('XDG_DATA_HOME') or os.path.expanduser('~/.local/share')

    target = os.path.join(base, app_name)
    try:
        os.makedirs(target, exist_ok=True)
        if not os.access(target, os.W_OK):
            raise OSError("Directory not writable")
        return target
    except OSError:
        import tempfile
        fallback = os.path.join(tempfile.gettempdir(), app_name)
        try:
            os.makedirs(fallback, exist_ok=True)
            if not os.access(fallback, os.W_OK):
                raise OSError("Fallback directory not writable")
            return fallback
        except OSError:
            return target

# --- Path Definitions & Configuration ---

@dataclass
class PathConfig:
    project_root: str
    script_dir: str
    data_dir: str
    temp_dir: str
    folders_file: str
    index_file: str
    playlists_dir: str
    config_file: str
    export_dir: str

    @classmethod
    def create(cls, data_dir=None, project_root=None, script_dir=None, temp_dir=None):
        p_root = project_root or _CURRENT_DIR
        s_dir = script_dir or os.path.dirname(os.path.abspath(sys.argv[0]))
        d_dir = data_dir or get_user_data_dir()
        t_dir = temp_dir or os.path.join(tempfile.gettempdir(), "mpv_playlist_organizer")
        return cls(
            project_root=p_root,
            script_dir=s_dir,
            data_dir=d_dir,
            temp_dir=t_dir,
            folders_file=os.path.join(d_dir, "folders.json"),
            index_file=os.path.join(d_dir, "index.json"),
            playlists_dir=os.path.join(d_dir, "playlists"),
            config_file=os.path.join(d_dir, "config.json"),
            export_dir=os.path.join(d_dir, "exported")
        )

# Get the directory where the current file (file_io.py) is located (project root)
_CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = _CURRENT_DIR

# SCRIPT_DIR remains based on the entry point for backward compatibility in some paths,
# but we prefer PROJECT_ROOT for internal resource finding.
SCRIPT_DIR = os.path.dirname(os.path.abspath(sys.argv[0]))
DATA_DIR = get_user_data_dir()
import tempfile
TEMP_DIR = os.path.join(tempfile.gettempdir(), "mpv_playlist_organizer")
try:
    os.makedirs(TEMP_DIR, exist_ok=True)
except OSError as e:
    logging.warning(f"[PY][IO] Failed to create temp directory at {TEMP_DIR}: {e}")

paths: PathConfig = None

def get_paths() -> PathConfig:
    """Returns the current structured PathConfig container."""
    global paths
    if paths is None:
        initialize_paths()
    return paths

def initialize_paths(new_data_dir=None):
    """Updates all global paths based on DATA_DIR. Useful for testing."""
    global DATA_DIR, FOLDERS_FILE, INDEX_FILE, PLAYLISTS_DIR, CONFIG_FILE, EXPORT_DIR, TEMP_DIR, paths
    if new_data_dir is not None:
        DATA_DIR = new_data_dir

    paths = PathConfig.create(
        data_dir=DATA_DIR,
        project_root=PROJECT_ROOT,
        script_dir=SCRIPT_DIR,
        temp_dir=TEMP_DIR
    )

    # Maintain backward compatibility for direct module global access
    FOLDERS_FILE = paths.folders_file
    INDEX_FILE = paths.index_file
    PLAYLISTS_DIR = paths.playlists_dir
    CONFIG_FILE = paths.config_file
    EXPORT_DIR = paths.export_dir

    try:
        os.makedirs(PLAYLISTS_DIR, exist_ok=True)
    except OSError as e:
        logging.warning(f"[PY][IO] Failed to create playlists directory at {PLAYLISTS_DIR}: {e}")

    # Reset in-memory settings cache when paths are re-initialized
    global _settings_cache, _settings_mtime, _settings_cache_file
    try:
        with _settings_lock:
            _settings_cache = None
            _settings_mtime = None
            _settings_cache_file = None
    except NameError as e:
        logging.debug(f"[PY][IO] Settings lock not initialized yet: {e}")

    return paths

# Settings caching (PY-M8)
_settings_cache = None
_settings_mtime = None
_settings_cache_file = None
_settings_lock = threading.Lock()

# Initialize paths once on module load
initialize_paths()

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
        try:
            os.makedirs(PLAYLISTS_DIR, exist_ok=True)
        except OSError as e:
            logging.error(f"[PY][IO] Migration failed: Could not create playlists directory at {PLAYLISTS_DIR}: {e}")
            return

        for folder_id, folder_data in raw_folders.items():
            playlist = folder_data.pop("playlist", [])
            
            # Index gets metadata
            index_data[folder_id] = {
                **folder_data,
                "item_count": len(playlist)
            }
            
            # Shard gets the content
            shard_path = _get_safe_shard_path(folder_id)
            if shard_path:
                _atomic_json_dump({"playlist": playlist}, shard_path)
                logging.info(f"[PY][IO] Created shard for folder: {folder_id}")

        # Save the new index
        if _atomic_json_dump(index_data, INDEX_FILE):
            logging.info("[PY][IO] Sharded migration complete. Index saved.")
            # We keep the old folders.json for a short period or rename it
            try:
                os.rename(FOLDERS_FILE, f"{FOLDERS_FILE}.migrated")
            except OSError as e:
                logging.warning(f"[PY][IO] Failed to rename migrated folders file {FOLDERS_FILE}: {e}")

def _get_safe_shard_path(folder_id):
    """Validates and sanitizes folder_id so shard paths never escape PLAYLISTS_DIR."""
    if not folder_id or not isinstance(folder_id, str):
        return None
    clean_id = folder_id
    if "/" in clean_id or "\\" in clean_id or ".." in clean_id or clean_id in (".", ".."):
        clean_id = sanitize_folder_name(clean_id).replace("..", "").strip(". ")
    if not clean_id:
        return None
    playlists_real = os.path.realpath(PLAYLISTS_DIR)
    shard_path = os.path.join(PLAYLISTS_DIR, f"{clean_id}.json")
    shard_real = os.path.realpath(shard_path)
    if os.path.commonpath([playlists_real, shard_real]) != playlists_real or os.path.dirname(shard_real) != playlists_real:
        logging.warning(f"[PY][IO] Security: Blocked shard path outside PLAYLISTS_DIR: {folder_id}")
        return None
    return shard_path

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
    # Note: caller should ideally pass canonical ID, but we normalize here for safety
    canonical_id = _get_canonical_folder_id(folder_id)
    shard_path = _get_safe_shard_path(canonical_id)
    if not shard_path or not os.path.exists(shard_path):
        return []
    
    with FileLock(shard_path):
        data = _safe_json_load(shard_path)
        return data.get("playlist", [])

def save_playlist_shard(folder_id, playlist, update_index=True):
    """Saves a specific playlist shard and optionally updates the index count."""
    if not update_index:
        index = get_index()
        canonical_id = _get_canonical_folder_id(folder_id, index)
        shard_path = _get_safe_shard_path(canonical_id)
        if not shard_path:
            return False
        with FileLock(shard_path):
            return _atomic_json_dump({"playlist": playlist}, shard_path)

    with FileLock(INDEX_FILE):
        index = _safe_json_load(INDEX_FILE) or {}
        canonical_id = _get_canonical_folder_id(folder_id, index)
        shard_path = _get_safe_shard_path(canonical_id)
        if not shard_path:
            return False

        # 1. Save the Shard (INDEX -> Shard lock order)
        with FileLock(shard_path):
            success = _atomic_json_dump({"playlist": playlist}, shard_path)

        # 2. Update Index Metadata (Item Count) while still holding INDEX_FILE lock
        if success and canonical_id in index:
            index[canonical_id]["item_count"] = len(playlist)
            _atomic_json_dump(index, INDEX_FILE)

        return success

def update_shard(folder_id, update_fn, update_index=False):
    """
    Atomically performs a read-modify-write on a shard and optionally the index,
    holding the file locks throughout the entire operation in INDEX -> Shard order (PY-M5).

    update_fn is called as: update_fn(playlist, index_entry)
    where playlist is a list of items and index_entry is the dict metadata from index.json.
    If update_fn returns False, the update is cancelled and no files are written.
    If update_fn returns True (or a list/dict), changes are committed atomically.
    Returns True on success, False on failure.
    """
    index = get_index()
    canonical_id = _get_canonical_folder_id(folder_id, index)
    shard_path = _get_safe_shard_path(canonical_id)
    if not shard_path:
        return False

    with FileLock(INDEX_FILE):
        current_index = _safe_json_load(INDEX_FILE) or {}
        canonical_id = _get_canonical_folder_id(folder_id, current_index)
        shard_path = _get_safe_shard_path(canonical_id)
        if not shard_path:
            return False
        index_entry = current_index.get(canonical_id)

        with FileLock(shard_path):
            current_shard = _safe_json_load(shard_path) or {}
            playlist = current_shard.get("playlist", [])

            try:
                res = update_fn(playlist, index_entry)
            except Exception as e:
                logging.error(f"[PY][IO] update_shard callback failed for '{folder_id}': {e}")
                return False

            if res is False:
                return False
            if res is None:
                return True

            if isinstance(res, list):
                playlist = res

            success = _atomic_json_dump({"playlist": playlist}, shard_path)
            if success and update_index and index_entry is not None:
                index_entry["item_count"] = len(playlist)
                _atomic_json_dump(current_index, INDEX_FILE)
            return success

def validate_safe_path(path, allow_user_content=False):
    """
    Validates that a path is safe for usage in flags (configuration/scripts).
    Delegates to utils.security.
    """
    return security.validate_safe_path(path, DATA_DIR, SCRIPT_DIR, TEMP_DIR, allow_user_content)

def _merge_playlists(existing_playlist, new_playlist):
    """
    Performs a 'Last Write Wins' merge between two playlist arrays based on last_modified.
    In this system, the browser is the source of truth for membership (deletions).
    """
    if not existing_playlist:
        return new_playlist
        
    existing_map = {item.get('id'): item for item in existing_playlist if item.get('id')}
    merged_playlist = []
    
    for new_item in new_playlist:
        item_id = new_item.get('id')
        if not item_id:
            merged_playlist.append(new_item)
            continue
        
        existing_item = existing_map.get(item_id)
        if existing_item:
            # Compare timestamps (ms)
            new_ts = new_item.get('last_modified', 0)
            old_ts = existing_item.get('last_modified', 0)
            
            if new_ts >= old_ts:
                merged_playlist.append(new_item)
            else:
                logging.debug(f"[PY][IO] Preserving newer local state for item {item_id} ({old_ts} > {new_ts})")
                merged_playlist.append(existing_item)
            
            # Remove from map to track processed items
            del existing_map[item_id]
        else:
            # Item is new from incoming data
            merged_playlist.append(new_item)
    
    return merged_playlist

def _move_orphan_to_trash(base_path, trash_dir, timestamp):
    """Moves an orphaned shard and its .bak/.lock sidecars into trash_dir with a timestamp suffix."""
    for path_to_clean in (base_path, f"{base_path}.bak", f"{base_path}.lock"):
        if os.path.exists(path_to_clean):
            try:
                os.makedirs(trash_dir, exist_ok=True)
                dest = os.path.join(trash_dir, f"{os.path.basename(path_to_clean)}.{timestamp}")
                shutil.move(path_to_clean, dest)
            except OSError as e:
                logging.debug(f"[PY][IO] Could not move orphaned shard file {path_to_clean} to trash: {e}")

def save_library_batch(folders_to_save, is_incremental=False):
    """
    Saves multiple folders (shards + index) atomically with merge support.
    folders_to_save: Dict of { folder_id: { playlist, metadata } }
    """
    if not isinstance(folders_to_save, dict):
        return False

    with FileLock(INDEX_FILE):
        index = _safe_json_load(INDEX_FILE)
        kept_canonical_ids = set()
        
        for folder_id, content in folders_to_save.items():
            if not isinstance(content, dict):
                continue
            canonical_id = _get_canonical_folder_id(folder_id, index)
            shard_path = _get_safe_shard_path(canonical_id)
            if not shard_path:
                continue
            kept_canonical_ids.add(canonical_id)
            new_playlist = content.get("playlist", [])
            
            # 1. Load existing for merge and 2. Save Shard under a single FileLock
            with FileLock(shard_path):
                existing_data = _safe_json_load(shard_path)
                existing_playlist = existing_data.get("playlist", []) if isinstance(existing_data, dict) else []
                merged_playlist = _merge_playlists(existing_playlist, new_playlist)
                _atomic_json_dump({"playlist": merged_playlist}, shard_path)
            
            # 3. Update Index Metadata
            meta = {k: v for k, v in content.items() if k != "playlist"}
            index[canonical_id] = {
                **meta,
                "item_count": len(merged_playlist)
            }
        
        if not is_incremental:
            if not folders_to_save and index:
                logging.warning("[PY][IO] save_library_batch received empty folders payload while index is non-empty; refusing to prune shards.")
            else:
                trash_dir = os.path.join(PLAYLISTS_DIR, "trash")
                timestamp = time.strftime("%Y%m%d_%H%M%S")
                removed_ids = [fid for fid in list(index.keys()) if fid not in kept_canonical_ids]
                for fid in removed_ids:
                    del index[fid]
                    orphan_shard = _get_safe_shard_path(fid)
                    if orphan_shard:
                        _move_orphan_to_trash(orphan_shard, trash_dir, timestamp)

                if os.path.isdir(PLAYLISTS_DIR):
                    valid_filenames = {
                        os.path.basename(p)
                        for p in (_get_safe_shard_path(fid) for fid in kept_canonical_ids)
                        if p
                    }
                    try:
                        for fname in os.listdir(PLAYLISTS_DIR):
                            if fname.endswith(".json") and fname not in valid_filenames:
                                orphan_path = os.path.join(PLAYLISTS_DIR, fname)
                                _move_orphan_to_trash(orphan_path, trash_dir, timestamp)
                    except OSError as e:
                        logging.debug(f"[PY][IO] Error scanning PLAYLISTS_DIR for orphans: {e}")

        # Finalize Index
        return _atomic_json_dump(index, INDEX_FILE)

# --- Atomic Write & Safe Load Helpers ---

def _atomic_json_dump(data, filepath):
    """Writes JSON data to a file atomically using a .tmp file and os.replace."""
    tmp_file = f"{filepath}.{os.getpid()}.{threading.get_ident()}.tmp"
    bak_file = f"{filepath}.bak"
    
    try:
        dirname = os.path.dirname(filepath)
        if dirname:
            os.makedirs(dirname, exist_ok=True)
        
        # 1. Write to temporary file
        with open(tmp_file, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=4)
            f.flush()
            os.fsync(f.fileno()) # Force write to disk
            
        # 2. Create backup of existing file only if it exists and is valid JSON
        if os.path.exists(filepath):
            is_valid_existing = False
            try:
                with open(filepath, 'r', encoding='utf-8') as existing_f:
                    existing_content = existing_f.read()
                    if existing_content.strip():
                        json.loads(existing_content)
                        is_valid_existing = True
            except (json.JSONDecodeError, OSError, UnicodeDecodeError) as val_err:
                logging.warning(f"[PY][IO] Existing file {filepath} is corrupt or unreadable ({val_err}); preserving existing .bak.")
            if is_valid_existing:
                shutil.copy2(filepath, bak_file)
            
        # 3. Atomic swap
        os.replace(tmp_file, filepath)
        return True
    except Exception as e:
        logging.error(f"[PY][IO] Atomic write failed for {filepath}: {e}")
        if os.path.exists(tmp_file):
            try:
                os.remove(tmp_file)
            except OSError as rm_err:
                logging.debug(f"[PY][IO] Could not remove temp file {tmp_file}: {rm_err}")
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
    """Gets the path to the mpv executable by prioritizing config then PATH then local search."""
    current_platform = platform.system()
    mpv_default_name = "mpv.exe" if current_platform == "Windows" else "mpv"

    # 1. Fallback to Configured Path (Highest priority if user set it)
    config = _safe_json_load(CONFIG_FILE)
    configured_mpv_path = config.get("mpv_path")
    if configured_mpv_path:
        if os.path.isdir(configured_mpv_path):
            full_path = os.path.join(configured_mpv_path, mpv_default_name)
            if os.path.exists(full_path):
                return os.path.abspath(full_path)
        elif os.path.exists(configured_mpv_path):
            return os.path.abspath(configured_mpv_path)

    # 2. Prioritize System PATH
    found_in_path = shutil.which(mpv_default_name)
    if found_in_path:
        return os.path.abspath(found_in_path)

    # 3. Search in common local locations relative to PROJECT_ROOT, SCRIPT_DIR and Python EXE
    # PROJECT_ROOT is the parent of utils/
    # SCRIPT_DIR is the folder containing native_host.py
    search_dirs = [PROJECT_ROOT, SCRIPT_DIR, os.path.dirname(sys.executable)]
    
    # Add subdirectories to search list
    for d in list(search_dirs):
        search_dirs.append(os.path.join(d, "mpv"))
        search_dirs.append(os.path.join(d, "bin"))

    for d in search_dirs:
        local_path = os.path.join(d, mpv_default_name)
        if os.path.exists(local_path):
            return os.path.abspath(local_path)

    return mpv_default_name

def sanitize_string(s, is_filename=False, is_url=False):
    """Sanitizes a string. preserves URL integrity while preventing shell/M3U issues."""
    return security.sanitize_string(s, is_filename=is_filename, is_url=is_url)

def sanitize_folder_name(name):
    """Specific strict sanitization for folder names used in filesystem paths."""
    return security.sanitize_string(name, is_filename=True)

def is_youtube_url(url):
    """Returns True if the URL is a recognized YouTube video or playlist URL."""
    if not url or not isinstance(url, str):
        return False
    return "youtube.com/" in url or "youtu.be/" in url

def sanitize_ytdlp_options(options_str, allow_settings_flags=False):
    """
    Sanitizes a comma-separated string of yt-dlp options (key=value).
    Delegates to utils.security.
    """
    return security.sanitize_ytdlp_options(options_str, allow_settings_flags=allow_settings_flags)

def merge_ytdlp_options(*args, allow_settings_flags=False):
    """Merges multiple ytdl-raw-options strings into one, deduplicating keys. Handles escaped commas."""
    merged_map = {}
    for options_str in args:
        if not options_str:
            continue
        # Split by comma NOT preceded by backslash
        parts = re.split(r'(?<!\\),', options_str)
        last_key = None
        for part in parts:
            part = part.strip()
            if not part:
                continue
            if '=' in part:
                key, value = part.split('=', 1)
                clean_k = key.strip().lower()
                merged_map[clean_k] = value
                last_key = clean_k
            else:
                clean_part = part.strip().lower().lstrip('-')
                if (
                    last_key in ('extractor-args', '--extractor-args')
                    and last_key in merged_map
                    and clean_part not in security.YTDLP_ALL_ALLOWED_FLAGS
                ):
                    merged_map[last_key] = f"{merged_map[last_key]}\\,{part}"
                else:
                    merged_map[part.strip().lower()] = ""
                    last_key = part.strip().lower()
    
    final_parts = []
    for k, v in merged_map.items():
        if v == "":
            final_parts.append(f"{k}=")
        else:
            final_parts.append(f"{k}={v}")
    
    merged_str = ",".join(final_parts)
    return sanitize_ytdlp_options(merged_str, allow_settings_flags=allow_settings_flags)

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

def _get_canonical_folder_id(folder_id, index=None):
    """
    Returns the exact casing of the folder_id as stored in the index.
    If not found, returns the provided folder_id.
    """
    if not folder_id:
        return folder_id
    
    if index is None:
        index = get_index()
        
    # 1. Try exact match
    if folder_id in index:
        return folder_id
        
    # 2. Try case-insensitive match
    lower_id = folder_id.lower()
    for actual_id in index.keys():
        if actual_id.lower() == lower_id:
            return actual_id
            
    return folder_id

def get_folder_data(folder_id):
    """Retrieves metadata and playlist for a single folder efficiently."""
    index = get_index()
    canonical_id = _get_canonical_folder_id(folder_id, index)
    meta = index.get(canonical_id)
    if not meta:
        return None
    
    playlist = get_playlist_shard(canonical_id)
    return {**meta, "playlist": playlist}

def write_folders_file(data):
    """
    Distributes the provided full data structure back into shards and the index.
    """
    return {"success": save_library_batch(data)}

def write_export_file(filename, data, subfolder=None):
    """Helper to write data to a file in the export directory, optionally in a subfolder."""
    try:
        export_root = os.path.realpath(EXPORT_DIR)
        target_dir = export_root
        clean_subfolder = None
        if subfolder:
            parts = [sanitize_folder_name(p) for p in re.split(r'[\\/]+', str(subfolder)) if p and p not in ('.', '..')]
            if parts:
                clean_subfolder = os.path.join(*parts)
                candidate_dir = os.path.realpath(os.path.join(export_root, clean_subfolder))
                if os.path.commonpath([export_root, candidate_dir]) != export_root:
                    return {"success": False, "error": "Access denied: Subfolder outside export directory."}
                target_dir = candidate_dir
            
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
            display_name = os.path.join(clean_subfolder, final_filename) if clean_subfolder else final_filename
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
    """Reads settings from config.json, providing default values for new keys (PY-M8)."""
    global _settings_cache, _settings_mtime, _settings_cache_file
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
        "enable_display_sync": True,
        "override_display_fps": "",
        "ultra_interpolation": "oversample",
        "ultra_deband": True,
        "ultra_fbo": True,
        "enable_reconnect": True,
        "reconnect_delay": 4,
        "mpv_decoder": "auto",
        "automatic_mpv_flags": [dict(f) for f in DEFAULT_AUTOMATIC_MPV_FLAGS],
        "live_removal": True,
        "enable_per_item_mark_watched": True,
        "clear_on_item_finish": False
    }

    # Fast path: check in-memory cache if mtime is unchanged
    with _settings_lock:
        if _settings_cache is not None and _settings_cache_file == CONFIG_FILE:
            try:
                if os.path.exists(CONFIG_FILE):
                    current_mtime = os.path.getmtime(CONFIG_FILE)
                    if current_mtime == _settings_mtime:
                        return dict(_settings_cache)
            except OSError as e:
                logging.debug(f"[PY][IO] mtime check failed for {CONFIG_FILE}: {e}")

    with FileLock(CONFIG_FILE):
        file_exists = os.path.exists(CONFIG_FILE)
        bak_exists = os.path.exists(f"{CONFIG_FILE}.bak")

        if not file_exists and not bak_exists:
            # Truly missing: initialize with default settings
            logging.info(f"[PY][IO] Initializing {CONFIG_FILE} with default settings.")
            _atomic_json_dump(default_settings, CONFIG_FILE)
            current_settings = default_settings
        else:
            current_settings = _safe_json_load(CONFIG_FILE)
            if current_settings is None:
                # File exists on disk but could not be parsed / read error.
                # DO NOT overwrite user config with defaults (PY-M8).
                logging.warning(f"[PY][IO] {CONFIG_FILE} exists but could not be parsed; preserving file on disk and using defaults/cache.")
                current_settings = {}

    # Merge current settings with defaults, prioritizing current_settings
    settings = {**default_settings, **current_settings}

    # --- NEW: Auto-sync Automatic MPV Flags ---
    if "automatic_mpv_flags" in current_settings:
        raw_flags = current_settings["automatic_mpv_flags"]
        if isinstance(raw_flags, list):
            current_flags = {
                f["flag"]: f
                for f in raw_flags
                if isinstance(f, dict) and isinstance(f.get("flag"), str)
            }
            updated_flags = []
            
            for default_f in default_settings["automatic_mpv_flags"]:
                if default_f["flag"] in current_flags:
                    updated_flags.append(current_flags[default_f["flag"]])
                else:
                    updated_flags.append(default_f)
            
            settings["automatic_mpv_flags"] = updated_flags
        else:
            logging.warning("[PY][IO] Malformed automatic_mpv_flags in config; using defaults.")
            settings["automatic_mpv_flags"] = [dict(f) for f in DEFAULT_AUTOMATIC_MPV_FLAGS]

    # Ensure mpv_path default is platform-appropriate and absolute if found
    if settings.get("mpv_path") is None:
        mpv_default_name = "mpv.exe" if platform.system() == "Windows" else "mpv"
        found_in_path = shutil.which(mpv_default_name)
        if found_in_path:
            settings["mpv_path"] = found_in_path
        else:
            settings["mpv_path"] = mpv_default_name

    # Update in-memory cache
    with _settings_lock:
        _settings_cache = dict(settings)
        _settings_cache_file = CONFIG_FILE
        try:
            if os.path.exists(CONFIG_FILE):
                _settings_mtime = os.path.getmtime(CONFIG_FILE)
            else:
                _settings_mtime = None
        except OSError as e:
            logging.debug(f"[PY][IO] Could not get mtime for settings cache: {e}")
            _settings_mtime = None

    return settings

def set_settings(settings_dict):
    """Writes the provided settings to config.json, merging with existing settings."""
    if not isinstance(settings_dict, dict):
        return {"success": False, "error": "Invalid settings payload type."}

    try:
        with FileLock(CONFIG_FILE):
            current_settings = get_settings()

            # Filter settings_dict against canonical allowlist
            filtered_dict = {}
            for k, v in settings_dict.items():
                if k in security.ALLOWED_SETTINGS_KEYS:
                    filtered_dict[k] = v
                else:
                    logging.warning(f"[PY][SEC] Rejected unknown settings key '{k}'.")

            settings_dict = filtered_dict

            if 'ytdl_quality' in settings_dict:
                valid_qualities = ['best', '2160', '1440', '1080', '720', '480']
                if str(settings_dict['ytdl_quality']) not in valid_qualities:
                    logging.warning(f"[PY][SEC] Invalid ytdl_quality '{settings_dict['ytdl_quality']}' ignored.")
                    del settings_dict['ytdl_quality']

            if 'automatic_mpv_flags' in settings_dict:
                raw_flags = settings_dict['automatic_mpv_flags']
                if not isinstance(raw_flags, list):
                    logging.warning("[PY][SEC] Invalid automatic_mpv_flags type; expected list. Ignoring.")
                    del settings_dict['automatic_mpv_flags']
                else:
                    valid_flags = [
                        f for f in raw_flags
                        if isinstance(f, dict) and isinstance(f.get('flag'), str) and f['flag'].strip()
                    ]
                    if len(valid_flags) != len(raw_flags):
                        logging.warning("[PY][SEC] Filtered malformed entries from automatic_mpv_flags.")
                    settings_dict['automatic_mpv_flags'] = valid_flags

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

            # 3. Validate executable binary paths against approved allowlists
            path_keys = ['mpv_path', 'ffmpeg_path', 'node_path', 'ytdlp_path', 'terminal_emulator']
            for key in path_keys:
                if key in settings_dict:
                    val = settings_dict[key]
                    if val is None or val == "":
                        settings_dict[key] = None
                    elif isinstance(val, str):
                        if not security.is_safe_executable_path(val, setting_key=key):
                            logging.warning(f"[PY][SEC] Blocked invalid or unsafe executable path for {key}: '{val}'.")
                            del settings_dict[key]
                        else:
                            # Always use forward slashes on Windows to avoid \U escaping issues in JSON/logs
                            path = os.path.normpath(val)
                            if platform.system() == "Windows":
                                path = path.replace("\\", "/")
                            settings_dict[key] = path
                    else:
                        logging.warning(f"[PY][SEC] Invalid type for executable path key {key}: {type(val)}.")
                        del settings_dict[key]

            merged_settings = {**current_settings, **settings_dict}

            if _atomic_json_dump(merged_settings, CONFIG_FILE):
                logging.info(f"[PY][IO] Settings successfully written to {CONFIG_FILE}.")
                with _settings_lock:
                    _settings_cache = dict(merged_settings)
                    _settings_cache_file = CONFIG_FILE
                    try:
                        _settings_mtime = os.path.getmtime(CONFIG_FILE)
                    except OSError as me:
                        logging.debug(f"[PY][IO] Could not update mtime after settings write: {me}")
                        _settings_mtime = None
                return {"success": True, "message": "Settings saved."}
            else:
                return {"success": False, "error": "Atomic write for settings failed."}
    except Exception as e:
        error_msg = f"[PY][IO] Failed to write settings to {CONFIG_FILE}: {e}"
        logging.error(error_msg)
        return {"success": False, "error": error_msg}