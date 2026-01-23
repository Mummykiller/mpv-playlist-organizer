import logging
import os
import uuid
import threading
from .. import native_link
from .context import BackendContext

class BaseHandler:
    def __init__(self, ctx: BackendContext):
        self.ctx = ctx
        # Aliases for easier access while maintaining some compatibility
        self.mpv_session = ctx.mpv
        self.file_io = ctx.io
        self.services = ctx.services
        self.ipc_utils = ctx.ipc
        self.send_message = ctx.sender
        
        # Shared locks
        self.all_folders_lock = threading.Lock()
        
        from ..item_processor import ItemProcessor
        self.item_processor = ItemProcessor(ctx.services, ctx.sender, ctx.io)

        # Restore session token
        restored_data = self.mpv_session.restore()
        if restored_data and restored_data.get("token"):
            self.server_token = restored_data["token"]
            logging.info("[PY] BaseHandler: Restored existing session token.")
        else:
            self.server_token = uuid.uuid4().hex
            logging.debug("[PY] BaseHandler: Generated new session token.")

    def _resolve_or_assign_item_id(self, url_item, folder_id, all_folders):
        """Ensures a url_item has a stable ID and is added to the folder's playlist."""
        with self.all_folders_lock:
            if folder_id not in all_folders:
                all_folders[folder_id] = {"playlist": []}

            folder_data = all_folders[folder_id]
            playlist = folder_data.get("playlist", [])
            
            self.item_processor.ensure_id(url_item)
            item_id = url_item['id']

            for stored_item in playlist:
                if stored_item.get('id') == item_id:
                    stored_item.update(url_item)
                    return stored_item, all_folders
            
            playlist.append(url_item)
            folder_data["playlist"] = playlist
            return url_item, all_folders

    def _process_url_item(self, url_item, folder_id, all_folders):
        """Processes a single URL item using the centralized ItemProcessor."""
        if isinstance(url_item, str): 
            url_item = {'url': url_item}
        
        url_item, all_folders = self._resolve_or_assign_item_id(url_item, folder_id, all_folders)
        settings = self._get_merged_settings(None)
        
        processed_items = self.item_processor.enrich_single_item(
            url_item, folder_id, settings=settings, session=self.mpv_session
        )

        if len(processed_items) > 1 or processed_items[0].get('id') != url_item.get('id'):
            # This was a playlist expansion or a replacement
            with self.all_folders_lock:
                if folder_id in all_folders and 'playlist' in all_folders[folder_id]:
                    # Remove the original placeholder if it was a playlist
                    all_folders[folder_id]['playlist'] = [
                        i for i in all_folders[folder_id]['playlist'] 
                        if i.get('id') != url_item.get('id')
                    ]
                    # Add newly discovered items
                    for new_item in processed_items:
                        self._resolve_or_assign_item_id(new_item, folder_id, all_folders)
        
        return [url_item], all_folders

    def _get_merged_settings(self, request_settings):
        """Merges global settings with request-specific overrides."""
        settings = self.file_io.get_settings()
        if request_settings:
            # Handle both dict and object with __dict__
            attrs = request_settings.__dict__ if hasattr(request_settings, '__dict__') else request_settings
            for key, value in attrs.items():
                if value is not None:
                    settings[key] = value
        return settings
