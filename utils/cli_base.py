import argparse
import logging
import os
import sys

# Common log format
LOG_FORMAT = '%(asctime)s - %(levelname)s - %(message)s'

def setup_script_env():
    """
    Ensures the project root is in sys.path so 'utils' and other root modules can be imported.
    Call this BEFORE importing project modules (like file_io) in standalone scripts.
    """
    sys.dont_write_bytecode = True
    os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
    
    current_dir = os.path.dirname(os.path.abspath(sys.argv[0]))
    
    # Check if we are in 'utils' subdirectory or executed directly
    # Heuristic: Look for 'native_host.py' to find root
    
    # Check if current_dir is root
    if os.path.exists(os.path.join(current_dir, 'native_host.py')):
        if current_dir not in sys.path:
            sys.path.insert(0, current_dir)
            
    # Check if parent is root (e.g. running utils/script.py)
    elif os.path.exists(os.path.join(os.path.dirname(current_dir), 'native_host.py')):
        project_root = os.path.dirname(current_dir)
        if project_root not in sys.path:
            sys.path.insert(0, project_root)

class BaseCLI:
    """
    Base class for CLI scripts to standardize logging, path setup, and argument parsing.
    """
    def __init__(self, description, log_level=logging.INFO, setup_logging=True):
        self.parser = argparse.ArgumentParser(description=description)
        if setup_logging:
            self.configure_logging(log_level)
            
    def configure_logging(self, level):
        """Configures basic logging if not already configured."""
        if not logging.getLogger().hasHandlers():
            logging.basicConfig(level=level, format=LOG_FORMAT)

    def add_argument(self, *args, **kwargs):
        """Wrapper for parser.add_argument."""
        self.parser.add_argument(*args, **kwargs)

    def parse_args(self):
        """Wrapper for parser.parse_args."""
        return self.parser.parse_args()

    def add_subparsers(self, **kwargs):
        """Wrapper for parser.add_subparsers."""
        return self.parser.add_subparsers(**kwargs)
