import logging
import threading
import time
import uuid
import json
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

        # Observe the 'path' property to detect when a file finishes
        self.ipc_manager.send({"command": ["observe_property", 1, "path"]})

        current_path = None
        response = self.ipc_manager.send({"command": ["get_property", "path"]}, expect_response=True)
        if response and 'data' in response:
            current_path = response['data']
        logging.info(f"Tracker: Initial current_path: {current_path}")

        while self.is_tracking:
            if not self.ipc_manager.is_connected():
                logging.warning("Tracker IPC disconnected. Attempting to reconnect...")
                if self.ipc_manager.connect(self.ipc_path):
                    logging.info("Tracker reconnected. Re-observing properties.")
                    self.ipc_manager.send({"command": ["observe_property", 1, "path"]})
                    self.ipc_manager.send({"command": ["observe_property", 2, "playlist-pos"]})
                else:
                    time.sleep(2)
                    continue

            try:
                event = self.ipc_manager.receive_event(timeout=1.0)
                if not event:
                    time.sleep(0.5) # Prevent tight loop if receive_event returns immediately (e.g. on Windows)
                    continue

                if event.get('event') == 'property-change':
                    prop_name = event.get('name')
                    data = event.get('data')

                    if prop_name == 'path':
                        new_path = data
                        logging.debug(f"Tracker: property-change 'path' detected. Old: {current_path}, New: {new_path}")

                        if current_path and current_path != new_path:
                            # File has changed, so the previous one is considered played.
                            for item in self.playlist:
                                logging.debug(f"Tracker: Comparing current_path '{current_path}' with item URL '{item.get('url')}'")
                                if item.get('url') == current_path and item.get('id') not in self.played_item_ids:
                                    logging.info(f"Tracker: Marking item as played: {item['url']} (ID: {item['id']})")
                                    self.played_item_ids.add(item['id'])
                                    break
                        current_path = new_path

                elif event.get('event') == 'end-file' and event.get('reason') == 'eof':
                    logging.debug(f"Tracker: end-file event (eof) detected for path: {current_path}")
                    # This event is a strong confirmation that a file finished naturally.
                    if current_path:
                         for item in self.playlist:
                            logging.debug(f"Tracker: Comparing current_path '{current_path}' with item URL '{item.get('url')}' for end-file.")
                            if item.get('url') == current_path and item.get('id') not in self.played_item_ids:
                                logging.info(f"Tracker: Marking item as played on end-file event: {item['url']} (ID: {item['id']})")
                                self.played_item_ids.add(item['id'])
                                break

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