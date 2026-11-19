import os
import sys
import time
import json
import subprocess
import threading
import logging
import secrets
import queue
from urllib.request import urlopen
from urllib.error import URLError
from . import security

SERVER_PREFIX = "server_"
SERVER_EXT = ".m3u"

class M3UServer:
    def __init__(self, script_dir, temp_playlists_dir, server_token=None):
        self.script_dir = script_dir
        self.temp_playlists_dir = temp_playlists_dir
        self.server_token = server_token or secrets.token_hex(16)
        self.server_lock = threading.RLock()

        self.process = None
        self.port = None
        self.temp_file = None

    def start(self, m3u_content):
        """Starts the local M3U server with the given content."""
        with self.server_lock:
            if not self.server_token:
                self.server_token = secrets.token_hex(16)

            os.makedirs(self.temp_playlists_dir, mode=0o700, exist_ok=True)
            if not self.temp_file:
                self.temp_file = os.path.join(self.temp_playlists_dir, f"{SERVER_PREFIX}{os.getpid()}{SERVER_EXT}")

            fd = os.open(self.temp_file, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                f.write(m3u_content)

            if self.process and self.process.poll() is None and self.port:
                base_url = f"http://127.0.0.1:{self.port}/playlist.m3u"
                return f"{base_url}?token={self.server_token}"

            server_path = os.path.join(self.script_dir, "playlist_server.py")
            if not os.path.exists(server_path):
                logging.error(f"Playlist server script not found at {server_path}")
                return None

            server_env = security.get_scrubbed_env()
            server_env["MPV_PLAYLIST_TOKEN"] = self.server_token
            try:
                self.process = subprocess.Popen(
                    [sys.executable, server_path, '--port', '0', '--file', self.temp_file],
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1, env=server_env
                )

                # Wait for port identification reliably via background queue reader
                stdout_queue = queue.Queue()
                def read_stdout(proc, q):
                    try:
                        for line in iter(proc.stdout.readline, ''):
                            q.put(line)
                    except (IOError, ValueError) as err:
                        logging.debug(f"[M3U_SERVER] Error in stdout reader thread: {err}")
                    finally:
                        try:
                            proc.stdout.close()
                        except (IOError, OSError) as err:
                            logging.debug(f"[M3U_SERVER] Error closing stdout: {err}")

                threading.Thread(target=read_stdout, args=(self.process, stdout_queue), daemon=True).start()

                def consume_stderr(proc):
                    try:
                        for line in iter(proc.stderr.readline, ''):
                            logging.info(f"Server stderr: {line.strip()}")
                    except (IOError, ValueError) as err:
                        logging.debug(f"[M3U_SERVER] Error in stderr reader thread: {err}")
                    finally:
                        try:
                            proc.stderr.close()
                        except (IOError, OSError) as err:
                            logging.debug(f"[M3U_SERVER] Error closing stderr: {err}")

                threading.Thread(target=consume_stderr, args=(self.process,), daemon=True).start()

                start_time = time.time()
                self.port = None
                while time.time() - start_time < 5.0:
                    if self.process.poll() is not None:
                        break
                    try:
                        line = stdout_queue.get(timeout=0.1)
                        if line:
                            try:
                                data = json.loads(line.strip())
                                if data.get("status") == "running" and data.get("port"):
                                    self.port = int(data.get("port"))
                                    break
                            except json.JSONDecodeError as json_err:
                                logging.debug(f"[M3U_SERVER] Line is not json: {json_err}")
                    except queue.Empty:
                        continue

                if self.port is None:
                    raise RuntimeError("Port detection failed: playlist server did not report an open port.")

                fetch_url = f"http://127.0.0.1:{self.port}/playlist.m3u?token={self.server_token}"

                # Probe server to verify it is responsive before returning URL
                server_ready = False
                for _ in range(30):
                    try:
                        with urlopen(fetch_url, timeout=0.5) as r:
                            if r.getcode() == 200:
                                server_ready = True
                                break
                    except (URLError, OSError, TimeoutError) as poll_err:
                        logging.debug(f"[M3U_SERVER] Server not ready yet: {poll_err}")
                    time.sleep(0.1)

                if not server_ready:
                    redacted_url = security.mask_path(fetch_url)
                    raise RuntimeError(f"Server timeout waiting for response at {redacted_url}")

                return fetch_url
            except Exception as e:
                logging.error(f"Failed to start M3U server: {security.mask_path(str(e))}")
                self.stop()
                return None

    def stop(self):
        """Stops the local M3U server."""
        with self.server_lock:
            if self.process:
                try:
                    self.process.terminate()
                    self.process.wait(timeout=2)
                except (subprocess.SubprocessError, OSError) as term_err:
                    logging.debug(f"[M3U_SERVER] Error terminating server process: {term_err}")
                    try:
                        self.process.kill()
                        self.process.wait(timeout=2)
                    except (subprocess.SubprocessError, OSError) as kill_err:
                        logging.debug(f"[M3U_SERVER] Error killing server process: {kill_err}")
                self.process = None
                self.port = None
                time.sleep(0.2)

            if self.temp_file and os.path.exists(self.temp_file):
                try:
                    os.remove(self.temp_file)
                except OSError as rm_err:
                    logging.debug(f"[M3U_SERVER] Error removing temp file: {rm_err}")
                self.temp_file = None
