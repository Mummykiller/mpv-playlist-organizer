# Missing Features (Master Branch Delta)

This document tracks the features and improvements present in the `master` branch (commit `4661522`) that were missing from this version.

### 1. Per-Item Watch Tracking & Visuals
*   **Watched Threshold Logic:** The Python tracker now identifies when an item has been watched for 30 seconds. This triggers an immediate `is_watched` status update.
*   **Visual Dimming:** Items marked as "watched" now appear with **60% opacity** in the playlist UI to provide clear visual progress.
*   **Status Checkmarks:** A green checkmark (`✓`) is now displayed next to watched items (for non-YouTube items or when the YouTube sync GUI is disabled).
*   **Currently Playing Highlight:** Added logic to track and highlight the specific item currently active in MPV, distinct from the "last played" position.
*   **New Preferences:** Added a "Show Watched Visual Effect" toggle in the settings menu to enable/disable these dimming/checkmark effects.

### 2. Enhanced Live Synchronization
*   **Live Folder Clearing:** If the "Remove from Running Player" setting is enabled, using the **Clear** action on a folder in the browser will now automatically wipe those items from the running MPV instance's internal playlist.
*   **Sync Global Removals:** Improved the "Sync Global Removals" logic to ensure that if an item is removed from a background folder because it was cleared elsewhere, it is also removed live from MPV if that folder is currently playing.
*   **Robust State Restoration:** The `mpv_playback_cache` now uses normalized keys (`isRunning` instead of `is_running`) to ensure the UI instantly recognizes an active session upon browser restart.

### 3. Smart "Clear on Completion" Logic
*   **Title-Aware Confirmations:** Confirmation dialogs now list the specific titles of items being cleared (e.g., *'Clear "Episode 01" and 2 others?'*) instead of just a generic count.
*   **Scope Filtering:** When MPV finishes naturally, the "Clear" prompt now intelligently suggests removing only the items actually watched during that session, rather than blindly wiping the whole folder.
*   **Live Warning:** Confirmations now include a warning footer: *(This will also remove them from the running MPV instance)* if live sync is active.

### 4. YouTube Integration Improvements
*   **Lazy Cookie Extraction:** The tracker can now perform "lazy extraction" of cookies from your browser specifically for marking history, reducing startup overhead for the main player.
*   **History Sync in Selection Mode:** YouTube history marking now works correctly even when playing detached selections that aren't part of a formal folder.
*   **Sync Reliability:** Added a "quiet" mode for batch URL analysis to reduce log spam in the background while still ensuring YouTube metadata (like `mark_watched` preferences) is correctly passed to MPV.

### 5. Technical & Stability Updates
*   **API Normalization:** A major refactor of the messaging bridge to normalize snake_case (Python) and camelCase (JS) properties (e.g., `resume_time` ↔ `resumeTime`), preventing duplicate or "ghost" properties in the storage shards.
*   **MPV Compatibility:** Added a robust `read_file` fallback in `adaptive_headers.lua` to maintain compatibility with older MPV versions that lack the `utils.read_file` API.
*   **Atomic Syncing:** `fallback_sync.py` was optimized to perform slow network calls (YouTube API) outside of file-system locks, preventing UI hang-ups when the tracker saves state.
*   **Metadata Handshake:** Enhanced the "Static Metadata Handshake" to pass project root and folder IDs directly to MPV via a temporary JSON file, bypassing shell command-line length limits.
