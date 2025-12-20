# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Added a "pin" button to the AniList UI to lock its position, with a blue glow effect when active.
- Began foundational refactoring of the service worker (`background.js`).
- Created `storageManager.js` to isolate all `chrome.storage` interactions and data migration logic.
- Added a "Force Panel Attached" setting to lock the AniList panel to the controller and manage its visibility when the controller is minimized.
- Added an "Attach on Open" setting to provide a "soft attach" behavior, snapping the AniList panel to the controller on open while still allowing it to be moved freely.
- Created `nativeConnection.js` to encapsulate all native messaging port management and communication logic.
- Created `contextMenu.js` to manage the creation and updates of browser context menu items.
- Created `playlistManager.js` to centralize all playlist-related actions (add, remove, clear, reorder).
- Created `mpv_session.py`, `file_io.py`, `services.py`, and `cli.py` to fully modularize the native host logic.
- Created `UIManager.js` to manage the lifecycle of all UI elements injected into web pages.
- Created `Resizable.js` to abstract UI resizing logic.
- Created `PlaylistUI.js` to manage all playlist rendering and event handling.
- Implemented cross-platform solution for `__pycache__` issue by modifying `Installer.py` to generate `run_native_host.sh` for Linux/macOS, similar to `run_native_host.bat` for Windows.
- Created `Draggable.js` to handle the drag of the on screen.
- Created `PageScraper.js` to centralize all page scraping logic, including the YouTube-specific rules.
- Created `AniListUI.js` to encapsulate all logic for the AniList side panel, including state management, event handling, and positioning.
- Added a command-line interface (CLI) wrapper (`mpv-cli`) that can be installed via the `Installer.py` GUI.
- Added a feature to the installer to add the application directory to the user's PATH for easy CLI access.
- Implemented adaptive (percentage-based) positioning for all draggable UI elements, allowing them to scale correctly with window resizes.
- Added customizable keybindings for "Add to Playlist", "Toggle Controller", and "Open Popup".
- Added a "Force Reload Settings" button in the popup to immediately apply changes across all tabs.
- Added a toggle button to show/hide the minimized stub icon in the on-page controller.
- Implemented a tag-based UI for managing custom MPV flags in settings.
- Added logic to auto-focus the "Add" button when the popup opens in mini-mode.

### Fixed
- Fixed an issue where the on-page AniList toggle button would not be highlighted (glow) when the panel was active.
- Fixed a bug where the on-page AniList toggle button would not move to the correct side of the controller when the panel was opened.
- Resolved an issue where the "Attach on Open" feature would stop working after the AniList panel was manually moved.
- Corrected position saving logic for the AniList panel to ensure its manually set position is remembered across page refreshes and when the main controller is minimized and restored.
- Resolved issue where AniList releases were not rendering in `popup.js` due to incorrect static method calls.
- Corrected `background.js` to properly map `playlistManager` functions in the `actionHandlers` map, restoring playlist functionality.
- Fixed `native_host.py` to correctly pass the `send_message` dependency to `MpvSessionManager`'s process monitoring threads, resolving MPV playback issues.
- Addressed `NameError` in `native_host.py` by reordering function definitions to ensure `get_all_folders_from_file` is defined before use.
- Resolved "Cannot load extension with file or directory name __pycache__" error by adding `PYTHONDONTWRITEBYTECODE=1` environment variable to `Installer.py` and generated native host wrapper scripts (`.bat` and `.sh`).
- Fixed a bug in `background.js` that prevented `.m3u8` stream detection on most sites.
- Fixed a bug in `content.js` that prevented the extension from loading on pages.
- Corrected a `NameError` in `native_host.py` caused by an incorrect dependency injection order for the `cli.py` module.
- Fixed an issue where the "Lock Panel Position" setting for the AniList panel was not being applied, allowing the panel to be dragged even when locked.
- Corrected the "Force Re-attach" setting for the AniList panel to properly reset after being used, ensuring it acts as a one-time trigger.
- Fixed the "Clear on Completion" feature by ensuring the `on_completion.lua` script is correctly loaded by MPV and by updating the background script to handle both natural playlist completion (exit code 99) and manual closing (exit code 0) as triggers for clearing the playlist.
- AniList panel state (position, visibility) is now correctly saved on a per-domain basis, preventing the state from being shared across different websites.
- Resolved an issue where toggling the AniList panel's visibility on one website would incorrectly show the panel on all other open tabs. The UI state is now correctly isolated to the tab where the change was made.
- Fixed a bug where dragging the minimized UI button would cause it to "bounce" back to its original position on certain dynamic websites. The button's manually set position is now correctly respected.
- Fixed a major bug where the on-page "Add" button for non-YouTube sites would fail by needlessly using the stream scanner. The button now correctly scrapes the current page locally for a much faster and more reliable experience.
- Fixed an issue where manually closing MPV would incorrectly clear the playlist; it now only clears on natural playlist completion (exit code 99).
- Corrected a fallback logic flaw in the stream scanner. Manually closing the scanner window will no longer result in adding an incorrect URL to the playlist.
- Optimized the on-page "Add" button for non-YouTube sites to perform scraping locally in the content script, preventing the creation of a redundant "scanner" window and making the process significantly faster.
- Fixed syntax errors in `background.js` that prevented the service worker from loading correctly.
- Resolved an issue where the Python CLI could not be run from outside its own directory.
- Fixed a bug where draggable UI elements would "jump" when placed at the right edge of the screen due to the vertical scrollbar's width.
- Fixed a bug on Windows where CLI commands would incorrectly launch a new, silent window instead of printing output to the current terminal.
- Corrected the CLI wrapper scripts (`mpv-cli.bat` and `mpv-cli`) to prevent the creation of `__pycache__` directories.
- Fixed the "Add" button in the popup not glowing green when a URL is detected.
- Fixed the "Add" button in the popup failing to add items if the content script wasn't fully loaded.
- Improved keybinding detection to handle spaces and modifier naming differences (e.g., "Control" vs "Ctrl").
### Changed
- Simplified the right-click "Add to MPV Folder" context menu. It is now a single-level list of folders instead of a nested menu for a cleaner experience.
- The context menu now intelligently places the most recently used folder at the top of the list for quick access, removing the separate "Add to current" option.
- `background.js` now imports and uses `storageManager.js`, `nativeConnection.js`, `contextMenu.js`, and `playlistManager.js` for improved modularity.
- `native_host.py` is now a fully modularized, lightweight entry point that coordinates between the browser and other Python modules.
- Removed several non-functional AniList settings ("Show UI sections", "Snap panel on open", "Force re-attach panel") to improve code clarity and user experience.
- Improved robustness of `native_host.py` with better failsafe logging and CLI error handling.
- Refactored `background.js` context menu handler for improved clarity.
- Refactored `content.js` to use `Draggable.js` for all draggable components.
- Refactored `content.js` to use `Resizable.js` for the AniList panel.
- Refactored `content.js` to delegate all playlist functionality to the new `PlaylistUI.js` class.
- Refactored `popup.js` to better centralize UI mode logic within `UIModeManager`.
- Refactored `content.js` to delegate UI creation and teardown to `UIManager.js`.
- Refactored `content.js` to use `PageScraper.js` for all title scraping.
- Refactored `content.js` to delegate all AniList-related functionality to the new `AniListUI.js` class, significantly cleaning up the main controller.
- Improved YouTube title scraping by making the oEmbed API fallback to the robust stream scanner on failure, instead of using a generic title.


### Documentation
- Completely overhauled the `README.md` to be more concise, user-friendly, and digestible.
- Restructured the document to prioritize installation and usage for new users.
- Condensed the "Features" section into a high-level "Core Features" list, removing the overly technical deep-dive.
- Simplified the "How It Works" and "Troubleshooting" sections to be more accessible.
- Removed the "Project Structure" and "Contributing" sections to reduce clutter for the average user.