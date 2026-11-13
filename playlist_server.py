import http.server
import socketserver
import logging
import os
import errno
import threading
import time
import sys 
import json
import hmac
from urllib.parse import urlparse, parse_qs

from utils.cli_base import BaseCLI, setup_script_env
from utils.ipc_utils import is_pid_running

setup_script_env()

class ThreadedPlaylistServer(http.server.ThreadingHTTPServer):
    """
    Multi-threaded HTTP server so slow or stalled clients do not block other requests.
    """
    daemon_threads = True
    allow_reuse_address = True
    timeout = 10.0

class PlaylistHandler(http.server.BaseHTTPRequestHandler):
    """
    Custom handler to serve the M3U playlist file.
    """
    def __init__(self, request, client_address, server, m3u_serve_file='test_playlist.m3u'):
        self.m3u_serve_file = m3u_serve_file
        super().__init__(request, client_address, server)

    def setup(self):
        super().setup()
        if hasattr(self.request, 'settimeout'):
            self.request.settimeout(10.0)

    def do_GET(self):
        # --- Host Header Validation ---
        actual_port = self.server.server_address[1]
        host_header = self.headers.get('Host', '')
        allowed_hosts = {f"127.0.0.1:{actual_port}", f"localhost:{actual_port}"}
        if host_header not in allowed_hosts:
            self.send_error(400, "Bad Request: Invalid Host header.")
            logging.warning(f"[PY][SEC] Blocked request with invalid Host header '{host_header}' from {self.client_address[0]}")
            return

        # --- Token Security Check (Fail closed!) ---
        query = parse_qs(urlparse(self.path).query)
        provided_token = query.get('token', [None])[0]
        secret_token = os.environ.get('MPV_PLAYLIST_TOKEN')

        if not secret_token:
            self.send_error(403, "Access denied: Server token not configured.")
            logging.warning(f"[PY][SEC] Blocked request because MPV_PLAYLIST_TOKEN is not configured.")
            return

        if not provided_token or not hmac.compare_digest(str(provided_token), str(secret_token)):
            self.send_error(403, "Access denied: Invalid or missing token.")
            logging.warning(f"[PY][SEC] Blocked unauthorized request from {self.client_address[0]}")
            return

        if self.path.startswith('/playlist.m3u'):
            m3u_file_path = self.m3u_serve_file
            if os.path.exists(m3u_file_path):
                try:
                    with open(m3u_file_path, 'rb') as f:
                        content = f.read()
                    
                    self.send_response(200)
                    self.send_header('Content-type', 'audio/x-mpegurl')
                    self.send_header('Content-Length', str(len(content)))
                    self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
                    self.send_header('Pragma', 'no-cache')
                    self.send_header('Expires', '0')
                    self.end_headers()
                    self.wfile.write(content)
                    self.wfile.flush()
                    logging.info(f"Served {m3u_file_path} ({len(content)} bytes) to {self.client_address[0]}")
                except Exception as e:
                    self.send_error(500, f"Error reading playlist: {e}")
            else:
                self.send_error(404, f"M3U playlist not found: {m3u_file_path}")
                logging.warning(f"M3U playlist file not found at {m3u_file_path}")
        else:
            # Reject any other path to avoid exposing arbitrary files from the working directory
            self.send_error(404, "Not Found")
            return

def start_playlist_server(start_port=0, max_port_attempts=5, m3u_file_to_serve='test_playlist.m3u'):
    """
    Starts a ThreadingHTTPServer.
    When start_port == 0, binds to port 0 to let the OS kernel allocate an open ephemeral port.
    If a specific non-zero port is passed, attempts consecutive ports up to max_port_attempts,
    falling back to letting the OS allocate an open port if all attempts are in use.
    """
    class CustomPlaylistHandler(PlaylistHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, m3u_serve_file=m3u_file_to_serve, **kwargs)

    Handler = CustomPlaylistHandler
    httpd = None

    if start_port == 0:
        try:
            httpd = ThreadedPlaylistServer(("127.0.0.1", 0), Handler)
            actual_port = httpd.server_address[1]
        except OSError as e:
            logging.error(f"Dynamic port 0 allocation failed: {e}")
            return None, None, None
    else:
        actual_port = start_port
        for _ in range(max_port_attempts):
            try:
                httpd = ThreadedPlaylistServer(("127.0.0.1", actual_port), Handler)
                actual_port = httpd.server_address[1]
                break
            except OSError as e:
                if getattr(e, "errno", None) == errno.EADDRINUSE:
                    logging.debug(f"Port {actual_port} is in use, trying next...")
                    actual_port += 1
                else:
                    logging.error(f"Failed to bind to port {actual_port}: {e}")
                    break

        if httpd is None:
            try:
                logging.info("Attempting fallback: Letting OS choose an available open port.")
                httpd = ThreadedPlaylistServer(("127.0.0.1", 0), Handler)
                actual_port = httpd.server_address[1]
            except OSError as e:
                logging.error(f"Fallback port allocation failed: {e}")
                return None, None, None

    try:
        # Structured output for reliable parsing by native host
        print(json.dumps({"port": actual_port, "status": "running"}))
        sys.stdout.flush()
        
        logging.info(f"Serving M3U playlist on 127.0.0.1:{actual_port}")
        server_thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        server_thread.start()
        return httpd, server_thread, actual_port
    except Exception as e:
        logging.error(f"Unexpected error during server startup: {e}")
        if httpd:
            httpd.server_close()
        return None, None, None

def suicide_watch():
    """
    Periodically checks if the parent process is still alive.
    If not, shuts down the server and exits.
    """
    parent_pid = os.getppid()
    while True:
        try:
            if not is_pid_running(parent_pid):
                logging.warning("Parent process died. Shutting down playlist server.")
                os._exit(0)
        except OSError as e:
            logging.warning(f"Parent process died ({e}). Shutting down playlist server.")
            os._exit(0)
        time.sleep(2)

def stop_playlist_server(httpd):
    """
    Stops the HTTP server.
    """
    logging.info("Shutting down playlist server...")
    if httpd:
        httpd.shutdown()
        httpd.server_close()
        logging.info("Playlist server shut down.")

if __name__ == "__main__":
    cli = BaseCLI(description="Simple M3U Playlist HTTP Server")
    cli.add_argument("--port", type=int, default=0, help="Starting port to bind to (0 for dynamic open port)")
    cli.add_argument("--file", type=str, default="test_playlist.m3u", help="Path to the M3U file to serve")
    args = cli.parse_args()

    server, thread, actual_port = start_playlist_server(start_port=args.port, m3u_file_to_serve=args.file)
    if server is None:
        logging.error("Server failed to start. Exiting.")
        sys.exit(1)

    # Start suicide watch to prevent orphan processes
    watch_thread = threading.Thread(target=suicide_watch, daemon=True)
    watch_thread.start()

    sys.stderr.write(f"Playlist server running at http://127.0.0.1:{actual_port}/playlist.m3u\n")
    sys.stderr.flush()
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        stop_playlist_server(server)
