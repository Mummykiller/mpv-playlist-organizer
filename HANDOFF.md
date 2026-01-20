# Project Handoff - January 20, 2026

## 1. AnimePahe Filter Expansion
- **Broadened Domain Support:** Added `uwucdn.top` to the AnimePahe "Native Bypass" logic.
- **Affected Files:** `utils/url_analyzer.py`, `services.py`, `utils/session_services.py`, and `mpv_scripts/adaptive_headers.lua`.
- **Outcome:** All AnimePahe vault links (owocdn or uwucdn) now receive correct `Referer` headers and use MPV's native networking for maximum speed.

## 2. Smart Resume & Staggered Loading
- **Tracker Fix:** Removed a redundant, broken definition of `_update_last_played` in `playlist_tracker.py` that was preventing progress from saving to disk.
- **Smart Launch:** Refactored folder playback to use the **Standard Flow** (staggered launch). It now starts the last-played item instantly and loads the rest in the background.
- **Batched Loading:** Background enrichment in `utils/session_services.py` now processes the "Future" block then the "History" block in batches. This ensures strict ordering without multi-threading race conditions.
- **Index Alignment:** Fixed a bug where MPV was told to start at a high index when only one item was initially loaded. It now starts at 0 and maps metadata correctly.

## 3. Safe Reverse Sync (Browser Crash Protection)
- **Deep Handshake:** `mpv_session.py` now returns the *entire* playlist state (including all resume times) when the browser reconnects.
- **Identity Protection:** The extension now verifies folder IDs during restoration. It will refuse to sync data for folder names it doesn't recognize (preventing the "Two Defaults" split).
- **Full Sync:** Implementation in `background/handlers/playback.js` ensures that all `resume_time` updates made while the browser was closed are synced back into `chrome.storage.local`.
- **Fallback Security:** `utils/fallback_sync.py` now checks `index.json` before writing. It will abort if a folder isn't officially registered, preventing "ghost" files on the drive.

## 4. Reliability & Performance
- **Faster Close:** Reduced shutdown hang time by 2-3 seconds by optimizing IPC reconnection and process wait timeouts in `utils/session_services.py`.
- **Double-Launch Fix:** Moved the launch logic inside the `sync_lock` in `mpv_session.py` to prevent rapid clicks from starting multiple MPV instances.
- **Logging Visibility:** Added a `python_log` hook to `mpv_scripts/python_loader.lua` so background enrichment status is visible in the MPV terminal.
- **Stability:** Fixed critical indentation and variable initialization errors in `mpv_session.py`.

## 5. Known State
- **Source of Truth:** The Browser remains the primary source, but the Python backend now acts as a robust, verified backup that can restore the browser's state after a crash or CLI session.
- **CLI Support:** CLI playback now fully supports Smart Resume and will sync its progress back to the browser the next time it is opened.