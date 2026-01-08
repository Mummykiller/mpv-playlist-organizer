# MPV Playlist Organizer - Architectural Hardening Handoff (Early 2026)

This document summarizes the major architectural improvements, resolved issues, and the current state of the codebase following the January 2026 stability sprint.

## 🛡️ Major System Hardening (v2.7.0)

### 1. Concurrency & Race Condition Resolution
*   **Atomic M3U Server**: Implemented a dedicated `server_lock` in `HandlerManager`. The lifecycle of the local M3U server (start, stop, update) is now fully atomic, preventing port collisions or multiple server instances during rapid concurrent requests.
*   **Thread-Safe IPC**: Added a `_send_lock` to `IPCSocketManager`. This protects the IPC channel, ensuring that low-level socket writes for commands and metadata registration don't interleave when multiple background threads (e.g., event listener and playlist tracker) talk to MPV simultaneously.
*   **Atomic Session Startup**: Moved the MPV launch sequence and initial folder state retrieval inside the primary `sync_lock` in `mpv_session.py`. This guarantees that only one MPV instance can be initialized at a time, eliminating race conditions during session handovers.
*   **Robust File Locking**: Overhauled `FileLock` in `file_io.py`.
    *   **Per-Path Locking**: Switched from a global lock to a granular per-path system, ensuring that a lock on `folders.json` doesn't block access to `config.json`.
    *   **Stale Lock Detection**: The system now records the PID in lock files and automatically clears them if the associated process has died, preventing permanent deadlocks after crashes.

### 2. Frontend Modernization & Compatibility
*   **Namespaced Global Architecture**: Following a failed attempt at ES Modules (due to strict CSP restrictions on sites like YouTube/GitHub), the content scripts have been refactored into a **Namespaced Global** structure (`window.MPV_INTERNAL`). 
    *   **Why**: This provides the isolation of modules while maintaining 100% compatibility with Manifest V3 static script loading.
    *   **Result**: No more "Failed to fetch dynamically imported module" errors. The extension is now CSP-proof.
*   **Brain Surgery (Logic Centralization)**: Stripped all "smart" logic (YouTube normalization, stream validation) from the Content Script (`MpvController.js`).
    *   **The "Dumb" UI**: Content scripts now act as a passive UI layer, simply reporting page URLs to the background.
    *   **Background Authority**: `playlistManager.js` and `ui_state.js` now handle all URL analysis and normalization, ensuring a single source of truth for data saved to `folders.json`.
*   **Targeted Messaging**: Fixed a cross-tab bug where a video detected in a background tab would cause the "Add" button to glow in the active tab. Each tab now recognizes its own `tabId` and filters broadcast messages accordingly.

### 3. Terminal & IPC Stability
*   **Digital Handshakes (Reconnection)**: Reconnection logic is now bulletproof.
    *   **Real PID Resolution**: The system now queries the *actual* MPV PID via IPC immediately after launch, ignoring the wrapper's PID.
    *   **Orphan Watcher**: If a terminal wrapper exits but MPV stays alive, the background watcher correctly identifies the orphaned process and maintains control.
*   **Bulletproof Terminal Wrapping**: Refactored the Linux terminal wrapper logic in `services.py`. 
    *   **Environment Preservation**: The system no longer strips Qt environment variables when using a terminal wrapper, ensuring `konsole` and other Qt-based terminals can start correctly.
    *   **Arg Compatibility**: Standardized on the `-e` flag for terminal emulators to ensure commands are executed rather than just opening a blank prompt.

## 💾 Storage & Data Integrity
*   **Uniform Normalization**: Every entry point (Add button, Context Menu, Scanner) now passes through the centralized `normalizeYouTubeUrl` utility. This prevents duplicate entries caused by different URL formats (Shorts vs. Watch vs. Mobile).
*   **ID Persistence**: Reorder actions now correctly preserve item UUIDs, maintaining consistency between the browser UI and the `PlaylistTracker` in Python.
*   **Live Synchronization**: Reorder, Remove, and the new **Clear** actions now synchronize instantly across all tabs and the live MPV session (if active), providing a seamless experience regardless of which UI context is used.

## 🔍 Remaining Issues (Status Report)

| Issue | Title | Status | Notes |
| :--- | :--- | :--- | :--- |
| **2** | Zombie MPV Risk | **Resolved** | Decisions: Autonomy preserved; Reconnection hardened. |
| **6** | Legacy Cleanup | **Completed** | Audited handlers and removed redundant frontend logic. |
| **7** | Visual Feedback | **Pending** | Need "Syncing..." indicators for live reorder/remove. |
| **8** | Sanitization Audit| **Completed** | Full implementation of SANITATION_PLAN.md across all layers. |

## 🚀 Playback Performance (Standardized)
We have confirmed that 1440p+ stability is best achieved using:
1.  `remote-components=ejs:github` (Solves latest N-challenges).
2.  `js-runtimes=node` (Ensures `yt-dlp` uses the correct JS engine).
3.  `http_persistent=1` (Reduces segment overhead).
4.  `bv*[height<=?{q}][vcodec~='^vp0?9|^av01']+ba/best` (Optimized codec selection).

The system is now stable, concurrent-safe, and ready for high-volume use.