# Plan for Implementing Sequential URL Playback with Per-URL Settings

The goal is to modify the extension to allow playing URLs one by one, with the ability to apply different settings (e.g., a bypass script) to each URL. This is a significant architectural change to move from a "playlist" model to a "single URL at a time" model with managed queuing.

## Current TODOs:

1.  **Modify `storageManager.js` to support per-URL settings:**
    *   **Goal:** Update the playlist item data structure to include optional `settings`.
    *   **Action:** Change playlist items from `{"url": "...", "title": "..."}` to `{"url": "...", "title": "...", "settings": {"bypass_script_needed": false, ...}}`. This affects how items are stored and retrieved.
    *   **Status:** pending

2.  **Modify `mpv_session.py` to play a single URL with settings:**
    *   **Goal:** Adapt `start` and `_launch` methods to handle a single `url_item` object, which will contain the URL and its specific settings.
    *   **Action:**
        *   Update `start` method signature to `start(self, url_item, folder_id, geometry, custom_width, custom_height, custom_mpv_flags, automatic_mpv_flags, start_paused, clear_on_completion)`.
        *   Similarly, modify `_launch` method signature.
        *   Within `_launch`, use `[url_item['url']]` as the `playlist` for the MPV command.
        *   (Temporarily, the `_sync` method will be less relevant in this sequential model; it will be revisited or removed later.)
    *   **Status:** pending

3.  **Modify `native_host.py` to handle single URL playback and settings:**
    *   **Goal:** Adapt the `play` command handler in `native_host.py` to accept and process a single `url_item` and pass it to the updated `mpv_session.start` method. This likely involves changing the expected message structure from `background.js`.
    *   **Action:**
        *   Create a new internal handler (or modify the existing `play` handler) that receives a single `url_item` from the extension.
        *   Call `mpv_session.start` with this `url_item`.
    *   **Status:** pending

4.  **Modify `background.js` for sequential playback and per-URL settings orchestration:**
    *   **Goal:** Implement the logic for iterating through the playlist, sending individual URL messages to the native host, and managing the playback queue.
    *   **Action:**
        *   Introduce new state variables in `background.js` (e.g., `currentPlayingFolderId`, `currentPlayingIndex`, `currentPlaylist`).
        *   The existing `play` action handler will initialize this state and send the first `url_item` for playback.
        *   Enhance the `handleMpvExited` callback to automatically play the next `url_item` in the queue upon completion of the current one.
        *   Ensure messages sent to `native_host.py` include the full `url_item` object with its settings.
    *   **Status:** pending

5.  **Implement bypass script execution in `native_host.py`:**
    *   **Goal:** Execute `play_with_bypass.sh` when a `url_item` specifies `bypass_script_needed`.
    *   **Action:**
        *   Create a helper function within `native_host.py` (e.g., `_apply_bypass_script(url_item)`) that checks `url_item['settings']['bypass_script_needed']`.
        *   If true, it will execute `play_with_bypass.sh` with the URL and use its output as the actual URL for MPV.
    *   **Status:** pending
