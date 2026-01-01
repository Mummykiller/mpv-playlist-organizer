# MPV Playlist Organizer - Session Handoff (Jan 1, 2026 - Turn 2)

## 📂 Recent Structural Changes
- **Dual-State Highlighting**: Playlists now distinguish between "Active" (currently playing in MPV) and "Inactive" (previously played). 
- **Universal M3U Append**: All live additions to MPV now use the temporary M3U "batch" method to guarantee title preservation via `#EXTINF`.
- **Refined Smart Resume**: Switched from list-reordering to a "Delayed Prepend" strategy to maintain the user's original playlist order while starting at specific episodes.

## 🛠 Features & Reworks Implemented

### 1. Robust Manual Quit (✅ COMPLETED)
- **Signal Chain**: The controller now sends a `manual_quit_initiated` script message before `quit`.
- **Lua/Python Safeguards**: `on_completion.lua` and `mpv_session.py` both respect this flag to prevent "natural completion" logic (like auto-clearing) from triggering when the user explicitly closes the player.

### 2. Precise Resume (✅ NEW)
- **Timestamp Tracking**: Added `enable_precise_resume` setting.
- **Mechanism**: The tracker now polls `time-pos` and performs a "Final Save" on skip/quit.
- **Forceful Resumption**: Launches MPV with the `--start=<seconds>` flag, bypassing MPV's often inconsistent `watch_later` hashes for network streams.

### 3. Smart Order Restoration (✅ OPTIMIZED)
- **Phase 1 (Launch)**: MPV opens instantly with the target episode.
- **Phase 2 (Append/Prepend)**: After a 2s delay, future items are appended, and history items are prepended to the front via IPC `playlist-move`. 
- **Outcome**: Player starts at index 0 and naturally shifts to its correct position (e.g., index 4) as the full list is restored around it.

### 4. Interactive Live Updates (✅ ADDED)
- **Add-to-Active**: New setting "Add to Active Player Automatically". If enabled, clicking "Add" sends the item to the player instantly.
- **Live Removal**: New setting "Remove from Active Player Automatically". Allows toggling whether deleting in the UI affects the running player.
- **Play-as-Sync**: Clicking "Play" on a folder that is already active now acts as a manual sync, appending any items added while the player was closed.

### 5. Session Recovery (✅ FIXED)
- **IPC Reconnection**: Fixed bugs where `restore()` failed to initialize the `ipc_manager` or set the `is_alive` flag.
- **Background Sync**: The background script now correctly updates its `isPlaying` state when a session is successfully reconnected on startup.

### 6. UI Enhancements (✅ COMPLETED)
- **Text Wrapping**: Removed `nowrap` and `ellipsis` from settings labels and section headers. Long descriptions now wrap correctly without colliding with checkboxes.
- **Visual Feedback**: MPV now shows OSD messages (e.g., "Appended 2 items") when syncing.

## 📂 Key Files Modified
- `mpv_session.py`: Core logic for launch, append, and restoration.
- `playlist_tracker.py`: Real-time coordinate for time-tracking and episode changes.
- `utils/native_host_handlers.py`: Fixed early-return bugs and synchronized M3U enrichment.
- `background/handlers/playback.js`: State management for session restoration.
- `utils/playlistManager.js`: Integrated live append/removal logic.
- `popup.html` / `popup.css`: New behavior settings and label wrapping.

## 💡 Technical Implementation Notes

### 1. The Prepend Strategy
- Items added to the start of the list are moved using: `self.ipc_manager.send({"command": ["playlist-move", source_idx, target_idx]})`. 
- The `source_idx` is always `total_len - history_count` because new items are appended to the end before being moved.

### 2. Title Preservation
- Never use `loadfile` for live appends if you want a title. Always use `append_batch` which generates a delta M3U and uses `loadlist`.

### 3. Highlighting Logic
- `active-item`: Full green glow (Player is running this folder).
- `last-played-item`: Number only highlighted in accent color (Folder is inactive, but this is where you left off).