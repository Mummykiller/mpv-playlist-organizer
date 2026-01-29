# Project Handoff: State of the Master Branch Delta

This document outlines the recent technical fixes and the roadmap for completing the missing features from the master branch.

## ✅ Recently Completed (Technical & Stability)
*   **Metadata Handshake:** Implemented a temporary JSON-based handshake system. Fixes crashes on Windows and with large playlists by bypassing shell command-line limits.
*   **Robust State Restoration:** Normalized `mpv_playback_cache` keys to `camelCase`. Ensures the extension instantly recognizes active MPV sessions after browser restarts.
*   **Heartbeat Persistence:** Added a 30-second heartbeat to the Python tracker. Progress is now auto-saved to disk during playback, preventing data loss on crash.
*   **YouTube Optimization:** 
    *   Implemented **Lazy Cookie Extraction** (cookies are pulled only when the 30s threshold is hit).
    *   Fixed **Detached Mode 403 Errors** by syncing User-Agents and essential security flags directly into CLI arguments.
*   **Log Spam Reduction:** Batch operations now show a single "Preparing playlist..." message instead of individual "Analyzing..." logs.

---

## 🛠️ Immediate Next Step: Enhanced Live Synchronization
**Goal:** Allow "Global Sync" (deleting a video from all folders when it's watched once) to also affect running MPV instances if the user chooses.

### 1. New Setting: `syncGlobalRemovalsLive`
*   Add a toggle in `popup.html` under "Duplicate & Global Sync".
*   Label: "Also remove from running player".
*   Default: `false` (OFF).

### 2. Background Logic (`background/handlers/playback.js`)
*   Update `clearFolderPlaylist` to check for this new setting.
*   If enabled, when a URL is removed from a folder that isn't the primary one, check if that folder is currently active in MPV.
*   If active, trigger the existing `remove_item_live` command using that folder's specific item ID for that URL.

### 3. UI Refinement (`utils/MpvController.js`)
*   **Message Formatting:** Already updated to list items in separate "lanes" with bullet points for readability.
*   **Dynamic Warnings:** Ensure the "(This will also remove them from the running MPV instance)" warning only appears if:
    1. The folder is active.
    2. Live removal is enabled.
    3. The message isn't for a "Natural Completion" where MPV is already closing anyway.

---

## 🎨 Future Milestone: Per-Item Watch Tracking & Visuals
This phase focuses on the "Visual Polish" required to match the master branch experience.

1.  **Watched Threshold Logic:** Update Python tracker to officially trigger `is_watched = true` via the bridge the moment the 30-second session duration is met.
2.  **Visual Dimming:** Add CSS to `content.css` and `PlaylistRenderer.js` to set `opacity: 0.6` for items marked as watched.
3.  **Status Checkmarks:** Inject a green checkmark icon (`✓`) into the playlist item template for watched items.
4.  **Now-Playing Highlight:** Add logic to track the `currently_playing` ID (distinct from "Last Played") and add a unique visual highlight (e.g., a glow or bold border) to that item.
5.  **Settings Toggle:** Add "Show Watched Visual Effect" to the global settings to allow users to disable these effects.

---

## 📝 Technical Notes
*   **Cleanup:** Handshake files are currently cleaned up after a 10-second delay for unmanaged sessions and immediately upon `clear()` for managed sessions.
*   **Compatibility:** `safe_read_file` fallback is active in Lua scripts to support older MPV versions.
