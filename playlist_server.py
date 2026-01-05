import http.server
import socketserver
import logging
import os
import threading
import time
import argparse # Import argparse
import sys # Import sys

sys.dont_write_bytecode = True # Prevent __pycache__ generation for this script

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

class PlaylistHandler(http.server.SimpleHTTPRequestHandler):
    """
    Custom handler to serve the M3U playlist file.
    """
    def __init__(self, request, client_address, server, m3u_serve_file='test_playlist.m3u'):
        self.m3u_serve_file = m3u_serve_file
        super().__init__(request, client_address, server)

    def do_GET(self):
        # --- Token Security Check ---
        from urllib.parse import urlparse, parse_qs
        query = parse_qs(urlparse(self.path).query)
        provided_token = query.get('token', [None])[0]
        secret_token = os.environ.get('MPV_PLAYLIST_TOKEN')

        if secret_token and provided_token != secret_token:
            self.send_error(403, "Access denied: Invalid or missing token.")
            logging.warning(f"[PY][SEC] Blocked unauthorized request from {self.client_address[0]}")
            return

        if self.path.startswith('/playlist.m3u'):
            m3u_file_path = self.m3u_serve_file # Use the dynamically set file path
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
                    self.wfile.flush() # Ensure all data is sent
                    logging.info(f"Served {m3u_file_path} ({len(content)} bytes) to {self.client_address[0]}")
                except Exception as e:
                    self.send_error(500, f"Error reading playlist: {e}")
            else:
                self.send_error(404, f"M3U playlist not found: {m3u_file_path}")
                logging.warning(f"M3U playlist file not found at {m3u_file_path}")
        else:
            # For any other path, fallback to SimpleHTTPRequestHandler's default behavior
            # (which usually serves files from the current directory)
            # You might want to restrict this or serve other assets as needed.
            return http.server.SimpleHTTPRequestHandler.do_GET(self)

def start_playlist_server(start_port=8000, max_port_attempts=10, m3u_file_to_serve='test_playlist.m3u'):
    """
    Starts a simple HTTP server in a separate thread, trying consecutive ports.
    """
    class CustomPlaylistHandler(PlaylistHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, m3u_serve_file=m3u_file_to_serve, **kwargs)

    Handler = CustomPlaylistHandler
    
    httpd = None
    actual_port = start_port

    socketserver.TCPServer.allow_reuse_address = True

    for _ in range(50): # Increased from 10 to 50 attempts
        try:
            httpd = socketserver.TCPServer(("127.0.0.1", actual_port), Handler)
            break # Successfully bound to a port
        except OSError as e:
            if "Address already in use" in str(e):
                logging.warning(f"Port {actual_port} is in use, trying next port...")
                actual_port += 1
            else:
                logging.error(f"Failed to start playlist server: {e}")
                return None, None, None # Indicate failure
    
    if httpd is None:
        logging.error(f"Could not find an available port after {max_port_attempts} attempts starting from {start_port}.")
        return None, None, None

    try:
        logging.info(f"Serving M3U playlist on port {actual_port}")
        server_thread = threading.Thread(target=httpd.serve_forever)
        server_thread.daemon = True # Allow the main program to exit even if server is running
        server_thread.start()
        logging.info(f"Playlist server thread started on port {actual_port}.")
        return httpd, server_thread, actual_port # Return httpd object and actual port
    except Exception as e:
        logging.error(f"An unexpected error occurred during playlist server startup: {e}")
        if httpd: httpd.server_close()
        return None, None, None

def suicide_watch():
    """
    Periodically checks if the parent process is still alive.
    If not, shuts down the server and exits.
    """
    parent_pid = os.getppid()
    while True:
        try:
            # os.kill(pid, 0) checks if the process is alive
            os.kill(parent_pid, 0)
        except OSError:
            logging.warning("Parent process died. Shutting down playlist server.")
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
    parser = argparse.ArgumentParser(description="Simple M3U Playlist HTTP Server")
    parser.add_argument("--port", type=int, default=8000, help="Starting port to bind to")
    parser.add_argument("--file", type=str, default="test_playlist.m3u", help="Path to the M3U file to serve")
    args = parser.parse_args()

    # The main execution block now uses the start_playlist_server function
    server, thread, actual_port = start_playlist_server(start_port=args.port, m3u_file_to_serve=args.file)
    if server is None:
        logging.error("Server failed to start. Exiting.")
        sys.exit(1)

    # Start suicide watch to prevent orphan processes
    watch_thread = threading.Thread(target=suicide_watch, daemon=True)
    watch_thread.start()

    print(f"Playlist server running at http://localhost:{actual_port}/playlist.m3u")
    print("Press Ctrl+C to stop the server and exit.")
    try:
        # Keep the main thread alive to allow the server thread to run
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        stop_playlist_server(server)
        print("Exiting.")