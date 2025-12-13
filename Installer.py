#!/usr/bin/env python3
import sys
import os

os.environ['PYTHONDONTWRITEBYTECODE'] = '1'

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

def get_browser_configs(is_mac):
    """Returns a dictionary of browser-specific paths for native messaging manifests."""
    if platform.system() == "Windows":
        manifest_path = os.path.join(DATA_DIR, f"{HOST_NAME}-chrome.json")
        return {
            "Google Chrome": ("SOFTWARE\\Google\\Chrome\\NativeMessagingHosts", manifest_path),
            "Brave": ("SOFTWARE\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts", manifest_path),
            "Microsoft Edge": ("SOFTWARE\\Microsoft\\Edge\\NativeMessagingHosts", manifest_path),
            "Chromium": ("SOFTWARE\\Chromium\\NativeMessagingHosts", manifest_path),
        }
    
    if is_mac:
        base_path = os.path.expanduser("~/Library/Application Support/")
        return {
            "Google Chrome": os.path.join(base_path, "Google/Chrome/NativeMessagingHosts"),
            "Chromium": os.path.join(base_path, "Chromium/NativeMessagingHosts"),
            "Brave": os.path.join(base_path, "BraveSoftware/Brave-Browser/NativeMessagingHosts"),
            "Microsoft Edge": os.path.join(base_path, "Microsoft Edge/NativeMessagingHosts"),
        }
    else: # Linux
        base_path = os.path.expanduser("~/.config/")
        return {
            "Google Chrome": os.path.join(base_path, "google-chrome/NativeMessagingHosts"),
            "Chromium": os.path.join(base_path, "chromium/NativeMessagingHosts"),
            "Brave": os.path.join(base_path, "BraveSoftware/Brave-Browser/NativeMessagingHosts"),
            "Microsoft Edge": os.path.join(base_path, "microsoft-edge/NativeMessagingHosts"),
        }

# --- GUI Application Class ---
class HostManagerApp:
    def __init__(self, root):
        self.root = root
        self.root.title("MPV Playlist Organizer - Host Manager")
        self.root.resizable(False, False)

        # --- Center the window on the screen ---
        window_width = 600
        window_height = 450
        # Get screen dimensions
        screen_width = self.root.winfo_screenwidth()
        screen_height = self.root.winfo_screenheight()
        # Calculate position x, y
        center_x = int(screen_width / 2 - window_width / 2)
        center_y = int(screen_height / 2 - window_height / 2)
        self.root.geometry(f'{window_width}x{window_height}+{center_x}+{center_y}')

        # --- Styles ---
        style = ttk.Style()
        style.theme_use('clam')
        style.configure("TButton", padding=6, relief="flat", background="#5865f2", foreground="white")
        style.map("TButton", background=[('active', '#4f5bda')])
        style.configure("Uninstall.TButton", background="#ed4245")
        style.map("Uninstall.TButton", background=[('active', '#da3739')])
        style.configure("TLabel", background="#f0f0f0", font=("Segoe UI", 10))
        style.configure("Header.TLabel", font=("Segoe UI", 12, "bold"))

        # --- Main Frame ---
        main_frame = ttk.Frame(root, padding="15")
        main_frame.pack(fill=tk.BOTH, expand=True)

        # --- Extension ID Input ---
        id_frame = ttk.Frame(main_frame)
        id_frame.pack(fill=tk.X, pady=(0, 10))
        ttk.Label(id_frame, text="Extension ID:", font=("Segoe UI", 10, "bold")).pack(side=tk.LEFT, padx=(0, 10))
        self.extension_id_var = tk.StringVar()
        self.extension_id_entry = ttk.Entry(id_frame, textvariable=self.extension_id_var, font=("Segoe UI", 10))
        self.extension_id_entry.pack(fill=tk.X, expand=True)

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
        self.log_area = scrolledtext.ScrolledText(main_frame, wrap=tk.WORD, height=10, font=("Consolas", 9))
        self.log_area.pack(fill=tk.BOTH, expand=True)
        self.log_area.configure(state='disabled')

    def log(self, message):
        self.log_area.configure(state='normal')
        self.log_area.insert(tk.END, message + "\n")
        self.log_area.configure(state='disabled')
        self.log_area.see(tk.END)
        self.root.update_idletasks()

    def run_install(self):
        extension_id = self.extension_id_var.get().strip()
        if not extension_id:
            messagebox.showerror("Error", "Extension ID cannot be empty.")
            return

        self.install_button.config(state=tk.DISABLED)
        self.uninstall_button.config(state=tk.DISABLED)
        self.cli_button.config(state=tk.DISABLED)
        
        # Run in a separate thread to keep the GUI responsive
        threading.Thread(target=self._install_thread, args=(extension_id,)).start()

    def run_uninstall(self):
        if not messagebox.askyesno("Confirm Uninstall", "Are you sure you want to uninstall the native host?"):
            return

        self.install_button.config(state=tk.DISABLED)
        self.uninstall_button.config(state=tk.DISABLED)
        self.cli_button.config(state=tk.DISABLED)

        threading.Thread(target=self._uninstall_thread).start()

    def run_install_cli(self):
        """Disables buttons and starts the CLI wrapper installation in a new thread."""
        self.install_button.config(state=tk.DISABLED)
        self.uninstall_button.config(state=tk.DISABLED)
        self.cli_button.config(state=tk.DISABLED)
        self.path_button.config(state=tk.DISABLED)

        # Run in a separate thread to keep the GUI responsive
        threading.Thread(target=self._install_cli_thread).start()

    def run_add_to_path(self):
        """Disables buttons and starts the 'add to PATH' logic in a new thread."""
        self.install_button.config(state=tk.DISABLED)
        self.uninstall_button.config(state=tk.DISABLED)
        self.cli_button.config(state=tk.DISABLED)
        self.path_button.config(state=tk.DISABLED)

        threading.Thread(target=self._add_to_path_thread).start()

    def _install_thread(self, extension_id):
        self.log("--- Starting Installation ---")
        try:
            current_platform = platform.system()
            if current_platform == 'Windows':
                self._install_windows(extension_id)
            elif current_platform in ['Linux', 'Darwin']:
                self._install_linux_macos(current_platform == 'Darwin', extension_id)
            else:
                self.log(f"ERROR: Unsupported platform: {current_platform}")
            
            self.log("\n--- Installation Finished! ---")
            self.log("[IMPORTANT] You must now RESTART your browser completely for the changes to take effect.")
        except Exception as e:
            self.log(f"An unexpected error occurred: {e}")
        finally:
            self.install_button.config(state=tk.NORMAL)
            self.uninstall_button.config(state=tk.NORMAL)
            self.cli_button.config(state=tk.NORMAL)
            self.path_button.config(state=tk.NORMAL)

    def _uninstall_thread(self):
        self.log("--- Starting Uninstallation ---")
        try:
            current_platform = platform.system()
            if current_platform == 'Windows':
                self._uninstall_windows()
            elif current_platform in ['Linux', 'Darwin']:
                self._uninstall_linux_macos(current_platform == 'Darwin')
            else:
                self.log(f"ERROR: Unsupported platform: {current_platform}")

            self.log("\n--- Uninstallation Finished! ---")
            self.log("You can now remove the extension from your browser and delete this folder.")
        except Exception as e:
            self.log(f"An unexpected error occurred: {e}")
        finally:
            self.install_button.config(state=tk.NORMAL)
            self.uninstall_button.config(state=tk.NORMAL)
            self.cli_button.config(state=tk.NORMAL)
            self.path_button.config(state=tk.NORMAL)

    def _install_cli_thread(self):
        """The actual logic for creating the CLI wrapper, run in a thread."""
        self.log("--- Installing CLI Wrapper ---")
        try:
            current_platform = platform.system()
            if current_platform == 'Windows':
                self._create_windows_cli_wrapper()
            elif current_platform in ['Linux', 'Darwin']:
                self._create_unix_cli_wrapper()
            else:
                self.log(f"ERROR: CLI wrapper not supported on platform: {current_platform}")

            self.log("\n--- CLI Wrapper Installation Finished! ---")
            self.log("Ensure this directory is in your system's PATH to use the command from anywhere.")
        except Exception as e:
            self.log(f"An unexpected error occurred during CLI wrapper installation: {e}")
        finally:
            self.install_button.config(state=tk.NORMAL)
            self.uninstall_button.config(state=tk.NORMAL)
            self.cli_button.config(state=tk.NORMAL)
            self.path_button.config(state=tk.NORMAL)

    def _add_to_path_thread(self):
        """The actual logic for adding the install directory to the user's PATH."""
        self.log("--- Adding to User PATH ---")
        try:
            current_platform = platform.system()
            if current_platform == 'Windows':
                self._add_to_path_windows()
            elif current_platform in ['Linux', 'Darwin']:
                self._add_to_path_unix()
            else:
                self.log(f"ERROR: Adding to PATH is not supported on platform: {current_platform}")

        except Exception as e:
            self.log(f"An unexpected error occurred while modifying PATH: {e}")
        finally:
            self.install_button.config(state=tk.NORMAL)
            self.uninstall_button.config(state=tk.NORMAL)
            self.cli_button.config(state=tk.NORMAL)
            self.path_button.config(state=tk.NORMAL)

    def _add_to_path_windows(self):
        """Adds the INSTALL_DIR to the user's PATH in the Windows Registry."""
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, 'Environment', 0, winreg.KEY_READ | winreg.KEY_WRITE) as key:
                current_path, _ = winreg.QueryValueEx(key, 'Path')
                if INSTALL_DIR in current_path.split(';'):
                    self.log("Directory is already in the user PATH.")
                    messagebox.showinfo("Already in PATH", f"The directory '{INSTALL_DIR}' is already in your user PATH.")
                    return

                new_path = f"{current_path};{INSTALL_DIR}"
                winreg.SetValueEx(key, 'Path', 0, winreg.REG_EXPAND_SZ, new_path)
                self.log("Successfully added directory to user PATH in registry.")
                self.log("You must restart any open command prompts or terminals for the change to take effect.")
                messagebox.showinfo("Success", "Directory added to user PATH. Please restart any open terminals to use the 'mpv-cli' command.")
        except FileNotFoundError:
            # This happens if the 'Path' value doesn't exist yet for the user.
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, 'Environment', 0, winreg.KEY_WRITE) as key:
                winreg.SetValueEx(key, 'Path', 0, winreg.REG_EXPAND_SZ, INSTALL_DIR)
            self.log("Created new user PATH and added directory.")
            messagebox.showinfo("Success", "Directory added to user PATH. Please restart any open terminals to use the 'mpv-cli' command.")
        except Exception as e:
            self.log(f"ERROR: Failed to modify registry: {e}")
            messagebox.showerror("Error", f"Failed to modify the registry. Please add the directory to your PATH manually.\n\nError: {e}")

    def _add_to_path_unix(self):
        """Shows instructions for adding the directory to PATH on Linux/macOS."""
        self.log("Displaying manual instructions for adding to PATH on Unix-like system.")
        instruction_message = (
            "To complete the process, you need to add the following line to your shell's startup file (e.g., ~/.bashrc, ~/.zshrc, or ~/.profile):\n\n"
            f'export PATH="$PATH:{INSTALL_DIR}"\n\n'
            "After adding the line, restart your terminal or run 'source <your_file>' for the change to take effect."
        )
        messagebox.showinfo("Add to PATH Manually", instruction_message)
        self.log("User has been shown the manual instructions.")

    def _create_windows_cli_wrapper(self):
        """Creates the mpv-cli.bat file."""
        script_path = os.path.join(INSTALL_DIR, SCRIPT_NAME)
        wrapper_path = os.path.join(INSTALL_DIR, "mpv-cli.bat")
        with open(wrapper_path, 'w') as f:
            f.write('@echo off\n')
            f.write('set PYTHONDONTWRITEBYTECODE=1\n')
            f.write(f'python3 "{script_path}" %*\n')
        self.log(f"Created Windows CLI wrapper: mpv-cli.bat")

    def _create_unix_cli_wrapper(self):
        """Creates the mpv-cli shell script for Linux/macOS."""
        script_path = os.path.join(INSTALL_DIR, SCRIPT_NAME)
        wrapper_path = os.path.join(INSTALL_DIR, "mpv-cli")
        with open(wrapper_path, 'w') as f:
            f.write("#!/bin/sh\n")
            f.write("export PYTHONDONTWRITEBYTECODE=1\n")
            f.write(f'python3 "{script_path}" "$@"\n')
        # Make the wrapper executable
        os.chmod(wrapper_path, 0o755)
        self.log(f"Created executable Unix CLI wrapper: mpv-cli")
        
    # --- Installation Logic (from install.py) ---
    def _install_windows(self, extension_id):
        self.log("Detected Windows OS.")
        
        # Find mpv.exe
        self.log("Searching for mpv.exe...")
        mpv_path = shutil.which('mpv.exe')
        if not mpv_path:
            self.log("mpv.exe not found in PATH. Please select it manually.")
            mpv_path = filedialog.askopenfilename(title="Select mpv.exe", filetypes=[("Executable", "*.exe")])
            if not mpv_path or not os.path.basename(mpv_path).lower() == 'mpv.exe':
                self.log("ERROR: mpv.exe not selected. Aborting installation.")
                messagebox.showerror("Installation Error", "mpv.exe not selected or invalid file. Aborting installation.")
                return
        self.log(f"Found mpv.exe at: {mpv_path}")

        # Save config
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(CONFIG_FILE, 'w') as f:
            json.dump({"mpv_path": mpv_path}, f, indent=4)
        self.log(f"Configuration saved to data/config.json")

        # Create .bat wrapper
        # This wrapper ensures that the same Python interpreter that runs the installer
        # is used to run the native host, avoiding PATH issues.
        script_path = os.path.join(INSTALL_DIR, SCRIPT_NAME)
        # Use pythonw.exe for the production wrapper to run silently without a console window.
        python_executable = sys.executable.replace("pythonw.exe", "python.exe")
        self.log(f"Using '{os.path.basename(python_executable)}' for a silent wrapper.")

        wrapper_path = os.path.join(INSTALL_DIR, "run_native_host.bat")
        with open(wrapper_path, 'w') as f:
            # %~dp0 expands to the directory of the .bat file, making the path relative.
            f.write(f'@echo off\nset PYTHONDONTWRITEBYTECODE=1\n"{python_executable}" "%~dp0{SCRIPT_NAME}" %*')
        self.log(f"Created wrapper script: run_native_host.bat")

        # Create Manifest
        # The manifest MUST point to the .bat wrapper, not the .py script directly.
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

        # Register with browsers
        browsers = get_browser_configs(is_mac=False)
        for browser, (reg_path, manifest_to_register) in browsers.items():
            try:
                key_path = os.path.join(reg_path, HOST_NAME)
                with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_path) as key:
                    winreg.SetValue(key, '', winreg.REG_SZ, manifest_path)
                self.log(f"Successfully registered for {browser}.")
            except OSError:
                self.log(f"Skipping {browser} (not installed or registry error).")

    def _install_linux_macos(self, is_mac, extension_id):
        os_name = "macOS" if is_mac else "Linux"
        self.log(f"Detected {os_name} OS.")

        # Check for mpv
        self.log("Searching for mpv...")
        mpv_path = shutil.which('mpv')
        
        if not mpv_path:
            self.log("mpv not found in PATH. You may select it manually.")
            mpv_path = filedialog.askopenfilename(title="Select mpv executable", filetypes=[("Executable", "*")])
            if not mpv_path or not os.path.basename(mpv_path).lower().startswith('mpv'): # mpv, mpv.app, etc.
                self.log("WARNING: mpv executable not selected. Native host will rely on 'mpv' being in PATH during runtime.")
                mpv_path = "mpv" # Fallback to default name, relying on PATH
                messagebox.showwarning("MPV Selection", "mpv executable not explicitly selected. The native host will attempt to find 'mpv' in your system's PATH during playback. Please ensure it is installed and accessible.")
            else:
                self.log(f"Selected mpv executable: {mpv_path}")
        else:
            self.log(f"Found mpv in PATH: {mpv_path}")

        # Save config for Unix-like systems as well
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(CONFIG_FILE, 'w') as f:
            json.dump({"mpv_path": mpv_path}, f, indent=4)
        self.log(f"Configuration saved to {os.path.relpath(CONFIG_FILE, INSTALL_DIR)}")

        # Make script executable
        script_path = os.path.join(INSTALL_DIR, SCRIPT_NAME)
        try:
            os.chmod(script_path, 0o755)
            self.log(f"Made {SCRIPT_NAME} executable.")
        except Exception as e:
            self.log(f"Could not make script executable: {e}")
        
        # Create a shell wrapper for Linux/macOS to set the environment variable
        wrapper_path = os.path.join(INSTALL_DIR, "run_native_host.sh")
        python_executable = sys.executable # Use the same python that's running the installer
        with open(wrapper_path, 'w') as f:
            f.write("#!/bin/sh\n")
            f.write("# This wrapper ensures __pycache__ directories are not created.\n")
            f.write("export PYTHONDONTWRITEBYTECODE=1\n\n")
            # Use dirname "$0" to find the script's directory, making it portable
            f.write(f'"{python_executable}" "$(dirname "$0")/{SCRIPT_NAME}" "$@"')
        
        # Make the wrapper executable
        os.chmod(wrapper_path, 0o755)
        self.log(f"Created executable wrapper script: run_native_host.sh")

        # Generate a single, portable manifest in the data directory.
        # The browser requires an absolute path to the executable inside the manifest file.
        manifest_path = os.path.join(DATA_DIR, f"{HOST_NAME}.json")
        chrome_manifest = {
            "name": HOST_NAME, "description": HOST_DESCRIPTION, "path": wrapper_path, "type": "stdio",
            "allowed_origins": [f"chrome-extension://{extension_id}/"]
        }
        with open(manifest_path, 'w') as f:
            json.dump(chrome_manifest, f, indent=4)
        self.log(f"Created portable manifest: {os.path.relpath(manifest_path, INSTALL_DIR)}")

        # Symlink the portable manifest into each browser's native messaging host directory.
        browser_paths = get_browser_configs(is_mac)
        for browser, path in browser_paths.items():
            if os.path.isdir(os.path.dirname(path)):
                try:
                    os.makedirs(path, exist_ok=True)
                    symlink_target = os.path.join(path, f"{HOST_NAME}.json")
                    
                    # Remove old symlink/file if it exists, then create a new one.
                    if os.path.lexists(symlink_target):
                        os.remove(symlink_target)
                    
                    os.symlink(manifest_path, symlink_target)
                    self.log(f"Successfully linked manifest for {browser}.")
                except Exception as e:
                    self.log(f"Failed to link manifest for {browser}. Error: {e}")
            else:
                self.log(f"Skipping {browser} (directory not found).")

    # --- Uninstallation Logic (from uninstall.py) ---
    def _uninstall_windows(self):
        self.log("Uninstalling for Windows...")
        
        # Unregister from browsers
        browsers = get_browser_configs(is_mac=False)
        for browser, (reg_path, _) in browsers.items():
            try:
                key_path = os.path.join(reg_path, HOST_NAME)
                winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key_path)
                self.log(f"Successfully unregistered from {browser}.")
            except FileNotFoundError:
                self.log(f"Not registered for {browser} (or already removed).")
            except OSError as e:
                self.log(f"Could not unregister for {browser}. Error: {e}")

        # Clean up generated files
        files_to_remove = [
            os.path.join(INSTALL_DIR, "run_native_host.bat"),
            os.path.join(DATA_DIR, f"{HOST_NAME}-chrome.json"),
            os.path.join(INSTALL_DIR, "mpv-cli.bat") # Remove the CLI wrapper
        ]
        for file_path in files_to_remove:
            if os.path.exists(file_path):
                try:
                    os.remove(file_path)
                    self.log(f"Removed generated file: {os.path.relpath(file_path, INSTALL_DIR)}")
                except OSError as e:
                    self.log(f"Could not remove file {file_path}. Error: {e}")

    def _uninstall_linux_macos(self, is_mac):
        os_name = "macOS" if is_mac else "Linux"
        self.log(f"Uninstalling for {os_name}...")

        browser_paths = get_browser_configs(is_mac)
        symlink_filename = f"{HOST_NAME}.json"
        for browser, path in browser_paths.items():
            symlink_path = os.path.join(path, symlink_filename)
            if os.path.lexists(symlink_path): # Use lexists to check for symlinks without following them
                try:
                    os.remove(symlink_path)
                    self.log(f"Successfully removed manifest link for {browser}.")
                except OSError as e:
                    self.log(f"Failed to remove manifest link for {browser}. Error: {e}")
            else:
                self.log(f"Manifest for {browser} not found (or already removed).")

        # Clean up generated files for Unix-like systems
        files_to_remove = [
            os.path.join(DATA_DIR, f"{HOST_NAME}.json"), # Remove the central manifest file
            os.path.join(INSTALL_DIR, "run_native_host.sh"),
            os.path.join(INSTALL_DIR, "mpv-cli") # Remove the CLI wrapper
        ]
        for file_path in files_to_remove:
            if os.path.exists(file_path):
                try:
                    os.remove(file_path)
                    self.log(f"Removed generated file: {os.path.relpath(file_path, INSTALL_DIR)}")
                except OSError as e:
                    self.log(f"Could not remove file {file_path}. Error: {e}")

def main():
    root = tk.Tk()
    app = HostManagerApp(root)
    root.mainloop()

if __name__ == "__main__":
    main()