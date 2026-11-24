---
name: playlist-operations-and-reordering
description: >-
  Governs playlist item schema normalization, auto-add stream ingestion, duplicate handling,
  SmartReorder similarity clustering, and drag-and-drop live MPV reordering. Load whenever
  modifying `utils/playlistManager.js`, `utils/item_processor.js`, `utils/item_processor.py`,
  `utils/smart_reorder.py`, `utils/PlaylistUI.js`, `utils/contextMenu.js`, or `background.js` auto-add.
---

# Playlist Operations, Reordering & Ingestion

## 1. Item Schema & Processing (`utils/item_processor.js`, `utils/item_processor.py`)
All playlist items must pass through `processPlaylistItem` (`{ url, title, id, settings, lastModified, currentlyPlaying, watched, resumeTime, markedAsWatched }`):
- **Sanitization:** Always run `sanitizeString()` and `normalizeYouTubeUrl()` to prevent control-character injection in `.m3u` files.
- **ID Preservation:** Never overwrite an existing `item.id` during title updates or reordering unless `forceNewId: true`. Breaking UUID stability breaks `lastPlayedId` tracking in running sessions.
- **LWW Timestamp:** Always update `lastModified` when mutating items so `file_io.py:_merge_playlists` reconciles changes accurately.
- **Playlist Expansion (`ItemProcessor.enrich_single_item`, `mpv_session.py`):** Dedicated YouTube playlist URLs (`url_analyzer.is_youtube_playlist_url`) expand into multiple items; `MpvSessionManager.start` splices the enriched slice (`_url_items_list[playlist_start_index:playlist_start_index + 1] = start_item_enriched`) so the placeholder is replaced cleanly.
- **Context Menu Canonicalization (`utils/contextMenu.js`, `background.js`):** "Add Playlist to MPV" matches both `/playlist?list=*` and `/watch?*list=*`, canonicalizing `/watch?...&list=<id>` to `https://www.youtube.com/playlist?list=<id>` before calling `playlistManager.handleAddFromContextMenu`.

---

## 2. Auto-Add Ingestion & Duplicate Matrix (`background.js`, `utils/playlistManager.js`)
- **Two-Stage Provisional Add:** Capture `(title, url, tabId)` snapshot → commit provisional item (`isProvisional: true`) immediately for zero-latency UI feedback → run background DOM scraper locked to `tabId` → surgically update via `handleUpdateItemTitle`.
- **5000ms URL Cooldown (`autoAddCooldowns`):** Persisted across service worker restarts to prevent `.m3u8` chunk cycling from flooding playlists.
- **Duplicate Handling (`settings.uiPreferences.global.duplicateUrlBehavior`):**
  - `"ask"`: Prompt via `promptUserConfirmation` on manual adds; silent reject (`return { success: true }`) on auto-add.
  - `"never"`: Reject without modal on both manual and auto-add.
  - `"always"`: Append with a newly generated UUID (`generateItemId()`).

---

## 3. Smart Reorder (`utils/smart_reorder.py`, `utils/playlistManager.js`)
- **Normalization (`SmartReorder.normalize_title`, `extract_metadata`):**
  1. Strip season tags via `SEASON_REGEX`.
  2. Strip explicit episode tags via `EXPLICIT_EPISODE_REGEX`.
  3. If no explicit tag exists, match `STANDALONE_EPISODE_REGEX` and strip **only the last** standalone number so numbered show titles (`"86 - 05"`, `"Mob Psycho 100 - 05"`) are preserved.
- **Clustering & Sorting:** Group normalized titles via `difflib.SequenceMatcher(threshold=0.85)`, then sort clusters ascending by `(season, episode)`.
- **Fresh Storage Read:** `utils/playlistManager.js:handleGetSmartReorder` **must** call `storage.get(true)` before writing reordered items back so concurrent additions are not overwritten.

---

## 4. Quick-Action Exclusivity & Live MPV Reorder (`utils/PlaylistUI.js`)
- **Mutually Exclusive Modes:** Pick Start (`#btn-osc-quick-a` / `isPickStartModeActive`), Live Reorder (`#btn-osc-quick-c` / `isLiveReorderModeActive`), and Selection Mode (`.btn-disconnected-toggle` / `isSelectionModeActive`) are strictly mutually exclusive—activating one **must** deactivate the other two and call `_refreshQuickActionsBar()`.
- **2000ms `reorder_live` Debounce:** Local DOM and Chrome storage update immediately on drop, but live MPV IPC sync (`sendCommandToBackground("reorder_live", folderId, { new_order: itemIds })`) **must** be debounced by 2000ms (`reorderDebounceTimer`) to avoid flooding MPV's event loop during drag-and-drop.
