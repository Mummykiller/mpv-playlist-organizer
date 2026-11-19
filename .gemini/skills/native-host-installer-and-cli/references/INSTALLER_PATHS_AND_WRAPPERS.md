# Native Host Manifest Paths & Wrapper Scripts Reference

This reference documents the cross-platform Native Messaging Host registration locations, generated wrapper scripts, and manifest JSON schema managed by `installer_src/installer_logic.py`.

---

## 1. Cross-Platform Manifest Locations (`installer_src/installer_logic.py`)

The installer writes the canonical Chrome Native Messaging manifest to `DATA_DIR/com.mpv_playlist_organizer.handler-chrome.json` and registers it across all detected Chromium-based browsers:

| Platform | Logic Class | Registration Mechanism & Browser Targets |
| :--- | :--- | :--- |
| **Linux** | `LinuxLogic` (`UnixLogic`) | Symlinks `~/.config/<browser>/NativeMessagingHosts/com.mpv_playlist_organizer.handler.json` → `DATA_DIR/com.mpv_playlist_organizer.handler-chrome.json`<br>**Browsers:** `google-chrome`, `chromium`, `BraveSoftware/Brave-Browser`, `microsoft-edge`, `vivaldi`, `opera` |
| **macOS** | `MacOSLogic` (`UnixLogic`) | Symlinks `~/Library/Application Support/<browser>/NativeMessagingHosts/com.mpv_playlist_organizer.handler.json` → `DATA_DIR/com.mpv_playlist_organizer.handler-chrome.json`<br>**Browsers:** `Google/Chrome`, `Chromium`, `BraveSoftware/Brave-Browser`, `Microsoft Edge`, `Vivaldi`, `com.operasoftware.Opera` |
| **Windows** | `WindowsLogic` | Sets default `REG_SZ` value of `HKEY_CURRENT_USER\SOFTWARE\<Browser>\NativeMessagingHosts\com.mpv_playlist_organizer.handler` to `DATA_DIR\com.mpv_playlist_organizer.handler-chrome.json`<br>**Browsers:** `Google\Chrome`, `BraveSoftware\Brave-Browser`, `Microsoft\Edge`, `Chromium`, `Vivaldi`, `Opera Software\Opera Stable` |

### Native Messaging Host Manifest Schema
```json
{
    "name": "com.mpv_playlist_organizer.handler",
    "description": "MPV Playlist Organizer Native Host",
    "path": "/absolute/path/to/run_native_host.sh",
    "type": "stdio",
    "allowed_origins": [
        "chrome-extension://<32_char_a-p_extension_id>/"
    ]
}
```

---

## 2. Generated Wrapper Scripts

### Native Host Launchers (`run_native_host.sh` & `run_native_host.bat`)
Generated during `UnixLogic.install` (`0o755` mode, `shlex.quote` on `sys.executable`) and `WindowsLogic.install`:

```sh
# Linux / macOS: run_native_host.sh
#!/bin/sh
export PYTHONDONTWRITEBYTECODE=1

exec '/usr/bin/python3' "$(dirname "$0")/native_host.py" "$@"
```

```bat
:: Windows: run_native_host.bat
@echo off
set PYTHONDONTWRITEBYTECODE=1
"C:\Path\To\python.exe" "%~dp0native_host.py" %*
```

### Standalone CLI Wrappers (`mpv-cli` & `mpv-cli.bat`)
Generated via `UnixLogic.install_cli` (`0o755` mode, `shlex.quote` on both `sys.executable` and `script_path`) and `WindowsLogic.install_cli`:

```sh
# Linux / macOS: mpv-cli
#!/bin/sh
export PYTHONDONTWRITEBYTECODE=1

exec '/usr/bin/python3' '/absolute/path/to/native_host.py' "$@"
```

```bat
:: Windows: mpv-cli.bat
@echo off
set PYTHONDONTWRITEBYTECODE=1
"C:\Path\To\python.exe" "C:\Path\To\native_host.py" %*
```
