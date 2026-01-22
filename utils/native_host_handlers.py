import os
import sys

# Prevent __pycache__ generation
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
sys.dont_write_bytecode = True

from .handlers.playback_handler import PlaybackHandler
from .handlers.data_handler import DataHandler
from .handlers.settings_handler import SettingsHandler

class HandlerManager(PlaybackHandler, DataHandler, SettingsHandler):
    """
    Main entry point for handling messages from the browser.
    Inherits specialized logic from Playback, Data, and Settings handlers.
    """
    def __init__(self, mpv_session, file_io_module, services_module, ipc_utils_module,
                 send_message_func, script_dir, anilist_cache_file, temp_playlists_dir, log_stream_func):
        # Initialize specialized handlers via multiple inheritance
        # BaseHandler.__init__ will be called via super().__init__ in the first inherited class
        super().__init__(
            mpv_session=mpv_session,
            file_io=file_io_module,
            services=services_module,
            ipc_utils=ipc_utils_module,
            send_message=send_message_func,
            script_dir=script_dir,
            anilist_cache_file=anilist_cache_file,
            temp_playlists_dir=temp_playlists_dir,
            log_stream=log_stream_func
        )
