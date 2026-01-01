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
        time.sleep(2) # Wait for mpv to start and the IPC socket to be available

        # Create a dedicated IPC manager for this thread
        self.ipc_manager = ipc_utils.IPCSocketManager()
        if not self.ipc_manager.connect(self.ipc_path):
            logging.error(f"Tracker failed to connect to IPC at {self.ipc_path}")
            return

        # Observe 'user-data/id' to detect when the active file changes.
        # This is set by adaptive_headers.lua and is more reliable than 'path'.
        self.ipc_manager.send({"command": ["observe_property", 1, "user-data/id"]})

        current_id = None
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

                        if new_id:
                            self._update_last_played(new_id)

                        if current_id and current_id != new_id:
                            # Item has changed, mark the previous one as played
                            logging.info(f"Tracker: Marking item as played: ID {current_id}")
                            self.played_item_ids.add(current_id)
                        
                        current_id = new_id

                elif event.get('event') == 'end-file' and event.get('reason') == 'eof':
                    logging.debug(f"Tracker: end-file event (eof) detected for ID: {current_id}")
                    if current_id:
                        self.played_item_ids.add(current_id)

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