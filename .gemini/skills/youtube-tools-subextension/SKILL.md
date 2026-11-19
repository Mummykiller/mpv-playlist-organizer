---
name: youtube-tools-subextension
description: Architecture, standalone-first workflow, and auto-porting guide for Shinku's YouTube Tools (yt-tools/, yt-tools-standalone/, yt-tools/port_to_main.py, yt-tools/export_standalone.py, background/yt_tools_service.js, popup/popup_youtube.js).
---

# Shinku's YouTube Tools (Sub-Extension)

An isolated, opt-in "extension within the extension" for YouTube playback comfort, anti-distraction filtering, hover-preview protection, and Watch Later bookmarking—kept completely separate from MPV playback/IPC so YouTube can be developed standalone and ported cleanly into the main extension.

## Core Architecture
- **Disabled by default in main extension**: Controlled by `shinkuYtToolsEnabled` (boolean, default `false` in main extension; defaults to `true` on install in standalone `yt-tools-standalone/`).
- **Dynamic Registration** (`background/yt_tools_service.js`):
  - Uses `chrome.scripting.registerContentScripts` / `unregisterContentScripts` (`persistAcrossSessions: true`) without modifying `manifest.json` or reloading the extension.
  - Registers `yt-tools/yt_defaults.js` + `yt-tools/yt_bridge.js` in `ISOLATED` world, and `yt-tools/yt_content.js` in `MAIN` world on `*://*.youtube.com/*`.
  - Also injects into already-open matching tabs via `injectIntoOpenMatchingTabs()` when enabled or on extension reload.
- **Context Menu** (`utils/contextMenu.js`, `background.js`):
  - Adds `"Save to Shinku YT Library"` (`shinku-yt-save-library`) on YouTube pages/links when `shinkuYtToolsEnabled` is true.
- **Popup UI & Overarching Settings Categories** (`popup.html`, `popup.css`, `popup.js`, `popup/popup_youtube.js`):
  - Top-level tab bar (`#popup-extension-tabs`): **MPV Organizer** | **YouTube Tools** (with `yt-tools/icons/icon16.png` and `#yt-tools-status-dot`). Persists `popupActiveExtTab` and `popupYtSubview` in `chrome.storage.local`.
  - `UIModeManager` in `popup.js` respects `isMpvViewHidden` so async MPV syncs don't overwrite `#youtube-tools-view`.
  - Library renders `shinkuLibrary` safely using `createElement` + `textContent` (never `innerHTML` with video metadata).
  - Settings render from `SHINKU_YT_UI_SCHEMA` (`yt-tools/yt_defaults.js`) across overarching categories, each with a header master switch that enables/disables all child features plus an independent collapse chevron:
    1. `frame-removal-settings` (`#yt-frame-removal-settings`, master: `frame-removal`)
    2. `distraction-settings` (`#yt-distraction-settings`, master: `distraction-master`)
    3. `video-player-settings` (`#yt-video-player-settings`, master: `video-settings`, with automatic migration from legacy `Video-settings`)
    4. `thumbnail-title-settings` (`#yt-thumbnail-title-settings`, master: `thumbnail-master`)
    5. `playlist-manager` (`#yt-playlist-manager-settings`, master: `playlist-manager`)

## Standalone-First & Auto-Porting Workflow
YouTube Tools can be developed independently in `yt-tools-standalone/` (loaded directly as an unpacked Chrome extension) and automatically ported into the main MPV Playlist Organizer extension—or exported back out to `yt-tools-standalone/` (and `yt-tools-standalone.zip`):

- **Port Standalone → Main (`python3 yt-tools/port_to_main.py [--source DIR] [--dry-run]`):**
  1. Validates `yt-tools/yt_defaults.js`, `yt-tools/yt_bridge.js`, `yt-tools/yt_content.js`, `popup/popup_youtube.js`, and `background/yt_tools_service.js` in the source directory.
  2. Copies `yt-tools/*.js` into `yt-tools/`, `images/icon{16,32,48,128}.png` (or `icons/icon*.png`) into `yt-tools/icons/`, and `popup/popup_youtube.js` into `popup/`.
  3. Maps `const logger = console;` back to `import { logger } from "../utils/SystemLogger.module.js";` when writing `background/yt_tools_service.js`.
  4. Syncs the `<div id="yt-tools-settings-panel" ...>...</div>` group containers from `popup.html` and the `Shinku's YouTube Tools` CSS section from `popup.css` into the main extension's `popup.html` and `popup.css`.
- **Export Main → Standalone (`python3 yt-tools/export_standalone.py [--out DIR] [--zip]`):**
  1. Copies `yt-tools/*.js`, `yt-tools/icons/icon*.png`, and `popup/popup_youtube.js` into `yt-tools-standalone/`.
  2. Adapts `background/yt_tools_service.js` (`logger` → `console`), writes standalone `manifest.json`, `background.js`, `popup.html`, `popup.js`, and extracts the YouTube Tools CSS section from `popup.css`.

## Key Files
- **Live Sub-Extension (Main Repo)**:
  - `yt-tools/yt_defaults.js` — `SHINKU_YT_DEFAULTS`, `SHINKU_YT_QUALITIES`, `SHINKU_YT_SPEEDS`, `SHINKU_YT_CODECS`, `SHINKU_YT_UI_SCHEMA`
  - `yt-tools/yt_bridge.js` — `ISOLATED` world storage/message bridge, invalidation cleanup, & SPA navigation detector
  - `yt-tools/yt_content.js` — `MAIN` world features across all schema categories, hover-preview shield, and Watch Later bookmarking/sync
  - `yt-tools/icons/icon{16,32,48,128}.png` — Dedicated YouTube Tools icons
  - `yt-tools/port_to_main.py` — Auto-porter from standalone extension into the main extension
  - `yt-tools/export_standalone.py` — Exporter from main extension to standalone extension + zip
  - `background/yt_tools_service.js` — Dynamic script registration & context menu save handler
  - `popup/popup_youtube.js` — YouTube Tools tab controller (enable toggle, Library, Settings)
- **Standalone Build (`yt-tools-standalone/`)**:
  - Self-contained Chrome MV3 extension ready to load unpacked or zip for distribution.
- **Archived Reference (`yt-tools-legacy/`)**:
  - Moved from the standalone `Shinku-yt-fix` extension; **not loaded** by the extension.

## Invariants & Guardrails
1. **Disabled by default in main extension:** `shinkuYtToolsEnabled` must default to `false` in the main extension so YouTube Tools stays opt-in and isolated from MPV playback.
2. **Dynamic registration only:** Never add static `yt-tools/*` entries to the main `manifest.json` `content_scripts`; always manage injection via `chrome.scripting` in `background/yt_tools_service.js`.
3. **XSS-safe library rendering:** Always render `shinkuLibrary` in `popup/popup_youtube.js` using `createElement` + `textContent`; never use `innerHTML` with video titles or metadata.
4. **Keep legacy reference isolated:** `yt-tools-legacy/` is archival documentation only and must never be imported or referenced by runtime code.
5. **Keep standalone logger-free:** `background/yt_tools_service.js` must use `import { logger } from "../utils/SystemLogger.module.js";` in the main repo and `const logger = console;` in `yt-tools-standalone/`.
