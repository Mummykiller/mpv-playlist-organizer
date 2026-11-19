# Settings UI Features & Shadow DOM Injection Reference

This reference details the `OptionsManager` (`utils/settings.js` and `popup/settings_*.js`) architecture, Shadow DOM CSS injection pattern, and on-page controller UI components.

---

## 1. Shadow DOM CSS Injection Pattern (`utils/UIManager.js`)

In-page UI hosts (`#m3u8-controller-host`, `#m3u8-minimized-host`, `#anilist-panel-host`) attach an open Shadow Root (`host.attachShadow({ mode: "open" })`).

### Mandatory Style Injection Sequence (`UIManager._injectStyles`)
1. Fetch `shared.css` and `content.css` text via `fetch(chrome.runtime.getURL(...))` and cache the combined promise (`MPV._cachedStylesPromise`).
2. Create or reuse `<style class="mpv-injected-styles">` inside the Shadow Root and assign the CSS string to `styleEl.textContent`.
3. Append UI containers as child elements (`shadowRoot.appendChild(uiWrapper)`)—**never** assign `shadowRoot.innerHTML = ...` after `_injectStyles()`, which would destroy the `<style>` element.

```javascript
this.shadowRoot = this.controllerHost.attachShadow({ mode: "open" });
this._injectStyles(this.shadowRoot);

const uiWrapper = document.createElement("div");
uiWrapper.id = "m3u8-controller";
this.shadowRoot.appendChild(uiWrapper); // Preserves injected <style>
```

---

## 2. Extension Settings UI Architecture (`utils/settings.js` & `popup/settings_*.js`)

Settings management is coordinated by `OptionsManager` in `utils/settings.js` alongside modular helpers in `popup/settings_ui.js`, `popup/settings_lists.js`, and `popup/settings_diagnostics.js`:

1. **Simple vs. Advanced Mode (`popup/settings_ui.js`):**
   - Toggles `.mode-simple` / `.mode-advanced` on `#shared-settings-container`.
   - Power-user controls marked with `.setting-advanced` or `.group-advanced` are hidden via CSS in Simple Mode without removing DOM nodes or listeners.
2. **Category Navigation Tabs (`.cat-tab-btn`):**
   - Categories: `All`, `General`, `Playback`, `Streaming`, `Performance`, `Shortcuts`, `Privacy`, `System`, and `Favorites`.
   - Filters `.settings-section[data-category="<name>"]` and auto-expands matching sections.
3. **Favorites & Pinned Settings (`.btn-favorite-setting`):**
   - Persisted to `localStorage:mpv_favorite_settings`.
   - **Power-User Override:** Favorited settings remain visible in the `Favorites` tab even if classified as `.setting-advanced` while the user is in Simple Mode.
4. **Buffering & Network Presets (`#setting-buffer-preset`):**
   - Presets (`Default`, `Smooth Streaming`, `Low RAM`, `Custom`) populate `demuxerMaxBytes`, `demuxerMaxBackBytes`, `cacheSecs`, and `streamBufferSize`. Manual edits automatically switch the selector to `Custom`.
5. **Live Keyword Search (`OptionsManager._handleSettingsSearch`):**
   - Filters section titles (`.settings-section-title`), labels, and tooltips (`.setting-help-text`), auto-expanding matching sections and updating `#settings-search-status`.
6. **Collapsible Full-View Settings (`#full-settings-controls`):**
   - Toggled via `#btn-full-toggle-settings` in `#folder-management-view` and persisted in `localStorage:mpv_full_settings_open`.
7. **Keybinding Recorder Lifecycle (`popup/settings_ui.js:startRecording`, `stopRecording`, `utils/settings.js:OptionsManager.stopRecording`):**
   - Pressing `Escape` while recording a shortcut restores `activeRecorder.originalValue` and calls `stopRecording(ctx)`.
   - Switching to the YouTube Tools tab in `popup.js` (`onHideMpvView`) invokes `optionsManager.stopRecording()` and `cancelReorderMode()` so active listeners never leak across tabs.

---

## 3. On-Page Controller Elements (`utils/ControllerView.js`, `utils/ControllerActions.js`)

- **Quick-Actions Bar (`#quick-actions-bar`):**
  - **Button A (`#btn-osc-quick-a`):** Left-click plays from beginning; right-click toggles Pick Start Item mode (`isPickStartModeActive`).
  - **Button C (`#btn-osc-quick-c`):** Left-click toggles interactive drag-and-drop Live Reorder mode (`isLiveReorderModeActive`); right-click triggers Smart Reorder (`get_smart_reorder`).
  - **Button ⚡ (`.btn-disconnected-toggle`):** Toggles Selection Mode (`isSelectionModeActive`) to launch a chosen item in an independent, unmanaged MPV instance (`play_new_instance`).
- **Minimized Launcher Stub (`#m3u8-minimized-stub`):**
  - Floating pill button displayed when the controller is minimized; position persisted in `uiPreferences.global.minimizedStubPosition` and draggable/resizable via `utils/Draggable.js` and `utils/Resizable.js`.
