import os
import json
import logging
import platform
import shutil
import subprocess
import sys
import services
import file_io

# Prevent __pycache__ generation
sys.dont_write_bytecode = True
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'

if platform.system() == "Windows":
    import winreg

# --- Configuration Constants ---
HOST_NAME = "com.mpv_playlist_organizer.handler"
HOST_DESCRIPTION = "MPV Playlist Organizer Native Host"
SCRIPT_NAME = "native_host.py"
# Point to parent directory since we are now in installer_src/
INSTALL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = file_io.DATA_DIR
CONFIG_FILE = file_io.CONFIG_FILE

def _generate_user_agent(browser_name, os_name):
    """Generates a plausible User-Agent string based on browser and OS."""
    base_ua = "Mozilla/5.0 ({os_part}; K) AppleWebKit/537.36 (KHTML, like Gecko)"

    os_map = {
        "Linux": "X11; Linux x86_64",
        "Windows": "Windows NT 10.0; Win64; x64",
        "Darwin": "Macintosh; Intel Mac OS X 10_15_7"
    }
    os_part = os_map.get(os_name, os_name)

    browser_map = {
        "brave": "Brave Chrome/120.0.0.0",
        "chrome": "Chrome/120.0.0.0",
        "edge": "Edg/120.0.0.0",
        "firefox": "Firefox/120.0",
        "vivaldi": "Vivaldi/6.5.3206.50",
        "opera": "Opera/100.0.0.0"
    }
    browser_part = browser_map.get(browser_name, "Chrome/120.0.0.0")
    if browser_name == "brave":
        browser_part = "Brave Chrome/120.0.0.0"
    elif browser_name == "vivaldi":
        browser_part = "Vivaldi/6.5.3206.50 Chrome/120.0.0.0"
    elif browser_name == "edge":
        browser_part = "Edg/120.0.0.0 Chrome/120.0.0.0"

    return f"{base_ua.format(os_part=os_part)} {browser_part} Safari/537.36"

class InstallerLogic:
    """Abstract base class for platform-specific installer logic."""
    def __init__(self, logger_func, ask_file_func=None, ask_dir_func=None):
        self.log = logger_func
        self.ask_file = ask_file_func
        self.ask_dir = ask_dir_func
        self.manual_user_data_paths = {}

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
        status = services.check_mpv_and_ytdlp_status(file_io.get_mpv_executable, lambda msg: None)

        if not status['ytdlp']['found']:
            warnings.append(f"'{status['ytdlp']['error']}'\nBypass scripts will not work without it.")
        else:
            self.log("yt-dlp found in PATH.")

        if not status['mpv']['found']:
            warnings.append(f"'{status['mpv']['error']}'\nPlayback will fail unless you select the executable manually.")
        else:
            self.log("mpv found in PATH.")

        if not status['node']['found']:
            warnings.append(f"'{status['node']['error']}'\nYouTube 1440p+ playback may fail without Node.js.")
        else:
            self.log("Node.js found in PATH.")

        return warnings

    def get_browser_user_data_dir(self, browser_name):
        """Returns the path to the browser's User Data directory."""
        raise NotImplementedError

    def find_extension_id(self, browser_name):
        """Attempts to find the extension ID by scanning browser preferences."""
        user_data_root = self.manual_user_data_paths.get(browser_name.lower())
        
        if not user_data_root:
            user_data_root = self.get_browser_user_data_dir(browser_name)
            
        if not user_data_root or not os.path.exists(user_data_root):
            self.log(f"User Data directory not found for {browser_name}: {user_data_root}")
            if self.ask_dir:
                self.log("Prompting for manual selection...")
                user_data_root = self.ask_dir(f"Select User Data directory for {browser_name}")
                if user_data_root:
                    self.manual_user_data_paths[browser_name.lower()] = user_data_root
            
        if not user_data_root or not os.path.exists(user_data_root):
            self.log(f"❌ User Data directory NOT found/selected for {browser_name}")
            return None

        self.log(f"Scanning profiles in {user_data_root} for Extension ID...")

        profiles = ['Default']
        for i in range(1, 21):
            profiles.append(f'Profile {i}')

        for profile in profiles:
            pref_path = os.path.join(user_data_root, profile, 'Preferences')
            if os.path.exists(pref_path):
                try:
                    with open(pref_path, 'r', encoding='utf-8', errors='ignore') as f:
                        data = json.load(f)

                    settings = data.get('extensions', {}).get('settings', {})
                    for ext_id, details in settings.items():
                        path = details.get('path')
                        if path:
                            norm_path = os.path.normpath(path)
                            norm_install = os.path.normpath(INSTALL_DIR)
                            if platform.system() == "Windows":
                                norm_path = norm_path.lower()
                                norm_install = norm_install.lower()

                            if norm_path == norm_install:
                                self.log(f"✅ Found ID '{ext_id}' in browser profile: '{profile}'")
                                return ext_id
                except Exception:
                    continue

        self.log(f"❌ Could not find an unpacked extension pointing to {INSTALL_DIR}")
        return None

    def run_diagnostics(self, browser):
        """Runs diagnostics and returns (result_text, has_critical_error)."""
        results = []
        has_critical_error = False
        status = services.check_mpv_and_ytdlp_status(file_io.get_mpv_executable, lambda msg: None)

        if status['ytdlp']['found']:
            ver = status['ytdlp'].get('version', 'Unknown')
            results.append(f"✅ yt-dlp found: {ver}")
        else:
            results.append("❌ yt-dlp NOT found in PATH")
            has_critical_error = True

        if status['mpv']['found']:
            results.append(f"✅ mpv found at: {status['mpv']['path']}")
        else:
            results.append("❌ mpv NOT found in PATH")
            has_critical_error = True

        if status['ffmpeg']['found']:
            ver = status['ffmpeg'].get('version', 'Found')
            results.append(f"✅ FFmpeg: {ver} at {status['ffmpeg']['path']}")
        else:
            results.append("❌ FFmpeg NOT found")
            results.append("   (Required for 1440p/4K YouTube)")
            has_critical_error = True

        if status['node']['found']:
            ver = status['node'].get('version', 'Found')
            results.append(f"✅ Node.js: {ver} at {status['node']['path']}")
        else:
            results.append("⚠️ Node.js NOT found")
            results.append("   (Recommended for 1440p+ YouTube)")

        if status['ytdlp']['found'] and browser:
            try:
                manual_path = self.manual_user_data_paths.get(browser.lower())
                cmd = [status['ytdlp']['path'], "--cookies-from-browser", browser]
                if manual_path:
                    cmd = [status['ytdlp']['path'], "--cookies-from-browser", f"{browser}:{manual_path}"]
                
                cmd.extend(["--simulate", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"])
                
                startupinfo = None
                if platform.system() == "Windows":
                    startupinfo = subprocess.STARTUPINFO()
                    startupinfo.dwFlags |= subprocess.STARTF_USESTDHANDLES | subprocess.STARTF_USESHOWWINDOW
                    startupinfo.wShowWindow = subprocess.SW_HIDE

                proc = subprocess.run(cmd, capture_output=True, text=True, startupinfo=startupinfo, timeout=20)

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
            except subprocess.TimeoutExpired:
                results.append(f"❌ Cookie test timed out for {browser}.\n   (Tip: Check your network or browser profile.)")
                has_critical_error = True
            except Exception as e:
                results.append(f"❌ Cookie test error: {e}")
                has_critical_error = True
        elif not browser:
            results.append("⚠️ No browser selected for cookie test")

        return "\n".join(results), has_critical_error

class WindowsLogic(InstallerLogic):
    def _get_console_python(self):
        exe = sys.executable
        if exe.lower().endswith("pythonw.exe"):
            return exe[:-5] + ".exe"
        return exe

    def get_browser_configs(self):
        manifest_path = os.path.join(DATA_DIR, f"{HOST_NAME}-chrome.json")
        return {
            "Google Chrome": (r"SOFTWARE\Google\Chrome\NativeMessagingHosts", manifest_path),
            "Brave": (r"SOFTWARE\BraveSoftware\Brave-Browser\NativeMessagingHosts", manifest_path),
            "Microsoft Edge": (r"SOFTWARE\Microsoft\Edge\NativeMessagingHosts", manifest_path),
            "Chromium": (r"SOFTWARE\Chromium\NativeMessagingHosts", manifest_path),
            "Vivaldi": (r"SOFTWARE\Vivaldi\NativeMessagingHosts", manifest_path),
            "Opera": (r"SOFTWARE\Opera Software\Opera Stable\NativeMessagingHosts", manifest_path),
        }

    def get_browser_user_data_dir(self, browser_name):
        appdata = os.environ.get('LOCALAPPDATA', '')
        mapping = {
            "chrome": os.path.join(appdata, "Google/Chrome/User Data"),
            "brave": os.path.join(appdata, "BraveSoftware/Brave-Browser/User Data"),
            "edge": os.path.join(appdata, "Microsoft/Edge/User Data"),
            "chromium": os.path.join(appdata, "Chromium/User Data"),
            "vivaldi": os.path.join(appdata, "Vivaldi/User Data"),
            "opera": os.path.join(appdata, "Opera Software/Opera Stable"),
        }
        return mapping.get(browser_name.lower())

    def install(self, extension_id, create_bypass, browser_for_bypass, enable_youtube_bypass):
        self.log("Detected Windows OS.")
        mpv_path = shutil.which('mpv.exe')
        if not mpv_path:
            try:
                existing_mpv = file_io.get_mpv_executable()
                if existing_mpv and os.path.exists(existing_mpv):
                    mpv_path = existing_mpv
                    self.log(f"mpv.exe found in existing config: {mpv_path}")
            except Exception:
                pass

        if not mpv_path and self.ask_file:
            self.log("mpv.exe not found. Prompting user to select it...")
            mpv_path = self.ask_file("Select mpv.exe", [("Executable", "*.exe"), ("All Files", "*.*")])

        if not mpv_path:
            raise FileNotFoundError("mpv.exe not found in PATH or config. Please add it to PATH or edit data/config.json.")

        self.log(f"Found mpv.exe at: {mpv_path}")
        os.makedirs(file_io.DATA_DIR, exist_ok=True)

        gpu_vendor = services.get_gpu_vendor()
        best_decoder = "nvdec" if gpu_vendor == "nvidia" else "d3d11va"
        status = services.check_mpv_and_ytdlp_status(lambda: mpv_path, lambda msg: None, force_refresh=True)
        ffmpeg_path = status['ffmpeg'].get('path')
        node_path = status['node'].get('path')

        config_to_save = {
            "os_platform": "Windows",
            "mpv_path": mpv_path,
            "mpv_decoder": best_decoder,
            "ffmpeg_path": ffmpeg_path,
            "node_path": node_path,
            "enable_url_analysis": create_bypass,
            "browser_for_url_analysis": browser_for_bypass,
            "enable_youtube_analysis": enable_youtube_bypass,
            "user_agent_string": _generate_user_agent(browser_for_bypass, platform.system()),
        }
        file_io.set_settings(config_to_save)
        self.log(f"Configuration saved to {file_io.CONFIG_FILE}")

        python_executable = self._get_console_python()
        wrapper_path = os.path.join(INSTALL_DIR, "run_native_host.bat")
        with open(wrapper_path, 'w') as f:
            f.write(f'@echo off\nset PYTHONDONTWRITEBYTECODE=1\n"{python_executable}" "%~dp0{SCRIPT_NAME}" %*')
        self.log("Created wrapper script: run_native_host.bat")

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

        browsers = self.get_browser_configs()
        browser_mapping = {
            "chrome": "Google Chrome", "brave": "Brave", "edge": "Microsoft Edge",
            "chromium": "Chromium", "vivaldi": "Vivaldi", "opera": "Opera"
        }
        target_key = browser_mapping.get(browser_for_bypass)
        for browser, (reg_path, manifest_to_register) in browsers.items():
            if target_key and browser != target_key:
                continue
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
            except (FileNotFoundError, OSError):
                pass

        files_to_remove = [
            os.path.join(INSTALL_DIR, "run_native_host.bat"),
            os.path.join(DATA_DIR, f"{HOST_NAME}-chrome.json"),
            os.path.join(INSTALL_DIR, "mpv-cli.bat"),
        ]
        for file_path in files_to_remove:
            if os.path.exists(file_path):
                os.remove(file_path)
                self.log(f"Removed: {os.path.basename(file_path)}")

    def install_cli(self):
        script_path = os.path.join(INSTALL_DIR, SCRIPT_NAME)
        wrapper_path = os.path.join(INSTALL_DIR, "mpv-cli.bat")
        with open(wrapper_path, 'w') as f:
            f.write(f'@echo off\nset PYTHONDONTWRITEBYTECODE=1\npython3 "{script_path}" %*\n')
        self.log("Created Windows CLI wrapper: mpv-cli.bat")

    def add_to_path(self):
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, 'Environment', 0, winreg.KEY_READ | winreg.KEY_WRITE) as key:
                current_path, _ = winreg.QueryValueEx(key, 'Path')
                if INSTALL_DIR.lower() in [p.lower() for p in current_path.split(';')]:
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

class UnixLogic(InstallerLogic):
    """Shared logic for Linux and macOS."""
    def get_browser_configs(self):
        raise NotImplementedError

    def install(self, extension_id, create_bypass, browser_for_bypass, enable_youtube_bypass):
        self.log(f"Detected {platform.system()} OS.")
        mpv_path = shutil.which('mpv') or "mpv"
        os.makedirs(file_io.DATA_DIR, exist_ok=True)
        gpu_vendor = services.get_gpu_vendor()
        if platform.system() == "Darwin":
            unix_decoder = "videotoolbox"
        elif gpu_vendor == "nvidia":
            unix_decoder = "nvdec"
        else:
            unix_decoder = "vaapi"

        status = services.check_mpv_and_ytdlp_status(lambda: mpv_path, lambda msg: None, force_refresh=True)
        config_to_save = {
            "os_platform": platform.system(),
            "mpv_path": mpv_path,
            "mpv_decoder": unix_decoder,
            "ffmpeg_path": status['ffmpeg'].get('path'),
            "node_path": status['node'].get('path'),
            "enable_url_analysis": create_bypass,
            "browser_for_url_analysis": browser_for_bypass,
            "enable_youtube_analysis": enable_youtube_bypass,
            "user_agent_string": _generate_user_agent(browser_for_bypass, platform.system()),
        }
        file_io.set_settings(config_to_save)
        script_path = os.path.join(INSTALL_DIR, SCRIPT_NAME)
        os.chmod(script_path, 0o755)

        wrapper_path = os.path.join(INSTALL_DIR, "run_native_host.sh")
        with open(wrapper_path, 'w') as f:
            f.write(f"#!/bin/sh\nexport PYTHONDONTWRITEBYTECODE=1\n\n\"{sys.executable}\" \"$(dirname \"$0\")/{SCRIPT_NAME}\" \"$@\"")
        os.chmod(wrapper_path, 0o755)

        manifest_path = os.path.join(DATA_DIR, f"{HOST_NAME}.json")
        with open(manifest_path, 'w') as f:
            json.dump({"name": HOST_NAME, "description": HOST_DESCRIPTION, "path": wrapper_path, "type": "stdio", "allowed_origins": [f"chrome-extension://{extension_id}/"]}, f, indent=4)

        browser_paths = self.get_browser_configs()
        browser_mapping = {"chrome": "Google Chrome", "brave": "Brave", "edge": "Microsoft Edge", "chromium": "Chromium", "vivaldi": "Vivaldi", "opera": "Opera"}
        target_key = browser_mapping.get(browser_for_bypass)
        for browser, path in browser_paths.items():
            if target_key and browser != target_key:
                continue
            if os.path.isdir(os.path.dirname(path)):
                os.makedirs(path, exist_ok=True)
                symlink_target = os.path.join(path, f"{HOST_NAME}.json")
                if os.path.lexists(symlink_target):
                    os.remove(symlink_target)
                os.symlink(manifest_path, symlink_target)
                self.log(f"Linked manifest for {browser}.")

    def uninstall(self):
        browser_paths = self.get_browser_configs()
        for browser, path in browser_paths.items():
            symlink_path = os.path.join(path, f"{HOST_NAME}.json")
            if os.path.lexists(symlink_path):
                try:
                    os.remove(symlink_path)
                except OSError:
                    pass
        for f in [os.path.join(DATA_DIR, f"{HOST_NAME}.json"), os.path.join(INSTALL_DIR, "run_native_host.sh"), os.path.join(INSTALL_DIR, "mpv-cli")]:
            if os.path.exists(f):
                os.remove(f)

    def install_cli(self):
        script_path = os.path.join(INSTALL_DIR, SCRIPT_NAME)
        wrapper_path = os.path.join(INSTALL_DIR, "mpv-cli")
        with open(wrapper_path, 'w') as f:
            f.write(f"#!/bin/sh\nexport PYTHONDONTWRITEBYTECODE=1\n\"{sys.executable}\" \"{script_path}\" \"$@\"\n")
        os.chmod(wrapper_path, 0o755)

    def add_to_path(self):
        return "Manual"

class MacOSLogic(UnixLogic):
    def get_browser_configs(self):
        base_path = os.path.expanduser("~/Library/Application Support/")
        return {
            "Google Chrome": os.path.join(base_path, "Google/Chrome/NativeMessagingHosts"),
            "Chromium": os.path.join(base_path, "Chromium/NativeMessagingHosts"),
            "Brave": os.path.join(base_path, "BraveSoftware/Brave-Browser/NativeMessagingHosts"),
            "Microsoft Edge": os.path.join(base_path, "Microsoft Edge/NativeMessagingHosts"),
            "Vivaldi": os.path.join(base_path, "Vivaldi/NativeMessagingHosts"),
        }

    def get_browser_user_data_dir(self, browser_name):
        base_path = os.path.expanduser("~/Library/Application Support/")
        mapping = {
            "chrome": os.path.join(base_path, "Google/Chrome"),
            "brave": os.path.join(base_path, "BraveSoftware/Brave-Browser"),
            "edge": os.path.join(base_path, "Microsoft Edge"),
            "chromium": os.path.join(base_path, "Chromium"),
            "vivaldi": os.path.join(base_path, "Vivaldi"),
            "opera": os.path.join(base_path, "com.operasoftware.Opera"),
        }
        return mapping.get(browser_name.lower())

class LinuxLogic(UnixLogic):
    def get_browser_configs(self):
        base_path = os.path.expanduser("~/.config/")
        return {
            "Google Chrome": os.path.join(base_path, "google-chrome/NativeMessagingHosts"),
            "Chromium": os.path.join(base_path, "chromium/NativeMessagingHosts"),
            "Brave": os.path.join(base_path, "BraveSoftware/Brave-Browser/NativeMessagingHosts"),
            "Microsoft Edge": os.path.join(base_path, "microsoft-edge/NativeMessagingHosts"),
            "Vivaldi": os.path.join(base_path, "vivaldi/NativeMessagingHosts"),
            "Opera": os.path.join(base_path, "opera/NativeMessagingHosts"),
        }

    def get_browser_user_data_dir(self, browser_name):
        base_path = os.path.expanduser("~/.config/")
        mapping = {
            "chrome": os.path.join(base_path, "google-chrome"),
            "brave": os.path.join(base_path, "BraveSoftware/Brave-Browser"),
            "edge": os.path.join(base_path, "microsoft-edge"),
            "chromium": os.path.join(base_path, "chromium"),
            "vivaldi": os.path.join(base_path, "vivaldi"),
            "opera": os.path.join(base_path, "opera"),
        }
        return mapping.get(browser_name.lower())
