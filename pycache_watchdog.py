import os
import shutil
import time
import sys
import subprocess
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

class PycacheHandler(FileSystemEventHandler):
    def __init__(self, root_dir):
        self.root_dir = root_dir

    def on_created(self, event):
        if event.is_directory and os.path.basename(event.src_path) == "__pycache__":
            self._delete_pycache(event.src_path)

    def on_modified(self, event):
        if event.is_directory:
            for item in os.listdir(event.src_path):
                full_path = os.path.join(event.src_path, item)
                if item == "__pycache__" and os.path.isdir(full_path):
                    self._delete_pycache(full_path)

    def _delete_pycache(self, path):
        try:
            time.sleep(0.1)
            if os.path.exists(path):
                shutil.rmtree(path)
        except Exception:
            pass

def initial_sweep(root_dir):
    """Initial cleanup of existing __pycache__ folders."""
    for root, dirs, files in os.walk(root_dir):
        if "__pycache__" in dirs:
            pycache_path = os.path.join(root, "__pycache__")
            try:
                shutil.rmtree(pycache_path)
            except Exception:
                pass

def run_watchdog():
    """The actual monitoring loop."""
    project_root = os.path.dirname(os.path.abspath(__file__))
    initial_sweep(project_root)
    
    event_handler = PycacheHandler(project_root)
    observer = Observer()
    observer.schedule(event_handler, project_root, recursive=True)
    observer.start()
    try:
        while True:
            time.sleep(5)
    except KeyboardInterrupt:
        observer.stop()
    observer.join()

if __name__ == "__main__":
    if "--worker" in sys.argv:
        # We are the background process
        run_watchdog()
    else:
        # Launch the background process
        # start_new_session=True makes it independent of the current terminal
        proc = subprocess.Popen(
            [sys.executable, sys.argv[0], "--worker"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True
        )
        print(f"🚀 Pycache Watchdog started in background.")
        print(f"   PID: {proc.pid}")
        print(f"   Root: {os.path.dirname(os.path.abspath(__file__))}")
        print(f"   To stop it, run: kill {proc.pid}")