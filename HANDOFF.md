# MPV Playlist Organizer - Networking Infrastructure & Bi-Directional Sync (Technical Handoff V6)

This handoff details the resolution of networking settings synchronization issues, the implementation of new performance-tuning settings, and the unification of preference management between the Extension and Native Host.

## 🛠️ Key Improvements & Fixes

### 1. Unified Settings Infrastructure
*   **Resolved ID Mismatches:** Fixed multiple discrepancies between `popup.html` and `utils/settings.js` that prevented settings from saving or loading correctly (including `Max Buffer RAM`, `Active Item Highlight`, and `Open Popup Keybind`).
*   **Bi-Directional Sync:** Implemented a real-time sync system where global preferences changed in the extension UI are immediately written to the native host's `config.json`.
*   **Dynamic Overrides:** Updated the playback flow to gather all networking and performance settings at the moment of playback. These are now sent as overrides to the Native Host, ensuring UI changes apply immediately to the next video without requiring a browser/extension restart.

### 2. Enhanced Networking & Performance
*   **Network Threads (Concurrent Fragments):**
    *   **New Setting:** Added a UI control for download parallelism.
    *   **Logic Unification:** Linked this setting to both yt-dlp (`concurrent-fragments`) and FFmpeg (`hls_segment_parallel_downloads`).
    *   **Default:** Increased default from 1 to **4** for better out-of-the-box buffering performance.
*   **Auto-Reconnect System:**
    *   **New Settings:** Added "Enable Auto-Reconnect" toggle and "Reconnect Delay (s)" input.
    *   **Lua Integration:** Updated `adaptive_headers.lua` to dynamically apply `reconnect` flags to the MPV engine based on these UI settings.
    *   **Master Override:** These settings are automatically bypassed if "Use MPV Defaults" is enabled.

### 3. Native Host Enhancements
*   **Preference Handlers:** Added `get_ui_preferences` and `set_ui_preferences` to the Native Host API, allowing the extension to act as a frontend for the `config.json` file.
*   **MPV Command Builder:** Updated `services.py` to prioritize extension-provided networking flags over file-based defaults.

### 4. Code Reliability & Bug Fixes
*   **Syntax Correction:** Fixed multiple `SyntaxError` and indentation issues in `mpv_session.py` regarding the construction of the `lua_options` dictionary.
*   **Audit Pass:** Completed a full audit of all UI element IDs in `settings.js` against `popup.html`, confirming 100% mapping accuracy.

## 📂 Verification Steps
1.  **Buffer Persistence:** Set "Max Buffer (RAM)" to `2G`. Close and re-open the popup. Verify the value remains `2G` and check `config.json` to confirm it was synced to disk.
2.  **Thread Speedup:** Set "Network Threads" to `8`. Launch a high-bitrate HLS stream. Check the MPV terminal logs (if visible) to verify `hls_segment_parallel_downloads=8` is being applied by `AdaptiveHeaders`.
3.  **Reconnect Toggle:** Disable "Enable Auto-Reconnect". Launch a stream and verify in the MPV logs that the `reconnect` demuxer options are no longer being set.

## 🚀 Next Steps
*   **Multi-Instance Tracking:** Investigate migrating the background `playbackQueueInstance` from a singleton to a Map to support multiple simultaneous MPV windows.
*   **Smart Resume Precision:** Add an option to auto-seek back 2-3 seconds when resuming a video to provide better context (Smart Resume Precision).
*   **Connection Quality Indicator:** Consider adding a small OSD message in MPV that shows the current buffering speed or fragment count.