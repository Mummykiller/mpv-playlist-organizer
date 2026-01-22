import logging
import os
import uuid
import threading
from .. import native_link

class BaseHandler:
    def __init__(self, mpv_session, file_io, services, ipc_utils, 
                 send_message, script_dir, anilist_cache_file, 
                 temp_playlists_dir, log_stream):
        self.mpv_session = mpv_session
        self.file_io = file_io
        self.services = services
        self.ipc_utils = ipc_utils
        self.send_message = send_message
        self.script_dir = script_dir
        self.anilist_cache_file = anilist_cache_file
        self.temp_playlists_dir = temp_playlists_dir
        self.log_stream = log_stream
        
        # Shared locks and state that might be needed by multiple handlers
        self.all_folders_lock = threading.Lock()
        self.server_lock = threading.RLock()
        
        self.playlist_server_process = None
        self.playlist_server_port = None
        self.temp_m3u_file_for_server = None
        
        # Restore session token
        restored_data = self.mpv_session.restore()
        if restored_data and restored_data.get("token"):
            self.server_token = restored_data["token"]
            logging.info("[PY] BaseHandler: Restored existing session token.")
        else:
            self.server_token = uuid.uuid4().hex
            logging.debug("[PY] BaseHandler: Generated new session token.")

    def _resolve_or_assign_item_id(self, url_item, folder_id, all_folders):
        """Ensures a url_item has a stable ID."""
        logging.debug(f"ResolveOrAssignId: Processing url_item: {url_item.get('title') or url_item['url']}, folder_id: {folder_id}")
        
        with self.all_folders_lock:
            if folder_id not in all_folders:
                all_folders[folder_id] = {"playlist": []}

            folder_data = all_folders[folder_id]
            playlist = folder_data.get("playlist", [])
            item_id = url_item.get('id')

            if item_id:
                for stored_item in playlist:
                    if stored_item.get('id') == item_id:
                        stored_item.update(url_item)
                        return stored_item, all_folders
            else:
                item_id = str(uuid.uuid4())
                url_item['id'] = item_id
            
            playlist.append(url_item)
            folder_data["playlist"] = playlist
            return url_item, all_folders

    def _process_url_item(self, url_item, folder_id, all_folders):
        """Processes a single URL item: resolves ID and applies bypass scripts."""
        if isinstance(url_item, str): 
            url_item = {'url': url_item}
        
        url_item, all_folders = self._resolve_or_assign_item_id(url_item, folder_id, all_folders)
        
        res = self.services.apply_bypass_script(url_item, self.send_message, session=self.mpv_session)
        processed_url, script_headers, ytdl_opts, use_ytdl_flag, is_yt_flag, entries, 
        disable_http_flag, cookies_file, mark_watched, ytdl_fmt, cookies_browser = res

        if entries:
            processed_entries = []
            for entry in entries:
                entry['id'] = str(uuid.uuid4())
                if not entry.get('original_url'):
                    entry['original_url'] = entry.get('url')
                entry, all_folders = self._resolve_or_assign_item_id(entry, folder_id, all_folders)
                entry['is_youtube'] = True
                entry['use_ytdl_mpv'] = False
                if disable_http_flag: entry['disable_http_persistent'] = True
                if cookies_browser: entry['cookies_browser'] = cookies_browser
                if cookies_file: entry['cookies_file'] = cookies_file
                processed_entries.append(entry)
            
            if 'playlist' in all_folders[folder_id]:
                all_folders[folder_id]['playlist'] = [i for i in all_folders[folder_id]['playlist'] if i.get('id') != url_item.get('id')]
            return processed_entries, all_folders

        url_item['url'] = processed_url
        url_item['original_url'] = url_item.get('original_url') or url_item.get('url')
        if script_headers: url_item['headers'] = script_headers
        if ytdl_opts: url_item['ytdl_raw_options'] = ytdl_opts
        url_item['use_ytdl_mpv'] = use_ytdl_flag
        url_item['is_youtube'] = is_yt_flag
        url_item['cookies_file'] = cookies_file
        url_item['cookies_browser'] = cookies_browser
        url_item['mark_watched'] = mark_watched
        url_item['ytdl_format'] = ytdl_fmt
        url_item['disable_http_persistent'] = disable_http_flag
        
        return [url_item], all_folders
