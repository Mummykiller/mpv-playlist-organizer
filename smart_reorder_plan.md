# Smart Reorder Feature (Right-Click)

Adds a "Smart Reorder" feature to the playlist triggered by a right-click (context menu) on the "Live Reorder" button. This feature automatically groups similar shows, handles season/episode detection, and organizes the playlist for a better binge-watching experience.

## User Review Required

> [!IMPORTANT]
> This feature relies on string similarity and regex-based extraction. While 85% is the requested threshold, some highly generic titles (e.g., "Episode 1") might require manual adjustment if multiple unrelated shows use identical naming conventions.

## Proposed Changes

### UI Layer (Popup)

#### [MODIFY] [popup.js](file:///home/shinku/Documents/mpv-playlist-organizer/popup.js)
- Add a `contextmenu` listener to `btn-quick-c` (and its mini counterpart).
- Trigger a new bridge action `smart_reorder_live`.
- Display a "Smart Reordering..." status message while the operation is in progress.

```javascript
// Example implementation in btn-quick-c listener section
btn.oncontextmenu = (e) => {
    e.preventDefault();
    showStatus("Smart Reordering...");
    sendMessageAsync({
        action: "smart_reorder_live",
        folderId: miniFolderSelect.value
    }).then(res => {
        if (res.success) {
            showStatus("Playlist organized by show/episode.");
            refreshPlaylist();
        } else {
            showStatus(res.error || "Smart reorder failed.", true);
        }
    });
};
```

---

### Bridge Layer (Background)

#### [MODIFY] [background.js](file:///home/shinku/Documents/mpv-playlist-organizer/background.js)
- Register the `smart_reorder_live` action in `actionHandlers`.
- Forward the request to the Python backend via `nativeLink`.

---

### Backend Layer (Python)

#### [NEW] `utils/smart_reorder.py`
Create a dedicated utility for playlist organization logic.

- **Similarity Engine:** Use `difflib.SequenceMatcher` to calculate the 85% similarity threshold.
- **Title Normalization:** Strip "Season X", "S2", etc., for the comparison phase.
- **Extraction Regex:**
    - Season: `(?:Season\s*(\d+)|S(\d+))`
    - Episode: `(?:e(\d+)|Episode\s*(\d+)|(?:\s|^)(\d+)(?:\s|$))`
- **Sorting Logic:**
    1. Group items by normalized title.
    2. Sort groups by the earliest appearance in the original playlist (to preserve general user intent).
    3. Within each group:
        - Primary Sort: Season Number (0 if not found).
        - Secondary Sort: Episode Number (float for versions like 1.5).

#### [MODIFY] `playlist_server.py` or `native_host_handlers.py`
- Add the `smart_reorder_live` action handler.
- Load the playlist for the specified `folder_id`.
- Apply the `smart_reorder` logic.
- Update the playlist in memory and sync to MPV using the existing `reorder_live` IPC logic.

---

### MPV Integration
- The existing `reorder_live` implementation in `mpv_session.py` and `on_completion.lua` already handles dynamic playlist updates. No changes are required to the player layer.

## Verification Plan

### Manual Verification
1. Open the popup.
2. Load a folder with disorganized items like:
    - "e7 - Show A"
    - "e1 - Show B"
    - "e6 - Show A"
    - "S2 e1 - Show A"
3. Right-click the "Live Reorder" button.
4. Verify the playlist becomes:
    - "e6 - Show A"
    - "e7 - Show A"
    - "S2 e1 - Show A"
    - "e1 - Show B"
5. Verify that natural completion still works and points to the correct "next" item in the new order.

### Automated Tests
- Create `testing_tools/scripts/test_smart_reorder.py` to verify the grouping and sorting logic against a variety of edge-case strings (mixed case, different season formats, non-numeric episode titles).
