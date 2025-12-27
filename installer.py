#!/usr/bin/env python3
import sys
import os

os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
sys.dont_write_bytecode = True

import re
# --- Windows Console Hiding Logic ---
# This block checks if the script is running on Windows with the standard 'python.exe'
# interpreter. If so, it re-launches itself using 'pythonw.exe' (the windowless version)
# and exits. This prevents a console window from appearing behind the GUI.
if sys.platform == "win32" and sys.executable.endswith("python.exe"):
    import subprocess
    # Re-launch with pythonw.exe and pass along any command-line arguments.
    subprocess.Popen([sys.executable.replace("python.exe", "pythonw.exe"), __file__] + sys.argv[1:])
    sys.exit(0)

import json
import subprocess
import shutil
import platform
import threading
import queue
import services
import file_io

# --- GUI Imports ---
try:
    import tkinter as tk
    from tkinter import ttk, scrolledtext, messagebox, filedialog
except ImportError:
    print("Tkinter is not installed. Please install it to run the GUI installer.", file=sys.stderr)
    sys.exit(1)

# --- Platform-specific imports ---
if platform.system() == "Windows":
    import winreg

# --- Configuration (merged from config.py) ---
HOST_NAME = "com.mpv_playlist_organizer.handler"
HOST_DESCRIPTION = "MPV Playlist Organizer Native Host"
SCRIPT_NAME = "native_host.py"
INSTALL_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(INSTALL_DIR, "data")
CONFIG_FILE = os.path.join(DATA_DIR, "config.json")

# --- Templates ---

class InstallerLogic:
    """Abstract base class for platform-specific installer logic."""
    def __init__(self, logger_func):
        self.log = logger_func

    def install(self, extension_id, create_bypass, browser_for_bypass, enable_youtube_bypass):
        raise NotImplementedError

    def uninstall(self):
        raise NotImplementedError

    def install_cli(self):
        raise NotImplementedError

    def add_to_path(self):
        raise NotImplementedError

    def check_dependencies(self):
        """Returns a list of warning messages if dependencies are missing."""
        warnings = []
        # Use shared logic from services
        status = services.check_mpv_and_ytdlp_status(file_io.get_mpv_executable, lambda msg: None)

        if not status['ytdlp']['found']:
            warnings.append(f"'{status['ytdlp']['error']}'\nBypass scripts will not work without it.")
        else:
            self.log("yt-dlp found in PATH.")

        if not status['mpv']['found']:
            warnings.append(f"'{status['mpv']['error']}'\nPlayback will fail unless you select the executable manually.")
        else:
            self.log("mpv found in PATH.")
            
        return warnings

    def run_diagnostics(self, browser):
        """Runs diagnostics and returns (result_text, has_critical_error)."""
        results = []
        has_critical_error = False

        # Use shared logic from services
        status = services.check_mpv_and_ytdlp_status(file_io.get_mpv_executable, lambda msg: None)

        # 1. Check yt-dlp
        if status['ytdlp']['found']:
            ver = status['ytdlp'].get('version', 'Unknown')
            results.append(f"✅ yt-dlp found: {ver}")
        else:
            results.append(f"❌ yt-dlp NOT found in PATH")
            has_critical_error = True

        # 2. Check mpv
        if status['mpv']['found']:
            results.append(f"✅ mpv found at: {status['mpv']['path']}")
        else:
            results.append(f"❌ mpv NOT found in PATH")
            has_critical_error = True

        # 3. Check ffmpeg
        ffmpeg_exe = "ffmpeg.exe" if platform.system() == "Windows" else "ffmpeg"
        if shutil.which(ffmpeg_exe):
            results.append(f"✅ ffmpeg found")
        else:
            results.append(f"⚠️ ffmpeg not found (recommended)")

        # 4. Check Cookies
        if status['ytdlp']['found'] and browser:
            try:
                cmd = [status['ytdlp']['path'], "--cookies-from-browser", browser, "--simulate", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"]
                startupinfo = None
                if platform.system() == "Windows":
                    startupinfo = subprocess.STARTUPINFO()
                    startupinfo.dwFlags |= subprocess.STARTF_USESTDHANDLES | subprocess.STARTF_USESHOWWINDOW
                    startupinfo.wShowWindow = subprocess.SW_HIDE

                proc = subprocess.run(cmd, capture_output=True, text=True, startupinfo=startupinfo)
                
                if proc.returncode == 0:
                    results.append(f"✅ Cookie access successful for {browser}")
                else:
                    err = proc.stderr.strip()
                    msg = f"❌ Cookie access failed for {browser}"
                    if "lock" in err.lower() or "open" in err.lower():
                        msg += "\n   (Tip: Close the browser and try again)"
                    results.append(msg)
                    self.log(f"Cookie error: {err}")
                    has_critical_error = True
            except Exception as e:
                results.append(f"❌ Cookie test error: {e}")
                has_critical_error = True
        elif not browser:
            results.append(f"⚠️ No browser selected for cookie test")

        return "\n".join(results), has_critical_error

class WindowsLogic(InstallerLogic):
    def get_browser_configs(self):
        manifest_path = os.path.join(DATA_DIR, f"{HOST_NAME}-chrome.json")
        return {
            "Google Chrome": ("SOFTWARE\\Google\\Chrome\\NativeMessagingHosts", manifest_path),
            "Brave": ("SOFTWARE\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts", manifest_path),
            "Microsoft Edge": ("SOFTWARE\\Microsoft\\Edge\\NativeMessagingHosts", manifest_path),
            "Chromium": ("SOFTWARE\\Chromium\\NativeMessagingHosts", manifest_path),
        }

    def install(self, extension_id, create_bypass, browser_for_bypass, enable_youtube_bypass):
        self.log("Detected Windows OS.")
        
        # 1. Find mpv.exe
        self.log("Searching for mpv.exe...")
        mpv_path = shutil.which('mpv.exe')
        if not mpv_path:
            self.log("mpv.exe not found in PATH. Please select it manually.")
            # Note: File dialogs must be run on main thread. 
            # For simplicity in this refactor, we assume PATH or fail, 
            # or the caller handles the UI interaction before calling install.
            # Ideally, we'd pass a callback or handle this in the UI layer.
            # Falling back to a hard error here for safety in thread.
            raise FileNotFoundError("mpv.exe not found in PATH. Please add it to PATH or implement manual selection.")
        
        self.log(f"Found mpv.exe at: {mpv_path}")

        # 2. Save config
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(CONFIG_FILE, 'w') as f:
            json.dump({"mpv_path": mpv_path}, f, indent=4)
        self.log(f"Configuration saved to data/config.json")

        # 3. Create Bypass Script
        if create_bypass:
            self._create_bypass_script(browser_for_bypass, enable_youtube_bypass)

        # 4. Create .bat wrapper
        script_path = os.path.join(INSTALL_DIR, SCRIPT_NAME)
        python_executable = sys.executable.replace("pythonw.exe", "python.exe")
        wrapper_path = os.path.join(INSTALL_DIR, "run_native_host.bat")
        with open(wrapper_path, 'w') as f:
            f.write(f'@echo off\nset PYTHONDONTWRITEBYTECODE=1\n"{python_executable}" "%~dp0{SCRIPT_NAME}" %*')
        self.log(f"Created wrapper script: run_native_host.bat")

        # 5. Create Manifest
        manifest_path = os.path.join(DATA_DIR, f"{HOST_NAME}-chrome.json")
        chrome_manifest = {
            "name": HOST_NAME,
            "description": HOST_DESCRIPTION,
            "path": wrapper_path,
            "type": "stdio",
            "allowed_origins": [f"chrome-extension://{extension_id}/"]
        }
        with open(manifest_path, 'w') as f:
            json.dump(chrome_manifest, f, indent=4)
        self.log(f"Created manifest: {os.path.relpath(manifest_path, INSTALL_DIR)}")

        # 6. Register with browsers
        browsers = self.get_browser_configs()
        for browser, (reg_path, manifest_to_register) in browsers.items():
            try:
                key_path = os.path.join(reg_path, HOST_NAME)
                with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_path) as key:
                    winreg.SetValue(key, '', winreg.REG_SZ, manifest_path)
                self.log(f"Successfully registered for {browser}.")
            except OSError:
                self.log(f"Skipping {browser} (not installed or registry error).")

    def uninstall(self):
        self.log("Uninstalling for Windows...")
        browsers = self.get_browser_configs()
        for browser, (reg_path, _) in browsers.items():
            try:
                key_path = os.path.join(reg_path, HOST_NAME)
                winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key_path)
                self.log(f"Successfully unregistered from {browser}.")
            except FileNotFoundError:
                self.log(f"Not registered for {browser}.")
            except OSError as e:
                self.log(f"Could not unregister for {browser}: {e}")

        files_to_remove = [
            os.path.join(INSTALL_DIR, "run_native_host.bat"),
            os.path.join(DATA_DIR, f"{HOST_NAME}-chrome.json"),
            os.path.join(INSTALL_DIR, "mpv-cli.bat"),
            os.path.join(INSTALL_DIR, "play_with_bypass.bat"),
            os.path.join(INSTALL_DIR, "utils", "_bypass_logic.py")
        ]
        for file_path in files_to_remove:
            if os.path.exists(file_path):
                os.remove(file_path)
                self.log(f"Removed: {os.path.basename(file_path)}")

    def install_cli(self):
        script_path = os.path.join(INSTALL_DIR, SCRIPT_NAME)
        wrapper_path = os.path.join(INSTALL_DIR, "mpv-cli.bat")
        with open(wrapper_path, 'w') as f:
            f.write('@echo off\n')
            f.write('set PYTHONDONTWRITEBYTECODE=1\n')
            f.write(f'python3 "{script_path}" %*\n')
        self.log(f"Created Windows CLI wrapper: mpv-cli.bat")

    def add_to_path(self):
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, 'Environment', 0, winreg.KEY_READ | winreg.KEY_WRITE) as key:
                current_path, _ = winreg.QueryValueEx(key, 'Path')
                if INSTALL_DIR in current_path.split(';'):
                    return "Directory is already in the user PATH."

                new_path = f"{current_path};{INSTALL_DIR}"
                winreg.SetValueEx(key, 'Path', 0, winreg.REG_EXPAND_SZ, new_path)
                self.log("Successfully added directory to user PATH in registry.")
                return "Success"
        except FileNotFoundError:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, 'Environment', 0, winreg.KEY_WRITE) as key:
                winreg.SetValueEx(key, 'Path', 0, winreg.REG_EXPAND_SZ, INSTALL_DIR)
            return "Success"
        except Exception as e:
            raise e

    def _create_bypass_script(self, browser_name, enable_youtube_bypass):
        self.log(f"Generating bypass script for '{browser_name}'...")
        python_executable = sys.executable.replace("pythonw.exe", "python.exe")
        bypass_logic_script = os.path.join(INSTALL_DIR, "utils", "_bypass_logic.py")
        
        youtube_enabled_str = "true" if enable_youtube_bypass else "false"

        content = f"""@echo off
setlocal enabledelayedexpansion
:: Auto-generated bypass script
:: This script uses the Python helper _bypass_logic.py to process URLs.

:: Check for arguments
if "%~1"=="" (
    echo {{"error": "Usage: %0 ^<URL^>"}} >&2
    exit /b 1
)

set "URL=%~1"
set "BROWSER={browser_name}"
set "YOUTUBE_ENABLED={youtube_enabled_str}"
set "PYTHON_EXE={python_executable}"
set "BYPASS_SCRIPT={bypass_logic_script}"

:: Execute the Python bypass logic script
:: It prints JSON output to stdout.
"%PYTHON_EXE%" "%BYPASS_SCRIPT%" "%URL%" "%BROWSER%" "%YOUTUBE_ENABLED%"
if !errorlevel! neq 0 (
    echo An error occurred during bypass script execution. >&2
    exit /b !errorlevel!
)
"""
        path = os.path.join(INSTALL_DIR, "play_with_bypass.bat")
        with open(path, 'w', newline='\n') as f:
            f.write(content)
        self.log("Created play_with_bypass.bat")

class UnixLogic(InstallerLogic):
    """Shared logic for Linux and macOS."""
    def get_browser_configs(self):
        raise NotImplementedError

    def install(self, extension_id, create_bypass, browser_for_bypass, enable_youtube_bypass):
        self.log(f"Detected {platform.system()} OS.")
        
        # 1. Check mpv
        mpv_path = shutil.which('mpv')
        if not mpv_path:
            self.log("WARNING: mpv not found in PATH. Playback may fail.")
            mpv_path = "mpv"
        else:
            self.log(f"Found mpv at: {mpv_path}")

        # 2. Save config
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(CONFIG_FILE, 'w') as f:
            json.dump({"mpv_path": mpv_path}, f, indent=4)

        # 3. Make script executable
        script_path = os.path.join(INSTALL_DIR, SCRIPT_NAME)
        os.chmod(script_path, 0o755)

        # 4. Create Bypass Script
        if create_bypass:
            self._create_bypass_script(browser_for_bypass, enable_youtube_bypass)

        # 5. Create Shell Wrapper
        wrapper_path = os.path.join(INSTALL_DIR, "run_native_host.sh")
        with open(wrapper_path, 'w') as f:
            f.write("#!/bin/sh\n")
            f.write("export PYTHONDONTWRITEBYTECODE=1\n\n")
            f.write(f'"{sys.executable}" "$(dirname "$0")/{SCRIPT_NAME}" "$@"')
        os.chmod(wrapper_path, 0o755)
        self.log("Created executable wrapper: run_native_host.sh")

        # 6. Create Portable Manifest
        manifest_path = os.path.join(DATA_DIR, f"{HOST_NAME}.json")
        chrome_manifest = {
            "name": HOST_NAME, "description": HOST_DESCRIPTION, "path": wrapper_path, "type": "stdio",
            "allowed_origins": [f"chrome-extension://{extension_id}/"]
        }
        with open(manifest_path, 'w') as f:
            json.dump(chrome_manifest, f, indent=4)
        self.log(f"Created manifest: {os.path.relpath(manifest_path, INSTALL_DIR)}")

        # 7. Symlink Manifest
        browser_paths = self.get_browser_configs()
        for browser, path in browser_paths.items():
            if os.path.isdir(os.path.dirname(path)):
                try:
                    os.makedirs(path, exist_ok=True)
                    symlink_target = os.path.join(path, f"{HOST_NAME}.json")
                    if os.path.lexists(symlink_target):
                        os.remove(symlink_target)
                    os.symlink(manifest_path, symlink_target)
                    self.log(f"Linked manifest for {browser}.")
                except Exception as e:
                    self.log(f"Failed to link for {browser}: {e}")
            else:
                self.log(f"Skipping {browser} (directory not found).")

    def uninstall(self):
        self.log(f"Uninstalling for {platform.system()}...")
        browser_paths = self.get_browser_configs()
        symlink_filename = f"{HOST_NAME}.json"
        for browser, path in browser_paths.items():
            symlink_path = os.path.join(path, symlink_filename)
            if os.path.lexists(symlink_path):
                try:
                    os.remove(symlink_path)
                    self.log(f"Removed manifest link for {browser}.")
                except OSError as e:
                    self.log(f"Failed to remove link for {browser}: {e}")

        files_to_remove = [
            os.path.join(DATA_DIR, f"{HOST_NAME}.json"),
            os.path.join(INSTALL_DIR, "run_native_host.sh"),
            os.path.join(INSTALL_DIR, "mpv-cli"),
            os.path.join(INSTALL_DIR, "play_with_bypass.sh"),
            os.path.join(INSTALL_DIR, "utils", "_bypass_logic.py")
        ]
        for file_path in files_to_remove:
            if os.path.exists(file_path):
                os.remove(file_path)
                self.log(f"Removed: {os.path.basename(file_path)}")

    def install_cli(self):
        script_path = os.path.join(INSTALL_DIR, SCRIPT_NAME)
        wrapper_path = os.path.join(INSTALL_DIR, "mpv-cli")
        with open(wrapper_path, 'w') as f:
            f.write("#!/bin/sh\n")
            f.write("export PYTHONDONTWRITEBYTECODE=1\n")
            f.write(f'python3 "{script_path}" "$@"\n')
        os.chmod(wrapper_path, 0o755)
        self.log(f"Created executable Unix CLI wrapper: mpv-cli")

    def add_to_path(self):
        return "Manual"

    def _create_bypass_script(self, browser_name, enable_youtube_bypass):
        self.log(f"Generating bypass script for '{browser_name}'...")
        python_executable = sys.executable # For Unix, sys.executable is usually python3
        bypass_logic_script = os.path.join(INSTALL_DIR, "utils", "_bypass_logic.py")
        
        youtube_enabled_str = "true" if enable_youtube_bypass else "false"

        content = f"""#!/bin/bash
# Auto-generated bypass script
# This script uses the Python helper _bypass_logic.py to process URLs.

# Check for arguments
if [ -z "$1" ]; then
  echo "{{\\"error\\": \\"Usage: $0 <URL>\\"}}" >&2
  exit 1
fi

URL="$1"
BROWSER="{browser_name}"
YOUTUBE_ENABLED="{youtube_enabled_str}"
PYTHON_EXE="{python_executable}"
BYPASS_SCRIPT="{bypass_logic_script}"

# Execute the Python bypass logic script
# It prints JSON output to stdout.
"$PYTHON_EXE" "$BYPASS_SCRIPT" "$URL" "$BROWSER" "$YOUTUBE_ENABLED"
if [ $? -ne 0 ]; then
    echo "An error occurred during bypass script execution." >&2
    exit 1
fi
"""
        path = os.path.join(INSTALL_DIR, "play_with_bypass.sh")
        with open(path, 'w', newline='\n') as f:
            f.write(content)
        os.chmod(path, 0o755)
        self.log("Created play_with_bypass.sh")

class MacOSLogic(UnixLogic):
    def get_browser_configs(self):
        base_path = os.path.expanduser("~/Library/Application Support/")
        return {
            "Google Chrome": os.path.join(base_path, "Google/Chrome/NativeMessagingHosts"),
            "Chromium": os.path.join(base_path, "Chromium/NativeMessagingHosts"),
            "Brave": os.path.join(base_path, "BraveSoftware/Brave-Browser/NativeMessagingHosts"),
            "Microsoft Edge": os.path.join(base_path, "Microsoft Edge/NativeMessagingHosts"),
        }

class LinuxLogic(UnixLogic):
    def get_browser_configs(self):
        base_path = os.path.expanduser("~/.config/")
        return {
            "Google Chrome": os.path.join(base_path, "google-chrome/NativeMessagingHosts"),
            "Chromium": os.path.join(base_path, "chromium/NativeMessagingHosts"),
            "Brave": os.path.join(base_path, "BraveSoftware/Brave-Browser/NativeMessagingHosts"),
            "Microsoft Edge": os.path.join(base_path, "microsoft-edge/NativeMessagingHosts"),
        }

# --- Tooltip Class for detailed explanations ---
class Tooltip:
    """
    Creates a tooltip for a given widget.
    """
    def __init__(self, widget, text):
        self.widget = widget
        self.text = text
        self.tooltip_window = None
        self.widget.bind("<Enter>", self.show_tooltip)
        self.widget.bind("<Leave>", self.hide_tooltip)

    def show_tooltip(self, event=None):
        # Don't show tooltip if the widget is disabled
        if str(self.widget['state']) == 'disabled':
            return
            
        x, y, _, _ = self.widget.bbox("insert")
        x += self.widget.winfo_rootx() + 25
        y += self.widget.winfo_rooty() + 25

        self.tooltip_window = tw = tk.Toplevel(self.widget)
        tw.wm_overrideredirect(True)
        tw.wm_geometry(f"+{x}+{y}")

        label = tk.Label(tw, text=self.text, justify=tk.LEFT,
                         background="#ffffe0", relief=tk.SOLID, borderwidth=1,
                         font=("Segoe UI", 9, "normal"))
        label.pack(ipadx=4, ipady=2)

    def hide_tooltip(self, event=None):
        if self.tooltip_window:
            self.tooltip_window.destroy()
        self.tooltip_window = None

# --- GUI Application Class ---
class HostManagerApp:
    def __init__(self, root):
        self.root = root
        self.root.title("MPV Playlist Organizer - Host Manager")
        self.log_queue = queue.Queue()
        
        self._setup_ui()
        
        self.root.resizable(False, False)

        # --- Center the window on the screen ---
        window_width = 600
        window_height = 500
        # Get screen dimensions
        screen_width = self.root.winfo_screenwidth()
        screen_height = self.root.winfo_screenheight()
        # Calculate position x, y
        center_x = int(screen_width / 2 - window_width / 2)
        center_y = int(screen_height / 2 - window_height / 2)
        self.root.geometry(f'{window_width}x{window_height}+{center_x}+{center_y}')

        # --- Initialize Logic ---
        self.logic = self._get_logic_strategy()
        
        # --- Start Log Poller ---
        self.root.after(100, self._process_log_queue)
        
        # --- Initial Dependency Check ---
        self.root.after(200, self._check_dependencies_async)

    def _get_logic_strategy(self):
        system = platform.system()
        if system == "Windows":
            return WindowsLogic(self.log)
        elif system == "Linux":
            return LinuxLogic(self.log)
        elif system == "Darwin":
            return MacOSLogic(self.log)
        else:
            self.log(f"Unsupported platform: {system}")
            return UnixLogic(self.log) # Fallback

    def _setup_ui(self):
        # --- Styles ---
        bg_color = "#f8f9fa"
        self.root.configure(bg=bg_color)

        style = ttk.Style()
        style.theme_use('clam')
        
        style.configure(".", background=bg_color, font=("Segoe UI", 10))
        style.configure("TFrame", background=bg_color)
        style.configure("TLabel", background=bg_color)
        style.configure("TCheckbutton", background=bg_color)
        
        style.configure("TButton", padding=8, relief="flat", background="#5865f2", foreground="white", borderwidth=0)
        style.map("TButton", background=[('active', '#4f5bda'), ('disabled', '#cccccc')])
        
        style.configure("Uninstall.TButton", background="#ed4245")
        style.map("Uninstall.TButton", background=[('active', '#da3739')])
        
        style.configure("Header.TLabel", font=("Segoe UI", 16, "bold"), foreground="#2c2f33")

        # --- Main Frame ---
        main_frame = ttk.Frame(self.root, padding="25")
        main_frame.pack(fill=tk.BOTH, expand=True)

        # --- Header ---
        ttk.Label(main_frame, text="MPV Playlist Organizer", style="Header.TLabel").pack(pady=(0, 20))

        # --- Settings Frame (using Grid layout for alignment) ---
        settings_frame = ttk.Frame(main_frame)
        settings_frame.pack(fill=tk.X, pady=(0, 10))
        settings_frame.columnconfigure(1, weight=1) # Make the input column expandable

        # --- Row 0: Extension ID ---
        ttk.Label(settings_frame, text="Extension ID:", font=("Segoe UI", 10, "bold")).grid(row=0, column=0, sticky=tk.W, pady=4)
        self.extension_id_var = tk.StringVar()
        self.extension_id_entry = ttk.Entry(settings_frame, textvariable=self.extension_id_var, font=("Segoe UI", 10))
        self.extension_id_entry.grid(row=0, column=1, sticky="ew", padx=(10, 0))

        # --- Row 1: AnimePahe Bypass Script Option ---
        bypass_label = ttk.Label(settings_frame, text="Create Bypass Script:", font=("Segoe UI", 10, "bold"))
        bypass_label.grid(row=1, column=0, sticky=tk.W, pady=4)
        
        self.create_bypass_var = tk.BooleanVar(value=True)
        self.bypass_checkbutton = ttk.Checkbutton(
            settings_frame,
            variable=self.create_bypass_var
        )
        self.bypass_checkbutton.grid(row=1, column=1, sticky=tk.W, padx=(10, 0))
        
        tooltip_text = (
            "If checked, creates a 'play_with_bypass' script.\n\n"
            "This script uses yt-dlp to resolve certain stream URLs (e.g., AnimePahe),\n"
            "allowing direct playback in MPV by bypassing site restrictions.\n"
            "Requires a selected browser below for cookie access."
        )
        Tooltip(bypass_label, tooltip_text)
        Tooltip(self.bypass_checkbutton, tooltip_text)

        # --- Row 2: YouTube Bypass Script Option ---
        yt_bypass_label = ttk.Label(settings_frame, text="Enable YouTube Bypass:", font=("Segoe UI", 10, "bold"))
        yt_bypass_label.grid(row=2, column=0, sticky=tk.W, pady=4)
        
        self.enable_youtube_bypass_var = tk.BooleanVar(value=True)
        self.yt_bypass_checkbutton = ttk.Checkbutton(
            settings_frame,
            variable=self.enable_youtube_bypass_var
        )
        self.yt_bypass_checkbutton.grid(row=2, column=1, sticky=tk.W, padx=(10, 0))

        yt_tooltip_text = (
            "If checked, the bypass script will also support YouTube URLs.\n\n"
            "This uses your browser cookies to access logged-in features like\n"
            "subscriptions, private videos, and ensures videos are marked as watched\n"
            "in your YouTube history after playback."
        )
        Tooltip(yt_bypass_label, yt_tooltip_text)
        Tooltip(self.yt_bypass_checkbutton, yt_tooltip_text)

        # --- Row 3: Browser for Bypass Script ---
        browser_label = ttk.Label(settings_frame, text="Browser for Bypass:", font=("Segoe UI", 10, "bold"))
        browser_label.grid(row=3, column=0, sticky=tk.W, pady=4)

        browser_input_frame = ttk.Frame(settings_frame)
        browser_input_frame.grid(row=3, column=1, sticky="ew", padx=(10, 0))
        browser_input_frame.columnconfigure(0, weight=1)

        self.browser_var = tk.StringVar()
        self.browser_combobox = ttk.Combobox(browser_input_frame, textvariable=self.browser_var, state="readonly", font=("Segoe UI", 10))
        self.browser_combobox['values'] = ('brave', 'chrome', 'firefox', 'edge', 'vivaldi', 'opera')
        self.browser_combobox.grid(row=0, column=0, sticky="ew")

        self.diagnostics_btn = ttk.Button(browser_input_frame, text="Run Diagnostics", command=self.run_diagnostics)
        self.diagnostics_btn.grid(row=0, column=1, sticky=tk.E, padx=(5, 0))

        # --- Connect Toggle Function ---
        def toggle_bypass_widgets():
            state = tk.NORMAL if self.create_bypass_var.get() else tk.DISABLED
            self.browser_combobox.config(state="readonly" if self.create_bypass_var.get() else "disabled")
            self.diagnostics_btn.config(state=state)
            self.yt_bypass_checkbutton.config(state=state)
            # Also toggle the labels' appearance to indicate they're disabled
            browser_label.config(state=state)
            yt_bypass_label.config(state=state)

        self.bypass_checkbutton.config(command=toggle_bypass_widgets)

        # --- Attempt to load previous Extension ID ---
        # We read the previously created manifest file to pre-fill the extension ID field.
        # The filename depends on the operating system.
        if platform.system() == "Windows":
            manifest_filename = f"{HOST_NAME}-chrome.json"
        else: # Linux/macOS
            manifest_filename = f"{HOST_NAME}.json"

        manifest_file_path = os.path.join(DATA_DIR, manifest_filename)
        if os.path.exists(manifest_file_path):
            try:
                with open(manifest_file_path, 'r', encoding='utf-8') as f:
                    manifest_data = json.load(f)
                allowed_origins = manifest_data.get("allowed_origins")
                if allowed_origins and len(allowed_origins) > 0:
                    # Extract ID from "chrome-extension://{id}/"
                    ext_id = allowed_origins[0].replace("chrome-extension://", "").replace("/", "")
                    self.extension_id_var.set(ext_id)
            except (IOError, json.JSONDecodeError, AttributeError, IndexError) as e:
                self.log(f"WARNING: Could not read previous Extension ID from manifest file: {e}")

        # --- Buttons ---
        button_frame = ttk.Frame(main_frame)
        button_frame.pack(fill=tk.X, pady=10)
        self.install_button = ttk.Button(button_frame, text="Install", command=self.run_install)
        self.install_button.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=(0, 5))
        self.uninstall_button = ttk.Button(button_frame, text="Uninstall", style="Uninstall.TButton", command=self.run_uninstall)
        self.uninstall_button.pack(side=tk.RIGHT, fill=tk.X, expand=True, padx=(5, 0))

        # --- CLI Wrapper Button ---
        cli_button_frame = ttk.Frame(main_frame)
        cli_button_frame.pack(fill=tk.X, pady=5)
        self.cli_button = ttk.Button(cli_button_frame, text="Install CLI Wrapper (mpv-cli)", command=self.run_install_cli)
        self.cli_button.pack(fill=tk.X, expand=True)

        # --- Add to PATH Button ---
        path_button_frame = ttk.Frame(main_frame)
        path_button_frame.pack(fill=tk.X, pady=(0, 5))
        self.path_button = ttk.Button(path_button_frame, text="Add Folder to User PATH", command=self.run_add_to_path)
        self.path_button.pack(fill=tk.X, expand=True)
        # --- Log Area ---
        ttk.Label(main_frame, text="Log Output:", font=("Segoe UI", 10, "bold")).pack(anchor=tk.W, pady=(10, 5))
        self.log_area = scrolledtext.ScrolledText(main_frame, wrap=tk.WORD, height=10, font=("Consolas", 9), relief="flat", borderwidth=1)
        self.log_area.pack(fill=tk.BOTH, expand=True)
        self.log_area.configure(state='disabled')
        
        # Load prefs
        self._load_installer_prefs()

    def _process_log_queue(self):
        try:
            while True:
                msg = self.log_queue.get_nowait()
                self.log_area.configure(state='normal')
                self.log_area.insert(tk.END, msg + "\n")
                self.log_area.configure(state='disabled')
                self.log_area.see(tk.END)
        except queue.Empty:
            pass
        self.root.after(100, self._process_log_queue)

    def log(self, message):
        self.log_queue.put(message)

    def run_install(self):
        extension_id = self.extension_id_var.get().strip()
        if not extension_id:
            messagebox.showerror("Error", "Extension ID cannot be empty.")
            return
        
        # Basic validation for Chrome extension ID format (32 lowercase alpha characters)
        if not re.match(r"^[a-z]{32}$", extension_id):
            if not messagebox.askyesno("Warning", "The Extension ID doesn't look like a standard Chrome extension ID (32 lowercase letters).\n\nAre you sure you want to proceed?"):
                return

        self.install_button.config(state=tk.DISABLED)
        self.uninstall_button.config(state=tk.DISABLED)
        self.cli_button.config(state=tk.DISABLED)
        self.browser_combobox.config(state=tk.DISABLED)
        
        # Run in a separate thread to keep the GUI responsive
        threading.Thread(target=self._install_thread, args=(extension_id,)).start()

    def run_uninstall(self):
        if not messagebox.askyesno("Confirm Uninstall", "Are you sure you want to uninstall the native host?"):
            return

        self.install_button.config(state=tk.DISABLED)
        self.uninstall_button.config(state=tk.DISABLED)
        self.cli_button.config(state=tk.DISABLED)
        self.browser_combobox.config(state=tk.DISABLED)

        threading.Thread(target=self._uninstall_thread).start()

    def run_install_cli(self):
        """Disables buttons and starts the CLI wrapper installation in a new thread."""
        self.install_button.config(state=tk.DISABLED)
        self.uninstall_button.config(state=tk.DISABLED)
        self.cli_button.config(state=tk.DISABLED)
        self.path_button.config(state=tk.DISABLED)
        self.browser_combobox.config(state=tk.DISABLED)

        # Run in a separate thread to keep the GUI responsive
        threading.Thread(target=self._install_cli_thread).start()

    def run_add_to_path(self):
        """Disables buttons and starts the 'add to PATH' logic in a new thread."""
        self.install_button.config(state=tk.DISABLED)
        self.uninstall_button.config(state=tk.DISABLED)
        self.cli_button.config(state=tk.DISABLED)
        self.path_button.config(state=tk.DISABLED)
        self.browser_combobox.config(state=tk.DISABLED)

        threading.Thread(target=self._add_to_path_thread).start()

    def _check_dependencies_async(self):
        threading.Thread(target=self._check_dependencies_thread, daemon=True).start()

    def _check_dependencies_thread(self):
        warnings = self.logic.check_dependencies()
        for w in warnings:
            self.log(f"WARNING: {w.splitlines()[0]}")
            self.root.after(0, lambda msg=w: messagebox.showwarning("Dependency Missing", msg))

    def run_diagnostics(self):
        """Runs a suite of diagnostic tests including dependency checks and cookie access."""
        browser = self.browser_var.get()
        
        self.install_button.config(state=tk.DISABLED) # Disable install while testing
        self.log(f"Starting diagnostics for '{browser}'...")
        
        def _test():
            report_text, has_critical_error = self.logic.run_diagnostics(browser)
            self.log("Diagnostics Results:\n" + report_text)
            
            title = "Diagnostics Failed" if has_critical_error else "Diagnostics Passed"
            
            self.root.after(0, lambda: messagebox.showinfo(title, report_text) if not has_critical_error else messagebox.showerror(title, report_text))
            self.root.after(0, lambda: self.install_button.config(state=tk.NORMAL))
        
        threading.Thread(target=_test, daemon=True).start()

    def _load_installer_prefs(self):
        """Loads installer preferences like the last selected browser."""
        prefs_file = os.path.join(DATA_DIR, "installer_prefs.json")
        default_browser = 'brave'
        if os.path.exists(prefs_file):
            try:
                with open(prefs_file, 'r', encoding='utf-8') as f:
                    prefs = json.load(f)
                last_browser = prefs.get('last_selected_browser')
                if last_browser in self.browser_combobox['values']:
                    self.browser_var.set(last_browser)
                    return # Success
            except (IOError, json.JSONDecodeError):
                # Fail silently on load error, will use default.
                pass
        
        self.browser_var.set(default_browser)

    def _save_installer_prefs(self):
        """Saves installer preferences to a file."""
        prefs_file = os.path.join(DATA_DIR, "installer_prefs.json")
        selected_browser = self.browser_var.get()
        prefs = {'last_selected_browser': selected_browser}
        try:
            os.makedirs(DATA_DIR, exist_ok=True)
            with open(prefs_file, 'w', encoding='utf-8') as f:
                json.dump(prefs, f, indent=4)
            self.log(f"Saved selected browser '{selected_browser}' for next time.")
        except Exception as e:
            self.log(f"ERROR: Could not save installer preferences: {e}")

    def _install_thread(self, extension_id):
        self.log("--- Starting Installation ---")
        try:
            # Save preferences before starting the main install process
            self._save_installer_prefs()

            # Get browser for bypass script and create the script if the user opted in.
            create_bypass = self.create_bypass_var.get()
            selected_browser = self.browser_var.get()
            enable_youtube = self.enable_youtube_bypass_var.get()

            self.logic.install(extension_id, create_bypass, selected_browser, enable_youtube)
            
            self.log("\n--- Installation Finished! ---")
            self.log("[IMPORTANT] You must now RESTART your browser completely for the changes to take effect.")
        except Exception as e:
            self.log(f"An unexpected error occurred: {e}")
        finally:
            self.install_button.config(state=tk.NORMAL)
            self.uninstall_button.config(state=tk.NORMAL)
            self.cli_button.config(state=tk.NORMAL)
            self.path_button.config(state=tk.NORMAL)
            self.browser_combobox.config(state="readonly")

    def _uninstall_thread(self):
        self.log("--- Starting Uninstallation ---")
        try:
            self.logic.uninstall()

            self.log("\n--- Uninstallation Finished! ---")
            self.log("You can now remove the extension from your browser and delete this folder.")
        except Exception as e:
            self.log(f"An unexpected error occurred: {e}")
        finally:
            self.install_button.config(state=tk.NORMAL)
            self.uninstall_button.config(state=tk.NORMAL)
            self.cli_button.config(state=tk.NORMAL)
            self.path_button.config(state=tk.NORMAL)
            self.browser_combobox.config(state="readonly")

    def _install_cli_thread(self):
        """The actual logic for creating the CLI wrapper, run in a thread."""
        self.log("--- Installing CLI Wrapper ---")
        try:
            self.logic.install_cli()

            self.log("\n--- CLI Wrapper Installation Finished! ---")
            self.log("Ensure this directory is in your system's PATH to use the command from anywhere.")
        except Exception as e:
            self.log(f"An unexpected error occurred during CLI wrapper installation: {e}")
        finally:
            self.install_button.config(state=tk.NORMAL)
            self.uninstall_button.config(state=tk.NORMAL)
            self.cli_button.config(state=tk.NORMAL)
            self.path_button.config(state=tk.NORMAL)
            self.browser_combobox.config(state="readonly")

    def _add_to_path_thread(self):
        """The actual logic for adding the install directory to the user's PATH."""
        self.log("--- Adding to User PATH ---")
        try:
            result = self.logic.add_to_path()
            if result == "Success":
                self.log("Successfully added directory to user PATH.")
                self.root.after(0, lambda: messagebox.showinfo("Success", "Directory added to user PATH. Please restart any open terminals."))
            elif result == "Manual":
                instruction_message = f"Please add the following line to your shell's startup file:\n\nexport PATH=\"$PATH:{INSTALL_DIR}\""
                self.root.after(0, lambda: messagebox.showinfo("Add to PATH Manually", instruction_message))
            else:
                self.log(result)

        except Exception as e:
            self.log(f"An unexpected error occurred while modifying PATH: {e}")
        finally:
            self.install_button.config(state=tk.NORMAL)
            self.uninstall_button.config(state=tk.NORMAL)
            self.cli_button.config(state=tk.NORMAL)
            self.path_button.config(state=tk.NORMAL)
            self.browser_combobox.config(state="readonly")

def main():
    root = tk.Tk()
    app = HostManagerApp(root)
    root.mainloop()

if __name__ == "__main__":
    main()