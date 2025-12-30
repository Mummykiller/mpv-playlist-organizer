import logging
import time
import os
import sys
from urllib.request import urlopen # Import urlopen
import subprocess # Import subprocess
import re # Import regex for parsing server output

sys.dont_write_bytecode = True # Prevent __pycache__ generation for this script

from mpv_session import MpvSessionManager

# Configure logging for the test script
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# --- Mock Dependencies for MpvSessionManager ---
# In a real scenario, these would come from your application's main setup.
# For this test, we provide minimal functional mocks.

def mock_get_all_folders_from_file():
    logger.info("Mock: get_all_folders_from_file called.")
    return {}

def mock_get_mpv_executable():
    # Attempt to find mpv in PATH, or specify a default
    mpv_exe = os.environ.get("MPV_EXECUTABLE", "mpv")
    if not os.path.exists(mpv_exe) and not os.path.isabs(mpv_exe):
        # Try finding it in system PATH
        import shutil
        found_mpv = shutil.which(mpv_exe)
        if found_mpv:
            return found_mpv
    return mpv_exe # Fallback or if absolute path provided

def mock_log_stream(stream, log_func, folder_id):
    for line in iter(stream.readline, b''):
        line_decoded = line.decode('utf-8', errors='ignore').strip()
        if line_decoded:
            print(f"MPV STDERR [{folder_id}]: {line_decoded}")
            sys.stdout.flush()

def mock_send_message(message):
    logger.info(f"Mock: send_message called with: {message}")

MOCK_SCRIPT_DIR = os.path.dirname(__file__) # Project root
MOCK_TEMP_PLAYLISTS_DIR = os.path.join(MOCK_SCRIPT_DIR, 'temp_playlists')
os.makedirs(MOCK_TEMP_PLAYLISTS_DIR, exist_ok=True)


mock_dependencies = {
    'get_all_folders_from_file': mock_get_all_folders_from_file,
    'get_mpv_executable': mock_get_mpv_executable,
    'log_stream': mock_log_stream,
    'send_message': mock_send_message,
    'SCRIPT_DIR': MOCK_SCRIPT_DIR,
    'TEMP_PLAYLISTS_DIR': MOCK_TEMP_PLAYLISTS_DIR,
}

# --- Mock Settings and File IO (if needed by MpvSessionManager) ---
# Assuming 'settings' and 'file_io' are simple objects or dictionaries
mock_settings = {} # Add any necessary settings here
mock_file_io = {}  # Add any necessary file_io mocks here

def main():
    playlist_port = 8000 # Default starting port for the server
    m3u_url = "" # Will be determined dynamically
    server_process = None # Initialize server_process
    actual_server_port = None

    try:
        # 1. Start the local M3U server as a separate process
        logger.info("Starting local M3U server process...")
        server_env = os.environ.copy()
        server_env["PYTHONDONTWRITEBYTECODE"] = "1"
        server_process = subprocess.Popen(
            [sys.executable, 'playlist_server.py', '--port', str(playlist_port)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True, # Decode stdout/stderr as text
            bufsize=1, # Line-buffered output
            env=server_env # Pass the modified environment
        )
        
        # Read stdout line by line to find the actual port
        # Give it a max timeout to find the port
        port_found_timeout = 10 # seconds
        start_time = time.time()
        
        while time.time() - start_time < port_found_timeout:
            line = server_process.stderr.readline() # Read from stderr
            if not line:
                if server_process.poll() is not None: # Process exited
                    break
                time.sleep(0.1) # Wait a bit if no line, but process is alive
                continue

            logger.info(f"Server process stderr output: {line.strip()}")
            match = re.search(r"Serving M3U playlist on port (\d+)", line)
            if match:
                actual_server_port = int(match.group(1))
                logger.info(f"Playlist server bound to port {actual_server_port}.")
                break
            # We don't need to check stdout explicitly here unless playlist_server.py prints non-log info there
            # For now, rely on stderr for logs.
        
        if actual_server_port is None:
            raise RuntimeError("Could not determine playlist server port from its output.")

        m3u_url = f"http://localhost:{actual_server_port}/playlist.m3u"

        # Check if the server process exited immediately after reporting its port
        if server_process.poll() is not None and actual_server_port is None:
            stdout, stderr = server_process.communicate()
            logger.error(f"Playlist server process exited prematurely. Stdout:\n{stdout}\nStderr:\n{stderr}")
            sys.exit(1)

        # Wait for the server to become ready by trying to connect to it
        max_retries = 20 # 20 retries * 0.5 sec = 10 seconds timeout
        for i in range(max_retries):
            try:
                with urlopen(m3u_url, timeout=0.5) as response:
                    if response.getcode() == 200:
                        logger.info(f"Playlist server is ready after {i+1} attempts.")
                        break
            except Exception as e:
                logger.debug(f"Attempt {i+1}: Server not ready yet ({e}). Retrying...")
            time.sleep(0.5)
        else:
            logger.error("Playlist server did not become ready within the timeout.")
            if server_process and server_process.poll() is None: # check if server process is still alive before terminating
                server_process.terminate()
                server_process.wait(timeout=2)
                stdout, stderr = server_process.communicate()
                logger.error(f"Server process final stdout:\n{stdout}\nServer process final stderr:\n{stderr}")
            sys.exit(1)

        # 2. Initialize MpvSessionManager
        session_file = os.path.join(MOCK_TEMP_PLAYLISTS_DIR, "test_mpv_session.json")
        mpv_session_manager = MpvSessionManager(session_file, mock_dependencies)

        logger.info(f"Step 1: Enrichment Phase for: {m3u_url}")

        # 3. Call MpvSessionManager.start with the M3U URL (Enrichment Phase)
        enrichment_result = mpv_session_manager.start(
            url_items_or_m3u=m3u_url,
            folder_id="test_m3u_playlist",
            settings=mock_settings,
            file_io=mock_file_io,
            custom_mpv_flags="--vo=null --ao=null --msg-level=all=v,ytdl_hook=debug", # Use null output for tests # Use null output for tests # Use null output for tests # Use null output for tests
            automatic_mpv_flags=[]
        )

        if not enrichment_result["success"]:
            logger.error(f"Failed enrichment phase: {enrichment_result.get('error')}")
            sys.exit(1)
        
        logger.info("Step 2: Updating test_playlist.m3u with enriched content...")
        # In a real app, the server would serve this. Here we overwrite the file being served.
        with open('test_playlist.m3u', 'w', encoding='utf-8') as f:
            f.write(enrichment_result['enriched_m3u_content'])

        logger.info(f"Step 3: Launch Phase with enriched items...")

        first_item = enrichment_result['enriched_url_items'][0] if enrichment_result['enriched_url_items'] else {}

        # 4. Call start AGAIN with enriched_items_list (Launch Phase)
        mpv_start_result = mpv_session_manager.start(
            url_items_or_m3u=m3u_url,
            folder_id="test_m3u_playlist",
            settings=mock_settings,
            file_io=mock_file_io,
            custom_mpv_flags="--vo=null --ao=null --msg-level=all=v,ytdl_hook=debug", # Use null output for tests # Use null output for tests
            automatic_mpv_flags=[],
            enriched_items_list=enrichment_result['enriched_url_items'],
            headers=first_item.get('headers'),
            ytdl_raw_options=first_item.get('ytdl_raw_options'),
            use_ytdl_mpv=first_item.get('use_ytdl_mpv', False),
            is_youtube=first_item.get('is_youtube', False)
        )

        if not mpv_start_result["success"]:
            logger.error(f"Failed to start MPV in launch phase: {mpv_start_result['error']}")
            sys.exit(1)
        
        logger.info("MPV started successfully. Waiting for MPV to finish or for manual termination...")

        # Keep the main thread alive until MPV process finishes
        # Timeout after 30 seconds for safety
        test_start_time = time.time()
        while mpv_session_manager.is_alive and (time.time() - test_start_time < 30):
            time.sleep(1)
        
        if mpv_session_manager.is_alive:
            logger.info("Test timeout reached, closing MPV.")
            mpv_session_manager.close()
        else:
            logger.info("MPV session has ended naturally.")

    except Exception as e:
        logger.error(f"An error occurred during MPV playback: {e}")
    finally:
        # 4. Cleanup: ensure MPV is closed and the server is shut down
        if 'mpv_session_manager' in locals() and mpv_session_manager.is_alive:
            mpv_session_manager.close() # Ensure MPV process is terminated

        if server_process and server_process.poll() is None:
            logger.info("Terminating playlist server process.")
            server_process.terminate()
            try:
                server_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server_process.kill()
            # Read any remaining output from the server process
            server_stdout, server_stderr = server_process.communicate()
            if server_stdout:
                logger.info(f"Server process final stdout:\n{server_stdout}")
            if server_stderr:
                logger.error(f"Server process final stderr:\n{server_stderr}")
        logger.info("Test script finished.")

if __name__ == "__main__":
    main()

