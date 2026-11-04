# Code Condensation Report: Duplicate Code & Consolidation Opportunities

> **Scope:** all project source (Python backend, JS extension/popup/content scripts, Lua, HTML/CSS, installer).
> **Excluded:** `testing_tools/`, `node_modules/`, and the 7 generated `utils/*.js` files (`SystemLogger.js`, `anilist_renderer.js`, `commUtils.js`, `security.js`, `nativeConnection.js`, `MpvInterface.js`, `domUtils.js`). These are build output from the `.module.js` sources and are meant to mirror them.
> **Method:** automated sliding-window duplicate-block scan (5- and 7-line windows), a same-name function scan across files, and a manual read of every hit to confirm it is a real duplicate and not a coincidence. **No code was changed for this report.**
> **Size of the codebase:** about 9.2k lines of Python and about 17.8k lines of JS. Realistic savings if everything below were done are **about 900–1,200 lines (roughly 4%)**, plus fewer places to fix the same bug.

---

## 1. Summary Table

| # | Finding | Where | Est. lines saved | Risk | Priority |
|---|---------|-------|:---:|:---:|:---:|
| **J1** | Clear-on-completion logic repeated 3× (finished-ID calc, titles, prompt, active-tab lookup) | `background/handlers/playback.js` | ~120 | 🟠 Med | ⭐⭐⭐ |
| **J2** | `PlaylistUI.render` and `PlaylistRenderer.render/_createItemNode` build the same DOM | `utils/PlaylistUI.js`, `utils/PlaylistRenderer.js` | ~150 | 🟠 Med | ⭐⭐⭐ |
| **J3** | Play-button state logic duplicated: popup vs on-page controller | `popup.js`, `utils/MpvController.js` | ~90 | 🟠 Med | ⭐⭐ |
| **J4** | Same "networking & performance" settings block built in 2 places | `utils/nativeLink.js`, `background/handlers/playback.js` | ~35 | 🟢 Low | ⭐⭐⭐ |
| **J5** | Settings defaults hand-copied across 5+ files | `storageManager.js`, `ContentState.js`, `MpvController.js`, `file_io.py`, `nativeLink.js` | ~60 + drift risk | 🟠 Med | ⭐⭐ |
| **J6** | `Draggable` and `Resizable` share the same mouse-drag skeleton | `utils/Draggable.js`, `utils/Resizable.js` | ~40 | 🟢 Low | ⭐ |
| **J7** | `isReloadError` / "Extension context invalidated" check copied 4× | `MessageBridge.js`, `MpvController.js`, `PlaybackStateManager.js`, `commUtils.module.js` | ~20 | 🟢 Low | ⭐⭐ |
| **J8** | Repeated small blocks: idle-playback default object, "clear detected URL", active-tab query, export try/catch, global-keydown normalizer | `ui_broadcaster.js`, `m3u8_scanner.js`, `popup.js` (12 `tabs.query` calls), `popup.js` | ~80 | 🟢 Low | ⭐⭐ |
| **J9** | `createHandler` option bundle `{requireFolder, syncToNative, syncImmediate, broadcastPlaylist}` repeated | `utils/playlistManager.js` | ~15 | 🟢 Low | ⭐ |
| **J10** | JS security module: dead `sanitizeString`, drifting limits vs Python | `utils/security.module.js`, `utils/commUtils.module.js` | ~25 | 🟢 Low | ⭐⭐ |
| **P1** | Unmanaged launch duplicates `LauncherService.launch` (handshake file + `construct_mpv_command` + Popen) | `utils/handlers/playback_handler.py`, `utils/session_services.py` | ~70 | 🟠 Med | ⭐⭐⭐ |
| **P2** | Natural-completion `mpv_quitting` payload built 3× in the tracker (and one is inconsistent) | `playlist_tracker.py` | ~25 | 🟢 Low | ⭐⭐ |
| **P3** | M3U text generation duplicated | `mpv_session.py` (live append vs `_generate_m3u_content`) | ~20 | 🟢 Low | ⭐⭐ |
| **P4** | IPC "get property and check `error == success`" repeated 15× | `mpv_session.py` (9), `playlist_tracker.py`, `session_services.py`, `playback_handler.py` | ~60 | 🟢 Low | ⭐⭐ |
| **P5** | `services.py` is mostly pass-through wrappers; protocol tuple duplicated in `url_analyzer.py` | `services.py`, `utils/url_analyzer.py:295`, `utils/mpv_command_builder.py:15` | ~50 | 🟠 Med | ⭐ |
| **P6** | Identical tiny helpers: `_remote_log`, `_stop_local_m3u_server` pass-through chain | `mpv_session.py`/`playlist_tracker.py`, `native_host_handlers.py`/`playback_handler.py` | ~20 | 🟢 Low | ⭐ |
| **P7** | `url_analyzer.py`: duplicated cookie-DB candidate search (Linux/Windows) and 3× near-identical return dicts | `utils/url_analyzer.py` | ~40 | 🟢 Low | ⭐ |
| **P8** | Installer: 2 copies of `_get_logic_strategy`, 2 `run_diagnostics` layers | `installer_cli.py`, `installer_src/installer_ui.py` | ~20 | 🟢 Low | ⭐ |
| **L1** | Lua: `safe_read_file` copied in two scripts; handshake loader and logger helpers repeated | `mpv_scripts/adaptive_headers.lua`, `on_completion.lua`, `python_loader.lua` | ~25 | 🟠 Med (Lua load model) | ⭐ |
| **C1** | CSS: 32 selectors with byte-identical bodies in `popup.css` and `content.css` | `popup.css`, `content.css` | ~250 | 🟠 Med | ⭐⭐ |
| **C2** | CSS: grouped-selector opportunities inside each file | `popup.css`, `content.css` | ~40 | 🟢 Low | ⭐ |
| **H1** | HTML/SVG: inline SVG icons repeated (30 in `popup.html`, 23 across JS) | `popup.html`, `popup.js`, `UIManager.js`, `PlaylistUI.js` | ~100 | 🟢 Low | ⭐ |

Legend: 🟢 safe and mechanical · 🟠 touches behavior-sensitive code, needs tests/manual check · ⭐⭐⭐ best value.

---

## 2. JavaScript: Background / Extension Logic

### J1. Clear-on-completion logic repeated 3× (`background/handlers/playback.js`)

Three handlers decide what to clear after playback and prompt the user:

| Handler | Lines |
|---|---|
| `handleItemNaturalCompletion` | [L82–204](file:///home/shinku/Documents/mpv-playlist-organizer/background/handlers/playback.js#L82-L204) |
| `handleMpvQuitting` | [L206–339](file:///home/shinku/Documents/mpv-playlist-organizer/background/handlers/playback.js#L206-L339) |
| `handleMpvExited` | [L341–~500](file:///home/shinku/Documents/mpv-playlist-organizer/background/handlers/playback.js#L341-L500) |

Duplicated pieces inside them:

1. **"Directional finished IDs"**: `finishedIdSet` → `maxFinishedIndex` → `.filter(isFinished || (idx < max && (watched || markedAsWatched)))` → `.map(id)`. It appears **2× inside `handleMpvQuitting`** (yes-branch ≈L247–262 and confirm-branch ≈L277–291) and once more (variant) in `handleItemNaturalCompletion` (L119–127, L157–169).
2. **`titles` mapping** (`ids.map(id => item.title || item.url || id)`): 4 copies.
3. **`watchedInStorage` merge** (`folder.playlist.filter(watched||markedAsWatched).map(id)` + `new Set([...playedIds, ...])`): 2 copies in `handleMpvExited`.
4. **Prompt block**: `chrome.tabs.query({active, currentWindow})` → build `session.pendingClear` → `chrome.tabs.sendMessage(tab, {action:"show_clear_confirmation", ...})`. 3 copies (L151/L192, L271/L324, L429/L473). The payload shape is identical except for `isQuitting`. The same message is also re-sent from [`ui_state.js:99`](file:///home/shinku/Documents/mpv-playlist-organizer/background/handlers/ui_state.js#L99).
5. **`isFullFolderComplete`**: computed in `handleMpvQuitting` and `handleMpvExited` with the same `every(watched || markedAsWatched || watchedSet.has)` test.

> ⚠️ **Behavior to preserve:** `handleMpvQuitting` additionally requires `sessionFinishedIds.size > 0` before declaring the folder complete; `handleMpvExited` does not. A shared helper must take that as a parameter, not merge it.

**Proposal.** Add private helpers at the top of `playback.js` (or a new `background/clear_helpers.js`):

```js
getDirectionalFinishedIds(playlist, finishedIdSet)      // replaces 4 copies
getWatchedIds(playlist)                                 // replaces 3 copies
resolveTitles(playlist, ids)                            // replaces 4 copies
isFolderFullyWatched(playlist, watchedSet, {requireSession, sessionIds})
async promptClear(folderId, session, {ids, scope, isQuitting})  // build pendingClear + send + active-tab lookup
```

`handleMpvQuitting` / `handleMpvExited` then shrink to "decide scope → `clear` or `promptClear`".

---

### J4. Networking/performance payload built twice (`nativeLink.js` ↔ `playback.js`)

- [`NativeLink._enrichPayload`](file:///home/shinku/Documents/mpv-playlist-organizer/utils/nativeLink.js#L219-L266) builds ~25 fields (`disableNetworkOverrides … ultraFbo`) from `globalPrefs`.
- [`handlePlayNewInstance`](file:///home/shinku/Documents/mpv-playlist-organizer/background/handlers/playback.js#L1186-L1240) builds the **same ~25 fields by hand** and then calls `nativeLink.call("play_new_instance", …)`.
- [`extractPlaybackSettings`](file:///home/shinku/Documents/mpv-playlist-organizer/background/handlers/playback.js) is a third consumer of the same key list.

The two literal blocks were already out of sync once (`targetedDefaults` had to be added to both in the last audit).

**Proposal.** Export one `buildPlaybackSettingsPayload(globalPrefs)` from `nativeLink.js`. `_enrichPayload` spreads it; `handlePlayNewInstance` and `extractPlaybackSettings` call it. It is a pure function with no behavior change, so it is low risk.

---

### J5. Settings defaults copy-pasted across files

The same default values live in:

| File | Block |
|---|---|
| [`utils/storageManager.js`](file:///home/shinku/Documents/mpv-playlist-organizer/utils/storageManager.js#L232-L335) | `_getDefaultData()` (authoritative for the browser) |
| [`utils/ContentState.js:20-43`](file:///home/shinku/Documents/mpv-playlist-organizer/utils/ContentState.js) | content-script state defaults |
| [`utils/MpvController.js:688-705`](file:///home/shinku/Documents/mpv-playlist-organizer/utils/MpvController.js) | `mappedSettings` fallbacks |
| [`file_io.py:get_settings`](file:///home/shinku/Documents/mpv-playlist-organizer/file_io.py) | `default_settings` (authoritative for Python, snake_case) |
| `nativeLink.js` / `playback.js` | inline `?? true` / `|| "auto"` fallbacks (see J4) |

**Proposal (incremental).**
1. Export `DEFAULT_GLOBAL_PREFS` as a plain constant from a new `utils/defaults.module.js`. Have `storageManager._getDefaultData()`, `ContentState`, and `MpvController.mappedSettings` import or spread it. (`.module.js` → generated global is already supported by `generate_js.py`.)
2. Keep `file_io.py`'s snake_case defaults as the Python source of truth. Add a test in `testing_tools` that asserts every key in `DEFAULT_GLOBAL_PREFS` (converted to snake_case) that is **not** in `UI_ONLY_KEYS` also exists in `file_io.get_settings()`. That turns drift into a failing test instead of a latent bug. The last audit found exactly this drift (`enableDisplaySync`, `overrideDisplayFps`, `targetedDefaults`).

---

### J7. "Extension context invalidated" detection copied 4×

- [`MessageBridge.js:52-58`](file:///home/shinku/Documents/mpv-playlist-organizer/utils/MessageBridge.js#L52-L58) `isReloadError(e)`
- [`MpvController.js:1473-1479`](file:///home/shinku/Documents/mpv-playlist-organizer/utils/MpvController.js#L1473-L1479) `_isReloadError(msg)`: same 3 `includes` checks
- [`PlaybackStateManager.js:192`](file:///home/shinku/Documents/mpv-playlist-organizer/utils/PlaybackStateManager.js#L192) a partial inline check
- [`commUtils.module.js:44`](file:///home/shinku/Documents/mpv-playlist-organizer/utils/commUtils.module.js#L44) the source of the error string

**Proposal.** Add `isExtensionReloadError(errOrMsg)` to `commUtils.module.js` (already loaded before all of these in `manifest.json`) and replace the three copies. Zero behavior change.

---

### J8. Small repeated blocks (all low risk)

| Pattern | Locations | Fix |
|---|---|---|
| `{isActive:false,isRunning:false,isPaused:false,needsAppend:false,sessionIds:[]}` returned twice | [`ui_broadcaster.js:45-51`](file:///home/shinku/Documents/mpv-playlist-organizer/background/ui_broadcaster.js#L45-L51), [`:80-86`](file:///home/shinku/Documents/mpv-playlist-organizer/background/ui_broadcaster.js#L80-L86) | `const IDLE_STATE = Object.freeze({…})` and return `{...IDLE_STATE}` |
| "clear detected URL for tab" (`delete lastDetectedUrls[tabId]; delete _detectedUrlsState[tabId]; broadcastToTabs({detected_url_changed,url:null})`) | [`m3u8_scanner.js:98-104`](file:///home/shinku/Documents/mpv-playlist-organizer/background/handlers/m3u8_scanner.js#L98-L104) and [`:113-119`](file:///home/shinku/Documents/mpv-playlist-organizer/background/handlers/m3u8_scanner.js#L113-L119) | `function clearDetectedUrl(tabId)` |
| `chrome.tabs.query({active:true,currentWindow:true})` | 12 call sites (3 in `playback.js`, 3+ in `popup.js` at L694, L711, L2193, …) | `getActiveTab()` helper in `commUtils.module.js` |
| `try { sendMessageAsync(...) ; if success showStatus(message) else showStatus(error \|\| "X failed") } catch …` | `popup.js` export handlers (≈L1000-1015, L1150-1170) and similar | `async function runAction(action, payload, failLabel)` returning the response and showing status |
| `handleOpenExportFolder` implemented twice | [`popup.js:1136`](file:///home/shinku/Documents/mpv-playlist-organizer/popup.js#L1136) (callback style) vs [`import_export.js:260`](file:///home/shinku/Documents/mpv-playlist-organizer/background/handlers/import_export.js#L260) (background side). They are two halves of one flow, not true duplicates. | Only convert the popup half to `await sendMessageAsync(...)` for consistency |
| Global keydown + key normalization (`control→ctrl, command/cmd→meta, option→alt`) | [`popup.js:1783-1830`](file:///home/shinku/Documents/mpv-playlist-organizer/popup.js#L1783-L1830) and [`MpvController.js:2054+`](file:///home/shinku/Documents/mpv-playlist-organizer/utils/MpvController.js#L2054) | Move `normalizeKeyCombo(e)` + `normalizeKeyString(str)` to `commUtils.module.js` |

---

### J9. `playlistManager.js`: repeated `createHandler` options

Lines [304–308](file:///home/shinku/Documents/mpv-playlist-organizer/utils/playlistManager.js#L304-L308), [343–347](file:///home/shinku/Documents/mpv-playlist-organizer/utils/playlistManager.js#L343-L347) and [361–365](file:///home/shinku/Documents/mpv-playlist-organizer/utils/playlistManager.js#L361-L365) pass the identical `{requireFolder, syncToNative, syncImmediate, broadcastPlaylist}`.

**Proposal.** `const PLAYLIST_MUTATION = Object.freeze({...})` and `createHandler(fn, PLAYLIST_MUTATION)`. A pure refactor.

---

### J10. JS security module: dead export and drifting limits

- [`security.module.js`](file:///home/shinku/Documents/mpv-playlist-organizer/utils/security.module.js) exports `SECURITY_LIMITS`, `ALLOWED_PROTOCOLS`, `isValidUrl`, `sanitizeString`. A repo-wide grep shows **only `isValidUrl` is consumed** (by `nativeConnection.module.js:188/191`). Its `sanitizeString` is never called. All real callers use [`commUtils.module.js:54 sanitizeString`](file:///home/shinku/Documents/mpv-playlist-organizer/utils/commUtils.module.js#L54).
- The two `sanitizeString` implementations **behave differently**: `security` truncates to 255/100 chars and strips `$` from titles; `commUtils` does neither. That is a trap if someone swaps one for the other.
- JS limits (`MAX_TITLE_LENGTH 255`, `MAX_URL_LENGTH 2048`, `MAX_PLAYLIST_ITEMS 5000`, `MAX_FOLDER_NAME_LENGTH 100`) disagree with Python [`security.py`](file:///home/shinku/Documents/mpv-playlist-organizer/utils/security.py#L15-L23) (`512 / 4096 / 10000 / 128`).

**Proposal.**
1. Delete `sanitizeString` from `security.module.js` (dead). Keep `isValidUrl`.
2. Decide on one set of limits (the Python values are the enforced ones) and update the JS constants, or document that JS is intentionally stricter.
3. Optional: fold `isValidUrl` into `commUtils.module.js` and drop the `MPV_SECURITY` namespace and its build entry (one less generated file).

---

### J6. `Draggable` ↔ `Resizable` (`utils/Draggable.js`, `utils/Resizable.js`)

Both classes have the same lifecycle:
`isX flag` → bind 3 handlers → `onMouseDown` (add body class, add document `mousemove`/`mouseup`) → `onMouseMove` → `onMouseUp` (remove body class, remove listeners, fire callback) → `attach()`.
Same-name methods (`onMouseDown/Move/Up`, `attach`, `destroy`) show up in the duplicate-name scan.

**Proposal.** A tiny `PointerGesture` base class holding the add/remove-listener and flag management; `Draggable`/`Resizable` implement `onStart/onMove/onEnd` only. About 40 lines saved, but this is UI-gesture code that is hard to unit-test. **Low priority; do it only if you are already touching these files.**

---

## 3. JavaScript: UI (Popup and On-page Controller)

### J2. Two playlist renderers (`PlaylistUI.js` ↔ `PlaylistRenderer.js`)

- [`PlaylistRenderer`](file:///home/shinku/Documents/mpv-playlist-organizer/utils/PlaylistRenderer.js) (222 lines) is used **only by the popup** ([`popup.js:12,1222`](file:///home/shinku/Documents/mpv-playlist-organizer/popup.js#L1222)).
- [`PlaylistUI.render`](file:///home/shinku/Documents/mpv-playlist-organizer/utils/PlaylistUI.js#L42-L226) (content script) rebuilds the same item DOM by hand: `list-item` div, `item-watched`, active/last-played highlight, copy button, index span, watched checkmarks, `url-text` via `domUtils.formatTitle`, YouTube watched checkbox, remove button, placeholder, scroll-restore logic.
- Same-name members in both files: `render`, `_formatTitle`, `updateItemDelta`.
- Both already delegate the hard parts to `MPV.domUtils` (`formatTitle`, `updateItemDelta`, `getDragAfterElement`), which shows the intent to share.

**Why it isn't shared today:** `PlaylistRenderer.js` contains an `export` statement, so it can't be listed in `manifest.json`'s classic content-script array.

**Proposal.**
1. Rename it to `PlaylistRenderer.module.js` and add it to `testing_tools/generate_js.py` `CONFIG` (the same mechanism used for `domUtils`). The build then emits a global `PlaylistRenderer.js` for content scripts and the module version for the popup.
2. Make `PlaylistUI.render` construct a `PlaylistRenderer` and pass its extra needs as options/callbacks:
   - `showCopyButton`, `showWatchedGui` flags (already read from `settings`),
   - `onWatchedToggle`, `onRemove` callbacks (the renderer already has `callbacks.onRemove`),
   - `enrichItem(item)` hook for the `chrome.storage` metadata-cache lookup ("LAYER 0") that only the content script does.
3. Keep `PlaylistUI`'s drag-and-drop, quick-action bar, and live-reorder logic (those differ from the popup). Only the item-node construction and render loop move.

**Risk: medium.** The two renderers differ in small ways (scroll behavior, `isLast`/`isPickStart` modes, the copy-button toggle). Do it behind the existing UI tests (`test_ui_sync.js`, `test_modular_components.js`) and visually check both surfaces.

---

### J3. Play-button state logic: popup vs on-page controller

| Concept | Popup | On-page controller |
|---|---|---|
| set loading | [`popup.js:567`](file:///home/shinku/Documents/mpv-playlist-organizer/popup.js#L567) | [`MpvController.js:1203`](file:///home/shinku/Documents/mpv-playlist-organizer/utils/MpvController.js#L1203) |
| set closing | [`popup.js:586`](file:///home/shinku/Documents/mpv-playlist-organizer/popup.js#L586) | [`MpvController.js:1236`](file:///home/shinku/Documents/mpv-playlist-organizer/utils/MpvController.js#L1236) |
| active/queue/paused icon+title | inside `renderPlaylist` ([`popup.js:~640-690`](file:///home/shinku/Documents/mpv-playlist-organizer/popup.js)) | [`setPlaybackActive` L1270](file:///home/shinku/Documents/mpv-playlist-organizer/utils/MpvController.js#L1270) |
| `refreshPlaylist` | [`popup.js:521`](file:///home/shinku/Documents/mpv-playlist-organizer/popup.js#L521) | [`MpvController.js:1138`](file:///home/shinku/Documents/mpv-playlist-organizer/utils/MpvController.js#L1138) |

All implement the same state machine: `closing > queue ("Queue to Playlist") > active ("Play/Pause Playlist") > idle ("Play Playlist")`, with the same CSS classes (`btn-loading`, `btn-playing`, `btn-closing`) and the same three title strings. In `MpvController` the logic is copied **per button** (`btn-play`, `btn-compact-play`, `m3u8-minimized-play-btn`). `showingNeedsAppend = isActive && effectiveNeedsAppend` is recomputed 3× in one method.

**Proposal.** A shared pure function in `domUtils.module.js`:

```js
getPlayButtonVisual({isLoading, isClosing, isActive, needsAppend}) // → {classes:{...}, title, iconKey}
applyPlayButtonVisual(btn, visual, {iconRenderer})                  // toggles classes + sets title/icon
```

Both surfaces call it; they differ only in which `iconRenderer` they pass (SVG in the popup, emoji+text in the controller). It also fixes the small quick-actions drift fixed in the last pass: one source of truth for titles.

---

## 4. Python Backend

### P1. Unmanaged launch duplicates the managed launcher ⭐

| Piece | `PlaybackHandler._launch_unmanaged_mpv` | `LauncherService.launch` |
|---|---|---|
| Location | [`playback_handler.py:393–512`](file:///home/shinku/Documents/mpv-playlist-organizer/utils/handlers/playback_handler.py#L393-L512) | [`session_services.py:266–~370`](file:///home/shinku/Documents/mpv-playlist-organizer/utils/session_services.py#L266) |
| Handshake dict (`folder_id, project_root, flag_dir, playlist_start_index, is_youtube, use_ytdl_mpv, title, id, original_url, headers, cookies_browser, lua_options, is_unmanaged`) | [L436](file:///home/shinku/Documents/mpv-playlist-organizer/utils/handlers/playback_handler.py#L436) | [L294](file:///home/shinku/Documents/mpv-playlist-organizer/utils/session_services.py#L294) |
| Write handshake JSON to `flags/handshake_*.json` | yes | yes (plus a Windows `\`→`/` fix the unmanaged path lacks) |
| Append `--script-opts=mpv_organizer-handshake=…` to custom flags | yes | yes |
| `construct_mpv_command(...)` | yes | yes |
| `subprocess.Popen(..., **get_mpv_popen_kwargs(...))` | yes | yes |

Notably, the unmanaged path **misses** the Windows path-slash normalization that the managed path has: a latent difference that a shared helper would fix.

**Proposal.** Extract two module-level helpers in `session_services.py` (or a new `utils/launch_helpers.py`):

```python
build_handshake(url_item, folder_id, settings, script_dir, flag_dir, *, playlist_start_index, headers, cookies_browser, is_unmanaged) -> dict
write_handshake(handshake: dict, flag_dir: str, prefix: str = "handshake_") -> (path, script_opts_flag)
```

Both launchers call these two. The command construction call differs enough (IPC path, idle, completion script) that it should stay separate.

**Test before and after:** `test_native_host_boot.py` plus a manual unmanaged ⚡ launch.

---

### P2. `mpv_quitting` message built three times (`playlist_tracker.py`)

[L210](file:///home/shinku/Documents/mpv-playlist-organizer/playlist_tracker.py#L210), [L389](file:///home/shinku/Documents/mpv-playlist-organizer/playlist_tracker.py#L389) and [L410](file:///home/shinku/Documents/mpv-playlist-organizer/playlist_tracker.py#L410) all `send_message({"action":"mpv_quitting", …})`.

- L389 and L410 are byte-identical (`folder_id, is_natural_completion, played_ids, watched_ids, session_ids`).
- **L210 sends only `folder_id`.** That looks like an inconsistency, not a design choice: on an EOF/connection-lost-without-event path the browser loses the "natural completion" hint.

**Proposal.** `def _notify_quitting(self, reason=None)` that builds the full payload, and call it from all three places. ⚠️ This *would* change the L210 payload (it would now include the played/watched IDs). It is almost certainly the intended behavior, but **confirm before applying**, or pass a `minimal=True` flag to preserve today's behavior exactly.

---

### P3. M3U text built in two places (`mpv_session.py`)

- Live append: [L670–L681](file:///home/shinku/Documents/mpv-playlist-organizer/mpv_session.py#L670-L681)
- Launch: [`_generate_m3u_content` L886–L909](file:///home/shinku/Documents/mpv-playlist-organizer/mpv_session.py#L886-L909)

Both do `is_youtube && original_url → original_url`, then append `#mpv_organizer_id=<id>` (`#` vs `&` separator), then `#EXTINF:-1,<sanitized title>` and `services.sanitize_url(url)`.

**Proposal.** The live-append block calls `self._generate_m3u_content(items_to_add)` and writes the result. (Verify the only difference, the debug log line, is irrelevant.)

---

### P4. IPC "get property → check success → return data" (15×)

`res = ipc.send({"command":["get_property", X]}, expect_response=True, timeout=T)` followed by `if res and res.get("error") == "success": return res.get("data")` appears in `mpv_session.py` (9 sites, incl. `get_pause_state` L358, `get_idle_state` L370, `user-data/id` at L147/L469/L559), `playlist_tracker.py` (2), `session_services.py`, `playback_handler.py` (L83-84), and `janitor.py`.

**Proposal.** Add to `IPCSocketManager`:

```python
def get_property(self, name, timeout=1.0, default=None):
    res = self.send({"command": ["get_property", name]}, expect_response=True, timeout=timeout)
    return res.get("data") if res and res.get("error") == "success" else default
```

and use it everywhere. It also removes ~15 `try/except Exception: pass` wrappers around those calls, but **keep the surrounding `sync_lock`** where it exists. ~60 lines saved with a single point to add logging or retries later.

---

### P5. `services.py` pass-throughs and duplicated constants

- [`services.py`](file:///home/shinku/Documents/mpv-playlist-organizer/services.py) wraps `dependency_manager.update_ytdlp`, `check_mpv_and_ytdlp_status`, `anilist_service.get_anilist_releases_with_cache`, `mpv_command_builder.construct_mpv_command`, `get_mpv_popen_kwargs` with one-liners, and re-exports `ALLOWED_PROTOCOLS` / `SAFE_MPV_FLAGS_ALLOWLIST` (no remaining users besides a comment).
- [`url_analyzer.py:295`](file:///home/shinku/Documents/mpv-playlist-organizer/utils/url_analyzer.py#L295) hardcodes its own `ALLOWED_PROTOCOLS` tuple (with a comment "Must match services.ALLOWED_PROTOCOLS") although `security.ALLOWED_PROTOCOLS` is already imported in that module's `security` import.
- [`mpv_command_builder.py:15`](file:///home/shinku/Documents/mpv-playlist-organizer/utils/mpv_command_builder.py#L15) aliases it again.
- [`file_io.py`](file:///home/shinku/Documents/mpv-playlist-organizer/file_io.py) wraps `security.sanitize_string`, `sanitize_ytdlp_options`, `validate_safe_path` (tiny wrappers; ~20+ call sites use `file_io.sanitize_string`).

**Proposal (safe subset first).**
1. `url_analyzer.py:295` → `security.ALLOWED_PROTOCOLS`; `mpv_command_builder.py:15` → use `security.ALLOWED_PROTOCOLS` directly. Remove the `services.py` re-exports.
2. Leave `services.py`'s *function* wrappers in place. Handlers receive `ctx.services` by injection and tests (`testing_tools/verify_refactor.py`) call them. Removing them is a bigger refactor for little gain.
3. Leave the `file_io` wrappers (widely used); optionally replace with `sanitize_string = security.sanitize_string` aliases.

---

### P6. Tiny helper duplicates

- `_remote_log(self, message)` is **byte-identical** in [`mpv_session.py:533`](file:///home/shinku/Documents/mpv-playlist-organizer/mpv_session.py#L533) and [`playlist_tracker.py:835`](file:///home/shinku/Documents/mpv-playlist-organizer/playlist_tracker.py#L835). Move it to `IPCSocketManager.log_to_mpv(message)`. Natural companion to P4.
- `_stop_local_m3u_server` is a 3-level pass-through (`native_host.py` atexit → `HandlerManager._stop_local_m3u_server` → `PlaybackHandler._stop_local_m3u_server` → `M3UServer.stop`). Register `handler_manager.playback.m3u_server.stop` with `atexit` directly and drop the two middle layers (~8 lines).

---

### P7. `url_analyzer.py` internal duplication

- Cookie-DB candidate discovery repeats the same loop twice (`for path in candidates: if os.path.exists(path): db_rel_path = path; break`) at [L121–L124](file:///home/shinku/Documents/mpv-playlist-organizer/utils/url_analyzer.py#L121-L124) (Linux) and [L161–L164](file:///home/shinku/Documents/mpv-playlist-organizer/utils/url_analyzer.py#L161-L164) (Windows) → `next((p for p in candidates if os.path.exists(p)), None)`.
- `run_bypass_logic` returns the near-identical dict `{success, url, headers:{User-Agent}, use_ytdl_mpv:True, is_youtube:True, disable_http_persistent:False}` in at least two fallbacks ([L464–L471](file:///home/shinku/Documents/mpv-playlist-organizer/utils/url_analyzer.py#L464-L471) and [L501–L508](file:///home/shinku/Documents/mpv-playlist-organizer/utils/url_analyzer.py#L501-L508)) → a local `_youtube_passthrough(url, ua)` helper.

---

### P8. Installer

- `_get_logic_strategy` exists in both [`installer_cli.py:14`](file:///home/shinku/Documents/mpv-playlist-organizer/installer_cli.py#L14) and [`installer_ui.py:73`](file:///home/shinku/Documents/mpv-playlist-organizer/installer_src/installer_ui.py#L73): the same 4-way `platform.system()` switch. Put `get_logic_for_platform(log, ask_file, ask_dir)` in `installer_logic.py` (next to the four Logic classes).
- `run_diagnostics` exists in the UI and logic layers by design (the UI is a thin thread wrapper). Not a real duplicate; leave it.

---

## 5. Lua (`mpv_scripts/`)

### L1. Repeated helpers across the three scripts

- `safe_read_file` is **copied** in [`adaptive_headers.lua:72`](file:///home/shinku/Documents/mpv-playlist-organizer/mpv_scripts/adaptive_headers.lua#L72) and [`on_completion.lua:9`](file:///home/shinku/Documents/mpv-playlist-organizer/mpv_scripts/on_completion.lua#L9).
- The handshake loader (`mp.get_opt("mpv_organizer-handshake")` → read → `utils.parse_json`) is implemented in both ([`adaptive_headers.lua:87-123`](file:///home/shinku/Documents/mpv-playlist-organizer/mpv_scripts/adaptive_headers.lua#L87-L123), [`on_completion.lua:22-38`](file:///home/shinku/Documents/mpv-playlist-organizer/mpv_scripts/on_completion.lua#L22-L38)).
- Three near-identical `debug_log`/`log` wrappers (`mp.msg.info("<Name>: " .. msg)`).

**Proposal.** A `mpv_scripts/lib/common.lua` loaded with `require`, with a `package.path` tweak using `mp.get_script_directory()` (mpv supports it for scripts passed by path).

> ⚠️ **Caveat:** the scripts are loaded with `--script=<path>` individually, so `require` resolution depends on mpv's version and script dir handling. This is the riskiest item for the lowest saving (~25 lines). **Recommendation: skip unless the Lua grows.**

---

## 6. CSS / HTML

### C1. `popup.css` and `content.css` share 32 byte-identical rule bodies

A selector-level comparison found **45 shared selectors, 32 with identical declarations**: `.anilist-nav-btn*`, `.anilist-releases-list`, `.release-details/-title/-bottom-info/-episode-info/-airing-time`, `.quick-action-btn:hover/:active`, all `*-mode-active` / `live-reorder-active` rules for `.list-item` and the action bar, `.smart-sync-pending`, `.watched-checkmark`, `.index-checkmark`, `.checkbox-checkmark`, `.btn-copy-item:hover`, `.item-watched-checkbox`, `.list-item.removing`, `.auto-add-active`, and the `from/to/0%/100%` keyframes. These are the playlist/AniList/quick-action visuals that both surfaces must render identically, so every tweak currently has to be made twice.

**Proposal.** Extract these into `shared.css`:
1. Popup: `<link rel="stylesheet" href="shared.css">` in `popup.html`.
2. Content script (Shadow DOM): wherever `content.css` is currently fetched/injected into the shadow root (see `UIManager.js`), also inject `shared.css`. Add it to `web_accessible_resources` in `manifest.json` if it is not already covered by a wildcard.

Because the content script uses a **Shadow DOM**, host-page CSS cannot leak in, so the shared rules render the same in both places. Do this one rule group at a time (start with the AniList block, which is self-contained).
**Risk: medium**, and only because CSS-cascade order may matter. Verify visually.

### C2. Grouped selectors inside each file

- `popup.css`: [`#popup-confirmation-modal`](file:///home/shinku/Documents/mpv-playlist-organizer/popup.css#L519) / `#export-filename-modal, #import-selection-modal, #export-all-modal, #rename-folder-modal` have identical bodies for the container, `.modal-content`, and `p` → add `#popup-confirmation-modal` to the existing grouped selector (3 rule blocks).
- `content.css`: `#btn-pin-anilist-panel` ≡ `.anilist-refresh-btn`; `#btn-play.btn-playing:hover, #btn-compact-play.btn-playing:hover` ≡ `.play-button.btn-playing:hover` (≈1,056–1,095 region repeats the same 7-property "icon button" block 3×: `background:none; border:none; color; cursor:pointer; padding:4px; border-radius:50%; display:flex; align-items:center; justify-content:center; transition…`) → a `.icon-btn` utility class.

### H1. Inline SVG repetition

`popup.html` has 30 inline `<svg>`; `popup.js` 6, `UIManager.js` 14, `PlaylistUI.js` 3, `settings.js` 2, `PlaylistRenderer.js` 1. The reload (`section-reload-btn`) icon is pasted in at least 4 section headers ([`popup.html:265, 333, 504, 606`](file:///home/shinku/Documents/mpv-playlist-organizer/popup.html#L265)); the anilist prev/next arrows and the list/lines "reorder" icon are duplicated between `popup.html` and `UIManager.js`/`PlaylistUI.js`.

**Proposal.** A single `Icons` map (`reload`, `chevronLeft`, `chevronRight`, `reorder`, `copy`, `play`, `pause`, `plus`, `close`…) in `domUtils.module.js`, rendered with a small `svgIcon(name, {size})` helper. HTML sections can use `<span data-icon="reload">` hydrated on load. Mechanical and safe, but lots of small edits for modest benefit; best done together with J3.

---

## 7. Checked and Intentionally NOT Flagged

| Item | Why it is fine |
|---|---|
| `utils/*.js` ↔ `utils/*.module.js` (7 pairs) | Generated by `testing_tools/generate_js.py`; `.js` is build output (CRLF/LF aside). Not hand-maintained. |
| `popup.html` quick-actions bar (A / B / C / D) vs `PlaylistUI._renderQuickActions` (A / B / C / ⚡) | Different surfaces with intentionally different button sets (already reconciled for tooltips in the last pass). |
| `get_unified_diagnostics` in `background.js`, `DataHandler`, `native_host.py` | One request hop per layer; each layer adds distinct data (JS / native / logs). |
| `run_diagnostics` (installer UI vs logic) | UI wrapper in a thread vs the actual implementation. |
| `handleOpenExportFolder` (popup vs background) | Two ends of one message flow. |
| `logger.py` `decorator`/`wrapper` names | Standard decorator idiom, not duplicate code. |
| `FileLock`, `_atomic_json_dump`, `_safe_json_load` in `file_io.py` | Single implementations, widely reused. |
| `mpv_command_builder.py` terminal-launch branches | Look similar but differ per terminal emulator (`-e`, `--`, `--hold`). Flattening would hide real differences. |

---

## 8. Recommended Order of Work

1. **Zero-risk mechanical (≈1 hour):** J4, J7, J8 (idle-state constant, `clearDetectedUrl`, `getActiveTab`), J9, J10-step-1, P5-step-1, P6, P7, P8, C2.
2. **Python consolidation (≈2 hours):** P4 (+P6 `get_property`/`log_to_mpv`), P3, P1, then P2 (after confirming the L210 payload question).
3. **Background JS logic (≈2 hours):** J1 (helpers only; keep exact semantics), J5 (defaults + drift-guard test).
4. **UI consolidation (≈half a day, needs visual checks):** J2 (shared renderer via `.module.js`), J3 (shared play-button visual), C1 (shared CSS), H1 (icons).
5. **Skip unless needed:** J6 (`Draggable`/`Resizable` base), L1 (Lua `require`).

### Safety protocol for each step
1. Make the change in the `.module.js` source, never in the generated `.js`.
2. Run `python3 verify_changes.py` (rebuilds the JS and runs all 3 test batches).
3. For UI-touching steps (J2, J3, C1, H1), also load the extension and check: popup playlist, on-page controller (full / compact / minimized), play/pause/queue/closing states, drag-reorder, and the AniList panel.
4. For `playback.js` clear logic (J1), manually test all three modes (`clearOnCompletion` = yes / confirm / no) with both natural completion and manual quit.
5. Commit each numbered finding separately so any regression can be reverted in isolation.

### Test gaps worth closing first
The current suite does not cover `playback.js` clear logic (J1), the launch-handshake path (P1), or default-key drift (J5). Adding a small test for each **before** refactoring makes these changes much safer.
