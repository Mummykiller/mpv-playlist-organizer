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
- Created `mpv_session.py`, `file_io.py`, `services.py`, and `cli.py` to fully modularize the native host logic.
- Created `UIManager.js` to manage the lifecycle of all UI elements injected into web pages.
- Created `Resizable.js` to abstract UI resizing logic.
- Created `PlaylistUI.js` to manage all playlist rendering and event handling.
- Implemented cross-platform solution for `__pycache__` issue by modifying `Installer.py` to generate `run_native_host.sh` for Linux/macOS, similar to `run_native_host.bat` for Windows.
- Created `Draggable.js` to handle the drag of the on screen.

### Fixed
- Resolved issue where AniList releases were not rendering in `popup.js` due to incorrect static method calls.
- Corrected `background.js` to properly map `playlistManager` functions in the `actionHandlers` map, restoring playlist functionality.
- Fixed `native_host.py` to correctly pass the `send_message` dependency to `MpvSessionManager`'s process monitoring threads, resolving MPV playback issues.
- Addressed `NameError` in `native_host.py` by reordering function definitions to ensure `get_all_folders_from_file` is defined before use.
- Resolved "Cannot load extension with file or directory name __pycache__" error by adding `PYTHONDONTWRITEBYTECODE=1` environment variable to `Installer.py` and generated native host wrapper scripts (`.bat` and `.sh`).
- Fixed a bug in `background.js` that prevented `.m3u8` stream detection on most sites.
- Fixed a bug in `content.js` that prevented the extension from loading on pages.
- Corrected a `NameError` in `native_host.py` caused by an incorrect dependency injection order for the `cli.py` module.

### Changed
- Simplified the right-click "Add to MPV Folder" context menu. It is now a single-level list of folders instead of a nested menu for a cleaner experience.
- The context menu now intelligently places the most recently used folder at the top of the list for quick access, removing the separate "Add to current" option.
- `background.js` now imports and uses `storageManager.js`, `nativeConnection.js`, `contextMenu.js`, and `playlistManager.js` for improved modularity.
- `native_host.py` is now a fully modularized, lightweight entry point that coordinates between the browser and other Python modules.
- Improved robustness of `native_host.py` with better failsafe logging and CLI error handling.
- Refactored `background.js` context menu handler for improved clarity.
- Refactored `content.js` to use `Draggable.js` for all draggable components.
- Refactored `content.js` to use `Resizable.js` for the AniList panel.
- Refactored `content.js` to delegate all playlist functionality to the new `PlaylistUI.js` class.
- Refactored `popup.js` to better centralize UI mode logic within `UIModeManager`.
- Refactored `content.js` to delegate UI creation and teardown to `UIManager.js`.
- Unified YouTube title scraping by making the on-page "Add" button use the same oEmbed API as the right-click context menu, ensuring consistent titles.