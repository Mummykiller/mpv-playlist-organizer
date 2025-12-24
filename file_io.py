import os
import json
import logging
import platform
import shutil
import sys

# --- Path Definitions ---

def get_user_data_dir():
    """Returns a platform-specific, user-writable directory for app data."""
    app_name = "MPVPlaylistOrganizer"
    system = platform.system()
    if system == "Windows":
        return os.path.join(os.environ['APPDATA'], app_name)
    elif system == "Darwin": # macOS
        return os.path.join(os.path.expanduser('~/Library/Application Support'), app_name)
    else: # Linux and other Unix-like systems
        return os.path.join(os.path.expanduser('~/.local/share'), app_name)

SCRIPT_DIR = os.path.dirname(os.path.abspath(sys.argv[0]))
DATA_DIR = get_user_data_dir()
FOLDERS_FILE = os.path.join(DATA_DIR, "folders.json")
CONFIG_FILE = os.path.join(DATA_DIR, "config.json")
EXPORT_DIR = os.path.join(DATA_DIR, "exported")

# --- File I/O Functions ---

def get_mpv_executable():
    """Gets the path to the mpv executable based on OS and config."""
    current_platform = platform.system()
    mpv_default_name = "mpv.exe" if current_platform == "Windows" else "mpv"

    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
                config = json.load(f)
            configured_mpv_path = config.get("mpv_path")
            if configured_mpv_path:
                if os.path.isabs(configured_mpv_path) and os.path.exists(configured_mpv_path):
                    return configured_mpv_path
                else:
                    return configured_mpv_path
        except (IOError, json.JSONDecodeError) as e:
            logging.warning(f"Could not read or parse config.json for mpv path: {e}. Falling back to default.")
    
    return mpv_default_name

def _migrate_legacy_data(raw_folders):
    """
    Normalizes folder data structures, converting legacy formats if necessary.
    Returns a tuple (normalized_folders, was_modified).
    """
    converted_folders = {}
    needs_resave = False
    
    for folder_id, folder_content in raw_folders.items():
        # Standard format: {"playlist": [{"url": "...", "title": "..."}, ...]}
        if isinstance(folder_content, dict) and "playlist" in folder_content:
            playlist = folder_content.get("playlist", [])
            # Check for legacy list-of-strings inside "playlist"
            if playlist and isinstance(playlist[0], str):
                 needs_resave = True
                 playlist = [{"url": url, "title": url} for url in playlist]
            converted_folders[folder_id] = {"playlist": playlist}
            
        # Legacy format: List of strings directly
        elif isinstance(folder_content, list):
            logging.info(f"Converting old format (list) for folder '{folder_id}' to new format.")
            converted_folders[folder_id] = {"playlist": [{"url": url, "title": url} for url in folder_content]}
            needs_resave = True
            
        # Legacy format: Dict with "urls" key
        elif isinstance(folder_content, dict) and "urls" in folder_content:
            logging.info(f"Converting old format (dict with 'urls') for folder '{folder_id}' to new format.")
            converted_folders[folder_id] = {"playlist": [{"url": url, "title": url} for url in folder_content.get("urls", [])]}
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
                logging.info(f"No folders file found in {DATA_DIR}. Copying default from {source_folders_file}.")
                shutil.copy2(source_folders_file, FOLDERS_FILE)
            except Exception as e:
                logging.error(f"Failed to copy default folders.json: {e}")
                return {}
        else:
            return {}

    try:
        with open(FOLDERS_FILE, 'r', encoding='utf-8') as f:
            content = f.read()
            if not content:
                return {}
            raw_folders = json.loads(content)
        
        converted_folders, needs_resave = _migrate_legacy_data(raw_folders)
        
        if needs_resave:
            logging.info("Resaving folders file after converting old data formats.")
            with open(FOLDERS_FILE, 'w') as f:
                json.dump(converted_folders, f, indent=4)

        return converted_folders
    except Exception as e:
        logging.error(f"Failed to read or process folders from file: {e}")
        return {}

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

        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=4)

        logging.info(f"Data exported to {filepath}")
        return {"success": True, "message": f"Data exported to '{final_filename}' in the 'exported' folder."}
    except Exception as e:
        error_msg = f"Failed to export data: {e}"
        logging.error(error_msg)
        return {"success": False, "error": error_msg}

def write_folders_file(data):
    """Writes the provided data to the main folders.json file."""
    try:
        with open(FOLDERS_FILE, 'w') as f:
            json.dump(data, f, indent=4)
        logging.info(f"Data synced to {FOLDERS_FILE}")
        return {"success": True, "message": "Data successfully synced to file."}
    except Exception as e:
        error_msg = f"Failed to write to {FOLDERS_FILE}: {e}"
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
        error_msg = f"Failed to list import files: {e}"
        logging.error(error_msg)
        return {"success": False, "error": error_msg}