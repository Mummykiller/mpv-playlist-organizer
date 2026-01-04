import logging
import threading
import time
import sys
import os

# Prevent __pycache__ generation
sys.dont_write_bytecode = True
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'

from utils import ipc_utils

class PlaylistTracker:
    """
    Tracks the playback progress of a playlist in an MPV instance.
    """

    def __init__(self, folder_id, initial_playlist, file_io, settings, ipc_path, send_message_func):
        self.folder_id = folder_id
        self.playlist = []
        self.played_item_ids = set()
        self.watched_this_session = set() # Track items already marked as watched this session
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
        logging.info(f"Playlist tracker started for folder '{self.folder_id}' with '{self.clear_behavior}' behavior.")

    def stop_tracking(self, mpv_return_code=None):
        """
        Stops tracking and performs the final comparison and clearing logic if necessary.
        """
        if not self.is_tracking:
            return

        self.is_tracking = False
        logging.info(f"Playlist tracker stopped for folder '{self.folder_id}'. Played item IDs: {self.played_item_ids}")
        if self.tracking_thread:
            self.tracking_thread.join()

    def add_item(self, item):
        """
        Adds a new item to the tracked playlist. It is assumed the item already has a stable ID.
        """
        # It is assumed the item already has an 'id' assigned by resolve_or_assign_item_id.
        with self.lock:
            self.playlist.append(item)
            logging.debug(f"Added item to tracker's internal playlist: {item.get('title') or item['url']} (ID: {item.get('id')})")

    def remove_item_internal(self, item_id):
        """Removes an item from the tracker's internal playlist (used when removed from UI)."""
        with self.lock:
            self.playlist = [item for item in self.playlist if item.get('id') != item_id]
            logging.debug(f"Removed item ID {item_id} from tracker's internal playlist.")

    def update_playlist_order(self, new_playlist):
        """Updates the internal playlist order to match the live session."""
        with self.lock:
            self.playlist = new_playlist
            logging.debug("Tracker: Internal playlist order updated.")

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
            logging.error(f"Tracker failed to connect to IPC at {self.ipc_path} after multiple attempts.")
            return

        # Observe 'user-data/id' to detect when the active file changes.
        # This is set by adaptive_headers.lua and is more reliable than 'path'.
        self.ipc_manager.send({"command": ["observe_property", 1, "user-data/id"]})
        self.ipc_manager.send({"command": ["observe_property", 2, "time-pos"]})

        current_id = None
        current_time = 0
        response = self.ipc_manager.send({"command": ["get_property", "user-data/id"]}, expect_response=True)
        if response and 'data' in response:
            current_id = response['data']
            if current_id:
                logging.info(f"Tracker: Initial current_id detected: {current_id}")
                self._update_last_played(current_id)
        
        logging.info(f"Tracker: Starting event loop. Initial current_id: {current_id}")

        while self.is_tracking:
            if not self.ipc_manager.is_connected():
                logging.warning("Tracker IPC disconnected. Attempting to reconnect...")
                if self.ipc_manager.connect(self.ipc_path):
                    logging.info("Tracker reconnected. Re-observing properties.")
                    self.ipc_manager.send({"command": ["observe_property", 1, "user-data/id"]})
                    self.ipc_manager.send({"command": ["observe_property", 2, "time-pos"]})
                else:
                    time.sleep(2)
                    continue

            try:
                event = self.ipc_manager.receive_event(timeout=1.0)
                if not event:
                    time.sleep(0.5)
                    continue

                if event.get('event') == 'property-change':
                    prop_name = event.get('name')
                    data = event.get('data')

                    if prop_name == 'user-data/id':
                        new_id = data
                        logging.debug(f"Tracker: property-change 'user-data/id' detected. Old: {current_id}, New: {new_id}")

                        if new_id and new_id != current_id:
                            # Reset watch timer flag for the new item if needed
                            # (The set already handles deduplication per session)
                            pass

                            # 1. If we were playing something else, do a FINAL save for it
                            if current_id and current_time > 2:
                                logging.info(f"Tracker: Saving final position for old item {current_id}: {int(current_time)}s")
                                self._update_resume_time(current_id, current_time)
                                self.played_item_ids.add(current_id)

                            # 2. Update the active item ID
                            current_id = new_id
                            
                            # 3. Notify the MPV terminal that we are tracking this new video
                            self._remote_log(f"AdaptiveHeaders: Watch history tracking started (Python) for ID: {current_id}")

                            # 4. Immediately notify the extension to update the UI highlight
                            logging.info(f"Tracker: Active episode changed to ID {current_id}. Notifying UI.")
                            self._update_last_played(current_id)
                    
                    elif prop_name == 'time-pos':
                        if current_id and data is not None:
                            current_time = data
                            
                            # 1. Check for mark-as-watched threshold (30s)
                            if current_time >= 30:
                                self._check_mark_watched(current_id)

                            # 2. Periodic save every 5 seconds, but don't let it block the loop
                            if int(current_time) > 0 and int(current_time) % 5 == 0:
                                self._update_resume_time(current_id, current_time)

                elif event.get('event') == 'end-file':
                    reason = event.get('reason')
                    logging.debug(f"Tracker: end-file event detected. Reason: {reason}, ID: {current_id}")
                    
                    if current_id:
                        if reason == 'eof':
                            # Natural finish: Reset resume time to 0
                            self.played_item_ids.add(current_id)
                            self._update_resume_time(current_id, 0)
                        elif reason == 'stop' or reason == 'quit':
                            # Manual stop/skip/quit: Save final position
                            if current_time > 2:
                                self._update_resume_time(current_id, current_time)

            except Exception as e:
                logging.error(f"Error in playlist tracker: {e}")

            except Exception as e: # Catch all for connection errors now handled by ipc_manager
                # IPCSocketManager handles FileNotFoundError, ConnectionRefusedError internally now.
                # If its send/receive methods return None, it means the connection might be dead.
                # If we get an exception here, it's something unexpected.
                logging.error(f"Error in playlist tracker: {e}")
                if not self.ipc_manager._sock: # If socket is explicitly closed by manager
                    logging.info("MPV IPC socket closed. Stopping tracker.")
                    self.is_alive = False
                time.sleep(1) # Original sleep

        # Clean up the local manager when loop exits
        if self.ipc_manager:
            self.ipc_manager.close()

    def _update_last_played(self, item_id):
        """Saves the last played item ID to the folder's metadata and notifies the extension."""
        if not self.folder_id or not item_id:
            return
        
        try:
            # 1. Update the local folders.json file (for CLI and persistence)
            all_folders = self.file_io.get_all_folders_from_file()
            if self.folder_id in all_folders:
                all_folders[self.folder_id]["last_played_id"] = item_id
                self.file_io.write_folders_file(all_folders)
                logging.debug(f"Tracker: Updated last_played_id to '{item_id}' for folder '{self.folder_id}'.")
            
            # 2. Notify the extension so it can update its internal storage
            self.send_message({
                "action": "update_last_played",
                "folderId": self.folder_id,
                "itemId": item_id
            })
        except Exception as e:
            logging.error(f"Tracker: Failed to update last_played_id: {e}")

    def _update_resume_time(self, item_id, resume_time):
        """Saves the current playback time for a specific item to the folder's playlist metadata."""
        if not self.folder_id or not item_id:
            return
        
        try:
            # 1. Update the local folders.json file
            all_folders = self.file_io.get_all_folders_from_file()
            if self.folder_id in all_folders:
                folder = all_folders[self.folder_id]
                for item in folder.get("playlist", []):
                    if item.get("id") == item_id:
                        # Only update if the difference is significant or it's a reset
                        old_time = item.get("resume_time", 0)
                        if abs(resume_time - old_time) > 2 or resume_time == 0:
                            item["resume_time"] = int(resume_time)
                            self.file_io.write_folders_file(all_folders)
                            logging.debug(f"Tracker: Updated resume_time for item '{item_id}' to {int(resume_time)}s.")
                            
                            # 2. Notify the extension
                            self.send_message({
                                "action": "update_item_resume_time",
                                "folderId": self.folder_id,
                                "itemId": item_id,
                                "resumeTime": int(resume_time)
                            })
                        break
        except Exception as e:
            logging.error(f"Tracker: Failed to update resume_time: {e}")

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
            return

        if target_item.get('mark_watched') and target_item.get('cookies_file') and target_item.get('original_url'):
            self.watched_this_session.add(item_id)
            
            watch_url = target_item['original_url']
            cookies = target_item['cookies_file']
            
            # Run yt-dlp in a separate thread to avoid blocking the tracker
            def mark():
                try:
                    import subprocess
                    import shutil
                    ytdlp_path = shutil.which("yt-dlp") or "yt-dlp"
                    
                    cmd = [
                        ytdlp_path,
                        "--ignore-config",
                        "--cookies", cookies,
                        "--mark-watched",
                        "--simulate",
                        "--quiet"
                    ]
                    
                    # Add User-Agent if available from headers
                    headers = target_item.get('headers', {})
                    if headers and 'User-Agent' in headers:
                        cmd.extend(["--user-agent", headers['User-Agent']])
                    
                    cmd.append(watch_url)
                    
                    logging.info(f"Tracker: Marking as watched: {watch_url}")
                    logging.debug(f"Tracker: Executing command: {' '.join(cmd)}")
                    self._remote_log(f"AdaptiveHeaders: Threshold met. Marking {watch_url} as watched via background process.")
                    
                    # Use subprocess.run with a timeout
                    subprocess.run(cmd, timeout=30, capture_output=True)
                    
                    # Show OSD message via IPC if still connected
                    if self.ipc_manager and self.ipc_manager.is_connected():
                        self.ipc_manager.send({"command": ["show-text", "YouTube: Video marked as watched", 2000]})
                        self._remote_log(f"AdaptiveHeaders: YouTube watch history updated for: {watch_url}")
                        
                except Exception as e:
                    logging.error(f"Tracker: Failed to mark {watch_url} as watched: {e}")

            threading.Thread(target=mark, daemon=True).start()

    def _remote_log(self, message):
        """Sends a message to MPV to be printed in its terminal."""
        if self.ipc_manager and self.ipc_manager.is_connected():
            try:
                self.ipc_manager.send({"command": ["script-message", "python_log", message]})
            except:
                pass