#!/usr/bin/env python3
import sys
import os
import platform

# --- Configuration (must match install.py) ---
HOST_NAME = "com.shinku.mpv_handler"
INSTALL_DIR = os.path.dirname(os.path.abspath(__file__))

def uninstall_windows():
    """Uninstaller for Windows. Removes manifest, wrapper, and registry keys."""
    import winreg
    print("--- Uninstalling for Windows ---")

    # Registry paths for various browsers
    browsers = {
        "Google Chrome": "SOFTWARE\\Google\\Chrome\\NativeMessagingHosts",
        "Mozilla Firefox": "SOFTWARE\\Mozilla\\NativeMessagingHosts",
        "Brave": "SOFTWARE\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts",
        "Microsoft Edge": "SOFTWARE\\Microsoft\\Edge\\NativeMessagingHosts",
        "Chromium": "SOFTWARE\\Chromium\\NativeMessagingHosts",
    }

    # 1. Remove Registry Keys
    for browser, reg_path in browsers.items():
        try:
            key_path = os.path.join(reg_path, HOST_NAME)
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key_path)
            print(f"Successfully removed registry key for {browser}.")
        except FileNotFoundError:
            print(f"Registry key for {browser} not found (already removed or browser not installed).")
        except OSError as e:
            print(f"Could not remove registry key for {browser}. You may need to run as administrator. Error: {e}")

    # 2. Remove generated files
    files_to_remove = [
        f"{HOST_NAME}.json",
        "run_native_host.bat"
    ]
    print("\n--- Removing generated files ---")
    for filename in files_to_remove:
        file_path = os.path.join(INSTALL_DIR, filename)
        if os.path.exists(file_path):
            try:
                os.remove(file_path)
                print(f"Removed file: {file_path}")
            except OSError as e:
                print(f"Error removing file {file_path}: {e}")

def uninstall_linux_macos(is_mac):
    """Uninstaller for Linux and macOS. Removes manifest files."""
    print(f"--- Uninstalling for {'macOS' if is_mac else 'Linux'} ---")

    # Base paths for browser configurations
    if is_mac:
        base_path = os.path.expanduser("~/Library/Application Support/")
        browser_paths = {
            "Google Chrome": os.path.join(base_path, "Google/Chrome/NativeMessagingHosts"),
            "Chromium": os.path.join(base_path, "Chromium/NativeMessagingHosts"),
            "Brave": os.path.join(base_path, "BraveSoftware/Brave-Browser/NativeMessagingHosts"),
            "Microsoft Edge": os.path.join(base_path, "Microsoft Edge/NativeMessagingHosts"),
        }
    else:  # Linux
        base_path = os.path.expanduser("~/.config/")
        browser_paths = {
            "Google Chrome": os.path.join(base_path, "google-chrome/NativeMessagingHosts"),
            "Chromium": os.path.join(base_path, "chromium/NativeMessagingHosts"),
            "Brave": os.path.join(base_path, "BraveSoftware/Brave-Browser/NativeMessagingHosts"),
            "Microsoft Edge": os.path.join(base_path, "microsoft-edge/NativeMessagingHosts"),
        }

    # Remove manifest files
    manifest_filename = f"{HOST_NAME}.json"
    for browser, path in browser_paths.items():
        manifest_path = os.path.join(path, manifest_filename)
        if os.path.exists(manifest_path):
            try:
                os.remove(manifest_path)
                print(f"Successfully removed manifest for {browser} at: {manifest_path}")
            except OSError as e:
                print(f"Error removing manifest for {browser}: {e}")

def main():
    """Main function to run the uninstaller."""
    print("--- MPV Playlist Organizer Native Host Uninstaller ---")
    print("This script will remove the native host configuration from your system.")
    confirm = input("> Are you sure you want to uninstall the native host? (yes/no): ").strip().lower()
    if confirm != 'yes':
        print("\nUninstallation aborted.")
        sys.exit(0)

    current_platform = platform.system()
    if current_platform == 'Windows':
        uninstall_windows()
    elif current_platform == 'Darwin':
        uninstall_linux_macos(is_mac=True)
    elif current_platform == 'Linux':
        uninstall_linux_macos(is_mac=False)

    print("\n--- Uninstallation Finished! ---")
    print("The native host has been deregistered. You can now safely delete this folder.")

if __name__ == "__main__":
    main()
    if platform.system() == "Windows":
        input("Press Enter to exit.")