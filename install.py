#!/usr/bin/env python3
import sys
import os
import json
import subprocess
import platform

# --- Configuration ---
HOST_NAME = "com.mpv_playlist_organizer.handler"
HOST_DESCRIPTION = "MPV Playlist Organizer Native Host"
SCRIPT_NAME = "native_host.py"
CONFIG_NAME = "config.json"
INSTALL_DIR = os.path.dirname(os.path.abspath(__file__))

def get_script_path():
    """Gets the absolute path to the native_host.py script."""
    return os.path.join(INSTALL_DIR, SCRIPT_NAME)

def get_config_path():
    """Gets the absolute path to the config.json file."""
    return os.path.join(INSTALL_DIR, CONFIG_NAME)

def find_mpv_windows():
    """Finds mpv.exe on Windows, checking PATH first, then prompting the user."""
    print("Searching for mpv.exe...")
    try:
        # Use 'where' command to find the executable in PATH
        result = subprocess.run(['where', 'mpv.exe'], check=True, capture_output=True, text=True)
        mpv_path = result.stdout.strip().split('\n')[0]
        print(f"Found mpv.exe at: {mpv_path}")
        return mpv_path
    except (subprocess.CalledProcessError, FileNotFoundError):
        print("mpv.exe not found in your system's PATH.")
        while True:
            mpv_path = input("Please enter the full path to mpv.exe (e.g., C:\\path\\to\\mpv.exe): ").strip()
            if os.path.isfile(mpv_path) and mpv_path.endswith('.exe'):
                return mpv_path
            else:
                print("Invalid path. Please ensure the path is correct and points to mpv.exe.")

def save_config(mpv_path):
    """Saves the configuration (like mpv path) to config.json."""
    config_data = {"mpv_path": mpv_path}
    with open(get_config_path(), 'w') as f:
        json.dump(config_data, f, indent=4)
    print(f"Configuration saved to {CONFIG_NAME}")

def install_windows(extension_id):
    """Installer for Windows. Finds mpv, creates manifest, and writes to registry."""
    import winreg

    mpv_path = find_mpv_windows()
    save_config(mpv_path)

    script_path = get_script_path()

    # --- Create a .bat wrapper for robustness ---
    # This ensures the correct python interpreter is used, regardless of file associations.
    python_executable = sys.executable
    wrapper_path = os.path.join(os.path.dirname(script_path), "run_native_host.bat")

    # The @echo off prevents the command from being printed to the console.
    # %* passes all command-line arguments from the browser to the python script.
    wrapper_content = f'@echo off\n"{python_executable}" "{script_path}" %*'

    with open(wrapper_path, 'w') as f:
        f.write(wrapper_content)
    print(f"Created wrapper script at: {wrapper_path}")

    manifest = {
        "name": HOST_NAME,
        "description": HOST_DESCRIPTION,
        "path": wrapper_path, # Point to the .bat wrapper
        "type": "stdio",
        # For Manifest V3, "allowed_origins" must be used instead of "allowed_extensions".
        # The format must include the protocol and a trailing slash.
        "allowed_origins": [f"chrome-extension://{extension_id}/"]
    }

    manifest_path = os.path.join(os.path.dirname(script_path), f"{HOST_NAME}.json")
    with open(manifest_path, 'w') as f:
        json.dump(manifest, f, indent=4)
    print(f"Native host manifest created at: {manifest_path}")

    # --- Register with browsers via Windows Registry ---
    browsers = {
        "Google Chrome": "SOFTWARE\\Google\\Chrome\\NativeMessagingHosts",
        "Mozilla Firefox": "SOFTWARE\\Mozilla\\NativeMessagingHosts", # For completeness
        "Brave": "SOFTWARE\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts",
        "Microsoft Edge": "SOFTWARE\\Microsoft\\Edge\\NativeMessagingHosts",
        "Chromium": "SOFTWARE\\Chromium\\NativeMessagingHosts",
    }

    for browser, reg_path in browsers.items():
        try:
            key_path = os.path.join(reg_path, HOST_NAME)
            key = winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_path)
            winreg.SetValue(key, '', winreg.REG_SZ, manifest_path)
            winreg.CloseKey(key)
            print(f"Successfully registered native host for {browser}.")
        except OSError as e:
            print(f"Could not register for {browser}. You may not have it installed. Error: {e}")

    print("\n[IMPORTANT] The native host has been registered using absolute paths.")
    print(f"Do NOT move or delete this folder: '{INSTALL_DIR}'")
    print("If you need to move it, please run this installer again from the new location.")

def install_linux_macos(is_mac, extension_id):
    """Installer for Linux and macOS. Checks for mpv, creates manifest, and places it in the correct directories."""
    print("Checking for mpv...")
    try:
        subprocess.run(['which', 'mpv'], check=True, capture_output=True)
        print("Found mpv in your system's PATH.")
    except (subprocess.CalledProcessError, FileNotFoundError):
        print("WARNING: 'mpv' command not found in your PATH. Please ensure it is installed and accessible.")

    script_path = get_script_path()
    # Make the script executable
    try:
        os.chmod(script_path, 0o755)
        print(f"Made {SCRIPT_NAME} executable.")
    except Exception as e:
        print(f"Could not make script executable: {e}")

    # --- Generate different manifests for Chrome-based and Firefox-based browsers ---
    chrome_manifest = {
        "name": HOST_NAME,
        "description": HOST_DESCRIPTION,
        "path": script_path,
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{extension_id}/"]
    }

    # Firefox uses a different key and format for the extension ID.
    firefox_manifest = {
        "name": HOST_NAME,
        "description": HOST_DESCRIPTION,
        "path": script_path,
        "type": "stdio",
        "allowed_extensions": [f"{extension_id}"]
    }

    if is_mac:
        base_path = os.path.expanduser("~/Library/Application Support/")
        # We map browser names to their path and the manifest type they need.
        browser_configs = {
            "Google Chrome": (os.path.join(base_path, "Google/Chrome/NativeMessagingHosts"), chrome_manifest),
            "Chromium": (os.path.join(base_path, "Chromium/NativeMessagingHosts"), chrome_manifest),
            "Brave": (os.path.join(base_path, "BraveSoftware/Brave-Browser/NativeMessagingHosts"), chrome_manifest),
            "Microsoft Edge": (os.path.join(base_path, "Microsoft Edge/NativeMessagingHosts"), chrome_manifest),
            "Mozilla Firefox": (os.path.join(base_path, "Mozilla/NativeMessagingHosts"), firefox_manifest),
        }
    else: # Linux
        base_path = os.path.expanduser("~/.config/")
        mozilla_base_path = os.path.expanduser("~/.mozilla/")
        browser_configs = {
            "Google Chrome": (os.path.join(base_path, "google-chrome/NativeMessagingHosts"), chrome_manifest),
            "Chromium": (os.path.join(base_path, "chromium/NativeMessagingHosts"), chrome_manifest),
            "Brave": (os.path.join(base_path, "BraveSoftware/Brave-Browser/NativeMessagingHosts"), chrome_manifest),
            "Microsoft Edge": (os.path.join(base_path, "microsoft-edge/NativeMessagingHosts"), chrome_manifest),
            "Mozilla Firefox": (os.path.join(mozilla_base_path, "native-messaging-hosts"), firefox_manifest),
        }

    for browser, (path, manifest_to_use) in browser_configs.items():
        if os.path.isdir(os.path.dirname(path)):
            try:
                os.makedirs(path, exist_ok=True)
                manifest_path = os.path.join(path, f"{HOST_NAME}.json")
                with open(manifest_path, 'w') as f:
                    json.dump(manifest_to_use, f, indent=4)
                print(f"Successfully installed manifest for {browser}.")
            except Exception as e:
                print(f"Failed to install for {browser}. Error: {e}")
        else:
            print(f"Skipping {browser} (directory not found).")

    print("\n[IMPORTANT] The native host manifest now points to the script in this folder.")
    print(f"Do NOT move or delete this folder: '{INSTALL_DIR}'")
    print("If you need to move it, please run this installer again from the new location.")

def main():
    """Main function to run the installer."""
    print("--- MPV Playlist Organizer Native Host Installer ---")
    print("This script will install the necessary files for the browser extension to communicate with MPV.")

    print("\n[!!!] PLEASE READ CAREFULLY [!!!]")
    print("1. Ensure you have extracted all files from any ZIP archive.")
    print("2. Place this folder in a PERMANENT location (e.g., your Documents folder).")
    print("The installation will fail if you move or delete this folder later.")
    confirm = input("\n> Type 'yes' to confirm you understand and wish to continue: ").strip().lower()
    if confirm != 'yes':
        print("\nInstallation aborted. Please move the folder to a permanent location and run this script again.")
        sys.exit(0)

    # --- Get Extension ID ---
    print("\nFirst, we need the extension's ID for your browser.")
    print("For Chrome/Edge/Brave: Go to your extensions page (e.g., chrome://extensions), enable 'Developer mode', and copy the ID.")
    print("For Firefox: Go to about:debugging, click 'This Firefox', find the extension, and copy its 'Internal UUID' or 'ID'.")
    extension_id = input("Please enter your extension ID: ").strip()

    # A simple check is enough, as IDs can have very different formats between browsers.
    if not extension_id:
        print("Extension ID cannot be empty. Installation aborted.")
        sys.exit(1)

    # --- Run Platform-Specific Installer ---
    current_platform = platform.system()
    if current_platform == 'Windows':
        print("\nDetected Windows OS.")
        install_windows(extension_id)
    elif current_platform == 'Darwin':
        print("\nDetected macOS.")
        install_linux_macos(is_mac=True, extension_id=extension_id)
    elif current_platform == 'Linux':
        print("\nDetected Linux OS.")
        install_linux_macos(is_mac=False, extension_id=extension_id)
    else:
        print(f"Unsupported platform: {current_platform}")
        sys.exit(1)

    print("\n--- Installation Finished! ---")
    print("The final and most important step is to RESTART your browser completely.")
    print("(Close all browser windows and ensure it's not running in the background).")

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"\nAn unexpected error occurred: {e}")
    finally:
        # Keep the console open on Windows if run by double-clicking
        if platform.system() == "Windows":
            input("Press Enter to exit.")
