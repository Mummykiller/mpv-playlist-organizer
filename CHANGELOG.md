# Changelog

All notable changes to the **MPV Playlist Organizer** project, summarizing the 134 commits from version 2.0.0 to 2.6.0.

## [2.6.0] - Current Local Version
### Architectural Overhaul
- **Modular Service Worker:** Refactored `background.js` from a monolithic file into a modular architecture with specialized handlers in `background/handlers/` (playback, storage, messaging, ui_state, etc.).
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
