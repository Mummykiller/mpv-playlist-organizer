import json
import logging
import os
import sys
import threading
import time
import uuid
from utils import ipc_utils, session_services
from utils.session_services import EnrichmentService, LauncherService, IPCService

# Prevent __pycache__ generation
sys.dont_write_bytecode = True
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'

# Constants for file patterns
DELTA_PREFIX = "delta_"
DELTA_EXT = ".m3u"
NATURAL_COMPLETION_FLAG = "mpv_natural_completion_"

def sanitize_url(url):
    import file_io
    return file_io.sanitize_string(url, is_filename=False)

class MpvSessionManager:
    def __init__(self, session_file_path, dependencies):
        self.process = None
        self.ipc_path = None
        self.playlist = None
        self.pid = None
        self.owner_folder_id = None
        self.session_file = session_file_path
        self.sync_lock = threading.Lock()
        self.is_alive = False
        self.ipc_manager = None
        self.playlist_tracker = None
        self.manual_quit = False
        self.session_cookies = set()

        # --- Injected Dependencies ---
        self.get_all_folders_from_file = dependencies['get_all_folders_from_file']
        self.get_mpv_executable = dependencies['get_mpv_executable']
        self.log_stream = dependencies['log_stream']
        self.send_message = dependencies['send_message']
        self.SCRIPT_DIR = dependencies['SCRIPT_DIR']
        self.TEMP_PLAYLISTS_DIR = dependencies['TEMP_PLAYLISTS_DIR']
        self.FLAG_DIR = os.path.join(os.path.dirname(self.TEMP_PLAYLISTS_DIR), "flags")
        
        # --- Specialized Services ---
        self.enricher = EnrichmentService(self.send_message)
        self.launcher = LauncherService(self)
        self.ipc_service = IPCService(self)

        try:
            os.makedirs(self.FLAG_DIR, exist_ok=True)
        except Exception as e:
            logging.warning(f"Could not create flag directory {self.FLAG_DIR}: {e}")

    def _log_audit(self, message):
        """Appends a message to the human-readable audit file."""
        try:
            import file_io
            from datetime import datetime
            inspection_path = os.path.join(file_io.DATA_DIR, "last_mpv_command.txt")
            with open(inspection_path, 'a', encoding='utf-8') as f:
                f.write(f"\n[{datetime.now().strftime('%H:%M:%S')}] SESSION UPDATE: {message}\n")
        except Exception:
            pass

    def persist_session(self):
        """Saves current session metadata to disk."""
        try:
            session_data = {
                "pid": self.pid,
                "ipc_path": self.ipc_path,
                "owner_folder_id": self.owner_folder_id,
                "token": getattr(self, 'current_token', None)
            }
            with open(self.session_file, 'w', encoding='utf-8') as f:
                json.dump(session_data, f)
            logging.info(f"[PY][Session] Saved session data to {self.session_file}")
        except Exception as e:
            logging.warning(f"[PY][Session] Failed to write session file: {e}")

    def clear(self, mpv_return_code=None):
        """Clears the session state and removes the session file."""
        self.is_alive = False
        pid_to_clear = self.pid
        self.pid = None

        if pid_to_clear:
            logging.info(f"Clearing session state for PID: {pid_to_clear}")

        if self.playlist_tracker:
            self.playlist_tracker.stop_tracking(mpv_return_code=mpv_return_code)
        self.playlist_tracker = None

        if self.ipc_manager:
            self.ipc_manager.close()
            self.ipc_manager = None

        self.process = None
        self.ipc_path = None
        self.playlist = None
        self.owner_folder_id = None
        self.manual_quit = False

        if self.session_cookies:
            logging.info(f"Cleaning up {len(self.session_cookies)} session cookies.")
            for cookie_path in list(self.session_cookies):
                try:
                    if os.path.exists(cookie_path):
                        os.remove(cookie_path)
                except Exception as e:
                    logging.warning(f"Failed to remove session cookie {cookie_path}: {e}")
            self.session_cookies.clear()

        if os.path.exists(self.session_file):
            try:
                os.remove(self.session_file)
                logging.info(f"Cleaned up session file: {self.session_file}")
            except OSError as e:
                logging.warning(f"Failed to remove session file during cleanup: {e}")

    def restore(self):
        """Checks for a persisted session file and restores state if the process is still alive."""
        if self.is_alive and self.pid and ipc_utils.is_pid_running(self.pid):
            return {"was_stale": False, "folderId": self.owner_folder_id, "lastPlayedId": getattr(self, 'last_played_id_cache', None)}

        if not os.path.exists(self.session_file):
            return None

        logging.info(f"[PY][Session] Found session file: {self.session_file}. Checking for live process.")
        try:
            with open(self.session_file, 'r', encoding='utf-8') as f:
                session_data = json.load(f)

            pid = session_data.get("pid")
            ipc_path = session_data.get("ipc_path")
            owner_folder_id = session_data.get("owner_folder_id")
            token = session_data.get("token")

            if not all([pid, ipc_path, owner_folder_id]):
                raise ValueError("Session file is malformed.")

            if ipc_utils.is_process_alive(pid, ipc_path):
                all_folders = self.get_all_folders_from_file()
                folder_data = all_folders.get(owner_folder_id)
                if not folder_data:
                    raise RuntimeError(f"Could not find data for restored folder '{owner_folder_id}'.")

                self.pid = pid
                self.ipc_path = ipc_path
                self.playlist = folder_data.get("playlist", [])
                self.owner_folder_id = owner_folder_id
                self.current_token = token
                self.is_alive = True
                
                self.ipc_manager = ipc_utils.IPCSocketManager()
                self.ipc_manager.connect(self.ipc_path)
                
                last_played_id = None
                if self.ipc_manager.is_connected():
                    try:
                        path_resp = self.ipc_manager.send({"command": ["get_property", "path"]}, expect_response=True)
                        title_resp = self.ipc_manager.send({"command": ["get_property", "media-title"]}, expect_response=True)
                        
                        current_path = path_resp.get("data") if path_resp and path_resp.get("error") == "success" else None
                        current_title = title_resp.get("data") if title_resp and title_resp.get("error") == "success" else None

                        if current_path or current_title:
                            for item in self.playlist:
                                if current_path and (item.get('url') == current_path or item.get('original_url') == current_path):
                                    last_played_id = item.get('id')
                                    break
                                if current_title and item.get('title') == current_title:
                                    last_played_id = item.get('id')
                                    break
                            self.last_played_id_cache = last_played_id
                    except Exception as e:
                        logging.warning(f"Failed to query active item during restore: {e}")
                
                import file_io
                from playlist_tracker import PlaylistTracker
                self.playlist_tracker = PlaylistTracker(owner_folder_id, self.playlist, file_io, file_io.get_settings(), self.ipc_path, self.send_message)
                self.playlist_tracker.start_tracking()

                self.launcher.start_restored_process_watcher(pid, ipc_path, owner_folder_id)

                logging.info(f"[PY][Session] Successfully restored session for folder '{owner_folder_id}'.")
                return {"was_stale": False, "folderId": owner_folder_id, "lastPlayedId": last_played_id, "token": token}
            else:
                logging.warning(f"[PY][Session] Stale session for PID {pid} found. Cleaning up.")
                try:
                    os.remove(self.session_file)
                except OSError: pass
                return {"was_stale": True, "folderId": owner_folder_id, "returnCode": -1}

        except Exception as e:
            logging.warning(f"[PY][Session] Could not restore session: {e}. Cleaning up.")
            try: os.remove(self.session_file)
            except OSError: pass
            return None

    def append_batch(self, items, mode="append"):
        """Appends multiple items using a temporary M3U to preserve titles and options natively."""
        if not items:
            return {"success": True, "message": "No items to append."}

        logging.info(f"Linked Playlist: Preparing to append {len(items)} items.")

        import file_io
        settings = file_io.get_settings()
        
        for item in items:
            item_url = sanitize_url(item['url'])
            
            # --- Centralized Flag Collection for Appending ---
            local_essential_flags = "ignore-config="
            if settings and settings.get('ffmpeg_path'):
                local_essential_flags = f"{local_essential_flags},ffmpeg-location={settings['ffmpeg_path']}"
            
            final_item_raw_opts = file_io.merge_ytdlp_options(item.get('ytdl_raw_options'), local_essential_flags)

            lua_options = {
                "id": item.get('id'), 
                "title": item.get('title'),
                "headers": item.get('headers'),
                "ytdl_raw_options": final_item_raw_opts,
                "use_ytdl_mpv": item.get('use_ytdl_mpv', False) or item.get('is_youtube', False),
                "ytdl_format": item.get('ytdl_format'),
                "ffmpeg_path": settings.get('ffmpeg_path'),
                "original_url": sanitize_url(item.get('original_url') or item.get('url')),
                "disable_http_persistent": item.get('disable_http_persistent', False),
                "cookies_file": item.get('cookies_file'),
                "disable_network_overrides": settings.get('disable_network_overrides', False),
                "http_persistence": settings.get('http_persistence', 'auto'),
                "enable_reconnect": settings.get('enable_reconnect', True),
                "reconnect_delay": settings.get('reconnect_delay', 4)
            }
            self.ipc_manager.send({"command": ["script-message", "set_url_options", item_url, json.dumps(lua_options)]})
            
            if self.playlist is None: self.playlist = []
            
            item_id = item.get('id')
            is_duplicate = any(i.get('id') == item_id for i in self.playlist)

            if not is_duplicate:
                item['url'] = item_url 
                self.playlist.append(item)
                if self.playlist_tracker: self.playlist_tracker.add_item(item)

        m3u_content = self._generate_m3u_content(items)
        
        try:
            os.makedirs(self.TEMP_PLAYLISTS_DIR, exist_ok=True)
            
            pid = os.getpid()
            unique_id = uuid.uuid4().hex[:8]
            temp_filename = f"{DELTA_PREFIX}{pid}_{unique_id}{DELTA_EXT}"
            temp_path = os.path.join(self.TEMP_PLAYLISTS_DIR, temp_filename)
            
            with open(temp_path, 'w', encoding='utf-8') as tf:
                tf.write(m3u_content)
            
            res = self.ipc_manager.send({"command": ["loadlist", temp_path, mode]}, expect_response=True)
            
            if res and res.get("error") == "success":
                idle_resp = self.ipc_manager.send({"command": ["get_property", "idle-active"]})
                if idle_resp and idle_resp.get("data") == True:
                    logging.info("MPV is idle. Forcing playback to start after append.")
                    self.ipc_manager.send({"command": ["set_property", "pause", False]})
                    self.ipc_manager.send({"command": ["playlist-next", "weak"]})
                
                msg = f"Appended {len(items)} new item{'s' if len(items) > 1 else ''}"
                self.ipc_manager.send({"command": ["show-text", msg, 3000]})
                
                return {"success": True, "message": f"Appended {len(items)} items to active session."}
            else:
                raise RuntimeError(f"MPV rejected loadlist command: {res}")

        except Exception as e:
            logging.error(f"Failed to append batch via delta M3U: {e}")
            return {"success": False, "error": str(e)}
        finally:
            # This block runs even if an error occurs above
            try:
                if os.path.exists(temp_path):
                    os.remove(temp_path)
                    logging.debug(f"Successfully cleaned up temp M3U: {temp_path}")
            except Exception as cleanup_e:
                logging.warning(f"Failed to cleanup delta M3U {temp_path}: {cleanup_e}")

    def remove(self, item_id, folder_id):
        """Removes an item from the active MPV playlist by ID."""
        with self.sync_lock:
            if not self.is_alive or self.owner_folder_id != folder_id:
                return {"success": False, "message": "Session not active or folder mismatch."}
            
            index_to_remove = -1
            if self.playlist:
                for i, item in enumerate(self.playlist):
                    if item.get('id') == item_id:
                        index_to_remove = i
                        break
            
            if index_to_remove != -1:
                logging.info(f"Removing item index {index_to_remove} (ID: {item_id}) from live MPV session.")
                self.ipc_manager.send({"command": ["playlist-remove", index_to_remove]}, expect_response=True)
                
                removed_item = self.playlist.pop(index_to_remove)
                
                if self.playlist_tracker:
                    self.playlist_tracker.remove_item_internal(item_id)
                
                title = sanitize_url(removed_item.get('title') or "Item")
                if len(title) > 60: title = title[:57] + "..."
                self.ipc_manager.send({"command": ["show-text", f"Removed: {title}", 2000]}, expect_response=True)
                
                return {"success": True, "message": "Item removed from live session."}
            
            return {"success": False, "message": "Item not found in live session."}

    def reorder(self, folder_id, new_order_items):
        """Delegates reordering to the IPC service."""
        return self.ipc_service.reorder_live(folder_id, new_order_items)

    def _generate_m3u_content(self, items):
        """Generates M3U content from a list of items."""
        m3u_lines = ["#EXTM3U"]
        for item in items:
            safe_title = sanitize_url(item.get('title', item['url']))
            m3u_lines.append(f"#EXTINF:-1,{safe_title}")
            m3u_lines.append(sanitize_url(item['url']))
        return "\n".join(m3u_lines)

    def start(self, url_items_or_m3u, folder_id, settings, file_io, **kwargs):
        """Starts a new mpv process with a playlist of URLs or an M3U."""
        _url_items_list, input_was_raw = self.enricher.resolve_input_items(url_items_or_m3u, kwargs.get('enriched_items_list'), kwargs.get('headers'))
        
        if not _url_items_list:
            return {"success": False, "error": "No URL items provided or parsed."}

        # Handle Enrichment for Raw Inputs
        if input_was_raw:
            is_m3u_flow = isinstance(url_items_or_m3u, str) and not ("youtube.com" in url_items_or_m3u)
            if is_m3u_flow:
                from concurrent.futures import ThreadPoolExecutor
                with ThreadPoolExecutor(max_workers=10) as executor:
                    # Pass context for cookie management
                    results = list(executor.map(lambda x: self.enricher.enrich_single_item(x, folder_id, self.session_cookies, self.sync_lock, settings=settings), _url_items_list))
                _url_items_list = [i for r in results for i in r]
                return {
                    "success": True, 
                    "enriched_url_items": _url_items_list,
                    "enriched_m3u_content": self._generate_m3u_content(_url_items_list),
                    "message": "Enriched content generated."
                }
            else:
                first_enriched = self.enricher.enrich_single_item(_url_items_list[0], folder_id, self.session_cookies, self.sync_lock, settings=settings)
                _url_items_list = first_enriched + _url_items_list[1:]

        # Smart Resume
        playlist_start_index = 0
        if settings.get("enable_smart_resume", True):
            last_id = file_io.get_all_folders_from_file().get(folder_id, {}).get("last_played_id")
            for idx, item in enumerate(_url_items_list):
                if item.get('id') == last_id:
                    playlist_start_index = idx
                    break

        launch_item = _url_items_list[playlist_start_index]
        
        if self.pid:
            if not ipc_utils.is_process_alive(self.pid, self.ipc_path): self.clear() 
            elif folder_id == self.owner_folder_id: 
                return {
                    "success": True, 
                    "already_active": True, 
                    "enriched_url_items": _url_items_list,
                    "enriched_m3u_content": self._generate_m3u_content(_url_items_list)
                }
            else: self.close()

        launch_result = self.launcher.launch(
            launch_item, folder_id, settings, file_io,
            full_playlist=_url_items_list if len(_url_items_list) == 1 else [_url_items_list[playlist_start_index]],
            playlist_start_index=playlist_start_index,
            **kwargs
        )

        if launch_result.get("success") and len(_url_items_list) > 1:
            self.enricher.handle_standard_flow_launch(self, _url_items_list, playlist_start_index, folder_id, settings, file_io)

        if launch_result.get("success") and input_was_raw:
            launch_result["handled_directly"] = True
            launch_result["enriched_url_items"] = _url_items_list
            launch_result["enriched_m3u_content"] = self._generate_m3u_content(_url_items_list)

        return launch_result

    def close(self):
        """Closes the current mpv session gracefully via IPC, then forcefully if needed."""
        return self.launcher.close()