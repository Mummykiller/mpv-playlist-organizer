---
name: ui-shadow-dom-and-settings
description: >-
  Governs the frontend presentation layer, Shadow DOM style injection, and Settings UI architecture.
  Load this skill whenever modifying `content.js`, `content.css`, `popup.html`, `popup.js`, `popup.css`,
  `shared.css`, `utils/UIManager.js`, `utils/MpvController.js`, `utils/PlaylistUI.js`,
  `utils/PlaylistRenderer.js`, or the Settings UI in `utils/settings.js`.
---

# UI, Shadow DOM & Settings Architecture

This skill defines the rendering architecture for both browser extension UI surfaces (Popup and In-Page Content Script), strict Shadow DOM encapsulation rules, and the settings management interface.

---

## 1. Dual Surface Architecture

The frontend renders across two distinct surfaces:

```
┌────────────────────────────────────────┐       ┌────────────────────────────────────────┐
│ 1. Extension Popup Window              │       │ 2. In-Page Injected Controller         │
│ (popup.html / popup.js)                │       │ (content.js / Shadow DOM)              │
├────────────────────────────────────────┤       ├────────────────────────────────────────┤
│ • Runs in extension context.           │       │ • Injected into target web pages.      │
│ • Uses shared.css + popup.css.         │       │ • Uses shared.css + content.css.       │
│ • Renders via PlaylistRenderer.js.     │       │ • Renders via PlaylistUI / MpvControl. │
│ • Completely reloads on every open.    │       │ • Encapsulated inside isolated Shadow  │
│ • Full management view, AniList tab,   │       │   DOM roots to prevent page CSS leaks. │
│   and collapsible settings controls.   │       │ • Minimized stub & quick-actions bar.  │
└────────────────────────────────────────┘       └────────────────────────────────────────┘
```

---

## 2. Strict Shadow DOM Encapsulation & CSS Injection Rules

In-page UI is injected into host elements attached directly to `document.body`:
- `#m3u8-controller-host`: Main floating overlay and compact player.
- `#m3u8-minimized-host`: Minimized launcher stub button.
- `#anilist-panel-host`: Floating, draggable AniList schedule panel.

All hosts attach an open Shadow Root: `host.attachShadow({ mode: "open" })`.

### ⚠️ Critical Rule 1: Never Use `<link rel="stylesheet">` in Shadow DOM

Websites with strict Content Security Policies (CSP) or cross-origin isolation (such as YouTube and Twitch) strictly block external extension stylesheet links:
```
Refused to load stylesheet 'chrome-extension://.../content.css' because it violates the following Content Security Policy directive...
Unsafe attempt to load URL... Domains, protocols and ports must match.
```

**The Solution (`UIManager._injectStyles`):**
1. Prefetch CSS text programmatically in the background using extension privileges (`fetch(chrome.runtime.getURL("shared.css"))` and `fetch(chrome.runtime.getURL("content.css"))`).
2. Cache the combined stylesheet promise (`MPV._cachedStylesPromise`).
3. Create or find `<style class="mpv-injected-styles">` in the Shadow Root.
4. Inject the raw CSS string into `styleEl.textContent`.

### ⚠️ Critical Rule 2: Never Overwrite `shadowRoot.innerHTML` After Style Injection

If you assign `shadowRoot.innerHTML = "..."` after calling `_injectStyles()`, the injected `<style>` element will be wiped from the DOM, causing completely unstyled UI and layout collapse.

**Mandatory Pattern:**
```javascript
// Correct:
this.shadowRoot = this.controllerHost.attachShadow({ mode: "open" });
this._injectStyles(this.shadowRoot);

const uiWrapper = document.createElement("div");
uiWrapper.id = "m3u8-controller";
uiWrapper.innerHTML = `<!-- UI markup here -->`;
this.shadowRoot.appendChild(uiWrapper); // Preserves <style>
```

---

## 3. Extension Settings UI Architecture (`utils/settings.js`)

Settings management is centralized in `OptionsManager`.

### A. Curated Simple vs. Advanced Mode

- Controlled via `.mode-simple` or `.mode-advanced` on `#shared-settings-container`.
- **Simple Mode:** Displays ~12 high-impact essential controls (playback behavior, basic toggles). Power-user controls marked with `.setting-advanced` or `.group-advanced` are hidden via CSS (`display: none;`).
- **Zero DOM Destruction:** No elements are removed from the DOM; mode toggling only toggles CSS classes, maintaining event listeners and form state.

### B. Category Navigation Tabs

Horizontal pill navigation buttons (`.cat-tab-btn`) filter settings sections:
- Categories: `All`, `General`, `Playback`, `Streaming`, `Performance`, `Shortcuts`, `Privacy`, `System`, and `Favorites`.
- Each `.settings-section` defines `data-category="<name>"`. Clicking a tab hides non-matching sections and auto-expands the matching section.

### C. Favorites & Quick-Access Pinned Settings (⭐)

- Every setting group features a star icon button (`.btn-favorite-setting`).
- Clicking toggles the setting identifier in `this.favoriteSettings` (persisted to `localStorage:mpv_favorite_settings`).
- Favorited settings appear under the `⭐ Favorites` tab at the top.
- **Power-User Override:** Favorited settings remain visible in the Favorites tab **even if classified as Advanced and the user is in Simple Mode**. This enables users to pin specific advanced controls without switching to full advanced view.

### D. Buffering & Network Presets

Quick technical presets (`#setting-buffer-preset`):
- Options: `Default`, `Smooth Streaming`, `Low RAM`, `Custom`.
- Selecting a preset automatically populates technical controls (`demuxerMaxBytes`, `demuxerMaxBackBytes`, `cacheSecs`, `streamBufferSize`, etc.).
- Modifying any technical buffer input manually automatically sets the preset selector back to `Custom`.

### E. Live Search & Keyword Filtering

- `OptionsManager._handleSettingsSearch(query)` executes live keyword filtering against:
  - Section titles (`.settings-section-title`).
  - Setting labels and names.
  - Setting help tooltips and descriptions (`.setting-help-text`).
- Highlights matching sections, auto-expands collapsed parent blocks containing matches, and updates match count in `#settings-search-status`.

### F. Collapsible Full View Settings

In the Folder Management view (`#folder-management-view`), settings controls are housed in a collapsible container (`#full-settings-controls`):
- Toggled via `#btn-full-toggle-settings`.
- Open/closed state is persisted in `localStorage:mpv_full_settings_open` to preserve user context across popup sessions.

---

## 4. On-Page Controller Elements & Interactions

- **Quick-Actions Bar (`#quick-actions-bar`):**
  - Displays quick action buttons (A, B, C, and ⚡ Unmanaged Launch).
  - ⚡ triggers `play_new_instance`, spawning a dedicated independent MPV player without closing or controlling the existing IPC session.
- **Minimized Launcher Stub (`#m3u8-minimized-stub`):**
  - Floating pill button positioned on-screen when controller is minimized.
  - Position persisted in `uiPreferences.global.minimizedStubPosition`.
  - Supports dragging via `utils/Draggable.js` and resizing via `utils/Resizable.js`.

---

## 5. UI Checklist & Common Regressions

- [ ] Verify that injected `<style>` tags are prepended before UI wrappers in all Shadow Roots.
- [ ] Confirm no external `<link rel="stylesheet">` exists inside any `attachShadow` root.
- [ ] Ensure any new setting key added to the UI is mirrored in `file_io.py:get_settings()` to satisfy `test_settings_synchronization`.
- [ ] Ensure advanced settings are marked with `class="setting-row setting-advanced"` so they hide correctly in Simple Mode.
