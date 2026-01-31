# MPV Playlist Organizer: Future Architectural Refactors

This document outlines the next phase of "face-lifts" for the system, following the successful implementation of the **Proactive Reactive (Storage-as-the-Bus)** architecture. These changes aim to move the project from a "Request/Response" model to a "Batch/State" model.

---

## 1. Native Task & Job Manager (The "Progress Engine")
**Goal:** Transform the Native Host from a linear command processor into a stateful background worker.

### Current Problem
- Adding 20 items spawns 20 separate `yt-dlp` processes.
- The UI has no way to track overall progress beyond individual log messages.
- No way to "Cancel" a large batch add once it starts.

### The Face-Lift
- **The Queue:** Implement an `asyncio.Queue` in `native_host.py`.
- **The Storage Bus:** The Native Host maintains an `active_tasks` bucket in `chrome.storage.local`.
- **Structure:**
  ```json
  "active_tasks": {
    "job_id_123": {
      "type": "playlist_resolve",
      "status": "processing",
      "progress": 45,
      "total": 100,
      "label": "Resolving YouTube Playlist..."
    }
  }
  ```
- **UI Integration:** `UIManager.js` adds a global **Progress Dashboard**. When `active_tasks` is not empty, a small, elegant progress bar appears at the top of the controller, synced in real-time via storage events.

---

## 2. Smart Global Metadata Cache (The "Instant Renderer")
**Goal:** Decouple URL metadata (titles, AniList covers, durations) from specific folders to prevent redundant API calls.

### Current Problem
- If you have the same video in three different folders, the system might resolve its title three times.
- Switching folders causes a "delay" while the system verifies titles.
- High risk of hitting YouTube/AniList rate limits.

### The Face-Lift
- **The Global Shard:** Create a new storage bucket `mpv_metadata_cache` sharded by domain (e.g., `meta_youtube`, `meta_anilist`).
- **The Mechanism:**
  - Before the Native Host starts `yt-dlp`, it checks the local Metadata Cache.
  - If a match is found, it returns the data in **<10ms**.
  - If a new URL is resolved, the result is saved globally.
- **Result:** Every folder in your library benefits from the work done in any other folder. The UI feels "instant" because 90% of your media is already cached.

---

## 3. MPV IPC Watchdog (The "Ghost Hunter")
**Goal:** Ensure the UI never gets stuck in a "Loading..." or "Running" state if MPV crashes or hangs.

### Current Problem
- If the MPV process is killed externally (or crashes), the Background script might not realize it immediately.
- The UI stays in "Playing" mode until the user manually tries to click a button and gets an error.

### The Face-Lift
- **The Heartbeat:** The Native Host implements a sub-500ms heartbeat check on the MPV JSON-IPC socket.
- **The Health Flag:** Add a `health` property to the `active_playback_state` in storage.
- **Logic:**
  - `health: "ok"`: Normal operation.
  - `health: "stale"`: IPC is lagging; UI shows a warning.
  - `health: "dead"`: Native Host detected process exit.
- **Auto-Recovery:** The `PlaybackStateManager` reacts to `health: "dead"` by immediately wiping the cache and resetting all UI buttons to "Stop." No user intervention required.

---

## 4. Virtualized Playlist Rendering
**Goal:** Support playlists with thousands of items without slowing down the browser.

### Current Problem
- `PlaylistUI.render` creates a DOM element for every item. 
- A 500-item playlist can cause the browser's "Style Recalculation" to lag the entire tab.

### The Face-Lift
- **The "Windowing" Pattern:** Only render the ~20 items that are actually visible in the scroll container.
- **The Mechanism:** 
  - As the user scrolls, the UI swaps the *content* of the existing `div` elements instead of creating new ones.
  - Reuses the `updateItemDelta` logic to swap metadata on the fly.
- **Result:** Infinite playlist support with **0ms** performance degradation.
