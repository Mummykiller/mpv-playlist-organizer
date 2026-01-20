import logging
import threading
import time
import sys
import os

# Prevent __pycache__ generation
sys.dont_write_bytecode = True
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'

from utils import ipc_utils
from utils import url_analyzer
from utils.fallback_sync import mark_video_as_watched_threaded

class PlaylistTracker:
    """
    Tracks the playback progress of a playlist in an MPV instance.
    """

    def __init__(self, folder_id, initial_playlist, file_io, settings, ipc_path, send_message_func):
        self.folder_id = folder_id
        self.playlist = []
        self.played_item_ids = set()
        self.watched_this_session = set() # Track items already marked as watched this session
        
        # New: Track playback duration in the current session
        self.current_session_duration = 0
        self.last_time_pos = None
        self.last_disk_save_time = 0 # Throttle for disk writes
        
        self.file_io = file_io
        self.ipc_path = ipc_path # Store the IPC path to create a dedicated connection
        self.send_message = send_message_func
        self.ipc_manager = None
        self.tracking_thread = None
        self.is_tracking = False
        self.clear_behavior = settings.get('playlist_clear_behavior', 'full_on_completion') # 'full_on_completion' or 'on_item_finish'
        self.lock = threading.Lock()

        for item in initial_playlist:
            self.add_item(item)

    def start_tracking(self): # ipc_path no longer needed here
        """
        Starts tracking the playlist in a separate thread.
        """
        self.is_tracking = True
        self.tracking_thread = threading.Thread(target=self._track)
        self.tracking_thread.daemon = True
        self.tracking_thread.start()
        logging.info(f"[PY][Tracker] Playlist tracker started for folder '{self.folder_id}' with '{self.clear_behavior}' behavior.")

    def stop_tracking(self, mpv_return_code=None):
        """
        Stops tracking and returns stats about what was played.
        """
        if not self.is_tracking:
            return {}

        self.is_tracking = False
        logging.info(f"[PY][Tracker] Playlist tracker stopped for folder '{self.folder_id}'. Played item IDs: {self.played_item_ids}")
        
        # Capture stats before joining
        stats = {
            "played_ids": list(self.played_item_ids),
            "session_ids": [item.get('id') for item in self.playlist if item.get('id')]
        }

        if self.tracking_thread:
            self.tracking_thread.join()
        
        return stats

    def add_item(self, item):
        """
        Adds a new item to the tracked playlist. It is assumed the item already has a stable ID.
        """
        # It is assumed the item already has an 'id' assigned by resolve_or_assign_item_id.
        with self.lock:
            self.playlist.append(item)
            logging.debug(f"[PY][Tracker] Added item to tracker's internal playlist: {item.get('title') or item['url']} (ID: {item.get('id')})")

    def remove_item_internal(self, item_id):
        """Removes an item from the tracker's internal playlist (used when removed from UI)."""
        with self.lock:
            self.playlist = [item for item in self.playlist if item.get('id') != item_id]
            logging.debug(f"[PY][Tracker] Removed item ID {item_id} from tracker's internal playlist.")

    def update_playlist_order(self, new_playlist):
        """Updates the internal playlist order to match the live session."""
        with self.lock:
            self.playlist = new_playlist
            logging.debug("[PY][Tracker] Internal playlist order updated.")

    def _track(self):
        """
        The main tracking loop that connects to MPV's IPC socket and listens for events.
        """
        # Optimized: Poll for connection instead of fixed sleep
        self.ipc_manager = ipc_utils.IPCSocketManager()
        connected = False
        for attempt in range(20): # Try for up to 4 seconds (20 * 0.2s)
            if self.ipc_manager.connect(self.ipc_path, timeout=0.2):
                connected = True
                break
            if not self.is_tracking: return
            time.sleep(0.2)

        if not connected:
            logging.error(f"[PY][Tracker] Tracker failed to connect to IPC at {self.ipc_path} after multiple attempts.")
            return

        # Observe 'user-data/id' to detect when the active file changes.
        # This is set by adaptive_headers.lua and is more reliable than 'path'.
        self.ipc_manager.send({"command": ["observe_property", 1, "user-data/id"]})
        self.ipc_manager.send({"command": ["observe_property", 2, "time-pos"]})
        # Added: ensure we also observe path changes as a backup/trigger
        self.ipc_manager.send({"command": ["observe_property", 3, "path"]})
        # Added: observe pause and idle state for proactive UI updates
        self.ipc_manager.send({"command": ["observe_property", 4, "pause"]})
        self.ipc_manager.send({"command": ["observe_property", 5, "idle-active"]})

        # Immediate Heartbeat to register Python presence
        self.ipc_manager.send({"command": ["script-message", "tracker_heartbeat"]})

        current_id = None
        self.previous_id = None # Track previous ID to handle event race conditions
        current_time = 0
        last_heartbeat = 0
        
        logging.info(f"[PY][Tracker] Starting event loop. Initial current_id: {current_id}")

        while self.is_tracking:
            if not self.ipc_manager.is_connected():
                logging.warning("[PY][Tracker] Tracker IPC disconnected. Attempting to reconnect...")
                if self.ipc_manager.connect(self.ipc_path):
                    logging.info("[PY][Tracker] Tracker reconnected. Re-observing properties.")
                    self.ipc_manager.send({"command": ["observe_property", 1, "user-data/id"]})
                    self.ipc_manager.send({"command": ["observe_property", 2, "time-pos"]})
                    self.ipc_manager.send({"command": ["observe_property", 3, "path"]})
                    self.ipc_manager.send({"command": ["observe_property", 4, "pause"]})
                    self.ipc_manager.send({"command": ["observe_property", 5, "idle-active"]})
                else:
                    time.sleep(2)
                    continue

            # Heartbeat to Lua to prevent fallback logic from triggering unnecessarily
            if time.time() - last_heartbeat > 5:
                self.ipc_manager.send({"command": ["script-message", "tracker_heartbeat"]})
                last_heartbeat = time.time()

            try:
                event = self.ipc_manager.receive_event(timeout=0.1)
                if not event:
                    time.sleep(0.05) # Tiny timer for stability
                    continue

                if event.get('event') == 'property-change':
                    prop_name = event.get('name')
                    data = event.get('data')

                    if prop_name == 'user-data/id':
                        new_id = data
                        
                        # IGNORE invalid/error IDs from MPV
                        if new_id is None or new_id == -1 or new_id == "-1" or new_id == "":
                            logging.debug(f"[PY][Tracker] Ignoring invalid ID from MPV: {new_id}")
                            continue

                        logging.debug(f"[PY][Tracker] property-change 'user-data/id' detected. Old: {current_id}, New: {new_id}")

                        if new_id != current_id:
                            # 1. If we were playing something else, do a FINAL save for it
                            if current_id and current_id != -1 and current_id != "-1" and current_time > 1:
                                logging.info(f"[PY][Tracker] Saving final position for old item {current_id}: {int(current_time)}s")
                                self._update_resume_time(current_id, current_time)
                                self.played_item_ids.add(current_id)

                            # Store previous ID to handle late 'end-file' events
                            self.previous_id = current_id

                            # 2. Update the active item ID and RESET session duration
                            current_id = new_id
                            self.current_session_duration = 0
                            self.last_time_pos = None

                            # Try to find title for better logs/OSD
                            display_name = current_id
                            is_yt = False
                            is_enabled = True
                            already_marked = False
                            with self.lock:
                                for item in self.playlist:
                                    if item.get('id') == current_id:
                                        display_name = item.get('title') or item.get('url')
                                        if len(display_name) > 50: display_name = display_name[:47] + "..."
                                        is_yt = item.get('is_youtube', False)
                                        is_enabled = item.get('mark_watched', True)
                                        already_marked = item.get('marked_as_watched', False)
                                        break
                            
                            status_info = ""
                            if is_yt:
                                if not is_enabled:
                                    status_info = " (Mark-as-watched: OFF)"
                                elif already_marked:
                                    status_info = " (Already marked)"

                            # 3. Notify the MPV terminal that we are tracking this new video
                            self._remote_log(f"AdaptiveHeaders: Tracking: {display_name}{status_info}")
                            
                            # 4. VISIBLE OSD FEEDBACK: Notify the user on screen
                            if self.ipc_manager and self.ipc_manager.is_connected():
                                self.ipc_manager.send({"command": ["show-text", f"Tracking: {display_name}{status_info}", 2000]})

                            # 5. Immediately notify the extension to update the UI highlight
                            logging.info(f"[PY][Tracker] Active episode changed to ID {current_id}. Notifying UI.")
                            self._update_last_played(current_id)
                            # Also update general status
                            self._update_playback_status()
                    
                    elif prop_name == 'pause' or prop_name == 'idle-active':
                        logging.debug(f"[PY][Tracker] property-change '{prop_name}' detected: {data}")
                        self._update_playback_status()

                    elif prop_name == 'time-pos':
                        if current_id and current_id != -1 and current_id != "-1" and data is not None:
                            # Ignore negative or invalid timestamps
                            if data < 0: continue
                            
                            # Update session duration
                            if self.last_time_pos is not None:
                                delta = data - self.last_time_pos
                                # Only count positive progress (no seeks/backwards) up to 2s jump
                                if 0 < delta < 2:
                                    self.current_session_duration += delta
                            
                            self.last_time_pos = data
                            current_time = data
                            
                            # 1. Check for mark-as-watched threshold (30s of SESSION playback)
                            if self.current_session_duration >= 30:
                                self._check_mark_watched(current_id)

                            # 2. Throttled periodic save (Every 5s of video time, but NO MORE THAN once every 5s of real time)
                            if int(current_time) > 0 and int(current_time) % 5 == 0:
                                now = time.time()
                                if now - getattr(self, 'last_disk_save_time', 0) >= 5:
                                    self._update_resume_time(current_id, current_time)
                                    self.last_disk_save_time = now
                                else:
                                    # Optional: still notify the UI so the progress bar moves, 
                                    # but don't hit the disk.
                                    pass

                elif event.get('event') == 'end-file':
                    reason = event.get('reason')
                    logging.debug(f"[PY][Tracker] end-file event detected. Reason: {reason}, ID: {current_id}")
                    
                    if reason == 'eof':
                        # Heuristic: If 'eof' happens immediately after an ID change (session < 5s),
                        # it almost certainly belongs to the PREVIOUS item, not the new one.
                        # This fixes race conditions where property-change arrives before end-file.
                        target_id_for_eof = current_id
                        
                        if self.current_session_duration < 5 and self.previous_id:
                            logging.info(f"[PY][Tracker] Detected late EOF event. Attributing to previous item: {self.previous_id}")
                            target_id_for_eof = self.previous_id
                        
                        if target_id_for_eof:
                            self._check_mark_watched(target_id_for_eof)
                            self.played_item_ids.add(target_id_for_eof)
                            self._update_resume_time(target_id_for_eof, 0)
                            
                    elif reason == 'stop' or reason == 'quit':
                        if current_id and current_time > 1:
                            self._update_resume_time(current_id, current_time)

            except Exception as e:
                logging.error(f"[PY][Tracker] Error in playlist tracker: {e}")

            except Exception as e: # Catch all for connection errors now handled by ipc_manager
                # IPCSocketManager handles FileNotFoundError, ConnectionRefusedError internally now.
                # If its send/receive methods return None, it means the connection might be dead.
                # If we get an exception here, it's something unexpected.
                logging.error(f"[PY][Tracker] Error in playlist tracker: {e}")
                if not self.ipc_manager._sock: # If socket is explicitly closed by manager
                    logging.info("[PY][Tracker] MPV IPC socket closed. Stopping tracker.")
                    self.is_alive = False
                time.sleep(1) # Original sleep

        # Clean up the local manager when loop exits
        if self.ipc_manager:
            self.ipc_manager.close()

    def _update_last_played(self, item_id):
        """Saves the last played item ID to the folder's metadata and notifies the extension."""
        if not self.folder_id or not item_id or item_id == -1 or item_id == "-1":
            return
        
        try:
            # 1. Update the local index file (lightweight metadata)
            index = self.file_io.get_index()
            if self.folder_id in index:
                index[self.folder_id]["last_played_id"] = item_id
                self.file_io.save_index(index)
                logging.debug(f"[PY][Tracker] Updated last_played_id to '{item_id}' for folder '{self.folder_id}'.")
            
            # 2. Notify the extension so it can update its internal storage
            self.send_message({
                "action": "update_last_played",
                "folderId": self.folder_id,
                "itemId": item_id
            })
        except Exception as e:
            logging.error(f"[PY][Tracker] Failed to update last_played_id: {e}")

    def _update_resume_time(self, item_id, resume_time):
        """Saves the current playback time for a specific item to the folder's playlist metadata."""
        if not self.folder_id or not item_id or item_id == -1 or item_id == "-1":
            return
        
        try:
            # 1. Update the specific playlist shard
            playlist = self.file_io.get_playlist_shard(self.folder_id)
            if playlist:
                for item in playlist:
                    if item.get("id") == item_id:
                        # Only update if the difference is significant or it's a reset
                        old_time = item.get("resume_time", 0)
                        if abs(resume_time - old_time) > 2 or resume_time == 0:
                            item["resume_time"] = int(resume_time)
                            self.file_io.save_playlist_shard(self.folder_id, playlist, update_index=False)
                            logging.debug(f"[PY][Tracker] Updated resume_time for item '{item_id}' to {int(resume_time)}s.")
                            
                            # 2. Notify the extension
                            self.send_message({
                                "action": "update_item_resume_time",
                                "folderId": self.folder_id,
                                "itemId": item_id,
                                "resumeTime": int(resume_time)
                            })
                        break
        except Exception as e:
            logging.error(f"[PY][Tracker] Failed to update resume_time: {e}")

    def _update_marked_as_watched(self, item_id, status, persist=True):
        """Saves the marked_as_watched status for a specific item to the folder's playlist metadata."""
        if not self.folder_id or not item_id or item_id == -1 or item_id == "-1":
            return
        
        try:
            # 1. Update internal playlist state
            with self.lock:
                for item in self.playlist:
                    if item.get('id') == item_id:
                        item["marked_as_watched"] = status
                        break

            # 2. Update the local playlist shard
            if persist:
                playlist = self.file_io.get_playlist_shard(self.folder_id)
                if playlist:
                    for item in playlist:
                        if item.get("id") == item_id:
                            item["marked_as_watched"] = status
                            self.file_io.save_playlist_shard(self.folder_id, playlist, update_index=False)
                            logging.debug(f"[PY][Tracker] Updated marked_as_watched for item '{item_id}' to {status}.")
                            break
            
            # 3. Notify the extension (always notify to keep UI in sync)
            self.send_message({
                "action": "update_item_marked_as_watched",
                "folderId": self.folder_id,
                "itemId": item_id,
                "markedAsWatched": status
            })

        except Exception as e:
            logging.error(f"[PY][Tracker] Failed to update marked_as_watched: {e}")

    def _check_mark_watched(self, item_id):
        """Checks if the item should be marked as watched on YouTube and triggers the call if so."""
        if item_id in self.watched_this_session:
            return

        target_item = None
        with self.lock:
            for item in self.playlist:
                if item.get('id') == item_id:
                    target_item = item
                    break
        
        if not target_item:
            logging.debug(f"[PY][Tracker] Cannot mark watched: Item ID {item_id} not found in internal playlist.")
            return

        # Diagnostic: Check if this is even a YouTube video
        if not target_item.get('is_youtube'):
            return

        # Ensure we check both the direct keys and potential nested settings
        is_enabled = target_item.get('mark_watched')
        if is_enabled is None:
            is_enabled = target_item.get('settings', {}).get('yt_mark_watched', True)
        
        already_marked = target_item.get('marked_as_watched', False)
        
        has_cookies = target_item.get('cookies_file') is not None
        has_browser = target_item.get('cookies_browser') is not None
        has_url = target_item.get('original_url') is not None
        
        logging.debug(f"[PY][Tracker] Mark-watched check for {item_id}: enabled={is_enabled}, already_marked={already_marked}, cookies={has_cookies}, url={has_url}")
        
        title = target_item.get('title') or target_item.get('original_url') or item_id
        if len(title) > 50: title = title[:47] + "..."

        # Lazy Extraction: If we are using direct browser access, we won't have a file yet.
        # Extract it now solely for the purpose of marking as watched.
        if is_enabled and not already_marked and has_url and not has_cookies and has_browser:
            browser = target_item['cookies_browser']
            watch_url = target_item['original_url']
            logging.info(f"[PY][Tracker] Lazy-extracting cookies from {browser} for history update...")
            self._remote_log("AdaptiveHeaders: Extracting cookies for history...")
            
            # Use volatile storage (RAM)
            extracted_path = url_analyzer.get_cookies_file(browser, watch_url, force_refresh=False)
            
            if extracted_path:
                with self.lock:
                    target_item['cookies_file'] = extracted_path
                has_cookies = True
                logging.info(f"[PY][Tracker] Cookies extracted to {extracted_path}")
            else:
                logging.warning("[PY][Tracker] Failed to lazy-extract cookies for history.")

        if is_enabled and not already_marked and has_cookies and has_url:
            self.watched_this_session.add(item_id)
            
            watch_url = target_item['original_url']
            cookies = target_item['cookies_file']
            headers = target_item.get('headers', {})
            ua = headers.get('User-Agent')
            
            logging.info(f"[PY][Tracker] Triggering watch history update for: {watch_url}")
            self.send_message({"log": {"text": "[Tracker]: Mark-as-watched triggered for YouTube video.", "type": "info"}})
            self._remote_log(f"AdaptiveHeaders: Threshold met or EOF reached. Marking {title} as watched.")
            self.ipc_manager.send({"command": ["show-text", "YouTube: Marking as watched...", 2000]})

            def on_done(success, msg):
                if self.ipc_manager and self.ipc_manager.is_connected():
                    if success:
                        self.ipc_manager.send({"command": ["show-text", "YouTube: Video marked as watched", 2000]})
                        self._remote_log(f"AdaptiveHeaders: YouTube watch history updated for: {title}")
                        self.send_message({"log": {"text": "[Tracker]: Successfully marked YouTube video as watched.", "type": "info"}})
                        # We pass persist=False because mark_video_as_watched_threaded calls sync_state 
                        # which already writes to disk upon success.
                        self._update_marked_as_watched(item_id, True, persist=False)
                        # Sync property to MPV so Lua knows we've done it
                        self.ipc_manager.send({"command": ["set_property", "user-data/marked-as-watched", "yes"]})
                    else:
                        self.ipc_manager.send({"command": ["show-text", f"YouTube: Mark watched failed ({msg})", 3000]})
                        self._remote_log(f"AdaptiveHeaders: Mark watched failed for {title}: {msg}")
                        self.send_message({"log": {"text": f"[Tracker]: Failed to mark YouTube video as watched: {msg}", "type": "error"}})

            mark_video_as_watched_threaded(watch_url, cookies, user_agent=ua, folder_id=self.folder_id, item_id=item_id, on_done=on_done)
        else:
            # Report why it was skipped
            reasons = []
            if not is_enabled: reasons.append("setting disabled")
            if already_marked: reasons.append("already marked as watched")
            if not has_cookies: reasons.append("missing cookies (is 'Use Cookies' ON?)")
            if not has_url: reasons.append("missing original URL")
            
            reason_str = ", ".join(reasons)
            logging.warning(f"[PY][Tracker] Mark-as-watched skipped for {item_id}: {reason_str}")
            
            if already_marked:
                self._remote_log(f"AdaptiveHeaders: {title} has been marked, ignoring.")
            elif not is_enabled:
                self._remote_log(f"AdaptiveHeaders: Mark-as-watched disabled for {title}, ignoring.")
            
            if is_enabled and not already_marked: # Only bother the user with a log if they actually expected it to work
                self.send_message({"log": {"text": f"[Tracker]: Mark-as-watched skipped: {reason_str}", "type": "warning"}})
                if self.ipc_manager and self.ipc_manager.is_connected():
                    self.ipc_manager.send({"command": ["show-text", f"YouTube: Mark watched skipped ({reasons[0] if reasons else 'unknown'})", 3000]})
            
            # Prevent spamming this error for the same item in this session
            self.watched_this_session.add(item_id)

    def _update_playback_status(self):
        """Notifies the host about general playback status changes (pause, idle, playlist)."""
        if not self.ipc_manager or not self.ipc_manager.is_connected():
            return

        try:
            pause_res = self.ipc_manager.send({"command": ["get_property", "pause"]}, expect_response=True, timeout=0.2)
            idle_res = self.ipc_manager.send({"command": ["get_property", "idle-active"]}, expect_response=True, timeout=0.2)
            
            is_paused = pause_res.get("data") if pause_res and pause_res.get("error") == "success" else False
            is_idle = idle_res.get("data") if idle_res and idle_res.get("error") == "success" else False
            
            # Send status update back to Python Host
            self.send_message({
                "action": "playback_status_changed",
                "folderId": self.folder_id,
                "is_paused": is_paused,
                "is_idle": is_idle,
                "session_ids": [item.get('id') for item in self.playlist if item.get('id')]
            })
        except Exception as e:
            logging.debug(f"[PY][Tracker] Failed to update playback status: {e}")

    def _remote_log(self, message):
        """Sends a message to MPV to be printed in its terminal."""
        if self.ipc_manager and self.ipc_manager.is_connected():
            try:
                self.ipc_manager.send({"command": ["script-message", "python_log", message]})
            except:
                pass