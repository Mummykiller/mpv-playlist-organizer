# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.2.0] - 2025-12-27

### Added
- **Modularized Frontend Handlers:** Extracted all action handlers from `background.js` into dedicated, modular files for improved organization and maintainability. New modules include `ui_state.js`, `m3u8_scanner.js`, `playback.js`, `folder_management.js`, `import_export.js`, and `dependency_anilist.js`.
- **PlaybackQueue Class:** Introduced a `PlaybackQueue` class in `playback.js` to encapsulate playback state and logic, enhancing clarity and control over queued items.

### Changed
- **Comprehensive background.js Refactoring:** The main `background.js` script was significantly refactored to act primarily as an orchestrator, importing and initializing modular handler files and delegating message handling to them. This drastically reduced its complexity and improved readability.
- **Improved Dependency Management (JS):** Reordered global declarations and initializations in `background.js` to ensure all shared dependencies (`storage`, `broadcastToTabs`, `broadcastLog`, etc.) are defined before being passed to handler initialization functions.
- **Refined PlaylistManager Dependencies:** Updated `utils/playlistManager.js` to explicitly receive `MPV_PLAYLIST_COMPLETED_EXIT_CODE` as a dependency from the new `playback.js` module.
- **Centralized Native Host Command Handling:** Centralized command handling within `native_host.py` into `HandlerManager` in `utils/native_host_handlers.py`, improving code organization.
- **Structured Services Module:** Further modularized `services.py` by introducing helper functions for `yt-dlp` updates (`_find_ytdlp_executable`, `_get_linux_sudo_command_prefix`, `_run_update_command`), encapsulating MPV command construction in `MpvCommandBuilder`, and managing AniList caching with `AniListCache`.
- **Streamlined Bypass Script Generation:** Improved bypass script generation in `installer.py` by centralizing the core logic into a new `utils/_bypass_logic.py` module.

### Fixed
- **Native Host `NameError`:** Resolved `NameError: name 'cleanup_ipc_socket' is not defined` in `native_host.py` by correctly placing the `cleanup_ipc_socket` function and its `atexit.register` call in the global scope.
- **Native Host `IndentationError`:** Corrected `IndentationError: unexpected indent` in `native_host.py` by fixing the indentation of global variables and functions.
- **Background Script `ReferenceError`:** Addressed `Uncaught ReferenceError: Cannot access 'storage' before initialization` in `background.js` by ensuring a correct and strict order of variable declarations and dependency injections during service worker initialization.
- **Missing UI State Handler:** Fixed an issue where the `set_minimized_state` handler was not correctly mapped in `background.js`'s `actionHandlers` object, preventing proper UI state management.



### Added
- **Configurable Natural Completion Clearing:** Implemented a custom MPV Lua script (`data/on_completion.lua`) to write a flag file upon natural video/playlist completion. This flag is detected by the native host, which then signals natural completion (exit code 99) to the browser extension, allowing for differentiated playlist clearing.
- **Native Host Folder Data Retrieval:** Added a `get_all_folders` action to `native_host.py`, enabling the browser extension to retrieve and resynchronize its local storage with the content of `folders.json` from the native host.
- **M3U Playlist Architecture:** Switched to generating temporary M3U playlists for playback. This ensures robust title display in MPV's playlist view (`#EXTINF`) and eliminates race conditions associated with IPC property injection.

### Fixed
- **Robust IPC Communication:**
    - Resolved persistent "Broken pipe" errors by implementing a persistent `IPCSocketManager` and a "hard kill switch" (`MpvSessionManager.is_alive`), preventing the native host from attempting IPC with closed MPV processes.
    - Enhanced `IPCSocketManager.send()` to correctly discard interleaved MPV events and retrieve valid command responses, fixing `Tracker: Initial current_path: None` issues where the playlist tracker failed to get the currently playing item's path.
    - Fixed a critical bug in `ipc_utils.py` where unread IPC responses on Windows caused `is_process_alive` to fail, leading to duplicate MPV instances.
    - Resolved a connection drop issue on Linux caused by improper handling of buffered IPC events during command execution.
- **Stable Playlist Item ID Management:** Fixed inconsistent playlist clearing by centralizing item ID management in `native_host.py` via `resolve_or_assign_item_id`. This ensures unique and stable IDs are persisted in `folders.json`, resolving previous `id` mismatches in `PlaylistTracker`.
- **Accurate MPV Session State Handling:**
    - Corrected `NameError: name 'PlaylistTracker' is not defined` by adding a missing import in `mpv_session.py`.
    - Resolved `NameError: name 'process' is not defined` by fixing a logging statement in `mpv_session.py`.
    - Corrected PID logging in `mpv_session.py` for MPV instances launched in terminals.
- **Consistent Playlist Clearing Differentiated by Exit Code:**
    - Modified `mpv_session.py` to detect a natural completion flag file created by `on_completion.lua` and set `returnCode = 99` for the `mpv_exited` message sent to the browser extension and for the internal `self.clear()` call.
    - Updated `playlist_tracker.py` to only clear played items from `folders.json` if `mpv_return_code` is `99`.
    - Modified `background.js` to only trigger UI playlist clearing and resync if `returnCode` is `99`, effectively differentiating natural completion from manual quits (which result in `returnCode = 0` and no clearing).
- **Browser Storage Synchronization:** Implemented `resyncDataFromNativeHostFile` in `background.js` to automatically resynchronize the browser's local storage with `folders.json` after the native host modifies it (e.g., clearing playlist items), ensuring the UI always reflects the current state.

### Changed
- **MPV Session Clearing API:** Modified `MpvSessionManager.clear()` and `PlaylistTracker.stop_tracking()` methods to accept `mpv_return_code`, allowing conditional clearing logic based on MPV's exit status.
- **YouTube Bypass Script Control Mechanism:** The YouTube bypass functionality in `play_with_bypass.sh` was updated to read its enabled state from an environment variable (`MPV_PLAYLIST_YOUTUBE_BYPASS_ENABLED`) set by the native host. The previous implementation for `config.json` control was removed as per user request, reverting to `play_with_bypass.sh` always attempting bypass for YouTube if present.
- **Title Handling:** Deprecated the Lua script title handler. Titles are now embedded directly in the generated M3U files.
- **YouTube Metadata:** YouTube links now defer to `yt-dlp` for metadata resolution within the M3U playlist, ensuring accurate titles.



## [2.1.0] - 2024-05-24

### Added
- **Installer UI Tooltips:** Added tooltips to the installer UI to explain complex options, such as the AnimePahe bypass script functionality.
- **Diagnostics Tool:** Added a diagnostics tool to the installer to help users troubleshoot issues by checking for dependencies like `mpv`, `yt-dlp`, and `ffmpeg`, and verifying browser cookie access.
- **AnimePahe Bypass Script:** The installer now generates a `play_with_bypass` script that uses `yt-dlp` to resolve streaming URLs, bypassing certain restrictions. This includes dynamic User-Agent generation.
- **YouTube Bypass Option:** Added an option in the installer to enable YouTube-specific bypass logic within the `play_with_bypass` script, allowing better handling of YouTube URLs and cookie integration.
- Implemented a sequential playback queue system in the background script. Videos are now processed one by one to ensure per-item settings (like bypass scripts) are applied correctly while maintaining a continuous MPV session.
- Added dynamic generation of `play_with_bypass` scripts (`.bat` for Windows, `.sh` for Linux/macOS) in the Installer, tailored to the user's selected browser.
- Added a browser selection dropdown to the Installer to configure cookies for the bypass script.
- Added startup dependency checks to the Installer to warn users if `mpv` or `yt-dlp` are missing from the system PATH.
- Added persistence for Installer preferences (e.g., last selected browser).
- Added support for launching MPV in a terminal window on Linux (via `--terminal` flag) by automatically detecting and using available terminal emulators.
- Updated `native_host.py` to support parsing JSON output from bypass scripts, allowing dynamic injection of HTTP headers (Referer, User-Agent) into MPV.

### Changed
- **Installer UI Layout:** Refactored the installer's main settings area to use a `grid` layout, ensuring proper alignment of labels and input fields for a cleaner and more robust user interface.
- Architectural refactoring of `installer.py` to use a platform-specific strategy pattern, improving maintainability and extensibility.
- Refactored folder data loading and migration in `file_io.py` to improve robustness and support various legacy data formats.
- Refactored `play_with_bypass.sh` to resolve URLs and output JSON metadata instead of piping directly to MPV. This allows the extension to maintain control over the MPV instance.
- The `play` action now queues items in the background script instead of immediately launching MPV, enabling seamless "stacking" of videos with individual processing.
- Refactored `native_host.py` to use a dictionary-based command dispatcher instead of a monolithic `if/elif` block, improving readability and maintainability.
- Extracted low-level IPC logic (process checking, command sending) into a new module `utils/ipc_utils.py` to reduce code duplication between `native_host.py` and `mpv_session.py`.
- Moved bypass script execution logic from `native_host.py` to `services.py` to separate business logic from the host controller.
- Centralized MPV command line argument construction and dependency checking in `services.py`, removing duplicate logic from `mpv_session.py` and `installer.py`.

### Fixed

- Fixed an issue on Linux where using the `--terminal` flag would cause a new MPV session for each queued item. The extension now correctly identifies the MPV process PID within the terminal.
- Fixed a crash in the installer caused by an invalid f-string format when generating the `play_with_bypass` script.



## [2.0.0] - 2025-12-20



### Added

- Added playlist display and management (remove, reorder) to the extension popup, mirroring the on-page controller's functionality.

- Implemented title color-coding (for episode numbers and YouTube channels) in the popup playlist for better readability.

- Added a new setting to manage automatic MPV flags, allowing users to enable/disable default flags like `--force-window` and `--no-terminal`.

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

- Fixed the scanner window's M3U8 detection timeout to be inactivity-based, preventing premature timeouts for slow-loading videos.

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

- Playlist in the on-page controller now automatically scrolls to newly added items if the list is long enough to be scrollable.

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
