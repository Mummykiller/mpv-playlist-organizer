import os
import sys

# Prevent __pycache__ generation
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
sys.dont_write_bytecode = True

from .handlers.playback_handler import PlaybackHandler
from .handlers.data_handler import DataHandler
from .handlers.settings_handler import SettingsHandler
from .handlers.context import BackendContext
from .handlers.registry import HandlerRegistry
from .native_link.metadata_cache import MetadataCache
from .native_link.task_manager import TaskManager

class HandlerManager:
    """
    Main entry point for handling messages from the browser.
    Uses composition to delegate to specialized handlers.
    """
    def __init__(self, **kwargs):
        self.metadata_cache = MetadataCache(kwargs.get('data_dir', ''), kwargs.get('file_io'))
        self.task_manager = TaskManager(kwargs.get('send_message'))
        self.ctx = BackendContext(
            mpv=kwargs.get('mpv_session'),
            io=kwargs.get('file_io'),
            services=kwargs.get('services'),
            ipc=kwargs.get('ipc_utils'),
            sender=kwargs.get('send_message'),
            script_dir=kwargs.get('script_dir'),
            anilist_cache_file=kwargs.get('anilist_cache_file'),
            temp_playlists_dir=kwargs.get('temp_playlists_dir'),
            log_stream=kwargs.get('log_stream'),
            data_dir=kwargs.get('data_dir', ''),
            metadata_cache=self.metadata_cache,
            task_manager=self.task_manager,
            diagnostic_collector=kwargs.get('diagnostic_collector')
        )
        self.playback = PlaybackHandler(self.ctx)
        self.data = DataHandler(self.ctx)
        self.settings = SettingsHandler(self.ctx)

        # Bind methods to instances for the registry
        HandlerRegistry.bind_instance(self.playback)
        HandlerRegistry.bind_instance(self.data)
        HandlerRegistry.bind_instance(self.settings)

    def _stop_local_m3u_server(self):
        """Helper for atexit cleanup."""
        self.playback._stop_local_m3u_server()
