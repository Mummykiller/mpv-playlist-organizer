# Content Script Recovery Injection & Context Invalidation Reference

This reference details the 4-stage ping-first recovery injection pipeline in `background.js:injectIntoTab`, non-reload failure handling, and the extension context invalidation guard pattern.

---

## 1. Ping-First Recovery Injection Pipeline (`background.js:injectIntoTab`)

Declarative `content_scripts` in `manifest.json` serve as the primary injection mechanism for normal page navigations. Dynamic recovery injection via `injectIntoTab` (used on extension startup, reload, or tab activation) executes a 4-stage ping-first guarded lifecycle:

```
┌─────────────────────────────────────────────────────────────────────────┐
│ 1. Tab Readiness, URL & Domain Validation                               │
│ • Require tab.status === "complete" (never tear down loading tabs)      │
│ • Skip restricted schemes: chrome://, about:, Chrome Web Store          │
│ • Skip domains configured in settings.uiPreferences.global.restrictedDom│
├─────────────────────────────────────────────────────────────────────────┤
│ 2. Early Alive Check (Attempt 1 Only — Ping-First Recovery)             │
│ • Send ping: chrome.tabs.sendMessage(tab.id, { action: "ping" })        │
│ • If responsive: Sync UI state via handleContentScriptInit and RETURN.  │
├─────────────────────────────────────────────────────────────────────────┤
│ 3. Pre-Injection Teardown & DOM Sweep                                   │
│ • Call existing controller teardown() / destroy() if present, and purge │
│   lingering hosts from previous injections:                             │
│   #m3u8-controller-host, #m3u8-minimized-host, #anilist-panel-host,     │
│   #mpv-organizer-host-styles                                            │
│ • Resets window.mpvControllerInitialized = false                        │
├─────────────────────────────────────────────────────────────────────────┤
│ 4. Script Execution & Verification (No chrome.runtime.reload())         │
│ • executeScript with chrome.runtime.getManifest().content_scripts[0].js │
│ • Sleep 200ms -> Verification ping                                      │
│ • If unresponsive -> Retry up to 3 times (2000ms delay)                 │
│ • If 3 attempts fail -> Log error & broadcast user notice (No reload)   │
└─────────────────────────────────────────────────────────────────────────┘
```

### Failure Recovery Policy (No `chrome.runtime.reload()`)
When verification fails after all retry attempts:
1. **Persisted Error Log:**
   ```javascript
   logger.error(`[Background] ALL injection attempts failed for tab ${tab.id}. Content script could not be verified.`, { persist: true });
   ```
2. **Isolated User Notification:**
   ```javascript
   broadcastLog({
       text: `[System]: Failed to connect to page controller on tab ${tab.id} after ${MAX_ATTEMPTS} attempts. Please refresh the tab.`,
       type: "error"
   });
   ```
3. **Zero Global Side Effects:** The failure is isolated to the affected tab; `chrome.runtime.reload()` is never called.

---

## 2. Extension Context Invalidation Pattern (`utils/commUtils.module.js:isExtensionReloadError`)

When the extension reloads or updates, content scripts in open tabs lose their connection to the background worker (`Extension context invalidated`, `Receiving end does not exist`, `message channel closed`).

### Defensive Wrapper Pattern
- **Classic Content Scripts:** Access `window.MPV_INTERNAL.isExtensionReloadError` (transpiled from `utils/commUtils.module.js`).
- **ES Modules (`background/` or `utils/*.module.js`):** Import `isExtensionReloadError` from `utils/commUtils.module.js`.

```javascript
// Classic content script: const { isExtensionReloadError } = window.MPV_INTERNAL;
// ES module: import { isExtensionReloadError } from "./commUtils.module.js";

try {
    await chrome.runtime.sendMessage(payload);
} catch (err) {
    if (isExtensionReloadError(err)) {
        return; // Suppress expected noise when extension reloads or updates
    }
    console.error("[MPV] Runtime message failed:", err);
}
```
