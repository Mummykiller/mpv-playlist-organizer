# Smart Reorder Feature (Two-Stage Sync)

Adds a "Smart Reorder" feature to the playlist triggered by a right-click (context menu) on the "Live Reorder" button. This feature uses a two-stage workflow to organize the playlist locally before optionally syncing to an active MPV session.

## User Review Required

> [!NOTE]
> This implementation splits sorting and syncing into two distinct user actions to prevent accidental playlist disruption during playback. The first right-click sorts the UI; the second right-click (indicated by a glowing button) syncs to MPV.

## Proposed Changes

### UI Layer (Popup & CSS)

#### [MODIFY] [popup.css](file:///home/shinku/Documents/mpv-playlist-organizer/popup.css)
Add a "glow" animation and a class to indicate a pending sync.

```css
@keyframes smart-glow {
    0% { box-shadow: 0 0 5px var(--accent-primary); }
    50% { box-shadow: 0 0 15px var(--accent-primary); border-color: var(--accent-primary); }
    100% { box-shadow: 0 0 5px var(--accent-primary); }
}

.smart-sync-pending {
    animation: smart-glow 1.5s infinite;
    color: var(--accent-primary) !important;
    border-color: var(--accent-primary) !important;
}
```

#### [MODIFY] [popup.js](file:///home/shinku/Documents/mpv-playlist-organizer/popup.js)
- Implement the two-stage logic in the `oncontextmenu` handler for `btn-quick-c`.
- **Stage 1 (Sort UI):** Call `get_smart_reorder`. Update `popupState.currentPlaylist` and re-render. If MPV is running, add `smart-sync-pending` class.
- **Stage 2 (Sync MPV):** If `smart-sync-pending` is active, call `reorder_live` and remove the class.

```javascript
btn.oncontextmenu = (e) => {
    e.preventDefault();
    const folderId = miniFolderSelect.value;
    
    // Stage 2: Sync to MPV
    if (btn.classList.contains("smart-sync-pending")) {
        const itemIds = popupState.currentPlaylist.map(item => item.id);
        MpvInterface.reorderLive(folderId, itemIds).then(res => {
            if (res.success) {
                showStatus("MPV playlist synchronized.");
                btn.classList.remove("smart-sync-pending");
            }
        });
        return;
    }

    // Stage 1: Sort UI
    showStatus("Calculating smart order...");
    sendMessageAsync({
        action: "get_smart_reorder",
        folderId: folderId
    }).then(res => {
        if (res.success && res.playlist) {
            renderPlaylist(res.playlist, popupState.lastPlayedId, popupState.isFolderActive);
            showStatus("Playlist organized. Right-click again to sync MPV.");
            
            if (popupState.isFolderActive) {
                btn.classList.add("smart-sync-pending");
            }
        }
    });
};
```

---

### Bridge Layer (Background)

#### [MODIFY] [background.js](file:///home/shinku/Documents/mpv-playlist-organizer/background.js)
- Register `get_smart_reorder` action.
- Call `nativeLink.getSmartReorder(folderId)`.

---

### Backend Layer (Python)

#### [MODIFY] `native_host_handlers.py`
- Add `get_smart_reorder` handler.
- Use the `SmartReorder` utility created in `utils/smart_reorder.py` to organize the folder's playlist.
- Return the sorted items to the extension.

---

### Verification Plan

#### Manual Verification
1. Load a folder with mixed episodes (e.g., Ep 1, Ep 10, Ep 2).
2. Start MPV.
3. **Right-click** "Live Reorder" button.
4. Verify the UI list sorts correctly (Ep 1, Ep 2, Ep 10).
5. Verify the button starts **glowing**.
6. **Right-click** again.
7. Verify MPV's internal playlist matches the new UI order.

#### Automated Tests
- Test `utils/smart_reorder.py` against edge cases (S1 vs No Season).
- Mock `get_smart_reorder` in JS tests to verify the `smart-sync-pending` class toggle.
