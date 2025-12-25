import logging
import threading
import time
import uuid
import json
from utils import ipc_utils

class PlaylistTracker:
    """
    Tracks the playback progress of a playlist in an MPV instance.
    """

    def __init__(self, folder_id, initial_playlist, file_io, settings):
        self.folder_id = folder_id
        self.playlist = []
        self.played_item_ids = set()
        self.file_io = file_io
        self.ipc_path = None
        self.tracking_thread = None
        self.is_tracking = False
        self.clear_behavior = settings.get('playlist_clear_behavior', 'full_on_completion') # 'full_on_completion' or 'on_item_finish'
        self.lock = threading.Lock()

        for item in initial_playlist:
            self.add_item(item)

    def start_tracking(self, ipc_path):
        """
        Starts tracking the playlist in a separate thread.
        """
        self.ipc_path = ipc_path
        self.is_tracking = True
        self.tracking_thread = threading.Thread(target=self._track)
        self.tracking_thread.daemon = True
        self.tracking_thread.start()
        logging.info(f"Playlist tracker started for folder '{self.folder_id}' with '{self.clear_behavior}' behavior.")

    def stop_tracking(self):
        """
        Stops tracking and performs the final comparison and clearing logic if necessary.
        """
        if not self.is_tracking:
            return

        self.is_tracking = False
        logging.info(f"Playlist tracker stopped for folder '{self.folder_id}'.")
        if self.tracking_thread:
            self.tracking_thread.join()
        
        if self.clear_behavior == 'full_on_completion':
            self._compare_and_clear()

    def add_item(self, item):
        """
        Adds a new item to the tracked playlist, assigning a unique ID if it doesn't have one.
        """
        if 'id' not in item:
            item['id'] = str(uuid.uuid4())
        self.playlist.append(item)

    def _track(self):
        """
        The main tracking loop that connects to MPV's IPC socket and listens for events.
        """
        time.sleep(2) # Wait for mpv to start and the IPC socket to be available
        
        # Observe the 'path' property to detect when a file finishes
        ipc_utils.send_ipc_command(self.ipc_path, {"command": ["observe_property", 1, "path"]})
        
        current_path = None
        response = ipc_utils.send_ipc_command(self.ipc_path, {"command": ["get_property", "path"]}, expect_response=True)
        if response and 'data' in response:
            current_path = response['data']

        while self.is_tracking:
            try:
                event = ipc_utils.receive_ipc_event(self.ipc_path, timeout=1.0)
                if not event:
                    continue

                if event.get('event') == 'property-change' and event.get('name') == 'path':
                    new_path = event.get('data')
                    
                    if current_path and current_path != new_path:
                        # File has changed, so the previous one is considered played.
                        for item in self.playlist:
                            if item.get('url') == current_path and item.get('id') not in self.played_item_ids:
                                logging.info(f"Marking item as played: {item['url']}")
                                self.played_item_ids.add(item['id'])
                                if self.clear_behavior == 'on_item_finish':
                                    self._clear_items({item['id']})
                                break
                    current_path = new_path

                elif event.get('event') == 'end-file' and event.get('reason') == 'eof':
                    # This event is a strong confirmation that a file finished naturally.
                    if current_path:
                         for item in self.playlist:
                            if item.get('url') == current_path and item.get('id') not in self.played_item_ids:
                                logging.info(f"Marking item as played on end-file event: {item['url']}")
                                self.played_item_ids.add(item['id'])
                                if self.clear_behavior == 'on_item_finish':
                                    self._clear_items({item['id']})
                                break

            except (FileNotFoundError, ConnectionRefusedError):
                logging.info("MPV IPC socket closed. Stopping tracker.")
                self.is_tracking = False
            except Exception as e:
                logging.error(f"Error in playlist tracker: {e}")
                time.sleep(1)

    def _clear_items(self, item_ids_to_clear):
        """
        Removes a set of item IDs from the playlist in storage.
        """
        with self.lock:
            logging.info(f"Clearing {len(item_ids_to_clear)} item(s) from playlist for folder '{self.folder_id}'.")
            all_folders = self.file_io.get_all_folders_from_file()
            if not all_folders or self.folder_id not in all_folders:
                logging.warning(f"Could not find folder '{self.folder_id}' in storage. Cannot clear items.")
                return

            stored_playlist = all_folders[self.folder_id].get("playlist", [])
            
            new_playlist = [item for item in stored_playlist if item.get('id') not in item_ids_to_clear]
            
            if len(new_playlist) < len(stored_playlist):
                all_folders[self.folder_id]["playlist"] = new_playlist
                self.file_io.write_folders_file(all_folders)
                logging.info(f"Successfully cleared {len(stored_playlist) - len(new_playlist)} item(s).")

    def _compare_and_clear(self):
        """
        Compares the played items with the playlist from storage and clears the playlist if necessary.
        Used for 'full_on_completion' mode.
        """
        if not self.played_item_ids:
            logging.info("No items were played. Nothing to clear.")
            return

        logging.info("Comparing and clearing playlist for 'full_on_completion' mode...")
        self._clear_items(self.played_item_ids)
