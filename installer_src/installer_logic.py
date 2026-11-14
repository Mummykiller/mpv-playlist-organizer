import os
import json
import logging
import platform
import shutil
import subprocess
import sys
import re
import shlex
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

EXTENSION_ID_PATTERN = re.compile(r"^[a-p]{32}$")

def validate_extension_id(extension_id: str) -> str:
    """Validates Chrome extension ID (must be exactly 32 lowercase letters a-p)."""
    if not extension_id or not isinstance(extension_id, str):
        raise ValueError("Extension ID is required.")
    cleaned_id = extension_id.strip()
    if not EXTENSION_ID_PATTERN.match(cleaned_id):
        raise ValueError(f"Invalid Extension ID '{cleaned_id}'. Must be exactly 32 lowercase letters (a-p).")
    return cleaned_id

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
        "chromium": "Chrome/120.0.0.0",
        "edge": "Edg/120.0.0.0",
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

        # Robust profile detection: Default, plus many numbered profiles
        profiles = ['Default', 'Guest Profile']
        for i in range(1, 31):
            profiles.append(f'Profile {i}')
        
        # Add common Opera-specific profile if applicable
        if browser_name.lower() == "opera":
            profiles.append(".") # Opera often has preferences in root of User Data

        norm_install = os.path.realpath(INSTALL_DIR)
        if platform.system() == "Windows":
            norm_install = norm_install.lower()

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
                            # 1. Try realpath comparison (most robust)
                            try:
                                if os.path.exists(path) and os.path.samefile(path, INSTALL_DIR):
                                    self.log(f"✅ Found ID '{ext_id}' in browser profile: '{profile}' (SameFile match)")
                                    return ext_id
                            except OSError as e:
                                logging.debug(f"[INSTALLER] samefile check failed for '{path}': {e}")

                            # 2. Fallback to normalized string comparison
                            norm_path = os.path.realpath(path)
                            if platform.system() == "Windows":
                                norm_path = norm_path.lower()

                            if norm_path == norm_install:
                                self.log(f"✅ Found ID '{ext_id}' in browser profile: '{profile}' (Path match)")
                                return ext_id
                except (OSError, json.JSONDecodeError, UnicodeDecodeError) as e:
                    logging.debug(f"[INSTALLER] Error reading profile {pref_path}: {e}")
                    continue

        self.log(f"❌ Could not find an unpacked extension pointing to {INSTALL_DIR}")
        return None

    def run_diagnostics(self, browser):
        """Runs diagnostics and returns (result_text, has_critical_error)."""
        results = []
        has_critical_error = False

        self.log("Checking dependencies (yt-dlp, mpv, FFmpeg, Node.js)...")
        status = services.check_mpv_and_ytdlp_status(file_io.get_mpv_executable, lambda msg: None)

        self.log("Checking yt-dlp...")
        if status['ytdlp']['found']:
            ver = status['ytdlp'].get('version', 'Unknown')
            msg = f"✅ yt-dlp found: {ver}"
            results.append(msg)
            self.log(msg)
        else:
            msg = "❌ yt-dlp NOT found in PATH"
            results.append(msg)
            self.log(msg)
            has_critical_error = True

        self.log("Checking mpv...")
        if status['mpv']['found']:
            msg = f"✅ mpv found at: {status['mpv']['path']}"
            results.append(msg)
            self.log(msg)
        else:
            msg = "❌ mpv NOT found in PATH"
            results.append(msg)
            self.log(msg)
            has_critical_error = True

        self.log("Checking FFmpeg...")
        if status['ffmpeg']['found']:
            ver = status['ffmpeg'].get('version', 'Found')
            msg = f"✅ FFmpeg: {ver} at {status['ffmpeg']['path']}"
            results.append(msg)
            self.log(msg)
        else:
            results.append("❌ FFmpeg NOT found")
            results.append("   (Required for 1440p/4K YouTube)")
            self.log("❌ FFmpeg NOT found (Required for 1440p/4K YouTube)")
            has_critical_error = True

        self.log("Checking Node.js...")
        if status['node']['found']:
            ver = status['node'].get('version', 'Found')
            msg = f"✅ Node.js: {ver} at {status['node']['path']}"
            results.append(msg)
            self.log(msg)
        else:
            results.append("⚠️ Node.js NOT found")
            results.append("   (Recommended for 1440p+ YouTube)")
            self.log("⚠️ Node.js NOT found (Recommended for 1440p+ YouTube)")

        if status['ytdlp']['found'] and browser:
            self.log(f"Testing browser cookie extraction for '{browser}'...")
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
                    msg = f"✅ Cookie access successful for {browser}"
                    results.append(msg)
                    self.log(msg)
                else:
                    err = proc.stderr.strip()
                    msg = f"❌ Cookie access failed for {browser}"
                    if "lock" in err.lower() or "open" in err.lower():
                        msg += "\n   (Tip: Close the browser and try again)"
                    results.append(msg)
                    self.log(f"❌ Cookie access failed for {browser}")
                    self.log(f"Cookie error: {err}")
                    has_critical_error = True
            except subprocess.TimeoutExpired:
                results.append(f"❌ Cookie test timed out for {browser}.\n   (Tip: Check your network or browser profile.)")
                self.log(f"❌ Cookie test timed out for {browser}.")
                has_critical_error = True
            except Exception as e:
                results.append(f"❌ Cookie test error: {e}")
                self.log(f"❌ Cookie test error: {e}")
                has_critical_error = True
        elif not browser:
            msg = "⚠️ No browser selected for cookie test"
            results.append(msg)
            self.log(msg)

        self.log("Diagnostics complete.")
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
        extension_id = validate_extension_id(extension_id)
        self.log("Detected Windows OS.")
        mpv_path = shutil.which('mpv.exe')
        if not mpv_path:
            try:
                existing_mpv = file_io.get_mpv_executable()
                if existing_mpv and os.path.exists(existing_mpv):
                    mpv_path = existing_mpv
                    self.log(f"mpv.exe found in existing config: {mpv_path}")
            except (OSError, json.JSONDecodeError, KeyError) as e:
                logging.debug(f"[INSTALLER] Could not get mpv executable from config: {e}")

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
        # Ensure Python path and script path are quoted correctly for Windows batch
        with open(wrapper_path, 'w') as f:
            f.write(f'@echo off\nset PYTHONDONTWRITEBYTECODE=1\n"{python_executable}" "%~dp0{SCRIPT_NAME}" %*')
        self.log(f"Created wrapper script: run_native_host.bat")

        # Native messaging manifests MUST use forward slashes or escaped backslashes in JSON, 
        # but the manifest file path itself should be native.
        manifest_path = os.path.join(DATA_DIR, f"{HOST_NAME}-chrome.json")
        chrome_manifest = {
            "name": HOST_NAME,
            "description": HOST_DESCRIPTION,
            "path": wrapper_path.replace("\\", "/"), # Standardize for JSON
            "type": "stdio",
            "allowed_origins": [f"chrome-extension://{extension_id}/"]
        }
        with open(manifest_path, 'w') as f:
            json.dump(chrome_manifest, f, indent=4)
        self.log(f"Created manifest: {os.path.relpath(manifest_path, INSTALL_DIR)}")

        browsers = self.get_browser_configs()
        
        # Registry paths on Windows MUST use backslashes
        native_manifest_path = os.path.normpath(manifest_path)

        for browser, (reg_path, _) in browsers.items():
            full_key_path = f"{reg_path}\\{HOST_NAME}"
            try:
                # Key creation needs native path
                normalized_key_path = full_key_path.replace("/", "\\")
                with winreg.CreateKey(winreg.HKEY_CURRENT_USER, normalized_key_path) as key:
                    winreg.SetValue(key, '', winreg.REG_SZ, native_manifest_path)
                self.log(f"Successfully registered for {browser} at {normalized_key_path}.")
            except OSError as e:
                self.log(f"Skipping {browser} registry path {full_key_path} (error: {e}).")

        if "Google Chrome" not in browsers:
            fallback_key_path = f"SOFTWARE\\Google\\Chrome\\NativeMessagingHosts\\{HOST_NAME}"
            try:
                with winreg.CreateKey(winreg.HKEY_CURRENT_USER, fallback_key_path) as key:
                    winreg.SetValue(key, '', winreg.REG_SZ, native_manifest_path)
                self.log(f"Successfully registered Chrome fallback at {fallback_key_path}.")
            except OSError as e:
                self.log(f"Skipping Chrome fallback registry path {fallback_key_path} (error: {e}).")

    def uninstall(self):
        self.log("Uninstalling for Windows...")
        browsers = self.get_browser_configs()
        for browser, (reg_path, _) in browsers.items():
            try:
                key_path = os.path.join(reg_path, HOST_NAME)
                winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key_path)
                self.log(f"Successfully unregistered from {browser}.")
            except (FileNotFoundError, OSError) as e:
                logging.debug(f"[INSTALLER] Key {key_path} not found or could not be deleted: {e}")

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
        python_executable = self._get_console_python()
        script_path = os.path.join(INSTALL_DIR, SCRIPT_NAME)
        wrapper_path = os.path.join(INSTALL_DIR, "mpv-cli.bat")
        with open(wrapper_path, 'w') as f:
            f.write(f'@echo off\nset PYTHONDONTWRITEBYTECODE=1\n"{python_executable}" "{script_path}" %*\n')
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
        extension_id = validate_extension_id(extension_id)
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
        quoted_py = shlex.quote(sys.executable)
        with open(wrapper_path, 'w') as f:
            f.write(f'#!/bin/sh\nexport PYTHONDONTWRITEBYTECODE=1\n\nexec {quoted_py} "$(dirname "$0")/{SCRIPT_NAME}" "$@"\n')
        os.chmod(wrapper_path, 0o755)

        manifest_path = os.path.join(DATA_DIR, f"{HOST_NAME}-chrome.json")
        native_manifest_path = os.path.normpath(manifest_path)
        with open(native_manifest_path, 'w') as f:
            json.dump({"name": HOST_NAME, "description": HOST_DESCRIPTION, "path": wrapper_path, "type": "stdio", "allowed_origins": [f"chrome-extension://{extension_id}/"]}, f, indent=4)

        browser_paths = self.get_browser_configs()
        for browser, path in browser_paths.items():
            if os.path.isdir(os.path.dirname(path)):
                os.makedirs(path, exist_ok=True)
                symlink_target = os.path.join(path, f"{HOST_NAME}.json")
                if os.path.lexists(symlink_target):
                    os.remove(symlink_target)
                os.symlink(native_manifest_path, symlink_target)
                self.log(f"Linked manifest for {browser}.")

    def uninstall(self):
        browser_paths = self.get_browser_configs()
        for browser, path in browser_paths.items():
            symlink_path = os.path.join(path, f"{HOST_NAME}.json")
            if os.path.lexists(symlink_path):
                try:
                    os.remove(symlink_path)
                except OSError as e:
                    logging.debug(f"[INSTALLER] Could not remove symlink {symlink_path}: {e}")
        for f in [
            os.path.join(DATA_DIR, f"{HOST_NAME}-chrome.json"),
            os.path.join(INSTALL_DIR, "run_native_host.sh"),
            os.path.join(INSTALL_DIR, "mpv-cli"),
        ]:
            if os.path.exists(f):
                os.remove(f)

    def install_cli(self):
        script_path = os.path.join(INSTALL_DIR, SCRIPT_NAME)
        wrapper_path = os.path.join(INSTALL_DIR, "mpv-cli")
        quoted_py = shlex.quote(sys.executable)
        quoted_script = shlex.quote(script_path)
        with open(wrapper_path, 'w') as f:
            f.write(f'#!/bin/sh\nexport PYTHONDONTWRITEBYTECODE=1\n\nexec {quoted_py} {quoted_script} "$@"\n')
        os.chmod(wrapper_path, 0o755)

    def _detect_unix_shell_rc(self):
        shell_name = os.path.basename(os.environ.get("SHELL", "")).lower()
        if "zsh" in shell_name:
            return "~/.zshrc"
        if "bash" in shell_name:
            return "~/.bash_profile" if platform.system() == "Darwin" else "~/.bashrc"
        if platform.system() == "Darwin":
            return "~/.zshrc"
        return "~/.bashrc"

    def add_to_path(self):
        quoted_dir = shlex.quote(INSTALL_DIR)
        session_cmd = f'export PATH="$PATH:"{quoted_dir}'
        rc_file = self._detect_unix_shell_rc()
        persist_cmd = f"echo {shlex.quote(session_cmd)} >> {rc_file}"
        full_cmd = f"{persist_cmd} && {session_cmd}"

        self.log(f"Automatic PATH modification is not supported on {platform.system()}.")
        self.log(f"Add permanently ({rc_file}): {persist_cmd}")
        self.log(f"Apply to current session: {session_cmd}")

        return {
            "status": "manual",
            "directory": INSTALL_DIR,
            "shell_rc": rc_file,
            "persist_command": persist_cmd,
            "session_command": session_cmd,
            "command": full_cmd,
        }

class MacOSLogic(UnixLogic):
    def get_browser_configs(self):
        base_path = os.path.expanduser("~/Library/Application Support/")
        return {
            "Google Chrome": os.path.join(base_path, "Google/Chrome/NativeMessagingHosts"),
            "Chromium": os.path.join(base_path, "Chromium/NativeMessagingHosts"),
            "Brave": os.path.join(base_path, "BraveSoftware/Brave-Browser/NativeMessagingHosts"),
            "Microsoft Edge": os.path.join(base_path, "Microsoft Edge/NativeMessagingHosts"),
            "Vivaldi": os.path.join(base_path, "Vivaldi/NativeMessagingHosts"),
            "Opera": os.path.join(base_path, "com.operasoftware.Opera/NativeMessagingHosts"),
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

def get_logic_for_platform(system=None, log_func=print, ask_file_func=None, ask_dir_func=None):
    if system is None:
        system = platform.system()
    if system == "Windows":
        return WindowsLogic(log_func, ask_file_func=ask_file_func, ask_dir_func=ask_dir_func)
    elif system == "Linux":
        return LinuxLogic(log_func, ask_file_func=ask_file_func, ask_dir_func=ask_dir_func)
    elif system == "Darwin":
        return MacOSLogic(log_func, ask_file_func=ask_file_func, ask_dir_func=ask_dir_func)
    return UnixLogic(log_func, ask_file_func=ask_file_func, ask_dir_func=ask_dir_func)

