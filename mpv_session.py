import json
import logging
import os
import sys
import threading
import time
import uuid
import platform
import re
import services
import file_io
from utils import ipc_utils, url_analyzer
from utils.session_services import EnrichmentService, LauncherService, IPCService

# Prevent __pycache__ generation
sys.dont_write_bytecode = True
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'

# Constants for file patterns
DELTA_PREFIX = "delta_"
DELTA_EXT = ".m3u"
NATURAL_COMPLETION_FLAG = "mpv_natural_completion_"
ID_MATCH_RE = re.compile(r"[#&]mpv_organizer_id=([^#&]+)")

class MpvSessionManager:
    def __init__(self, session_file_path, dependencies):
        self.process = None
        self.ipc_path = None
        self.playlist = []
        self.pid = None
        self.owner_folder_id = None
        self.session_file = session_file_path
        self.sync_lock = threading.RLock() # Changed from Lock to RLock
        self.is_alive = False
        self.ipc_manager = None
        self.playlist_tracker = None
        self.manual_quit = False
        self.session_cookies = set()
        self.launch_cancelled = False
        self.last_played_id_cache = None
        self.handshake_path = None

        # --- Injected Dependencies ---
        self.get_all_folders_from_file = dependencies['get_all_folders_from_file']
        self.get_mpv_executable = dependencies['get_mpv_executable']
        self.log_stream = dependencies['log_stream']
        self.send_message = dependencies['send_message']
        self.SCRIPT_DIR = dependencies['SCRIPT_DIR']
        self.TEMP_PLAYLISTS_DIR = dependencies['TEMP_PLAYLISTS_DIR']
        self.FLAG_DIR = os.path.join(os.path.dirname(self.TEMP_PLAYLISTS_DIR), "flags")
        
        # --- Specialized Services ---
        self.enricher = EnrichmentService(services, self.send_message, file_io)
        self.launcher = LauncherService(self)
        self.ipc_service = IPCService(self)

        try:
            os.makedirs(self.FLAG_DIR, exist_ok=True)
        except Exception as e:
            logging.warning(f"Could not create flag directory {self.FLAG_DIR}: {e}")

    def register_ipc_callbacks(self):
        if self.ipc_manager:
            self.ipc_manager.register_script_message_handler("ytdl_error_detected", self._handle_ytdl_error)

    def _handle_ytdl_error(self, args):
        error_msg = args[0] if args else "Unknown error"
        logging.warning(f"[PY][IPC] YTDL Failure signaled from Lua: {error_msg}")
        
        # Notify extension to check for updates
        self.send_message({
            "action": "ytdlp_update_check", 
            "folder_id": self.owner_folder_id,
            "log": {
                "text": f"[Native Host]: YTDL Failure detected ({error_msg}). Checking for updates...",
                "type": "error"
            }
        })

        # Attempt automatic fallback if it's a known cookie issue
        if any(x in error_msg for x in ["Sign in", "cookies", "403", "unavailable", "Private video"]):
            logging.info(f"Attempting cookie fallback for: {error_msg}")
            threading.Thread(target=self._perform_cookie_fallback, daemon=True).start()

    def _perform_cookie_fallback(self):
        # Use a separate lock or no lock to avoid deadlock if called from reader thread?
        # Reader thread calls _handle_ytdl_error -> spawns thread -> calls this.
        # So we are in a fresh thread. sync_lock is safe.
        with self.sync_lock:
            if not self.is_alive or not self.ipc_manager:
                return
            
            try:
                # 1. Identify current item via user-data/id (set by adaptive_headers.lua)
                id_resp = self.ipc_manager.send({"command": ["get_property", "user-data/id"]}, expect_response=True, timeout=1.0)
                item_id = id_resp.get("data") if id_resp else None
                
                if not item_id: 
                    logging.debug("Fallback: Could not identify current item ID.")
                    return
                
                # Find item in playlist
                target_item = next((i for i in self.playlist if i.get('id') == item_id), None)
                if not target_item: 
                    logging.debug(f"Fallback: Item ID {item_id} not found in local playlist.")
                    return
                
                browser = target_item.get('cookies_browser')
                if not browser: 
                    logging.debug("Fallback: No browser specified for this item. Cannot extract.")
                    return 
                
                url = target_item.get('original_url') or target_item.get('url')
                
                logging.info(f"Fallback: Extracting cookies to RAM for {browser}...")
                self.ipc_manager.send({"command": ["show-text", "Cookie Error: Retrying with fallback...", 5000]})
                
                # 2. Extract (FORCE REFRESH)
                # This uses the new VolatileCookieManager in url_analyzer
                cookie_path = url_analyzer.get_cookies_file(browser, url, force_refresh=True)
                
                if cookie_path:
                    logging.info(f"Fallback: Success. Cookie path: {cookie_path}")
                    
                    # 3. Update Properties LIVE
                    # We must manually set these because adaptive_headers.lua only runs on-load.
                    # Retrying loadfile will re-trigger on-load, so we must ALSO update the persistent Lua options.
                    
                    target_item['cookies_file'] = cookie_path
                    # We keep cookies_browser in the item for record, but we want adaptive_headers 
                    # to prefer the file if we re-send options.
                    
                    import file_io
                    settings = file_io.get_settings()
                    essential_flags = services.get_essential_ytdlp_flags()
                    raw_opts = target_item.get('ytdl_raw_options')
                    # Note: We do NOT append cookies-from-browser string here.
                    # We assume raw_opts from the item MIGHT have it if it was baked in, 
                    # but typically we construct it dynamically in append_batch/start.
                    # Wait, target_item['ytdl_raw_options'] comes from enrichment. 
                    # In append_batch, we ADDED it to a local var `final_item_raw_opts`, not the item dict.
                    # So `target_item['ytdl_raw_options']` is clean. Good.
                    
                    final_opts = file_io.merge_ytdlp_options(raw_opts, essential_flags)
                    
                    # Send updated options to Lua so they persist for next load
                    # We need to find the index to update it properly?
                    # Or just use the URL key which adaptive_headers uses.
                    item_url = services.sanitize_url(url)
                    
                    # Centralized helper handles metadata, headers, and setting normalization
                    # Note: We temporarily override cookies_file for this specific reload
                    lua_options, _ = services.construct_lua_options(
                        target_item, settings, self.SCRIPT_DIR
                    )
                    lua_options["cookies_file"] = cookie_path
                    lua_options["use_ytdl_mpv"] = True # Force for fallback
                    
                    # Update Lua state
                    self.ipc_manager.send({"command": ["script-message", "set_url_options", item_url, json.dumps(lua_options)]})
                    
                    self.ipc_manager.send({"command": ["set_property", "cookies-file", cookie_path]})
                    self.ipc_manager.send({"command": ["set_property", "ytdl-raw-options", final_opts]})
                    self.ipc_manager.send({"command": ["set_property", "user-data/folder-id", self.owner_folder_id]})
                    self.ipc_manager.send({"command": ["set_property", "user-data/cookies-browser", target_item.get('cookies_browser', "")]})
                    self.ipc_manager.send({"command": ["set_property", "user-data/project-root", self.SCRIPT_DIR]})
                    
                    # 5. Reload
                    logging.info("Fallback: Reloading file with volatile cookies.")
                    self.ipc_manager.send({"command": ["loadfile", url, "replace"]})
                else:
                    logging.warning("Fallback: Failed to extract cookies.")
                    self.ipc_manager.send({"command": ["show-text", "Fallback Failed: Could not extract cookies.", 5000]})
                    
            except Exception as e:
                logging.error(f"Fallback failed: {e}")

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
        stats = {}
        with self.sync_lock:
            self.is_alive = False
            pid_to_clear = self.pid
            self.pid = None

            if pid_to_clear:
                logging.info(f"Clearing session state for PID: {pid_to_clear}")

            if self.playlist_tracker:
                stats = self.playlist_tracker.stop_tracking(mpv_return_code=mpv_return_code)
            self.playlist_tracker = None

            if self.ipc_manager:
                self.ipc_manager.close()
                self.ipc_manager = None

            self.process = None
            self.ipc_path = None
            self.playlist = []
            self.owner_folder_id = None
            self.manual_quit = False
            self.last_played_id_cache = None

            if self.handshake_path and os.path.exists(self.handshake_path):
                try:
                    os.remove(self.handshake_path)
                    logging.info(f"Cleaned up handshake file: {self.handshake_path}")
                except Exception as e:
                    logging.warning(f"Failed to remove handshake file: {e}")
            self.handshake_path = None

            if self.session_cookies:
                logging.info(f"Cleaning up {len(self.session_cookies)} session cookies.")
                for cookie_path in list(self.session_cookies):
                    try:
                        if os.path.exists(cookie_path):
                            os.remove(cookie_path)
                    except Exception as e:
                        logging.warning(f"Failed to remove session cookie {cookie_path}: {e}")
                self.session_cookies.clear()

            # Clean up the entire volatile directory if this was the last managed session
            try:
                from utils.url_analyzer import VolatileCookieManager
                VolatileCookieManager.cleanup_volatile_dir()
            except Exception as e:
                logging.warning(f"Failed to cleanup volatile directory: {e}")

            if os.path.exists(self.session_file):
                try:
                    os.remove(self.session_file)
                    logging.info(f"Cleaned up session file: {self.session_file}")
                except OSError as e:
                    logging.warning(f"Failed to remove session file during cleanup: {e}")
        return stats

    def get_pause_state(self):
        """Queries the current pause state from MPV via IPC."""
        with self.sync_lock:
            if not self.is_alive or not self.ipc_manager:
                return None
            try:
                res = self.ipc_manager.send({"command": ["get_property", "pause"]}, expect_response=True, timeout=0.5)
                if res and res.get("error") == "success":
                    return res.get("data")
            except Exception:
                pass
            return None

    def get_idle_state(self):
        """Queries the current idle state from MPV via IPC."""
        with self.sync_lock:
            if not self.is_alive or not self.ipc_manager:
                return None
            try:
                res = self.ipc_manager.send({"command": ["get_property", "idle-active"]}, expect_response=True, timeout=0.5)
                if res and res.get("error") == "success":
                    return res.get("data")
            except Exception:
                pass
            return None

    def restore(self):
        """Checks for a persisted session file and restores state if the process is still alive."""
        with self.sync_lock:
            # 1. Check if we are already reconnected
            if self.is_alive and self.pid and ipc_utils.is_pid_running(self.pid):
                return {
                    "was_stale": False, 
                    "folder_id": self.owner_folder_id, 
                    "last_played_id": getattr(self, 'last_played_id_cache', None),
                    "token": getattr(self, 'current_token', None),
                    "playlist": self.playlist
                }

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

                # 2. Verify IPC connectivity and get actual MPV PID
                actual_mpv_pid = None
                temp_manager = ipc_utils.IPCSocketManager()
                if temp_manager.connect(ipc_path, timeout=2.0, start_event_reader=False):
                    try:
                        pid_resp = temp_manager.send({"command": ["get_property", "pid"]}, expect_response=True, timeout=1.0)
                        if pid_resp and pid_resp.get("error") == "success":
                            actual_mpv_pid = pid_resp.get("data")
                    except Exception:
                        pass
                    temp_manager.close()

                # 3. Validation Logic
                is_alive = False
                if actual_mpv_pid:
                    is_alive = True # Socket is alive, that's enough for us to try re-attach
                elif ipc_utils.is_pid_running(pid):
                    # PID exists but IPC failed - might be starting up or just unresponsive
                    is_alive = True
                    logging.warning(f"[PY][Session] Restore: PID {pid} is running but IPC check failed. Attempting attachment anyway.")

                if is_alive:
                    folder_data = file_io.get_folder_data(owner_folder_id)
                    if not folder_data:
                        raise RuntimeError(f"Could not find data for restored folder '{owner_folder_id}'.")

                    # 4. Populate Session State (Full Parity)
                    self.pid = actual_mpv_pid if actual_mpv_pid else pid
                    self.ipc_path = ipc_path
                    self.owner_folder_id = owner_folder_id
                    self.current_token = token
                    self.is_alive = True
                    
                    # Persist actual PID if it changed (important for terminal wrappers)
                    if actual_mpv_pid and actual_mpv_pid != pid:
                        self.persist_session()

                    # 5. Initialize Services
                    self.ipc_manager = ipc_utils.IPCSocketManager()
                    if not self.ipc_manager.connect(self.ipc_path, timeout=5.0):
                        logging.error("[PY][Session] Restore: Persistent IPC connection failed.")
                        self.is_alive = False
                        return None

                    # --- Sync Internal Playlist with MPV Reality ---
                    # We parse IDs from MPV's 'playlist' property to ensure self.playlist
                    # only contains items that are actually in MPV.
                    try:
                        pl_resp = self.ipc_manager.send({"command": ["get_property", "playlist"]}, expect_response=True, timeout=2.0)
                        mpv_playlist_urls = pl_resp.get("data") if pl_resp else None
                        
                        if mpv_playlist_urls and isinstance(mpv_playlist_urls, list):
                            logging.info(f"[PY][Session] Restore: Found {len(mpv_playlist_urls)} items in MPV playlist.")
                            synced_playlist = []
                            shard_playlist = folder_data.get("playlist", [])
                            shard_map = {item.get('id'): item for item in shard_playlist if item.get('id')}
                            
                            for mpv_item in mpv_playlist_urls:
                                path = mpv_item.get('filename', '')
                                logging.debug(f"[PY][Session] Restore: Processing MPV path: {path}")
                                # Extract Solid ID from fragment
                                match = re.search(r"[#&]mpv_organizer_id=([^#&]+)", path)
                                item_id = match.group(1) if match else None
                                logging.debug(f"[PY][Session] Restore: Extracted ID: {item_id}")
                                
                                if item_id and item_id in shard_map:
                                    synced_playlist.append(shard_map[item_id])
                                else:
                                    # Fallback: try to find by URL if no ID fragment
                                    # This might happen for items added outside our system
                                    synced_playlist.append({"url": path, "title": mpv_item.get('title') or path, "id": item_id or str(uuid.uuid4())})
                            
                            self.playlist = synced_playlist
                            logging.info(f"[PY][Session] Restore: Synced {len(self.playlist)} items from MPV reality.")
                        else:
                            self.playlist = folder_data.get("playlist", [])
                            logging.warning("[PY][Session] Restore: Could not get playlist from MPV. Falling back to shard.")
                    except Exception as e:
                        self.playlist = folder_data.get("playlist", [])
                        logging.warning(f"[PY][Session] Restore: Error syncing playlist: {e}. Falling back to shard.")

                    self.register_ipc_callbacks()
                    
                    # 6. Re-sync active item ID
                    last_played_id = None
                    try:
                        id_resp = self.ipc_manager.send({"command": ["get_property", "user-data/id"]}, expect_response=True, timeout=1.0)
                        if id_resp and id_resp.get("error") == "success":
                            last_played_id = id_resp.get("data")
                        
                        if not last_played_id:
                            # Fallback to path/title matching
                            path_resp = self.ipc_manager.send({"command": ["get_property", "path"]}, expect_response=True)
                            curr_path = path_resp.get("data") if path_resp else None
                            if curr_path:
                                for item in self.playlist:
                                    if item.get('url') == curr_path or item.get('original_url') == curr_path:
                                        last_played_id = item.get('id')
                                        break
                        
                        self.last_played_id_cache = last_played_id
                    except Exception as e:
                        logging.warning(f"Failed to query active item during restore: {e}")
                    
                    from playlist_tracker import PlaylistTracker
                    self.playlist_tracker = PlaylistTracker(owner_folder_id, self.playlist, file_io, file_io.get_settings(), self.ipc_path, self.send_message)
                    self.playlist_tracker.start_tracking()
                    
                    # Ensure tracker authoritative state is reflected
                    if last_played_id:
                        self.playlist_tracker.current_id = last_played_id
                        self.playlist_tracker.last_played_id = last_played_id

                    self.launcher.start_restored_process_watcher(self.pid, ipc_path, owner_folder_id)

                    logging.info(f"[PY][Session] Successfully restored session for folder '{owner_folder_id}'.")
                    return {
                        "was_stale": False, 
                        "folder_id": owner_folder_id, 
                        "last_played_id": last_played_id, 
                        "token": token,
                        "playlist": self.playlist
                    }
                else:
                    logging.warning(f"[PY][Session] Stale session for PID {pid} found. Cleaning up.")
                    if os.path.exists(self.session_file):
                        try:
                            os.remove(self.session_file)
                        except OSError:
                            pass
                    return {"was_stale": True, "folder_id": owner_folder_id, "return_code": -1}

            except Exception as e:
                logging.warning(f"[PY][Session] Could not restore session: {e}. Cleaning up.")
                if os.path.exists(self.session_file):
                    try:
                        os.remove(self.session_file)
                    except OSError:
                        pass
                return None

    def _remote_log(self, message):
        """Sends a message to MPV to be printed in its terminal."""
        if self.ipc_manager and self.ipc_manager.is_connected():
            try:
                self.ipc_manager.send({"command": ["script-message", "python_log", message]})
            except Exception:
                pass

    def _sync_playlist_from_mpv(self):
        """Forces a real-time synchronization of the internal playlist from MPV reality."""
        if not self.ipc_manager or not self.ipc_manager.is_connected():
            return False
        
        try:
            res = self.ipc_manager.send({"command": ["get_property", "playlist"]}, expect_response=True, timeout=2.0)
            # If the command failed, we don't want to clear our internal list.
            if not res or res.get("error") != "success":
                return False

            mpv_playlist = res.get("data", [])
            # An empty playlist is possible, but we should still update our state.
            
            # Get latest shard data to match IDs back to metadata
            folder_data = file_io.get_folder_data(self.owner_folder_id)
            shard_playlist = folder_data.get("playlist", []) if folder_data else []
            shard_map = {item.get('id'): item for item in shard_playlist if item.get('id')}
            url_map = {item.get('url'): item for item in shard_playlist}

            synced_playlist = []
            for mpv_item in mpv_playlist:
                path = mpv_item.get('filename', '')
                # Try matching by Solid ID fragment first
                match = ID_MATCH_RE.search(path)
                item_id = match.group(1) if match else None
                
                clean_url = path.split('#')[0].split('&mpv_organizer_id=')[0]
                
                if item_id and item_id in shard_map:
                    synced_playlist.append(shard_map[item_id])
                else:
                    # Fallback to URL matching (stripped of fragment)
                    if clean_url in url_map:
                        synced_playlist.append(url_map[clean_url])
                    else:
                        synced_playlist.append({
                            "url": clean_url, 
                            "title": mpv_item.get('title') or clean_url, 
                            "id": item_id or str(uuid.uuid4())
                        })
            
            self.playlist = synced_playlist
            logging.info(f"[PY][Session] Reality Sync: {len(self.playlist)} items tracked.")
            return True
        except Exception as e:
            logging.error(f"[PY][Session] Reality Sync Failed: {e}")
            return False

    def append_batch(self, items, mode="append", folder_id=None, quiet=False):
        """Appends (or prepends) multiple items with mandatory real-time sync."""
        if not items:
            return {"success": True}
        with self.sync_lock:
            return self._append_batch_internal(items, mode, folder_id, quiet=quiet)

    def _append_batch_internal(self, items, mode="append", folder_id=None, quiet=False):
        """Internal append logic with strict MPV-state filtering."""
        if not self.is_alive or not self.ipc_manager:
            return {"success": False, "error": "No active session."}

        # 1. Reality Sync: Get exactly what MPV currently has in its memory
        # This populates self.playlist with ONLY items already in the player.
        sync_success = self._sync_playlist_from_mpv()
        
        # Ensure we have a valid list to work with
        if self.playlist is None:
            self.playlist = []

        current_mpv_count = len(self.playlist)
        
        # If sync failed but we are prepend/appending, we should at least try to get a count
        # to avoid index-based mapping errors (even though we use ID-based mapping mostly)
        if not sync_success:
            count_res = self.ipc_manager.send({"command": ["get_property", "playlist-count"]}, expect_response=True, timeout=1.0)
            if count_res and count_res.get("error") == "success":
                current_mpv_count = count_res.get("data") or current_mpv_count

        # 2. Filter based on ACTIVE items only
        # We only skip if the item is already physically inside the MPV instance.
        active_ids = {i.get('id') for i in self.playlist if i.get('id')}
        items_to_add = [itm for itm in items if itm.get('id') not in active_ids]
        
        if not items_to_add:
            logging.info("[PY][Session] All requested items already active in MPV.")
            return {"success": True, "message": "Items already in playlist."}

        logging.info(f"[PY][Session] Appending {len(items_to_add)} unique items to MPV.")
        self._remote_log(f"Session: Appending {len(items_to_add)} items to live playlist.")
        
        # 3. Map Metadata to FUTURE indices
        import file_io
        settings = file_io.get_settings()
        for idx, item in enumerate(items_to_add):
            target_idx = current_mpv_count + idx
            lua_options, item_url = services.construct_lua_options(item, settings, self.SCRIPT_DIR, index=target_idx)
            # Map metadata so Lua knows the title/headers when the file opens
            self.ipc_manager.send({"command": ["script-message", "set_url_options", item_url, json.dumps(lua_options), str(target_idx)]})

        # 4. Atomic Load via M3U
        m3u_lines = ["#EXTM3U"]
        for itm in items_to_add:
            url = itm['url']
            if itm.get('is_youtube') and itm.get('original_url'):
                url = itm['original_url']
            if itm.get('id'):
                sep = "#" if "#" not in url else "&"
                url = f"{url}{sep}mpv_organizer_id={itm['id']}"
            m3u_lines.append(f"#EXTINF:-1,{itm.get('title', 'Unknown')}")
            # Ensure the URL is sanitized for M3U and shell safety
            m3u_lines.append(services.sanitize_url(url))
        
        temp_path = os.path.join(self.TEMP_PLAYLISTS_DIR, f"batch_{uuid.uuid4().hex[:8]}.m3u")
        try:
            os.makedirs(self.TEMP_PLAYLISTS_DIR, exist_ok=True)
            with open(temp_path, 'w', encoding='utf-8') as f:
                f.write("\n".join(m3u_lines))
            
            res = self.ipc_manager.send({"command": ["loadlist", temp_path, "append"]}, expect_response=True, timeout=5.0)
            if res and res.get("error") == "success":
                # 5. Update Internal State immediately
                if mode == "prepend":
                    for i in range(len(items_to_add)):
                        # Move from the end (where it was appended) to the beginning.
                        # MPV will automatically shift the 'playlist-pos' pointer to stay on the current item.
                        self.ipc_manager.send({"command": ["playlist-move", current_mpv_count + i, i]})
                    self.playlist = items_to_add + self.playlist
                else:
                    self.playlist.extend(items_to_add)

                if self.playlist_tracker:
                    self.playlist_tracker.update_playlist_order(self.playlist)
                
                # Force start if MPV was finished/idle
                idle = self.ipc_manager.send({"command": ["get_property", "idle-active"]}, expect_response=True)
                if idle and idle.get("data"):
                    # We might need to unpause if idle-active is true because of a pause-at-end
                    self.ipc_manager.send({"command": ["set_property", "pause", False]})
                    self.ipc_manager.send({"command": ["playlist-next", "weak"]})
                
                if not quiet:
                    self.ipc_manager.send({"command": ["show-text", f"Added {len(items_to_add)} items", 3000]})
                return {"success": True, "message": f"Added {len(items_to_add)} items."}
            else:
                return {"success": False, "error": f"MPV rejected loadlist: {res}"}
        except Exception as e:
            logging.error(f"Append Internal Error: {e}")
            return {"success": False, "error": str(e)}
        finally:
            if os.path.exists(temp_path):
                try:
                    os.remove(temp_path)
                except Exception:
                    pass


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
                
                title = services.sanitize_url(removed_item.get('title') or "Item")
                if len(title) > 60:
                    title = title[:57] + "..."
                self.ipc_manager.send({"command": ["show-text", f"Removed: {title}", 2000]}, expect_response=True)
                
                return {"success": True, "message": "Item removed from live session."}
            
            return {"success": False, "message": "Item not found in live session."}

    def reorder(self, folder_id, new_order_items):
        """Delegates reordering to the IPC service."""
        with self.sync_lock:
            return self.ipc_service.reorder_live(folder_id, new_order_items)

    def clear_live(self, folder_id):
        """Clears all items from the active MPV playlist."""
        with self.sync_lock:
            if not self.is_alive or self.owner_folder_id != folder_id:
                return {"success": False, "message": "Session not active or folder mismatch."}
            
            logging.info(f"Clearing live MPV playlist for folder '{folder_id}'.")
            # We use 'playlist-clear' which removes everything except the currently playing file.
            # To clear everything, we might need a different approach or just stop.
            self.ipc_manager.send({"command": ["playlist-clear"]}, expect_response=True)
            
            # Reset internal playlist state
            self.playlist = []
            if self.playlist_tracker:
                self.playlist_tracker.update_playlist_order([])
            
            self.ipc_manager.send({"command": ["show-text", "Playlist cleared", 2000]}, expect_response=True)
            return {"success": True, "message": "Live playlist cleared."}

    def _generate_m3u_content(self, items):
        """Generates M3U content from a list of items."""
        m3u_lines = ["#EXTM3U"]
        for item in items:
            # Minimal sanitization for titles: only remove newlines and commas to avoid breaking M3U format.
            raw_title = item.get('title', item['url'])
            safe_title = str(raw_title).replace('\n', ' ').replace('\r', '').replace(',', ' ').strip()
            
            url_to_use = item['url']
            if item.get('is_youtube') and item.get('original_url'):
                url_to_use = item['original_url']
            
            # --- Solid ID Injection ---
            # Append the UUID as a fragment to the URL. 
            # MPV/yt-dlp will ignore it, but Lua can read it.
            if item.get('id'):
                separator = "#" if "#" not in url_to_use else "&"
                url_to_use = f"{url_to_use}{separator}mpv_organizer_id={item['id']}"

            logging.debug(f"[PY][Session] Generating M3U entry: {safe_title} -> {url_to_use[:60]}...")
            m3u_lines.append(f"#EXTINF:-1,{safe_title}")
            m3u_lines.append(services.sanitize_url(url_to_use))
        return "\n".join(m3u_lines)

    def start(self, url_items_or_m3u, folder_id, settings, file_io, **kwargs):
        """Starts a new mpv process with a playlist of URLs or an M3U."""
        self.launch_cancelled = False
        launch_result = {"success": False, "error": "Initialization failed"}
        _url_items_list, input_was_raw = self.enricher.resolve_input_items(url_items_or_m3u, kwargs.get('enriched_items_list'), kwargs.get('headers'))
        
        if not _url_items_list:
            return {"success": False, "error": "No URL items provided or parsed."}

        # Calculate Smart Resume Index EARLY
        playlist_start_index = 0
        if settings.get("enable_smart_resume", True):
            # 1. Highest Priority: Request-level override (from user click)
            target_id = kwargs.get('playlist_start_id')
            
            # 2. Second Priority: Persistent 'currently_playing' marker in items
            if not target_id:
                for item in _url_items_list:
                    if item.get('currently_playing'):
                        target_id = item.get('id')
                        break
            
            # 3. Third Priority: last_played_id from index metadata
            if not target_id:
                target_id = file_io.get_index().get(folder_id, {}).get("last_played_id")
            
            # Find the index for the determined target_id
            if target_id:
                for idx, item in enumerate(_url_items_list):
                    if item.get('id') == target_id:
                        playlist_start_index = idx
                        break
            
            logging.info(f"[PY][Session] Smart Resume: folder='{folder_id}', target_id='{target_id}', found_at_index={playlist_start_index}")

        # Handle Enrichment for Raw Inputs
        if input_was_raw:
            is_m3u_flow = isinstance(url_items_or_m3u, str) and "youtube.com" not in url_items_or_m3u
            if is_m3u_flow:
                from concurrent.futures import ThreadPoolExecutor
                with ThreadPoolExecutor(max_workers=10) as executor:
                    # Pass context for cookie management
                    results = list(executor.map(lambda x: self.enricher.enrich_single_item(x, folder_id, self.session_cookies, self.sync_lock, settings=settings, session=self), _url_items_list))
                _url_items_list = [i for r in results for i in r]
                return {
                    "success": True, 
                    "enriched_url_items": _url_items_list,
                    "enriched_m3u_content": self._generate_m3u_content(_url_items_list),
                    "message": "Enriched content generated."
                }
            else:
                # Standard Flow: Enrich only the STARTING item immediately
                # This ensures the item we actually launch with has headers/cookies
                logging.info(f"Enriching start item at index {playlist_start_index} for immediate launch.")
                start_item_enriched = self.enricher.enrich_single_item(_url_items_list[playlist_start_index], folder_id, self.session_cookies, self.sync_lock, settings=settings, session=self)
                
                # Replace the raw item with the enriched one in the list
                # Note: enrich_single_item returns a list (usually of length 1)
                if start_item_enriched:
                    _url_items_list[playlist_start_index] = start_item_enriched[0]

        with self.sync_lock:
            launch_item = _url_items_list[playlist_start_index]

            if self.pid:
                # 1. Determine if actually alive
                currently_alive = self.is_alive
                if currently_alive:
                    if self.ipc_manager and self.ipc_manager.is_connected():
                        # Verification ping
                        res = self.ipc_manager.send({"command": ["get_property", "pid"]}, timeout=0.5, expect_response=True)
                        if not res or res.get("error") != "success":
                            # Ping failed, but is the process really gone?
                            if not ipc_utils.is_pid_running(self.pid):
                                currently_alive = False
                            else:
                                logging.warning(f"Session PID {self.pid} is unresponsive but still running. Keeping alive.")
                    else:
                        currently_alive = ipc_utils.is_process_alive(self.pid, self.ipc_path)

                if not currently_alive:
                    logging.info(f"Session for PID {self.pid} is confirmed dead. Clearing.")
                    self.clear() 
                elif folder_id == self.owner_folder_id: 
                    # --- NON-DESTRUCTIVE HOT SWAP ---
                    # If we are asked to play items in the CURRENT folder, we attempt a direct jump.
                    if self.ipc_manager and self.ipc_manager.is_connected():
                        logging.info(f"Hot Swap: Switching active session to item: {launch_item.get('title')}")
                        
                        # 1. Mandatory Sync: Get current MPV reality
                        self._sync_playlist_from_mpv()
                        mpv_playlist_urls = []
                        try:
                            # We need the filenames specifically for fragment matching
                            pl_res = self.ipc_manager.send({"command": ["get_property", "playlist"]}, expect_response=True)
                            mpv_playlist_urls = pl_res.get("data", []) if pl_res else []
                        except Exception:
                            pass

                        target_url = services.sanitize_url(launch_item['url'])
                        if launch_item.get('is_youtube') and launch_item.get('original_url'):
                            target_url = services.sanitize_url(launch_item['original_url'])
                        
                        item_id = launch_item.get('id')
                        if item_id:
                            sep = "#" if "#" not in target_url else "&"
                            target_url = f"{target_url}{sep}mpv_organizer_id={item_id}"
                        
                        # 2. Try to find the item by ID fragment or URL
                        target_index = -1
                        clean_target_url = target_url.split('#')[0].split('&mpv_organizer_id=')[0]

                        for idx, mpv_item in enumerate(mpv_playlist_urls):
                            fname = mpv_item.get('filename', '')
                            # Priority 1: Match by Solid ID
                            if item_id and f"mpv_organizer_id={item_id}" in fname:
                                target_index = idx
                                break
                            # Priority 2: Match by URL (stripped)
                            clean_fname = fname.split('#')[0].split('&mpv_organizer_id=')[0]
                            if clean_fname == clean_target_url:
                                target_index = idx
                                break
                        
                        # 3. Prepare Metadata & Network properties
                        essential_flags = services.get_essential_ytdlp_flags()
                        raw_opts = launch_item.get('ytdl_raw_options')
                        if launch_item.get('cookies_browser'):
                             browser_opt = f"cookies-from-browser={launch_item['cookies_browser']}"
                             raw_opts = f"{raw_opts},{browser_opt}" if raw_opts else browser_opt
                        final_item_raw_opts = file_io.merge_ytdlp_options(raw_opts, essential_flags)

                        lua_options, _ = services.construct_lua_options(launch_item, settings, self.SCRIPT_DIR)
                        
                        self.ipc_manager.send({"command": ["set_property", "user-data/hot-swap-options", json.dumps(lua_options)]})
                        orig_url = launch_item.get('original_url') or launch_item.get('url', '')
                        self.ipc_manager.send({"command": ["set_property", "user-data/original-url", services.sanitize_url(orig_url)]})
                        self.ipc_manager.send({"command": ["set_property", "user-data/id", item_id or ""]})
                        self.ipc_manager.send({"command": ["set_property", "ytdl", "yes" if launch_item.get('is_youtube') or launch_item.get('use_ytdl_mpv') else "no"]})
                        self.ipc_manager.send({"command": ["set_property", "ytdl-raw-options", final_item_raw_opts]})
                        
                        if launch_item.get('cookies_file'):
                            self.ipc_manager.send({"command": ["set_property", "cookies-file", launch_item['cookies_file']]})

                        if lua_options.get('headers') and isinstance(lua_options['headers'], dict):
                            ua = lua_options['headers'].get('User-Agent')
                            ref = lua_options['headers'].get('Referer')
                            if ua:
                                self.ipc_manager.send({"command": ["set_property", "user-agent", ua]})
                            if ref:
                                self.ipc_manager.send({"command": ["set_property", "referrer", ref]})

                        if settings.get('enable_precise_resume', True):
                            try:
                                start_time = int(float(lua_options.get('resume_time') or 0))
                                self.ipc_manager.send({"command": ["set_property", "user-data/primed-resume-time", str(start_time)]})
                            except (ValueError, TypeError):
                                pass

                        # 4. Trigger Execution
                        if target_index != -1:
                            logging.info(f"Hot Swap: Item exists at index {target_index}. Jumping.")
                            self.ipc_manager.send({"command": ["set_property", "playlist-pos", target_index]})
                        else:
                            logging.info("Hot Swap: Item not in MPV. Appending and jumping.")
                            # Force a re-sync of internal list before manual append
                            self.ipc_manager.send({"command": ["loadfile", target_url, "append"]})
                            time.sleep(0.1) # Brief yield for MPV
                            
                            pl_count_res = self.ipc_manager.send({"command": ["get_property", "playlist-count"]}, expect_response=True)
                            new_idx = (pl_count_res.get("data", 1) if pl_count_res else 1) - 1
                            self.ipc_manager.send({"command": ["set_property", "playlist-pos", new_idx]})
                            
                            # Add to internal list
                            if self.playlist is not None:
                                self.playlist.append(launch_item)
                                if self.playlist_tracker:
                                    self.playlist_tracker.add_item(launch_item)

                        launch_result = {
                            "success": True, 
                            "already_active": True,
                            "handled_directly": True, # Hot swaps are always handled directly
                            "message": f"Switched to item: {launch_item.get('title')}",
                            "enriched_url_items": _url_items_list
                        }
                    else:
                        logging.info(f"[PY][Session] Session already active for folder '{folder_id}'. Returning already_active=True.")
                        launch_result = {
                            "success": True, 
                            "already_active": True, 
                            "handled_directly": True, # Active but no IPC is also handled directly
                            "enriched_url_items": _url_items_list,
                            "enriched_m3u_content": self._generate_m3u_content(_url_items_list)
                        }
                else:
                    # Folder mismatch - close old session first
                    if ipc_utils.is_pid_running(self.pid):
                        self.close()
                    else:
                        self.clear()

            # --- LAUNCH LOGIC (Only if not already active) ---
            if not launch_result.get("already_active"):
                # Determine indices for the staggered launch.
                # If we are background-loading (len > 1), the initial MPV instance only sees ONE item, 
                # so it must start at 0 regardless of its eventual position in the full list.
                staggered_initial_index = 0 if len(_url_items_list) > 1 else playlist_start_index

                launch_result = self.launcher.launch(
                    launch_item, folder_id, settings, file_io,
                    full_playlist=_url_items_list if len(_url_items_list) > 1 else [_url_items_list[playlist_start_index]],
                    playlist_start_index=staggered_initial_index,
                    **kwargs
                )
                
                if launch_result.get("success"):
                    # Ensure owner-only permissions for the IPC socket immediately after creation
                    if self.ipc_path and os.path.exists(self.ipc_path) and platform.system() != "Windows":
                        try:
                            os.chmod(self.ipc_path, 0o600)
                            logging.info(f"Set secure permissions (0600) for IPC socket: {self.ipc_path}")
                        except Exception:
                            pass
                    
                    self.register_ipc_callbacks()

        if launch_result.get("success") and len(_url_items_list) > 1:
            # Trigger background enrichment if it's NOT the first pass of a raw launch 
            # (Wait for the second pass with enriched items)
            # OR if it's a Hot Swap/Active session (already_active), since it won't have a second pass.
            if not launch_result.get("handled_directly") or launch_result.get("already_active"):
                self.enricher.handle_standard_flow_launch(self, _url_items_list, playlist_start_index, folder_id, settings, file_io)

        if launch_result.get("success") and input_was_raw and not launch_result.get("already_active"):
            launch_result["handled_directly"] = True
            launch_result["enriched_url_items"] = _url_items_list
            launch_result["enriched_m3u_content"] = self._generate_m3u_content(_url_items_list)

        return launch_result

    def close(self):
        """Closes the current mpv session gracefully via IPC, then forcefully if needed."""
        return self.launcher.close()
