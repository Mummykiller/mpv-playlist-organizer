import os
import sys
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional

# Prevent __pycache__ generation
sys.dont_write_bytecode = True
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'

@dataclass
class BackendContext:
    """
    Consolidated context containing all shared services and configuration.
    This replaces individual argument passing across the handler hierarchy.
    """
    mpv: Any  # MpvSessionManager
    io: Any   # file_io module
    services: Any # services module
    ipc: Any # ipc_utils module
    sender: Callable[[Dict[str, Any]], None] # send_message function
    script_dir: str
    anilist_cache_file: str
    temp_playlists_dir: str
    log_stream: Callable
    data_dir: str
    diagnostic_collector: Optional[Any] = None
