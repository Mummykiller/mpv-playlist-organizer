---
name: ui-shadow-dom-and-settings
description: >-
  Governs the frontend presentation layer, Shadow DOM style injection, and Settings UI architecture.
  Load this skill whenever modifying `content.js`, `content.css`, `popup.html`, `popup.js`, `popup.css`,
  `popup/*.js`, `shared.css`, `utils/UIManager.js`, `utils/ControllerView.js`, `utils/MpvController.js`,
  `utils/PlaylistUI.js`, `utils/PlaylistRenderer.js`, or the Settings UI in `utils/settings.js`.
---

# UI, Shadow DOM & Settings Architecture

This skill defines the rendering architecture across the Extension Popup and In-Page Shadow DOM controller, modular `popup/*.js` boundaries, and Shadow DOM CSS encapsulation rules.

> [!IMPORTANT]
> For Shadow DOM `_injectStyles` code templates, `OptionsManager` features (Simple/Advanced mode, category tabs, favorites, buffer presets, live search), and Quick-Actions bar details, see [references/SETTINGS_AND_SHADOW_DOM.md](references/SETTINGS_AND_SHADOW_DOM.md).

---

## 1. Dual-Surface & Modular Popup Architecture

| Surface | Entry & Styles | Core Rendering Modules |
| :--- | :--- | :--- |
| **Extension Popup** | `popup.html`, `popup.js`<br>`shared.css` + `popup.css` | `utils/PlaylistRenderer.js`, `utils/settings.js` (`OptionsManager`), and modular controllers in `popup/*.js` |
| **In-Page Controller** | `content.js` (Shadow DOM)<br>`shared.css` + `content.css` | `utils/UIManager.js`, `utils/MpvController.js`, `utils/ControllerView.js`, `utils/ControllerActions.js`, `utils/PlaylistUI.js`, `utils/AniListUI.js` |

### Popup & Settings Module Ownership (`popup/*.js`)
To respect the large-file rule in `lead-architect`, route popup and settings changes to their dedicated modules rather than bloating `popup.js` or `utils/settings.js`:

| Module | Owned Concern |
| :--- | :--- |
| `popup/popup_anilist.js` | AniList popup tab wiring & schedule rendering |
| `popup/popup_backup.js` | Data export/import & backup restore controls |
| `popup/popup_folders.js` | Folder management, creation, renaming, & item list rendering |
| `popup/popup_playback.js` | Popup playback controls & active session status |
| `popup/popup_youtube.js` | YouTube Tools sub-extension popup tab (see `youtube-tools-subextension`) |
| `popup/settings_diagnostics.js` | Diagnostics report, log viewer, & dependency status UI |
| `popup/settings_lists.js` | URL/domain rules, custom headers, & list-based settings |
| `popup/settings_ui.js` | Simple/Advanced mode, category tabs, search, & presets UI helpers |

---

## 2. Non-Negotiable Shadow DOM & UI Invariants

1. **Never use `<link rel="stylesheet">` inside Shadow DOM (`utils/UIManager.js:_injectStyles`):**
   - Sites with strict CSPs (YouTube, Twitch) block `chrome-extension://` stylesheet links. Always fetch `shared.css` and `content.css` via `chrome.runtime.getURL` and inject into `<style class="mpv-injected-styles">.textContent`.
2. **Never overwrite `shadowRoot.innerHTML` after style injection:**
   - Assigning `shadowRoot.innerHTML = ...` wipes the injected `<style>` tag. Always append child wrapper elements (`shadowRoot.appendChild(uiWrapper)`).
3. **XSS-Safe DOM Rendering (`utils/domUtils.module.js`, `utils/PlaylistRenderer.js`, `popup/popup_youtube.js`):**
   - Never interpolate untrusted video titles, folder names, URLs, or AniList/YouTube metadata into `innerHTML`. Use `document.createElement` and `textContent`.
4. **Settings Synchronization:**
   - Every new backend-synced setting added to `popup.html` / `utils/settings.js` must be registered in `utils/storageManager.js:_getDefaultData()`, `file_io.py:get_settings()`, and `utils/security.py:ALLOWED_SETTINGS_KEYS`.
   - Mark power-user controls with `.setting-advanced` or `.group-advanced` so they hide automatically in Simple Mode (unless pinned to `⭐ Favorites`).
