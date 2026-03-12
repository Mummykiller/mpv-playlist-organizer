# Changelog

All notable changes to the **MPV Playlist Organizer** project.

> **Note:** The creator primarily develops and uses this tool on Linux. While Windows compatibility is a major priority and actively tested, some platform-specific edge cases or features may be missed.
>
> **Security Warning:** While this update includes significant hardening against injection and path-related attacks, this application still facilitates the downloading and playback of media from external, potentially malicious third-party websites. Users should remain cautious and understand the inherent risks of streaming from unverified sources.

## [2.8.0] - 2026-03-12 (Auto-Add & Stream Collector)

### New Features & Capabilities
- **Auto-Add (Stream Collector):** Introduced a powerful new "passive" mode for collecting media while browsing.
    - **One-Click Activation:** Right-click the **"Add"** button in either the Popup or the On-Page Controller to toggle Auto-Add mode.
    - **Visual Feedback:** When active, the Add button displays a smooth **green-to-purple pulsing animation** to indicate the collector is "watching" for streams.
    - **Retroactive Detection:** Enabling Auto-Add immediately checks the current tab for previously detected streams and adds them automatically.
    - **Scanner Bypass:** Auto-Add utilizes direct tab messaging and `PageScraper` logic to extract high-quality titles and URLs **without opening scanner windows**, ensuring a zero-interruption workflow.
    - **Smart Inactivity Logic:** Added configurable settings to automatically disable Auto-Add after a period of inactivity (default 30s) to save resources.

### UI & UX Improvements
- **Log Consolidation:** Eliminated browser-log spam by grouping batch operations. Appending multiple items, restoring playlists, or preprocessing M3U files now show a single consolidated summary line (e.g., *"Adding X items to 'Folder'..."*) instead of individual "Running analysis..." entries.
- **Enhanced Tooltips:** Updated "Add" button descriptions to improve discoverability of the new right-click toggle feature.

### Stability & Bug Fixes
- **Module Resolution:** Fixed a `SyntaxError` in `playlistManager.js` caused by incorrect module exports and missing `itemProcessor` aliases.
- **Test Suite Robustness:** 
    - Restored `initialize_paths` in `file_io.py` to allow stable mocking of data directories during testing.
    - Increased heartbeat wait intervals in `test_robustness.py` to eliminate race conditions during throttled disk commits.
- **Anti-Spam Filter:** Implemented a 5-second per-URL cooldown for Auto-Add to prevent redundant additions on pages that rapidly re-report the same stream.

## [2.7.0] - 2026-03-09 (Windows Reliability & UI Polish)

### Platform & Installer Hardening
- **Windows Path Resilience:** Fixed several path-related failures on Windows, including incorrect quoting in the `run_native_host.bat` wrapper and standardized registry paths to use native backslashes.
- **Registry Reliability:** Implemented a "Chrome Fallback" registration strategy for Chromium-based browsers (Brave, Vivaldi, Edge) to ensure the Native Messaging host is correctly detected even if the browser-specific key fails.
- **Improved Dependency Detection:** Enhanced Windows detection for `yt-dlp` to automatically search inside the `mpv` folder (handling common "mpv+yt-dlp" combined installers).
- **Diagnostic Clarity:** Updated the dependency manager to provide explicit, named error messages for missing components (e.g., "Node.js not found" instead of generic "Not found").

### UI & UX Improvements
- **Minimize Button Fix:** Resolved a Windows-specific issue where the minimize ("-") button required two clicks. Optimized `Draggable.js` to only prevent default events during active drags and ensured `setMinimizedState` updates locally before background synchronization.
- **Playback State Synchronization:** Fixed a bug where the Play/Queue button would get stuck in a "loading" state. Standardized the broadcast of `isLaunching` and `isAppending` flags to ensure the UI always reflects the true backend state.

### Security & Sanitation
- **M3U Injection Hardening:** Hardened playlist generation by stripping shell-sensitive characters (`$` and `` ` ``) from titles, as mandated by the `@SECURITY.md` standards.
- **Defensive Programming:** Fixed a `TypeError` in the dependency manager that occurred when optional tools (like Node.js) were missing from the system.

### Development & DevOps Tools
- **New Release Script:** Introduced `testing_tools/create_release.py` to automate the generation of clean, production-ready project copies with smart file exclusion (ignoring dev tools, internal docs, and local logs).
- **Test Suite Overhaul:** Upgraded `run_suite.py` with automated test discovery for both Python and JS, and introduced a new `--watch` mode for real-time verification during development.
- **Watchdog Hardening:** Enhanced the `pycache_watchdog.py` utility with PID-based instance locking, a dedicated `kill` command, and custom process naming (`pycache_clear`) for better visibility in system monitors.

### Maintenance
- **JS Build Process:** Standardized the generation of legacy JS files from ES modules to ensure consistent behavior across all extension contexts.
- **State Logic Refactor:** Unified state objects in `ui_broadcaster.js` to prevent partial updates from causing UI "ghosting" or stuck loading indicators.

## [2.6.0] - 2026-03-08 (Stable Release)
### Platform & Core Stability
- **Windows Compatibility:** Hardened IPC and path handling for Windows (Named Pipes/Sockets).
- **YouTube Scanner Fix:** Removed redundant scanner windows for a cleaner background experience.
- **Modular Background:** Refactored monolithic `background.js` into specialized handlers.
- **Python Utility Centralization:** Moved core logic from `native_host.py` into a new `utils/` directory structure, including:
  - `ipc_utils.py`: Centralized IPC socket and communication logic.
  - `mpv_command_builder.py`: Dedicated class for constructing complex MPV command lines.
  - `item_processor.py`: Unified handling of playlist item metadata.
  - `janitor.py`: Automated cleanup of orphaned processes and sockets.

### New Features & Capabilities
- **Expanded Extension Permissions:** Added `unlimitedStorage`, `scripting`, and `alarms` for more robust background tasks and larger playlist support.
- **Enhanced Session Recovery:** Implemented a reliable handshake flow and orphaned process watcher to restore MPV sessions even after browser or host crashes.
- **Advanced URL Handling:** Added specialized support for YouTube (including history tracking and 30s threshold) and AnimePahe with integrated bypass scripts.
- **Unified API Normalization:** Implemented a consistent internal API for handling various streaming site data structures.

### UI & UX Improvements
- **Action Bar & Controls:** Introduced a new action bar in the extension popup with "Disconnected Play" and enhanced playback status indicators.
- **UI Performance:** Optimized popup responsiveness by implementing preference caching and reducing redundant message passing.
- **AniList Integration:** Improved the AniList renderer and UI components for better tracking and display of anime progress.
- **Styling Refactor:** Significant cleanup and modernization of `popup.css` and `content.css`.

### Reliability & Security
- **Logging Overhaul:** Implemented a comprehensive Python logging system and unified `SystemLogger.js` for better debugging.
- **Socket Management:** Fixed IPC socket deletion issues when the native host exits while MPV is still running.
- **Sanitization:** Added robust URL and input sanitization helpers across both JS and Python codebases.
- **Installer 2.0:** Completely refactored `installer.py` using a platform-specific strategy pattern and added a GUI (`installer_ui.py`) and diagnostics tool.

### Technical Debt & Maintenance
- **Refactoring:** Removed camelCase from Python code and snake_case from JS where appropriate for idiomatic consistency.
- **Error Handling:** Hardened asynchronous message channel handling to prevent "message channel closed" errors.
- **Performance:** Optimized `on_completion` scripts and playback managers to reduce CPU overhead during long sessions.

## [2.0.0] - Last Remote Version (GitHub)
- Basic playlist organization and MPV integration.
- Monolithic background and native host scripts.
- Initial support for core streaming sites.
