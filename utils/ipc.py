"""
IPC Module Façade for MPV JSON IPC.
Re-exports IPCSocketManager and helper utilities from utils.ipc_utils.
"""
import sys
import os

# Prevent __pycache__ generation
sys.dont_write_bytecode = True
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'

from .ipc_utils import (
    IPCSocketManager,
    is_pid_running,
    is_process_alive,
    get_ipc_path,
    IPC_DIR_LINUX,
    PIPE_NAME_WINDOWS,
    ipc_logger
)

__all__ = [
    "IPCSocketManager",
    "is_pid_running",
    "is_process_alive",
    "get_ipc_path",
    "IPC_DIR_LINUX",
    "PIPE_NAME_WINDOWS",
    "ipc_logger"
]
