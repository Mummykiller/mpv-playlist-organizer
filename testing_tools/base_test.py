import os
import sys
import unittest
import tempfile
import shutil
import logging
import time

# Add project root to path
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PROJECT_ROOT)

from utils import logger

class BaseTestCase(unittest.TestCase):
    """Base class for all MPV Playlist Organizer tests."""
    
    def setUp(self):
        # Create a clean temp directory for logs and data
        self.test_dir = tempfile.mkdtemp()
        
        # Mock UI message sender
        self.sent_messages = []
        def mock_send(msg):
            self.sent_messages.append(msg)
        self.mock_send = mock_send
        
        # Initialize logger with temp dir
        logger.set_ui_sender(mock_send)
        logger.initialize(self.test_dir, PROJECT_ROOT)
        
        # Common paths
        self.main_log = os.path.join(self.test_dir, "native_host.log")
        self.ipc_log = os.path.join(self.test_dir, "ipc_events.log")
        self.browser_error_log = os.path.join(self.test_dir, "browser_errors.log")

    def tearDown(self):
        logger.shutdown()
        # Small delay to ensure files are released
        time.sleep(0.1)
        if os.path.exists(self.test_dir):
            shutil.rmtree(self.test_dir)
        
        # Reset logging for next test
        root = logging.getLogger()
        root.handlers.clear()
        logger._is_initialized = False

    def wait_for_async(self, seconds=0.1):
        """Wait for background threads (like the logger) to catch up."""
        time.sleep(seconds)
