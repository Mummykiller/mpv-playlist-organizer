# Architectural Debt: The "Re-render Storm" Issue

This document tracks a significant logic flaw discovered in the "Storage-as-the-Bus" implementation that currently negates the performance benefits of the Delta Update system.

---

## 1. The Conflict: Sledgehammer vs. Scalpel
**The Issue:** The system is currently performing a "Full DOM Rebuild" every time a "Surgical Update" occurs.

### How it breaks:
1. **The Background** updates an item's `resume_time` and saves the entire folder shard to `chrome.storage.local`.
2. **The Storage Observer** in `MpvController.js` sees the shard change and immediately calls `playlistUI.render()`.
3. **The Result:** The entire 200-item DOM list is destroyed and recreated just to update one number.
4. **The Redundancy:** Simultaneously, the background sends an `update_playlist_item` signal for the "Delta Update," but it arrives *after* the DOM has already been rebuilt slowly.

---

## 2. Payload Overload
**The Issue:** The IPC (Inter-Process Communication) pipe is still clogged.

- **Status:** `ui_broadcaster.js` is still including the full `playlist` array in its broadcast messages.
- **Problem:** Even though we have a "Storage-as-the-Bus" model, we are still pushing massive amounts of redundant data through the messaging system, wasting CPU and memory.

---

## 3. Necessary Fixes (The "Face-Lift" for the Face-Lift)

### A. Intelligence in the Storage Observer
The storage listener needs a "Change-Type" filter:
- If `new_list.length !== old_list.length` $\rightarrow$ **Structural Change** (Full Render).
- If `new_list[i].id !== old_list[i].id` $\rightarrow$ **Reorder Change** (Full Render).
- Otherwise $\rightarrow$ **Ignore Storage Update** (Let the Delta Message handle property changes).

### B. "Data-Less" Signaling
- Strip the `playlist` array from all broadcast messages.
- Change `render_playlist` message to `data_dirty`.
- The Tab should decide whether it needs to pull the data from storage based on its visibility and current folder.

### C. Write-Throttling in Background
- Frequency-dependent data (like `resume_time`) should be batched or "silently" written to storage without triggering a full shard update notification if possible.

---

## 4. Risks of Ignoring This
- **UI Stutter:** Frequent updates during playback will cause noticeable lag in the playlist view.
- **Battery Drain:** Mobile/Laptop users will see significantly higher power usage due to constant DOM reconstruction.
- **Race Conditions:** If two updates happen in rapid succession, the "Full Render" might overwrite a "Delta Update" that was just applied.
