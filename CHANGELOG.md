# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Began foundational refactoring of the service worker (`background.js`).
- Created `storageManager.js` to isolate all `chrome.storage` interactions and data migration logic.
- Created `nativeConnection.js` to encapsulate all native messaging port management and communication logic.
- Created `contextMenu.js` to manage the creation and updates of browser context menu items.
- Created `playlistManager.js` to centralize all playlist-related actions (add, remove, clear, reorder).
- Created `mpv_session.py` to isolate the `MpvSessionManager` class and its MPV process/IPC logic from `native_host.py`.
- Implemented cross-platform solution for `__pycache__` issue by modifying `Installer.py` to generate `run_native_host.sh` for Linux/macOS, similar to `run_native_host.bat` for Windows.

### Fixed
- Resolved issue where AniList releases were not rendering in `popup.js` due to incorrect static method calls.
- Corrected `background.js` to properly map `playlistManager` functions in the `actionHandlers` map, restoring playlist functionality.
- Fixed `native_host.py` to correctly pass the `send_message` dependency to `MpvSessionManager`'s process monitoring threads, resolving MPV playback issues.
- Addressed `NameError` in `native_host.py` by reordering function definitions to ensure `get_all_folders_from_file` is defined before use.
- Resolved "Cannot load extension with file or directory name __pycache__" error by adding `PYTHONDONTWRITEBYTECODE=1` environment variable to `Installer.py` and generated native host wrapper scripts (`.bat` and `.sh`).

### Changed
- Simplified the right-click "Add to MPV Folder" context menu. It is now a single-level list of folders instead of a nested menu for a cleaner experience.
- The context menu now intelligently places the most recently used folder at the top of the list for quick access, removing the separate "Add to current" option.
- `background.js` now imports and uses `storageManager.js`, `nativeConnection.js`, `contextMenu.js`, and `playlistManager.js` for improved modularity.
- `native_host.py` now imports and uses `mpv_session.py`, making the main script a lighter entry point.