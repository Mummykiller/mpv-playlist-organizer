# MPV Playlist Organizer - Architectural Hardening Handoff (Early 2026)

This document summarizes the major architectural improvements, resolved issues, and the current state of the codebase following the January 2026 stability sprint.

## 🛡️ Major System Hardening (v2.7.0)

### 1. Concurrency & Race Condition Resolution
*   **Atomic M3U Server**: Implemented a dedicated `server_lock` in `HandlerManager`. The lifecycle of the local M3U server (start, stop, update) is now fully atomic, preventing port collisions or multiple server instances during rapid concurrent requests.
*   **Thread-Safe IPC**: Added a `_send_lock` to `IPCSocketManager`. This protects the IPC channel, ensuring that low-level socket writes for commands and metadata registration don't interleave when multiple background threads (e.g., event listener and playlist tracker) talk to MPV simultaneously.
*   **Atomic Session Startup**: Moved the MPV launch sequence inside the primary `sync_lock` in `mpv_session.py`. This guarantees that only one MPV instance can be initialized at a time, eliminating race conditions during session handovers.
*   **Reentrant File Locking**: Upgraded `FileLock` in `file_io.py` to support reentrancy using `threading.RLock` and thread-local state. This prevents deadlocks when nested operations (like `set_settings` calling `get_settings`) occur within the same thread.

### 2. Frontend Modernization & Compatibility
*   **Namespaced Global Architecture**: Following a failed attempt at ES Modules (due to strict CSP restrictions on sites like YouTube/GitHub), the content scripts have been refactored into a **Namespaced Global** structure (`window.MPV_INTERNAL`). 
    *   **Why**: This provides the isolation of modules while maintaining 100% compatibility with Manifest V3 static script loading.
    *   **Result**: No more "Failed to fetch dynamically imported module" errors. The extension is now CSP-proof.
*   **Brain Surgery (Logic Centralization)**: Stripped all "smart" logic (YouTube normalization, stream validation) from the Content Script (`MpvController.js`).
    *   **The "Dumb" UI**: Content scripts now act as a passive UI layer, simply reporting page URLs to the background.
    *   **Background Authority**: `playlistManager.js` and `ui_state.js` now handle all URL analysis and normalization, ensuring a single source of truth for data saved to `folders.json`.
*   **Targeted Messaging**: Fixed a cross-tab bug where a video detected in a background tab would cause the "Add" button to glow in the active tab. Each tab now recognizes its own `tabId` and filters broadcast messages accordingly.

### 3. Terminal & IPC Stability
*   **Bulletproof Terminal Wrapping**: Refactored the Linux terminal wrapper logic in `services.py`. 
    *   **Environment Preservation**: The system no longer strips Qt environment variables when using a terminal wrapper, ensuring `konsole` and other Qt-based terminals can start correctly.
    *   **Arg Compatibility**: Standardized on the `-e` flag for terminal emulators to ensure commands are executed rather than just opening a blank prompt.
*   **Digital Handshakes**: Improved the `is_process_alive` check to verify the MPV PID via an actual IPC command (`get_property pid`), making reconnection much more reliable after browser restarts.

## 💾 Storage & Data Integrity
*   **Uniform Normalization**: Every entry point (Add button, Context Menu, Scanner) now passes through the centralized `normalizeYouTubeUrl` utility. This prevents duplicate entries caused by different URL formats (Shorts vs. Watch vs. Mobile).
*   **ID Persistence**: Reorder actions now correctly preserve item UUIDs, maintaining consistency between the browser UI and the `PlaylistTracker` in Python.

## 🔍 Remaining Issues (Status Report)

| Issue | Title | Status | Notes |
| :--- | :--- | :--- | :--- |
| **2** | Zombie MPV Risk | **Skipped** | Decision: Preserve MPV autonomy if browser closes. |
| **6** | Legacy Cleanup | **Pending** | `_get_emergency_log_path` and old try-blocks in UI. |
| **7** | Visual Feedback | **Pending** | Need "Syncing..." indicators for live reorder/remove. |
| **8** | Sanitization Audit| **In Progress** | Auditing newer handlers for `SANITATION_PLAN.md` compliance. |

## 🚀 Playback Performance (Standardized)
We have confirmed that 1440p+ stability is best achieved using:
1.  `remote-components=ejs:github` (Solves latest N-challenges).
2.  `js-runtimes=node` (Ensures `yt-dlp` uses the correct JS engine).
3.  `http_persistent=1` (Reduces segment overhead).
4.  `bv*[height<=?{q}][vcodec~='^vp0?9|^av01']+ba/best` (Optimized codec selection).

The system is now stable, concurrent-safe, and ready for high-volume use.