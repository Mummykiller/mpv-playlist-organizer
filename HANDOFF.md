# MPV Playlist Organizer - Handoff V8

This handoff details the implementation of the "Smart Update" system, the centralization of sanitization logic, and new diagnostic capabilities.

## 🛠️ Key Improvements & Fixes

### 1. Smart Update System (Performance & Accuracy)
*   **Hashed State Tracking:** `content.js` now uses a hashing mechanism (`performSmartUpdate`) to track the controller's state (playlist content, MPV status, AniList visibility). It only triggers a DOM redraw if the state actually changes.
*   **Debounced Refreshing:** Added `requestUpdate` (50ms debounce) to handle rapid-fire messages from the background script without UI flickering or CPU spikes.
*   **Proactive Broadcasts:** Updated `playback.js` to broadcast updates on critical events (MPV exit, item append, last played update), ensuring all tabs and the popup are perfectly synchronized.

### 2. Centralized Sanitization
*   **New Utility:** Created `utils/sanitization.js` to house the unified `sanitizeString` logic.
*   **Deduplication:** Removed local `sanitizeString` copies from `playlistManager.js`, `folder_management.js`, and `import_export.js`.
*   **Strict vs. Minimal:** The utility correctly distinguishes between "Strict" filename sanitization (for folders) and "Minimal" destruction (preserving URL parameters).

### 3. Diagnostics & Cache Control
*   **Diagnostics UI:** Added a "Diagnostics & Dependencies" section to the settings popup.
*   **Cache Invalidation:** Implemented a "Force Refresh Dependencies" button that clears the 5-10 minute caches in both JS and Python, triggering a fresh system scan for `mpv` and `yt-dlp`.

### 4. Issue Tracking
*   **Expanded Backlog:** Updated `issues.md` with 5 new architectural improvements, including utility consolidation, standardized logging, and native host health checks.

## 📂 Verification Steps
1.  **Smart Update Test:** Open multiple tabs. Add an item in one tab; verify the controller in other tabs updates its count immediately without a page refresh.
2.  **MPV Sync:** Close MPV. Verify the green "active" highlight disappears in all open tabs and the popup simultaneously.
3.  **Sanitization Check:** Rename a folder using illegal characters (e.g. `Folder/Name?`). Verify it is cleaned correctly using the new shared utility.

## 🚀 Next Steps
*   **Consolidate Infrastructure:** Move `debounce` and `sendMessageAsync` into a shared utility file.
*   **Heartbeat Mechanism:** Implement a proactive "Native Host Status" check to detect Python crashes.
*   **Storage Maintenance:** Add a janitor task for pruning orphaned metadata in `chrome.storage`.

## ⏭️ Instructions for the Next Agent
1.  **Read Issues:** Open `issues.md` and read the listed issues one by one.
2.  **Verify Issues:** For each issue, perform the necessary steps to verify its existence and understand its impact.
3.  **Develop Plans:** Come up with a clear, grounded plan for resolving each verified issue.
4.  **Communicate:** Share your findings and the proposed plan with the user before proceeding with implementation.