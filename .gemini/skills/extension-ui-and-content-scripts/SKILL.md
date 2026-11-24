---
name: extension-ui-and-content-scripts
description: >-
  Governs the Extension Popup, In-Page Shadow DOM controller, Settings UI, content script
  multi-frame isolation, SPA navigation tracking, and recovery injection. Load whenever modifying
  `content.js`, `content.css`, `popup.html`, `popup.js`, `popup.css`, `popup/*.js`, `shared.css`,
  `utils/UIManager.js`, `utils/MpvController.js`, `utils/ControllerView.js`, `utils/PlaylistUI.js`,
  `utils/PlaylistRenderer.js`, `utils/settings.js`, `utils/NavigationObserver.js`, `utils/ContentState.js`,
  `utils/janitor.js`, or `background.js` injection/tab activation routines.
---

# Extension UI, Shadow DOM & Content Script Lifecycle

> [!IMPORTANT]
> - For Shadow DOM `_injectStyles` templates, `OptionsManager` features (Simple/Advanced mode, tabs, favorites, presets, search), and Quick-Actions bar details, see [references/SETTINGS_AND_SHADOW_DOM.md](references/SETTINGS_AND_SHADOW_DOM.md).
> - For the 4-stage `injectIntoTab` ping-first recovery flow, isolated failure logging, and `isExtensionReloadError` patterns, see [references/INJECTION_AND_RECOVERY.md](references/INJECTION_AND_RECOVERY.md).

---

## 1. Dual-Surface & Modular Popup Architecture
- **Extension Popup:** `popup.html`, `popup.js`, `shared.css` + `popup.css`, `utils/PlaylistRenderer.js`, `utils/settings.js` (`OptionsManager`), and dedicated `popup/*.js` modules.
- **In-Page Controller (Shadow DOM):** `content.js`, `shared.css` + `content.css`, `utils/UIManager.js`, `utils/MpvController.js`, `utils/ControllerView.js`, `utils/ControllerActions.js`, `utils/PlaylistUI.js`, `utils/AniListUI.js`.

### Popup & Settings Module Ownership (`popup/*.js`)
Route popup/settings changes to their owning module instead of bloating `popup.js` or `utils/settings.js`:
- `popup/popup_anilist.js` — AniList tab wiring & schedule rendering
- `popup/popup_backup.js` — Data export/import & backup restore
- `popup/popup_folders.js` — Folder management & item list rendering
- `popup/popup_playback.js` — Popup playback controls & active session status
- `popup/popup_youtube.js` — YouTube Tools tab (see `youtube-tools-subextension`)
- `popup/settings_diagnostics.js` — Diagnostics report, log viewer, dependency status
- `popup/settings_lists.js` — URL/domain rules, custom headers, list settings
- `popup/settings_ui.js` — Simple/Advanced mode, category tabs, search, presets

---

## 2. Shadow DOM, XSS & Settings Invariants
1. **Never use `<link rel="stylesheet">` inside Shadow DOM (`utils/UIManager.js:_injectStyles`):** Strict site CSPs (YouTube, Twitch) block extension stylesheet links. Fetch `shared.css` + `content.css` via `chrome.runtime.getURL` and set `<style class="mpv-injected-styles">.textContent`.
2. **Never overwrite `shadowRoot.innerHTML` after style injection:** It wipes the `<style>` tag. Append child wrappers instead (`shadowRoot.appendChild(uiWrapper)`).
3. **XSS-safe DOM rendering (`utils/domUtils.module.js`, `utils/PlaylistRenderer.js`, `popup/popup_youtube.js`):** Never interpolate untrusted titles, folder names, URLs, or metadata into `innerHTML`. Use `document.createElement` + `textContent`.
4. **3-way settings synchronization:** Any new backend-synced setting must be registered simultaneously in `utils/storageManager.js:_getDefaultData()`, `file_io.py:get_settings()`, and `utils/security.py:ALLOWED_SETTINGS_KEYS`. Mark power-user controls with `.setting-advanced` / `.group-advanced`.

---

## 3. Multi-Frame Isolation, Recovery Injection & SPA Tracking
- **Top-Frame Controller Exclusivity (`content.js`):** `manifest.json` uses `"all_frames": true` so `MPV.Janitor` (`utils/janitor.js`) can run in embedded video iframes, but `MPV.MpvController` **must only** mount when `window.top === window.self` (and guarded by `window.mpvControllerInitialized`). When `mpv_playlist_scanner=true` is in the URL, bind message listeners only (skip `controller.init()`).
- **Ping-First Recovery (`background.js:injectIntoTab`):**
  - `manifest.json` `content_scripts` is primary; `injectIntoTab` is strictly a recovery path after extension reload/update or tab activation.
  - Wait for `tab.status === "complete"` and check `restrictedDomains` before pinging (`{ action: "ping" }`). If responsive, sync state and return without re-injecting.
  - Before `chrome.scripting.executeScript`, call existing controller `teardown()`/`destroy()`, purge `#m3u8-controller-host`, `#m3u8-minimized-host`, `#anilist-panel-host`, and `#mpv-organizer-host-styles`, and reset `window.mpvControllerInitialized = false`.
  - **Bounded self-healing:** `MAX_ATTEMPTS = 3` with per-tab cooldowns. Log routine attempts at `debug` (`persist: false`); persist only confirmed multi-attempt failures. **Never** call `chrome.runtime.reload()`.
- **SPA Navigation & Cleanup (`utils/NavigationObserver.js`):** Uses 250ms debounced URL check + 500ms `MutationObserver` + 1000ms fallback poller. Every `setInterval` and `MutationObserver` in `MpvController`, `ControllerTimers`, `NavigationObserver`, and `yt_bridge.js` must be cleaned up in `destroy()`.
- **Prototype-safe dispatch maps:** Use `Object.hasOwn` or `Map` so `"__proto__"` / `"constructor"` keys cannot be invoked.
