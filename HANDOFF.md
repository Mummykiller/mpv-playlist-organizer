# Agent Handoff: Playback State Consolidation & terminology Refinement

## 🎯 Current Status
The UI state management system has been completely refactored to a **State Machine** architecture. The "Vanishing Glow" and flickering play button issues are **Resolved**. The system now uses a unified "Queue" terminology instead of "Append".

---

## ✅ Completed Tasks

### 1. Unified Playback State Machine
*   **Created `utils/PlaybackStateManager.js`**: A Singleton Observable that manages high-level transitions: `STOPPED` → `LOADING` → `PLAYING` / `PAUSED`.
*   **Graceful Idle Handling**: The manager now treats MPV's "Idle" blips as transitions. Visual states (`PLAYING`/`PAUSED`) are maintained during file loads or seeks, preventing UI flickering.
*   **Centralized Subscription**: Both the On-Screen Controller (OSC) and the Popup now subscribe to this manager, ensuring 100% visual parity across all UI instances.

### 2. Bridge Normalization & Protocol Stability
*   **Normalizing Bridge**: Updated `utils/nativeConnection.js` with a `normalizePayload` layer. All upper-layer logic now uses consistent camelCase keys (`isRunning`, `isPaused`, `folderId`), regardless of whether the source was Python (snake_case) or the local cache.
*   **Lightweight Broadcasting**: Implemented `broadcastPlaybackState` in the background script. Status updates now send tiny state packets instead of the entire playlist array, significantly reducing CPU overhead.
*   **Direct Sync Handshake**: UI components now call `requestSync()` on focus/load, triggering a `get_playback_status` call that performs a "Deep Sync" with the background cache and native host.

### 3. Terminology: Append → Queue
*   **UI Renaming**: Standardized all labels to **"Queue"** (e.g., "Queue to Playlist").
*   **Logic Alignment**: Updated internal checks (like `needsAppend`) to correctly trigger the "Queue" state when new items are added to an active folder.
*   **Log Clarity**: Background logs now report "Queued [Item]" for better user feedback.

### 4. Bug Fixes & Stability
*   **TypeError Resolution**: Fixed several crashes in `popup.js` where `playlist.length` was accessed without checking for null (common during partial status updates).
*   **Process Liveness**: Decoupled the "Active" (Blue Glow) state from the "Idle" property. The controller now stays active as long as the MPV process is alive for that folder.
*   **Initialization Reordering**: Fixed a race condition in `MpvController.js` where state updates were arriving before the Shadow DOM was fully initialized.

---

## 💡 Notes for the Next Agent
*   **State Machine Priority**: Always prefer updating/querying `MPV.playbackStateManager` over raw ContentState for playback-related icons or glows.
*   **Bridge Consistency**: If adding new Python properties to the tracker, add them to the `mapping` in `utils/nativeConnection.js` to keep the frontend clean.
*   **Future Feature**: The `LOADING` state is now ready for a proper spinner implementation ifyt-dlp resolution takes a significant amount of time.

## 🏁 Final Sign-off
The core communication loop between MPV, the Python Host, and the Browser UI is now stable and predictable. The "Queue" feature is fully integrated and robust.