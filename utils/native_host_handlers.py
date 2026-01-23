import os
import sys

# Prevent __pycache__ generation
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
sys.dont_write_bytecode = True

from .handlers.playback_handler import PlaybackHandler
from .handlers.data_handler import DataHandler
from .handlers.settings_handler import SettingsHandler

class HandlerManager:
    """
    Main entry point for handling messages from the browser.
    Uses composition to delegate to specialized handlers.
    """
    def __init__(self, **kwargs):
        self.playback = PlaybackHandler(**kwargs)
        self.data = DataHandler(**kwargs)
        self.settings = SettingsHandler(**kwargs)

    def _stop_local_m3u_server(self):
        """Helper for atexit cleanup."""
        self.playback._stop_local_m3u_server()
