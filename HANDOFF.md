# MPV Playlist Organizer - Sanitization Pass & Performance Optimization (Technical Handoff V7)

This handoff details the implementation of a project-wide security/sanitization audit and a significant performance optimization pass to improve UI responsiveness and reduce system overhead.

## 🛠️ Key Improvements & Fixes

### 1. Robust Sanitization Pass (Defense-in-Depth)
*   **Regex Synchronization:** Unified `sanitizeString` logic across all JavaScript handlers (`content.js`, `folder_management.js`, `import_export.js`).
    *   **Filenames/Folders:** Strict blacklist: `/ \ : * ? " < > | $ ; & ` ` and line breaks/tabs.
    *   **URLs/Titles (Minimal Destruction):** Strips only `"`, `` ` ``, and line breaks/tabs while **strictly preserving** `&`, `?`, `=`, `;`, and `$` to maintain URL functionality.
*   **Import Security:** Hardened `import_export.js` to re-sanitize all URLs, titles, and derived folder names during file imports, preventing malicious JSON from entering storage.
*   **yt-dlp Hardening:** Expanded the `BLOCKED_KEYS` list in `file_io.py` to include more dangerous flags such as `--downloader`, `--plugin-dirs`, and `--ffmpeg-location` to prevent Remote Code Execution (RCE).
*   **Sanitization Plan Sync:** Updated `SANITATION_PLAN.md` to accurately reflect the 4-layer defense strategy and the actual characters being stripped vs. preserved.

### 2. Performance & Bottleneck Optimization
*   **Settings Load Speed:** 
    *   Implemented a 10-minute in-memory cache for native host info (like the recommended hardware decoder) in `ui_state.js`.
    *   Consolidated redundant IPC calls during the settings initialization flow.
*   **Python-Side Caching:** Added a 5-minute memory cache in `services.py` for dependency status checks. Slow shell commands (like `yt-dlp --version`) are now only executed once every few minutes instead of on every request.
*   **UI Responsiveness:**
    *   **Playlist Caching:** `PlaylistUI.js` now maintains a local `currentPlaylist` cache.
    *   **Messaging Efficiency:** `content.js` now uses this local cache for its 500ms `updateAddButtonState` loop, eliminating thousands of redundant background messages.
    *   **Observer Optimization:** Streamlined the `MutationObserver` in `content.js` to be less aggressive, reducing CPU overhead on dynamic sites like YouTube.
*   **Consolidated Fetching:** Combined `get_all_folder_ids` and `get_last_folder_id` into a single logic flow in `updateFolderDropdowns`.

### 3. Bug Fixes
*   **Null Pointer Guard:** Fixed a `TypeError: Cannot read properties of undefined (reading 'startsWith')` in `m3u8_scanner.js` by adding a safety check for `tab.url` during early "loading" states.

## 📂 Verification Steps
1.  **Sanitization Test:** Create a folder with characters like `&` or `$`. Verify it is cleaned. Add a URL with complex parameters. Verify the parameters are **preserved** and the video plays.
2.  **Settings Snapiness:** Open the settings tab, close the popup, and re-open it immediately. The hardware decoder and other native info should load instantly from the cache.
3.  **CPU/Network Audit:** Monitor the "Background Page" console and "Network" tab. You should see significantly fewer messages being sent between the content script and background script during normal browsing.

## 🚀 Next Steps
*   **Global Sanitization Utility:** Consider moving the duplicated `sanitizeString` JS logic into a shared utility module to prevent future drift.
*   **Cache Invalidation UI:** Add a "Force Refresh Dependencies" button in the diagnostics section to manually clear the new 5-minute status cache.
*   **Multi-Instance Tracking:** (Carried forward) Investigate supporting multiple simultaneous MPV windows via a Map-based tracker.
