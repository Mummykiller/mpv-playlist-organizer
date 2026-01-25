import argparse
import sys
import logging
import time

sys.dont_write_bytecode = True

# --- Injected Dependencies ---
file_io = None
mpv_session = None
ipc_utils = None

def inject_dependencies(deps):
    """Injects dependencies from the main native_host script."""
    global file_io, mpv_session, ipc_utils, time
    file_io = deps['file_io']
    mpv_session = deps['mpv_session']
    ipc_utils = deps['ipc_utils']
    time = deps['time']

from utils.cli_base import BaseCLI

def _cli_list_folders(args):
    """CLI command to list all available folders and their item counts."""
    folders_data = file_io.get_all_folders_from_file()
    if not folders_data:
        print("No folders found. Please add an item in the extension first to create the data file.")
        return

    print("Available folders:")
    for folder_id, folder_info in sorted(folders_data.items()):
        playlist = folder_info.get("playlist", [])
        item_count = len(playlist)
        print(f"  - {folder_id} ({item_count} item{'s' if item_count != 1 else ''})")

def _cli_play_folder(args):
    """CLI command to play a specific folder."""
    folder_id = args.folder_id
    folders_data = file_io.get_all_folders_from_file()
    folder_info = folders_data.get(folder_id)

    if not folders_data:
         print("Error: Data file not found or is empty. Please add an item in the extension first to create it.", file=sys.stderr)
         sys.exit(1)

    if folder_info is None:
        print(f"Error: Folder '{folder_id}' not found.", file=sys.stderr)
        if folders_data:
            print("\nAvailable folders are:")
            for available_folder_id in sorted(folders_data.keys()):
                print(f"  - {available_folder_id}")
        sys.exit(1)
    
    playlist_items = folder_info.get("playlist", [])

    if not playlist_items:
        print(f"Playlist for folder '{folder_id}' is empty. Nothing to play.")
        sys.exit(0)

    print(f"Starting mpv for folder '{folder_id}' with {len(playlist_items)} item(s)...")
    
    # Retrieve settings to pass to start()
    settings = file_io.get_settings()
    result = mpv_session.start(playlist_items, folder_id, settings, file_io, clear_on_completion=True)

    if not result.get("success"):
        print(f"Error starting mpv: {result.get('error')}", file=sys.stderr)
        sys.exit(1)

    # Since the CLI is a foreground process, we need to wait for the playback to complete.
    # The `start` method is now threaded, so we can't just wait on the process.
    # We will poll the `is_mpv_running` status.
    while mpv_session.pid and ipc_utils.is_process_alive(mpv_session.pid, mpv_session.ipc_path):
        try:
            time.sleep(1)
        except KeyboardInterrupt:
            print("\nInterrupted by user. Closing mpv...")
            mpv_session.close()
            break
    
    print("Playback finished.")

def handle_cli():
    """Handles command-line invocation using argparse for a more robust CLI."""
    # Only treat as a CLI call if:
    # 1. Known CLI commands/flags are used
    # 2. OR we are in a terminal (TTY) with no arguments (where we want to show help)
    is_known_command = len(sys.argv) >= 2 and sys.argv[1] in ['play', 'list', '-h', '--help']
    is_tty_no_args = len(sys.argv) == 1 and sys.stdin.isatty()

    if not (is_known_command or is_tty_no_args):
        return False

    logging.info(f"Native host started in CLI mode with args: {sys.argv}")
    
    cli = BaseCLI(description="Command-line interface for MPV Playlist Organizer.", setup_logging=False)
    subparsers = cli.add_subparsers(dest='command', help='Available commands')

    # Note: We don't set required=True for subparsers so we can manually handle 
    # the empty-argument case and print help gracefully.

    play_parser = subparsers.add_parser('play', help='Play a playlist from a specified folder.')
    play_parser.add_argument('folder_id', help='The name of the folder to play.')
    play_parser.set_defaults(func=_cli_play_folder)

    list_parser = subparsers.add_parser('list', help='List all available folders and their item counts.')
    list_parser.set_defaults(func=_cli_list_folders)

    # If no arguments provided, print help and exit.
    if len(sys.argv) == 1:
        cli.parser.print_help()
        return True

    args = cli.parse_args()
    if args.command:
        args.func(args)
    else:
        cli.parser.print_help()
    
    return True