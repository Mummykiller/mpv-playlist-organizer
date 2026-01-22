# 📋 Execution Plan: "NativeLink" Refactor

## 🎯 Objective
Centralize all JavaScript-to-Python communication into a single service class (`NativeLink.js`). This eliminates code duplication (specifically payload construction) and provides a type-safe, semantic API for the rest of the application.

## 🛡️ Critical Safety Mandates
1.  **Command Inventory:** You **MUST** ensure every `action` string currently used in the codebase is either explicitly mapped to a method or handled via a generic passthrough.
2.  **Preference Injection:** The most complex logic is in `background/handlers/playback.js` where global preferences (flags, geometry, networking) are merged into the payload. This logic **MUST** be preserved exactly in `NativeLink._enrichPayload`.
3.  **Return Values:** Ensure the methods return promises that resolve to the same structure expected by the callers (usually `{ success: boolean, ... }`).

---

## 🔍 Phase 1: Action Inventory & Mapping
*Verify this list against the codebase before starting. Do not drop any commands.*

| Legacy Action | Target Method in `NativeLink` | Context |
| :--- | :--- | :--- |
| `ping` | `ping()` | Heartbeat |
| `is_mpv_running` | `isMpvRunning()` | Status Check |
| `get_playback_status` | `getPlaybackStatus()` | Status Check |
| `close_mpv` | `closeMpv(folderId)` | Lifecycle |
| `play` | `play(item, folderId, options)` | Playback |
| `play_new_instance` | `play(..., { play_new_instance: true })` | Playback |
| `play_m3u` | `playM3U(data, folderId, options)` | Playback |
| `append` | `append(item, folderId)` | Queue Management |
| `sync_to_file` | `syncToFile(data)` | Persistence |
| `clear_live` | `clearLive(folderId)` | Playlist Manager |
| `reorder_live` | `reorderLive(folderId, newOrder)` | Playlist Manager |
| `set_ui_preferences` | `setUiPreferences(prefs)` | UI State |
| `get_ui_preferences` | `getUiPreferences()` | UI State |
| `get_default_automatic_flags` | `getDefaultAutomaticFlags()` | UI State |
| `set_minimized_state` | `setMinimizedState(isMinimized)` | UI State |
| `get_anilist_releases` | `getAnilistReleases(query, type)` | Dependency |
| `ytdlp_update_check` | `checkYtdlpUpdate()` | Dependency |
| `run_ytdlp_update` | `runYtdlpUpdate()` | Dependency |
| `list_import_files` | `fileSystem.listFiles()` | Import/Export |
| `open_export_folder` | `fileSystem.openExportFolder()` | Import/Export |
| `export_...` / `import_...` | `fileSystem.call(action, data)` | Import/Export |

---

## 🛠️ Phase 2: Implementation Steps

### Step 1: Create `utils/nativeLink.js`
Create the class structure.
*   **Imports:** `callNativeHost`, `addNativeListener` from `./nativeConnection.js`, `storage` from `../background/storage_instance.js`.
*   **Method `_enrichPayload(payload)`**: Copy the extensive logic from `background/handlers/playback.js` (lines ~60-100 and ~450-480) that injects `geometry`, `custom_mpv_flags`, `ytdl_quality`, `demuxer_max_bytes`, etc.
*   **Method `_injectItemSettings(item)`**: Copy logic ensuring `yt_use_cookies` etc. are attached to the URL item.
*   **Public Methods:** Implement the methods defined in the "Action Inventory" table above.

### Step 2: Refactor Playback Handlers (`background/handlers/playback.js`)
*   **Import:** `import { nativeLink } from "../../utils/nativeLink.js";`
*   **Replace:** Locate `callNativeHost` calls inside `_playSingleUrlItem`, `processQueue` (append batch), `handlePlay`, `handlePlayM3U`, `handleCloseMpv`.
*   **Simplify:** Delete the massive object definitions. Replace with:
    ```javascript
    // Example Refactor
    return nativeLink.play(url_item, folderId, {
        clear_on_completion: request.clear_on_completion,
        start_paused: request.start_paused
        // ... specific overrides only
    });
    ```
*   **Verification:** Ensure `PlaybackSession` (the queue manager) uses `nativeLink.append`.

### Step 3: Refactor UI State Handlers (`background/handlers/ui_state.js`)
*   **Import:** `import { nativeLink } from "../../utils/nativeLink.js";`
*   **Replace:** Calls to `get_ui_preferences`, `set_ui_preferences`, `set_minimized_state`.

### Step 4: Refactor Dependency & Filesystem Handlers
*   **Files:** `background/handlers/dependency_anilist.js`, `background/handlers/import_export.js`.
*   **Action:** Replace direct calls with semantic `nativeLink` methods.
*   **Note:** For simple one-off actions like `import_from_file`, you can define a `nativeLink.fileSystem` namespace or generic methods to avoid cluttering the main class if preferred, but explicit methods are cleaner.

### Step 5: Refactor Playlist Manager (`utils/playlistManager.js`)
*   **Import:** `import { nativeLink } from "./nativeLink.js";`
*   **Replace:** `callNativeHost` calls for `clear_live` and `reorder_live`.

### Step 6: Refactor Core Services (`background/core_services.js`)
*   **Action:** Update `_syncToNativeHostFile` to use `nativeLink.syncToFile()`.

---

## ✅ Phase 3: Verification Checklist

1.  **Compile Check:** Ensure no syntax errors in `nativeLink.js`.
2.  **Playback Test:**
    *   Play a single video. (Checks `play` + Preference Injection)
    *   Queue a video while playing. (Checks `append`)
    *   Close MPV. (Checks `closeMpv`)
3.  **Settings Test:** Change a setting (e.g., MPV flags) and play a video. Verify in MPV logs (if possible) or by behavior that the flag was passed.
4.  **Persistence Test:** Ensure `session.json` updates on the Python side (triggered by `syncToFile`).
5.  **Anilist Test:** Open the AniList panel to trigger `get_anilist_releases`.

## ⚠️ Handover Notes
*   **Do not modify `utils/nativeConnection.js`**. That file handles the raw Chrome Port connection. `NativeLink` is a wrapper *around* it.
*   **Circular Dependencies:** Be careful importing `storage` into `NativeLink` if `storage` eventually depends on `NativeLink`. (Currently `storageManager` is standalone, so it should be safe).
*   **Reference:** Use `background/handlers/playback.js` as the source of truth for the "Preference Injection" logic. It is the most up-to-date definitions of what flags MPV supports.
