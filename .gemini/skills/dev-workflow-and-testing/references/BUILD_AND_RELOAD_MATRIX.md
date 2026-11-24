# JS Transpilation Matrix & Reload Reference

This reference details the module transpilation table (`testing_tools/generate_js.py:CONFIG`), hand-written vs. generated file classification, and the component reloading matrix.

---

## 1. Transpiled Module Mapping (`testing_tools/generate_js.py:CONFIG`)

| Source Module | Generated Target | Global Namespace | Transpiled Window Export |
| :--- | :--- | :--- | :--- |
| `utils/SystemLogger.module.js` | `utils/SystemLogger.js` | `MPV_INTERNAL` | `window.MPV_INTERNAL.logger`, `window.MPV_INTERNAL.LogLevel` |
| `utils/anilist_renderer.module.js` | `utils/anilist_renderer.js` | `MPV_INTERNAL` | `window.MPV_INTERNAL.AniListRenderer` |
| `utils/commUtils.module.js` | `utils/commUtils.js` | `MPV_INTERNAL` | `window.MPV_INTERNAL` |
| `utils/security.module.js` | `utils/security.js` | `MPV_SECURITY` | `window.MPV_SECURITY` |
| `utils/nativeConnection.module.js` | `utils/nativeConnection.js` | `MPV_INTERNAL` | `window.MPV_INTERNAL` |
| `utils/MpvInterface.module.js` | `utils/MpvInterface.js` | `MPV_INTERNAL` | `window.MPV_INTERNAL.MpvInterface` |
| `utils/domUtils.module.js` | `utils/domUtils.js` | `MPV_INTERNAL` | `window.MPV_INTERNAL.domUtils` |

### Generated vs. Hand-Written `utils/*.js`
Only the target files listed in `testing_tools/generate_js.py:CONFIG` are auto-generated (marked with `// AUTO-GENERATED from <Module>.module.js. DO NOT EDIT MANUALLY.`). All other `utils/*.js` files are hand-written sources and are safe to edit directly:
- **Classic content-script / UI helpers (`window.MPV_INTERNAL`):** `AniListUI.js`, `ContentState.js`, `ControllerActions.js`, `ControllerTimers.js`, `ControllerView.js`, `Draggable.js`, `MessageBridge.js`, `MpvController.js`, `NavigationObserver.js`, `PageScraper.js`, `PlaybackStateManager.js`, `PlaylistRenderer.js`, `PlaylistUI.js`, `Resizable.js`, `UIManager.js`, `janitor.js`.
- **ES modules (background / popup):** `contextMenu.js`, `item_processor.js`, `nativeLink.js`, `playlistManager.js`, `settings.js`, `storageManager.js`.

### Transpilation Mechanism (`testing_tools/generate_js.py:transpile_file`)
1. Strips ES module `import { ... } from "..."` statements and maps imported symbols to their global namespace aliases (`const normalizeKeys = window.MPV_INTERNAL.normalizeKeys;`).
2. Converts `export class`, `export function`, and `export const` declarations into namespace assignments (`const Foo = MPV.Foo = class Foo ...`).
3. Wraps the output in an IIFE initializing `window.<NAMESPACE> = window.<NAMESPACE> || {};`.

---

## 2. Component Reloading & Troubleshooting Matrix

| Component | How to Reload | Notes |
| :--- | :--- | :--- |
| **Extension UI / Popup** | Close and reopen the popup | Popup reloads on every open. |
| **Content Scripts** | Refresh the web page (`F5`) | Content scripts reload on page navigation. |
| **Service Worker (`background.js`)** | Go to `chrome://extensions` and click **Reload** | Needed when modifying `background/`, `manifest.json`, or root scripts. |
| **Python Native Host** | **Restart the browser** or terminate `native_host.py` | Chrome keeps the native host process open across the browser session. |
| **MPV Scripts (`mpv_scripts/*.lua`)** | Restart MPV or re-trigger playback | Active MPV instances hold loaded Lua scripts in memory. |

### Common Build & Registration Pitfalls
- **Service worker registration failed (Status code: 15):** Top-level JS syntax error or unresolved import in `background.js` or `background/handlers/*.js`. Run `node --check <file>` or `python3 testing_tools/run_suite.py`.
- **Missing Global Symbol at Runtime:** Confirm the module is registered in `testing_tools/generate_js.py:CONFIG`, run `python3 testing_tools/generate_js.py`, and verify the consumer reads from the matching namespace (`window.MPV_INTERNAL` vs. `window.MPV_SECURITY`).
