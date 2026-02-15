import os
import sys
import uuid
import time
import json
import subprocess
import threading
import logging
from urllib.request import urlopen

SERVER_PREFIX = "server_"
SERVER_EXT = ".m3u"

class M3UServer:
    def __init__(self, script_dir, temp_playlists_dir, server_token):
        self.script_dir = script_dir
        self.temp_playlists_dir = temp_playlists_dir
        self.server_token = server_token
        self.server_lock = threading.RLock()
        
        self.process = None
        self.port = None
        self.temp_file = None

    def start(self, m3u_content):
        """Starts the local M3U server with the given content."""
        with self.server_lock:
            if not self.temp_file:
                self.temp_file = os.path.join(self.temp_playlists_dir, f"{SERVER_PREFIX}{os.getpid()}{SERVER_EXT}")
            
            with open(self.temp_file, 'w', encoding='utf-8') as f:
                f.write(m3u_content)

            if self.process and self.process.poll() is None:
                base_url = f"http://localhost:{self.port}/playlist.m3u"
                return f"{base_url}?token={self.server_token}" if self.server_token else base_url

            server_path = os.path.join(self.script_dir, "playlist_server.py")
            if not os.path.exists(server_path):
                logging.error(f"Playlist server script not found at {server_path}")
                return None

            server_env = os.environ.copy()
            server_env["MPV_PLAYLIST_TOKEN"] = self.server_token
            try:
                self.process = subprocess.Popen(
                    [sys.executable, server_path, '--port', '0', '--file', self.temp_file],
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1, env=server_env
                )
                
                # Wait for port identification (non-blocking)
                start_time = time.time()
                self.port = None
                while time.time() - start_time < 5:
                    # check if process died
                    if self.process.poll() is not None:
                        break
                    
                    # Try to read line without blocking indefinitely
                    # We use a simple read-and-check approach for compatibility
                    import fcntl
                    fd = self.process.stdout.fileno()
                    fl = fcntl.fcntl(fd, fcntl.F_GETFL)
                    fcntl.fcntl(fd, fcntl.F_SETFL, fl | os.O_NONBLOCK)
                    
                    try:
                        line = self.process.stdout.readline()
                        if line:
                            try:
                                data = json.loads(line.strip())
                                if data.get("status") == "running" and data.get("port"):
                                    self.port = int(data.get("port"))
                                    break
                            except json.JSONDecodeError:
                                pass
                    except (IOError, ValueError):
                        pass
                    
                    # Reset to blocking for future reads if needed, or just sleep
                    time.sleep(0.1)
                
                # Restore blocking mode for safety
                try:
                    fcntl.fcntl(fd, fcntl.F_SETFL, fl)
                except: pass
                
                def consume_stderr(proc):
                    for line in iter(proc.stderr.readline, ''):
                        logging.info(f"Server stderr: {line.strip()}")
                    proc.stderr.close()
                threading.Thread(target=consume_stderr, args=(self.process,), daemon=True).start()

                if self.port is None:
                    raise RuntimeError("Port detection failed.")

                fetch_url = f"http://localhost:{self.port}/playlist.m3u?token={self.server_token}"
                
                # Wait for server to be responsive
                for _ in range(30):
                    try:
                        with urlopen(fetch_url, timeout=0.2) as r:
                            if r.getcode() == 200:
                                return fetch_url
                    except Exception:
                        pass
                    time.sleep(0.2)
                
                raise RuntimeError("Server timeout.")
            except Exception as e:
                logging.error(f"Failed to start M3U server: {e}")
                self.stop()
                return None

    def stop(self):
        """Stops the local M3U server."""
        with self.server_lock:
            if self.process:
                try:
                    self.process.terminate()
                    self.process.wait(timeout=2)
                except Exception:
                    try:
                        self.process.kill()
                    except Exception:
                        pass
                self.process = None
                self.port = None
                time.sleep(0.2)
            
            if self.temp_file and os.path.exists(self.temp_file):
                try:
                    os.remove(self.temp_file)
                except Exception:
                    pass
                self.temp_file = None
