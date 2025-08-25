#!/usr/bin/env python3
import sys
import os
import platform

# --- Configuration (should match install.py) ---
HOST_NAME = "com.mpv_playlist_organizer.handler"
INSTALL_DIR = os.path.dirname(os.path.abspath(__file__))

def uninstall_windows():
    """Uninstaller for Windows. Removes registry keys and generated files."""
    import winreg

    print("Uninstalling for Windows...")

    # --- Unregister from browsers via Windows Registry ---
    browsers = {
        "Google Chrome": "SOFTWARE\\Google\\Chrome\\NativeMessagingHosts",
        "Brave": "SOFTWARE\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts",
        "Microsoft Edge": "SOFTWARE\\Microsoft\\Edge\\NativeMessagingHosts",
        "Chromium": "SOFTWARE\\Chromium\\NativeMessagingHosts",
    }

    for browser, reg_path in browsers.items():
        try:
            key_path = os.path.join(reg_path, HOST_NAME)
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key_path)
            print(f"Successfully unregistered native host for {browser}.")
        except FileNotFoundError:
            print(f"Native host was not registered for {browser} (or already removed).")
        except OSError as e:
            print(f"Could not unregister for {browser}. You may need to run as administrator. Error: {e}")

    # --- Clean up generated files ---
    files_to_remove = [
        os.path.join(INSTALL_DIR, "run_native_host.bat"),
        os.path.join(INSTALL_DIR, f"{HOST_NAME}-chrome.json")
    ]
    for file_path in files_to_remove:
        if os.path.exists(file_path):
            try:
                os.remove(file_path)
                print(f"Removed generated file: {os.path.basename(file_path)}")
            except OSError as e:
                print(f"Could not remove file {file_path}. Error: {e}")

def uninstall_linux_macos(is_mac):
    """Uninstaller for Linux and macOS. Removes manifest files."""
    print(f"Uninstalling for {'macOS' if is_mac else 'Linux'}...")

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

    manifest_filename = f"{HOST_NAME}.json"
    for browser, path in browser_paths.items():
        manifest_path = os.path.join(path, manifest_filename)
        if os.path.exists(manifest_path):
            try:
                os.remove(manifest_path)
                print(f"Successfully removed manifest for {browser}.")
            except OSError as e:
                print(f"Failed to remove manifest for {browser}. Error: {e}")
        else:
            print(f"Manifest for {browser} not found (or already removed).")

def main():
    """Main function to run the uninstaller."""
    print("--- MPV Playlist Organizer Native Host Uninstaller ---")
    print("This script will remove the native messaging host registration from your browsers.")
    print("\n[!] This will NOT remove the browser extension itself or this folder.")

    confirm = input("> Type 'yes' to confirm you wish to uninstall the native host: ").strip().lower()
    if confirm != 'yes':
        print("\nUninstallation aborted.")
        sys.exit(0)

    # --- Run Platform-Specific Uninstaller ---
    current_platform = platform.system()
    if current_platform == 'Windows':
        uninstall_windows()
    elif current_platform == 'Darwin':
        uninstall_linux_macos(is_mac=True)
    elif current_platform == 'Linux':
        uninstall_linux_macos(is_mac=False)
    else:
        print(f"Unsupported platform: {current_platform}")
        sys.exit(1)

    print("\n--- Uninstallation Finished! ---")
    print("\nNext Steps:")
    print("1. Remove the 'MPV Playlist Organizer' extension from your browser's extensions page.")
    print(f"2. You can now safely delete this folder: '{INSTALL_DIR}'")

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"\nAn unexpected error occurred: {e}")
    finally:
        # Keep the console open on Windows if run by double-clicking
        if platform.system() == "Windows":
            print("\nUninstallation is complete.")
            input("Press Enter to exit the uninstaller.")