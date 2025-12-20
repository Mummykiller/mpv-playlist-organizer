/**
 * Manages the lifecycle of all UI elements injected onto the page.
 * This includes creation, injection, and teardown of the main controller,
 * the minimized stub, and the AniList panel.
 */
class UIManager {
    constructor() {
        this.controllerHost = null;
        this.shadowRoot = null;
        this.minimizedHost = null;
        this.anilistPanelHost = null;
        this.anilistShadowRoot = null;
    }

    /**
     * Gets the hostname of the current page.
     * @returns {string|null} The domain, or null if it can't be determined.
     */
    getDomain() {
        try {
            return new URL(window.location.href).hostname;
        } catch (e) {
            return null;
        }
    }

    /**
     * Creates the controller container and injects the UI's HTML into the DOM.
     */
    createAndInjectUi() {
        // Create the host element that will live in the main DOM.
        this.controllerHost = document.createElement('div');
        this.controllerHost.id = 'm3u8-controller-host';
        this.controllerHost.style.display = 'none'; // Start hidden

        const uiWrapper = document.createElement('div');
        uiWrapper.id = 'm3u8-controller';
        const cssUrl = chrome.runtime.getURL('content.css');
        uiWrapper.innerHTML = `
            <link rel="stylesheet" type="text/css" href="${cssUrl}">
            <div id="status-banner"><span id="stream-status">No stream detected</span></div>
            <div id="m3u8-header">
                <div id="m3u8-url">
                    <button id="btn-toggle-minimize" title="Minimize UI"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line></svg></button>
                    <button id="btn-toggle-anilist-left" title="Toggle AniList Releases" style="display: none;"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="15" rx="2" ry="2"></rect><polyline points="17 2 12 7 7 2"></polyline></svg></button>
                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M7 7v10" /><path d="M11 7v10" /><path d="M15 9l5 3-5 3V9z" fill="currentColor" stroke-width="0" /></svg>
                    <span class="title-text">MPV Playlist Organizer</span>
                </div>
                <div id="ui-toggles">
                    <button id="btn-toggle-pin" title="Pin UI Position"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" x2="12" y1="17" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg></button>
                    <button id="btn-toggle-anilist-right" title="Toggle AniList Releases"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="15" rx="2" ry="2"></rect><polyline points="17 2 12 7 7 2"></polyline></svg></button>
                    <button id="btn-toggle-stub" title="Toggle Minimized Button"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="16" cy="16" r="4"/><polygon points="10 8 16 12 10 16" fill="currentColor" stroke-width="0"/></svg></button>
                    <button id="btn-toggle-ui-mode" title="Switch to Compact UI"><svg class="icon-full-ui" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/></svg><svg class="icon-compact-ui" style="display: none;" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/></svg></button>
                </div>
            </div>
            <div id="full-ui-container"><div id="controls-container"><div id="top-controls"><select id="folder-select"></select></div><div id="playback-controls"><button id="btn-play"><span class="emoji">▶️</span> Play</button><button id="btn-play-new" title="Launch a new, separate MPV instance."><span class="emoji">➕</span> Play New</button><button id="btn-close-mpv" title="Close MPV Instance"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button></div><div id="list-controls"><button id="btn-add"><span class="emoji">📥</span> Add</button><button id="btn-clear"><span class="emoji">🗑️</span> Clear</button></div></div><div id="playlist-container"><p id="playlist-placeholder">Playlist is empty.</p></div><div id="log-section"><div id="log-header"><span id="log-title">Communication Log</span><div id="log-buttons"><button id="btn-filter-info" class="log-filter-btn active" title="Toggle Info Logs">Info</button><button id="btn-filter-error" class="log-filter-btn active" title="Toggle Error Logs">Error</button><button id="btn-clear-log" title="Clear Log"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-trash-2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg></button><button id="btn-toggle-log" title="Hide Log"><svg class="log-toggle-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg></button></div></div><div id="log-container"><p id="log-placeholder">Logs will appear here...</p></div></div></div>
            <div id="compact-ui-container" style="display: none;"><div id="compact-controls"><select id="compact-folder-select"></select><div id="compact-item-count-container" title="Items in playlist"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg><span id="compact-item-count">0</span></div><button id="btn-compact-add" title="Add Current URL"><span class="emoji">📥</span></button><button id="btn-compact-play" title="Play List"><span class="emoji">▶️</span></button><button id="btn-compact-clear" title="Clear List"><span class="emoji">🗑️</span></button><button id="btn-compact-close-mpv" title="Close MPV Instance"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button></div></div>
            <div id="confirmation-modal" style="display: none;"><div class="modal-content"><p id="modal-message"></p><div class="modal-actions"><button id="modal-confirm-btn">Confirm</button><button id="modal-cancel-btn">Cancel</button></div></div></div>
        `;
        this.shadowRoot = this.controllerHost.attachShadow({ mode: 'open' });
        this.shadowRoot.appendChild(uiWrapper);
        document.body.appendChild(this.controllerHost);

        // --- Create Minimized Stub ---
        this.minimizedHost = document.createElement('div');
        this.minimizedHost.id = 'm3u8-minimized-host';
        this.minimizedHost.style.display = 'none';
        const minimizedShadowRoot = this.minimizedHost.attachShadow({ mode: 'open' });
        minimizedShadowRoot.innerHTML = `
            <link rel="stylesheet" type="text/css" href="${cssUrl}">
            <div id="m3u8-minimized-wrapper"><button id="m3u8-minimized-stub" title="Show MPV Controller"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M7 7v10" /><path d="M11 7v10" /><path d="M15 9l5 3-5 3V9z" fill="currentColor" stroke-width="0" /></svg></button><button id="m3u8-minimized-play-btn" title="Play Playlist" class="play-button"><span id="m3u8-minimized-item-count" class="play-button-count" style="display: none;">0</span><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg></button></div>
        `;
        document.body.appendChild(this.minimizedHost);

        // --- Create AniList Panel ---
        this.anilistPanelHost = document.createElement('div');
        this.anilistPanelHost.id = 'anilist-panel-host';
        this.anilistPanelHost.style.display = 'none';
        this.anilistShadowRoot = this.anilistPanelHost.attachShadow({ mode: 'open' });
        const anilistPanelWrapper = document.createElement('div');
        anilistPanelWrapper.id = 'anilist-panel-wrapper';
        anilistPanelWrapper.innerHTML = `
            <link rel="stylesheet" type="text/css" href="${cssUrl}">
            <div class="anilist-panel-header"><button id="btn-refresh-anilist" class="anilist-refresh-btn" title="Refresh Releases"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2v6h6"/><path d="M21 12A9 9 0 0 0 6 5.3L3 8"/><path d="M21 22v-6h-6"/><path d="M3 12a9 9 0 0 0 15 6.7l3-2.7"/></svg></button><p class="anilist-release-delay-info">Note: There may be a 30 minute to 3 hour delay on release times.</p><button id="btn-pin-anilist-panel" title="Pin Panel Position"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"></line><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"></path></svg></button><button id="btn-close-anilist-panel" title="Close Panel">&times;</button></div>
            <div id="anilist-releases-container"><ul id="anilist-releases-list" class="anilist-releases-list"></ul></div>
            <div id="anilist-resize-handle" title="Resize Panel"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="20" y1="14" x2="14" y2="20"></line><line x1="15" y1="9" x2="9" y2="15"></line></svg></div>
        `;
        this.anilistShadowRoot.appendChild(anilistPanelWrapper);
        document.body.appendChild(this.anilistPanelHost);

        // Inject styles for the host elements into the main document's head.
        const hostStyle = document.createElement('style');
        hostStyle.textContent = `
            #m3u8-controller-host, #m3u8-minimized-host { position: fixed; z-index: 2147483647; } /* Default position is top-left (0,0) until JS moves it */
            #m3u8-minimized-host.top-left { top: 15px; left: 15px; right: auto; bottom: auto; }
            #m3u8-minimized-host.top-right { top: 15px; right: 15px; left: auto; bottom: auto; }
            #anilist-panel-host { position: fixed; width: 400px; height: 600px; z-index: 2147483646; }
            body.mpv-controller-dragging, body.mpv-controller-dragging * { user-select: none; -webkit-user-select: none; cursor: grabbing !important; }
            body.mpv-anilist-dragging, body.mpv-anilist-dragging * { user-select: none; -webkit-user-select: none; cursor: grabbing !important; }
            body.mpv-anilist-resizing, body.mpv-anilist-resizing * { user-select: none; -webkit-user-select: none; cursor: se-resize !important; }
        `;
        document.head.appendChild(hostStyle);
    }

    /**
     * Removes all UI elements and their associated styles from the DOM.
     */
    teardown() {
        this.controllerHost?.remove();
        this.minimizedHost?.remove();
        this.anilistPanelHost?.remove();

        // Reset properties
        this.controllerHost = null;
        this.shadowRoot = null;
        this.minimizedHost = null;
        this.anilistPanelHost = null;
        this.anilistShadowRoot = null;
    }
}