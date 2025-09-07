/* ------------------------------------------------------------------
 * content.js (fully fixed and now draggable, with saved position)
 * UI + messaging with the local MPV server.
 * ------------------------------------------------------------------*/

// --- Utility Functions ---

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

const sendMessageAsync = (payload) => new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
        if (chrome.runtime.lastError) {
            // The error message is more useful than a generic rejection.
            return reject(new Error(chrome.runtime.lastError.message));
        }
        resolve(response);
    });
});

class MpvController {
    constructor() {
        // --- State ---
        this.detectedUrl = null;
        this.controllerHost = null;
        this.shadowRoot = null;
        this.anilistPanelHost = null;
        this.anilistShadowRoot = null;
        this.currentUiMode = 'full';
        this.isPinned = false;
        this.lastUrl = window.location.href;
        this.activeLogFilters = { info: true, error: true };

        // Bind `this` for methods that are used as event listeners or callbacks
        this.handleMessage = this.handleMessage.bind(this);
        this.handlePageUpdate = debounce(this.handlePageUpdate.bind(this), 250);
        this.handleFullscreenChange = this.handleFullscreenChange.bind(this);
    }

    /**
     * Handles messages from the background script.
     * @param {object} request - The message object.
     */
    handleMessage(request) {
        if (request.action === 'show_ui') {
            // Re-query the host from the DOM to ensure we have a live reference,
            // as `this.controllerHost` could be stale if the UI was re-injected.
            const host = document.getElementById('m3u8-controller-host');
            if (host) {
                host.style.display = 'block';
                // When explicitly shown, save the new state.
                this.savePreference({ minimized: false });
                // After showing, validate its position to ensure it's not off-screen.
                this.validateAndRepositionController();
            }
        } else if (request.m3u8) {
            this.detectedUrl = request.m3u8;
            // Report the detected stream URL to the background script
            chrome.runtime.sendMessage({ action: 'report_detected_url', url: this.detectedUrl });
            // Call the global UI update function
            this.updateStatusBanner(`Stream detected`, true);
        } else if (request.action === 'render_playlist') {
            // The background has sent an updated list. Render it only if it
            // matches the currently selected folder.
            const currentFolderId = this.shadowRoot?.getElementById('folder-select')?.value;
            if (currentFolderId === request.folderId) {
                this.renderPlaylist(request.playlist);
            }
        } else if (request.foldersChanged) {
            // The list of available folders has changed (e.g., a new one was created)
            this.updateFolderDropdowns();
        } else if (request.action === 'last_folder_changed') {
            // The selected folder was changed in another context (e.g., the popup).
            // We need to sync our dropdowns to reflect this change.
            const fullSelect = this.shadowRoot?.getElementById('folder-select');
            const compactSelect = this.shadowRoot?.getElementById('compact-folder-select');
            if (fullSelect && compactSelect && request.folderId) {
                // Check if the value is different to avoid redundant playlist refreshes.
                if (fullSelect.value !== request.folderId) {
                    fullSelect.value = request.folderId;
                    compactSelect.value = request.folderId;
                    this.refreshPlaylist(); // Refresh the playlist view for the new folder.
                }
            }
        } else if (request.log) {
            // Call the global UI update function
            this.addLogEntry(request.log);
        } else if (request.action === 'preferences_changed') {
            // Global or another domain's preferences changed, re-fetch ours.
            this.applyInitialState();
        }
    }

    /**
     * Creates the controller container and injects the UI's HTML into the DOM.
     */
    async createAndInjectUi() {
        // Create the host element that will live in the main DOM.
        // All styling and positioning will be applied to this host.
        this.controllerHost = document.createElement('div');
        this.controllerHost.id = 'm3u8-controller-host';
        this.controllerHost.style.display = 'none'; // Start hidden, background script will tell us to show.

        // The UI container now lives inside the shadow DOM.
        const uiWrapper = document.createElement('div');
        uiWrapper.id = 'm3u8-controller';
        // Get the URL for the stylesheet, which is made available via web_accessible_resources.
        const cssUrl = chrome.runtime.getURL('content.css');
        uiWrapper.innerHTML = `
        <link rel="stylesheet" type="text/css" href="${cssUrl}">
        <div id="status-banner">
            <span id="stream-status">No stream detected</span>
        </div>

        <div id="m3u8-header">
            <div id="m3u8-url">
                <button id="btn-toggle-minimize" title="Minimize UI">
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="5" y1="12" x2="19" y2="12"></line>
                    </svg>
                </button>
                <button id="btn-toggle-anilist-left" title="Toggle AniList Releases" style="display: none;">
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="15" rx="2" ry="2"></rect><polyline points="17 2 12 7 7 2"></polyline></svg>
                </button>
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect width="18" height="18" x="3" y="3" rx="2" />
                    <path d="M7 7v10" />
                    <path d="M11 7v10" />
                    <path d="M15 9l5 3-5 3V9z" fill="currentColor" stroke-width="0" />
                </svg>
                <span class="title-text">MPV Playlist Organizer</span>
            </div>
            <div id="ui-toggles">
                <button id="btn-toggle-pin" title="Pin UI Position">
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="12" x2="12" y1="17" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/>
                    </svg>
                </button>
                <button id="btn-toggle-anilist-right" title="Toggle AniList Releases">
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <rect x="2" y="7" width="20" height="15" rx="2" ry="2"></rect><polyline points="17 2 12 7 7 2"></polyline>
                    </svg>
                </button>
                <button id="btn-toggle-ui-mode" title="Switch to Compact UI">
                    <svg class="icon-full-ui" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/>
                    </svg>
                    <svg class="icon-compact-ui" style="display: none;" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/>
                    </svg>
                </button>
            </div>
        </div>

        <div id="full-ui-container">
            <div id="controls-container">
                <div id="top-controls">
                    <select id="folder-select"><!-- Options populated dynamically --></select>
                </div>

                <div id="playback-controls">
                    <button id="btn-play"><span class="emoji">▶️</span> Play</button>
                    <button id="btn-play-new" title="Launch a new, separate MPV instance."><span class="emoji">➕</span> Play New</button>
                    <button id="btn-close-mpv" title="Close MPV Instance">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                    </button>
                </div>

                <div id="list-controls">
                    <button id="btn-add"><span class="emoji">📥</span> Add</button>
                    <button id="btn-clear"><span class="emoji">🗑️</span> Clear</button>
                </div>

            </div>

            <div id="playlist-container">
                <p id="playlist-placeholder">Playlist is empty.</p>
            </div>

            <div id="log-section">
                <div id="log-header">
                    <span id="log-title">Communication Log</span>
                    <div id="log-buttons">
                        <button id="btn-filter-info" class="log-filter-btn active" title="Toggle Info Logs">Info</button>
                        <button id="btn-filter-error" class="log-filter-btn active" title="Toggle Error Logs">Error</button>
                        <button id="btn-clear-log" title="Clear Log">
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-trash-2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
                        </button>
                        <button id="btn-toggle-log" title="Hide Log">
                            <svg class="log-toggle-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
                        </button>
                    </div>
                </div>

                <div id="log-container">
                    <p id="log-placeholder">Logs will appear here...</p>
                </div>
            </div>

        </div>

        <div id="compact-ui-container" style="display: none;">
            <div id="compact-controls">
                <select id="compact-folder-select"><!-- Options populated dynamically --></select>
                <div id="compact-item-count-container" title="Items in playlist">
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="8" y1="6" x2="21" y2="6"></line>
                        <line x1="8" y1="12" x2="21" y2="12"></line>
                        <line x1="8" y1="18" x2="21" y2="18"></line>
                        <line x1="3" y1="6" x2="3.01" y2="6"></line>
                        <line x1="3" y1="12" x2="3.01" y2="12"></line>
                        <line x1="3" y1="18" x2="3.01" y2="18"></line>
                    </svg>
                    <span id="compact-item-count">0</span>
                </div>
                <button id="btn-compact-add" title="Add Current URL"><span class="emoji">📥</span></button>
                <button id="btn-compact-play" title="Play List"><span class="emoji">▶️</span></button>
                <button id="btn-compact-clear" title="Clear List"><span class="emoji">🗑️</span></button>
                <button id="btn-compact-close-mpv" title="Close MPV Instance">
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                </button>
            </div>
        </div>

        <!-- Confirmation Modal -->
        <div id="confirmation-modal" style="display: none;">
            <div class="modal-content">
                <p id="modal-message"></p>
                <div class="modal-actions">
                    <button id="modal-confirm-btn">Confirm</button>
                    <button id="modal-cancel-btn">Cancel</button>
                </div>
            </div>
        </div>
        `;
        // Attach the shadow root for isolation.
        this.shadowRoot = this.controllerHost.attachShadow({ mode: 'open' });
        this.shadowRoot.appendChild(uiWrapper);

        // Append the host to the body *after* the shadow DOM is populated
        document.body.appendChild(this.controllerHost);

        // --- Create AniList Panel ---
        this.anilistPanelHost = document.createElement('div');
        this.anilistPanelHost.id = 'anilist-panel-host';
        this.anilistPanelHost.style.display = 'none'; // Start hidden

        this.anilistShadowRoot = this.anilistPanelHost.attachShadow({ mode: 'open' });

        const anilistPanelWrapper = document.createElement('div');
        anilistPanelWrapper.id = 'anilist-panel-wrapper';
        anilistPanelWrapper.innerHTML = `
            <link rel="stylesheet" type="text/css" href="${cssUrl}">
            <p class="anilist-release-delay-info">Note: There may be a 30 minute to 3 hour delay on release times.</p>
            <div id="anilist-releases-container">
                <ul id="anilist-releases-list" class="anilist-releases-list">
                    <!-- AniList items will be rendered here -->
                </ul>
            </div>
        `;
        this.anilistShadowRoot.appendChild(anilistPanelWrapper);
        document.body.appendChild(this.anilistPanelHost);

        // Inject styles for the host elements into the main document's head.
        const hostStyle = document.createElement('style');
        hostStyle.textContent = `
            #m3u8-controller-host {
                position: fixed; z-index: 2147483647;
            }
            #anilist-panel-host {
                position: fixed;
                width: 388px; /* Match popup width for consistency */
                z-index: 2147483646; /* Just below controller */
            }
            body.mpv-controller-dragging, body.mpv-controller-dragging * {
                user-select: none; -webkit-user-select: none; cursor: grabbing !important;
            }`;
        document.head.appendChild(hostStyle);
    }

    switchUi(uiMode, saveState = true) {
        const fullUiContainer = this.shadowRoot?.getElementById('full-ui-container');
        const compactUiContainer = this.shadowRoot?.getElementById('compact-ui-container');
        const toggleBtn = this.shadowRoot?.getElementById('btn-toggle-ui-mode');
        const fullIcon = toggleBtn?.querySelector('.icon-full-ui');
        const compactIcon = toggleBtn?.querySelector('.icon-compact-ui');

        if (!fullUiContainer || !compactUiContainer || !toggleBtn || !fullIcon || !compactIcon) return;

        this.currentUiMode = uiMode;
        if (uiMode === 'full') {
            fullUiContainer.style.display = 'flex';
            compactUiContainer.style.display = 'none';
            toggleBtn.title = 'Switch to Compact UI';
            fullIcon.style.display = 'block';
            compactIcon.style.display = 'none';
        } else if (uiMode === 'compact') {
            fullUiContainer.style.display = 'none';
            compactUiContainer.style.display = 'flex';
            toggleBtn.title = 'Switch to Full UI';
            fullIcon.style.display = 'none';
            compactIcon.style.display = 'block';
        }
        if (saveState) {
            this.savePreference({ mode: uiMode });
        }
        this.refreshPlaylist();
    }

    /**
     * Displays a custom confirmation modal inside the controller UI.
     * @param {string} message The message to display in the modal.
     * @returns {Promise<boolean>} A promise that resolves to true if confirmed, false if cancelled.
     */
    showConfirmationModal(message) {
        return new Promise((resolve) => {
            const modal = this.shadowRoot.getElementById('confirmation-modal');
            const messageEl = this.shadowRoot.getElementById('modal-message');
            const confirmBtn = this.shadowRoot.getElementById('modal-confirm-btn');
            const cancelBtn = this.shadowRoot.getElementById('modal-cancel-btn');

            if (!modal || !messageEl || !confirmBtn || !cancelBtn) {
                // Fallback to browser confirm if the modal elements are not found
                resolve(confirm(message));
                return;
            }

            messageEl.textContent = message;
            modal.style.display = 'flex';

            const close = (result) => {
                modal.style.display = 'none';
                // Remove listeners to prevent memory leaks
                confirmBtn.onclick = null;
                cancelBtn.onclick = null;
                resolve(result);
            };

            // Assign new click handlers
            confirmBtn.onclick = () => close(true);
            cancelBtn.onclick = () => close(false);
        });
    }

    /**
     * Saves a UI preference. The background script will determine if it's
     * a global or domain-specific setting based on the sender.
     * @param {object} preference - The preference object to save (e.g., {pinned: true}).
     */
    savePreference(preference) {
        chrome.runtime.sendMessage({
            action: 'set_ui_preferences',
            preferences: preference
        });
    }

    /**
     * Ensures the controller is within the visible viewport boundaries.
     * This is crucial after window resizes or when showing the UI after it was hidden.
     */
    validateAndRepositionController() {
        // We only care about repositioning if the host element exists.
        if (!this.controllerHost) return;

        // Use a small timeout. When an element's display changes from 'none' to 'block',
        // its dimensions (offsetWidth/Height) are not immediately available in the same
        // execution frame. The timeout pushes this logic to the next event loop tick,
        // by which time the browser has calculated the layout.
        setTimeout(() => {
            // If the controller is hidden, don't do anything.
            if (this.controllerHost.style.display === 'none') return;

            const hostWidth = this.controllerHost.offsetWidth;
            const hostHeight = this.controllerHost.offsetHeight;

            // If dimensions are zero, it's likely not rendered yet. Abort.
            if (hostWidth === 0 || hostHeight === 0) return;

            const maxX = window.innerWidth - hostWidth;
            const maxY = window.innerHeight - hostHeight;

            const currentLeft = this.controllerHost.offsetLeft;
            const currentTop = this.controllerHost.offsetTop;

            // Clamp the values to be within the viewport.
            const newLeft = Math.min(maxX, Math.max(0, currentLeft));
            const newTop = Math.min(maxY, Math.max(0, currentTop));

            // Only update and save if a change was necessary.
            if (newLeft !== currentLeft || newTop !== currentTop) {
                this.controllerHost.style.left = `${newLeft}px`;
                this.controllerHost.style.top = `${newTop}px`;
                this.controllerHost.style.right = 'auto'; // Ensure we are using left/top positioning
                this.controllerHost.style.bottom = 'auto';

                const newPosition = { left: this.controllerHost.style.left, top: this.controllerHost.style.top, right: this.controllerHost.style.right, bottom: this.controllerHost.style.bottom };
                this.savePreference({ position: newPosition });
            }
            // Always update adaptive elements after a potential reposition.
            this.updateAdaptiveElements();
        }, 10); // 10ms is a safe, small delay.
    }

    // --- UI State Management Functions ---
    // These functions update the UI and, by default, save the state to storage.
    // They can be called with `saveState = false` during initialization to prevent
    // a redundant write operation.

    setLogVisibility(isVisible, saveState = true) {
        const logContainer = this.shadowRoot?.getElementById('log-container');
        const toggleLogBtn = this.shadowRoot?.getElementById('btn-toggle-log');
        if (!logContainer || !toggleLogBtn) return;

        if (isVisible) { // If log should be visible
            logContainer.classList.remove('log-hidden'); // Remove the hidden class
            toggleLogBtn.classList.add('active');
            toggleLogBtn.title = 'Hide Log';
        } else { // If log should be hidden
            logContainer.classList.add('log-hidden'); // Add the hidden class
            toggleLogBtn.classList.remove('active');
            toggleLogBtn.title = 'Show Log';
        }
        if (saveState) {
            this.savePreference({ logVisible: isVisible });
        }
    }

    setPinState(shouldBePinned, saveState = true) {
        const togglePinBtn = this.shadowRoot?.getElementById('btn-toggle-pin');
        const dragHandle = this.shadowRoot?.getElementById('status-banner');
        if (!this.controllerHost || !togglePinBtn || !dragHandle) return;

        this.isPinned = shouldBePinned; // Update instance state variable

        if (shouldBePinned) {
            this.controllerHost.classList.add('pinned');
            togglePinBtn.classList.add('active-toggle');
            togglePinBtn.title = 'Unpin UI (allows dragging)';
            dragHandle.style.cursor = 'default';
        } else {
            this.controllerHost.classList.remove('pinned');
            togglePinBtn.classList.remove('active-toggle');
            togglePinBtn.title = 'Pin UI (locks at current position)';
            dragHandle.style.cursor = 'grab';
        }
        if (saveState) {
            this.savePreference({ pinned: shouldBePinned });
        }
    }

    setLogFilters(newFilters, saveState = true) {
        this.activeLogFilters = { ...this.activeLogFilters, ...newFilters };

        const infoBtn = this.shadowRoot?.getElementById('btn-filter-info');
        const errorBtn = this.shadowRoot?.getElementById('btn-filter-error');

        if (infoBtn) infoBtn.classList.toggle('active', this.activeLogFilters.info);
        if (errorBtn) errorBtn.classList.toggle('active', this.activeLogFilters.error);

        this.applyLogFilters();

        if (saveState) {
            this.savePreference({ logFilters: this.activeLogFilters });
        }
    }

    /**
     * Iterates through existing log items and shows/hides them based on the
     * current `this.activeLogFilters` state.
     */
    applyLogFilters() {
        const logContainer = this.shadowRoot?.getElementById('log-container');
        if (!logContainer) return;

        const logItems = logContainer.querySelectorAll('.log-item');
        logItems.forEach(item => {
            const isError = item.classList.contains('log-item-error');
            const type = isError ? 'error' : 'info';

            if (this.activeLogFilters[type]) {
                item.classList.remove('hidden-by-filter');
            } else {
                item.classList.add('hidden-by-filter');
            }
        });
    }

    updateAnilistPanelPosition() {
        if (!this.anilistPanelHost || !this.controllerHost) {
            return; // Don't do anything if panel is hidden or elements are missing
        }

        const controllerRect = this.controllerHost.getBoundingClientRect();
        const panelWidth = this.anilistPanelHost.offsetWidth; // Should be 380px from style
        const gap = 10; // Gap between controller and panel

        const controllerCenter = controllerRect.left + (controllerRect.width / 2);
        const screenCenter = window.innerWidth / 2;

        let newLeft;
        if (controllerCenter < screenCenter) {
            // Controller is on the left, so panel should be to its right.
            newLeft = controllerRect.right + gap;
        } else {
            // Controller is on the right, so panel should be to its left.
            newLeft = controllerRect.left - panelWidth - gap;
        }

        this.anilistPanelHost.style.top = `${controllerRect.top}px`;
        this.anilistPanelHost.style.left = `${newLeft}px`;
        this.anilistPanelHost.style.right = 'auto';
        this.anilistPanelHost.style.bottom = 'auto';
    }

    updateAdaptiveElements() {
        if (!this.controllerHost || !this.shadowRoot) return;

        const anilistBtnLeft = this.shadowRoot.getElementById('btn-toggle-anilist-left');
        const anilistBtnRight = this.shadowRoot.getElementById('btn-toggle-anilist-right');
        if (!anilistBtnLeft || !anilistBtnRight) return;

        const controllerCenter = this.controllerHost.offsetLeft + (this.controllerHost.offsetWidth / 2);
        const screenCenter = window.innerWidth / 2;

        if (controllerCenter < screenCenter) {
            // Controller is on the left half, so the "outer" button is on the right.
            anilistBtnLeft.style.display = 'none';
            anilistBtnRight.style.display = 'flex';
        } else {
            // Controller is on the right half, so the "outer" button is on the left.
            anilistBtnLeft.style.display = 'flex';
            anilistBtnRight.style.display = 'none';
        }
        // Also update the panel's position in case the controller was moved
        // while the panel was hidden.
        this.updateAnilistPanelPosition();
    }
    /**
     * Finds all interactive UI elements and attaches their corresponding event listeners.
     */
    bindEventListeners() {
        this._bindHeaderControls();
        this._bindActionControls();
        this._bindPlaylistControls();
        this._bindLogControls();
        this._bindDragAndDrop();
        this._bindWindowEvents();
    }

    /** Binds listeners for the main header (minimize, pin, UI mode, AniList). */
    _bindHeaderControls() {
        this.shadowRoot.getElementById('btn-toggle-minimize').addEventListener('click', () => {
            this.controllerHost.style.display = 'none';
            this.savePreference({ minimized: true });
        });

        this.shadowRoot.getElementById('btn-toggle-pin').addEventListener('click', () => this.setPinState(!this.isPinned));

        this.shadowRoot.getElementById('btn-toggle-ui-mode').addEventListener('click', () => {
            const newMode = this.currentUiMode === 'full' ? 'compact' : 'full';
            this.switchUi(newMode);
        });

        const anilistBtnLeft = this.shadowRoot.getElementById('btn-toggle-anilist-left');
        const anilistBtnRight = this.shadowRoot.getElementById('btn-toggle-anilist-right');
        const toggleAnilistHandler = () => {
            const isVisible = this.anilistPanelHost.style.display !== 'none';
            if (isVisible) {
                this.anilistPanelHost.style.display = 'none';
                anilistBtnLeft.classList.remove('active-toggle');
                anilistBtnRight.classList.remove('active-toggle');
            } else {
                this.anilistPanelHost.style.display = 'block';
                anilistBtnLeft.classList.add('active-toggle');
                anilistBtnRight.classList.add('active-toggle');
                this.updateAnilistPanelPosition();
                this.fetchAniListReleases();
            }
        };
        anilistBtnLeft.addEventListener('click', toggleAnilistHandler);
        anilistBtnRight.addEventListener('click', toggleAnilistHandler);
    }

    /** Binds listeners for the primary action buttons (Play, Add, Clear, etc.). */
    _bindActionControls() {
        const getCurrentFolderId = () => {
            const folderSelect = this.shadowRoot.getElementById('folder-select');
            const compactFolderSelect = this.shadowRoot.getElementById('compact-folder-select');
            return this.currentUiMode === 'full' ? folderSelect.value : compactFolderSelect.value;
        };

        const handleAddClick = async () => {
            const folderId = getCurrentFolderId();
            const urlToAdd = this.detectedUrl;
            if (!urlToAdd) {
                return this.addLogEntry({ text: `[Content]: No stream/video detected to add.`, type: 'error' });
            }
            try {
                const [prefsResponse, currentPlaylist] = await Promise.all([
                    sendMessageAsync({ action: 'get_ui_preferences' }),
                    this.getPlaylistFromBackground(folderId)
                ]);
                const duplicateBehavior = prefsResponse?.preferences?.duplicate_url_behavior || 'ask';
                const isDuplicate = currentPlaylist.includes(urlToAdd);
                if (isDuplicate) {
                    if (duplicateBehavior === 'never') return this.addLogEntry({ text: `[Content]: URL already exists. 'Never Add' is selected.`, type: 'info' });
                    if (duplicateBehavior === 'ask') {
                        const confirmed = await this.showConfirmationModal('This URL is already in the playlist. Add it again?');
                        if (!confirmed) return this.addLogEntry({ text: `[Content]: Add action cancelled by user.`, type: 'info' });
                    }
                }
                this.sendCommandToBackground('add', folderId);
            } catch (error) {
                this.addLogEntry({ text: `[Content]: Error checking for duplicates: ${error.message}`, type: 'error' });
            }
        };

        const handlePlayClick = () => this.sendCommandToBackground('play', getCurrentFolderId());

        const handleClearClick = async () => {
            const folderId = getCurrentFolderId();
            const prefsResponse = await sendMessageAsync({ action: 'get_ui_preferences' });
            if (prefsResponse?.preferences?.confirm_clear_playlist ?? true) {
                const confirmed = await this.showConfirmationModal(`Are you sure you want to clear the playlist in "${folderId}"?`);
                if (!confirmed) return this.addLogEntry({ text: `[Content]: Clear action cancelled by user.`, type: 'info' });
            }
            this.sendCommandToBackground('clear', folderId);
        };

        const handleCloseMpvClick = async () => {
            const [isRunning, prefsResponse] = await Promise.all([
                this.isMpvRunningFromBackground(),
                sendMessageAsync({ action: 'get_ui_preferences' })
            ]);
            if (!isRunning) return this.addLogEntry({ text: `[Content]: Close command ignored, MPV is not running.`, type: 'info' });
            if (prefsResponse?.preferences?.confirm_close_mpv ?? true) {
                const confirmed = await this.showConfirmationModal('Are you sure you want to close MPV?');
                if (!confirmed) return this.addLogEntry({ text: `[Content]: Close MPV action cancelled by user.`, type: 'info' });
            }
            this.sendCommandToBackground('close_mpv', getCurrentFolderId());
        };

        const handlePlayNewClick = async () => {
            const folderId = getCurrentFolderId();
            const prefsResponse = await sendMessageAsync({ action: 'get_ui_preferences' });
            if (prefsResponse?.preferences?.confirm_play_new ?? true) {
                const confirmed = await this.showConfirmationModal("Launching a new MPV instance while another is running may cause issues. Continue?");
                if (!confirmed) return this.addLogEntry({ text: `[Content]: 'Play New' action cancelled by user.`, type: 'info' });
            }
            this.sendCommandToBackground('play_new_instance', folderId);
        };

        const actionMap = { add: handleAddClick, play: handlePlayClick, clear: handleClearClick, 'close-mpv': handleCloseMpvClick };
        for (const [action, handler] of Object.entries(actionMap)) {
            this.shadowRoot.getElementById(`btn-${action}`).addEventListener('click', handler);
            this.shadowRoot.getElementById(`btn-compact-${action}`).addEventListener('click', handler);
        }
        this.shadowRoot.getElementById('btn-play-new').addEventListener('click', handlePlayNewClick);
    }

    /** Binds listeners related to the playlist (item removal, folder selection). */
    _bindPlaylistControls() {
        const folderSelect = this.shadowRoot.getElementById('folder-select');
        const compactFolderSelect = this.shadowRoot.getElementById('compact-folder-select');

        const handleFolderChange = (newFolderId) => {
            folderSelect.value = newFolderId;
            compactFolderSelect.value = newFolderId;
            chrome.runtime.sendMessage({ action: 'set_last_folder_id', folderId: newFolderId });
            this.refreshPlaylist();
        };
        folderSelect.addEventListener('change', () => handleFolderChange(folderSelect.value));
        compactFolderSelect.addEventListener('change', () => handleFolderChange(compactFolderSelect.value));

        this.shadowRoot.getElementById('playlist-container').addEventListener('click', (e) => {
            if (e.target.classList.contains('btn-remove-item')) {
                const index = parseInt(e.target.dataset.index, 10);
                const folderId = folderSelect.value; // Can get from either select
                if (!isNaN(index)) {
                    this.sendCommandToBackground('remove_item', folderId, { data: { index } });
                }
            }
        });
    }

    /** Binds listeners for the log panel (filtering, clearing, toggling visibility). */
    _bindLogControls() {
        this.shadowRoot.getElementById('btn-toggle-log').addEventListener('click', () => {
            const logContainer = this.shadowRoot.getElementById('log-container');
            const isCurrentlyVisible = !logContainer.classList.contains('log-hidden');
            this.setLogVisibility(!isCurrentlyVisible);
        });

        this.shadowRoot.getElementById('btn-clear-log').addEventListener('click', () => {
            this.addLogEntry({ text: '[Content]: Log cleared.', type: 'info' }, true);
        });

        this.shadowRoot.getElementById('btn-filter-info').addEventListener('click', () => {
            this.setLogFilters({ info: !this.activeLogFilters.info });
        });

        this.shadowRoot.getElementById('btn-filter-error').addEventListener('click', () => {
            this.setLogFilters({ error: !this.activeLogFilters.error });
        });
    }

    /** Sets up the logic for making the controller draggable. */
    _bindDragAndDrop() {
        const dragHandle = this.shadowRoot.getElementById('status-banner');
        let isDragging = false;
        let offsetX, offsetY;

        dragHandle.addEventListener('mousedown', (e) => {
            if (this.isPinned) return;
            e.preventDefault();
            isDragging = true;
            document.body.classList.add('mpv-controller-dragging');
            offsetX = e.clientX - this.controllerHost.offsetLeft;
            offsetY = e.clientY - this.controllerHost.offsetTop;
            this.controllerHost.style.transition = 'none';
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging || this.isPinned) return;
            const newLeft = e.clientX - offsetX;
            const newTop = e.clientY - offsetY;
            const maxX = window.innerWidth - this.controllerHost.offsetWidth;
            const maxY = window.innerHeight - this.controllerHost.offsetHeight;
            this.controllerHost.style.left = `${Math.min(maxX, Math.max(0, newLeft))}px`;
            this.controllerHost.style.top = `${Math.min(maxY, Math.max(0, newTop))}px`;
            this.controllerHost.style.right = 'auto';
            this.controllerHost.style.bottom = 'auto';
            this.updateAdaptiveElements();
        });

        document.addEventListener('mouseup', () => {
            if (!isDragging) return;
            isDragging = false;
            document.body.classList.remove('mpv-controller-dragging');
            this.controllerHost.style.transition = '';
            const newPosition = { left: this.controllerHost.style.left, top: this.controllerHost.style.top, right: this.controllerHost.style.right, bottom: this.controllerHost.style.bottom };
            this.savePreference({ position: newPosition });
        });
    }

    /** Binds listeners to the main window object (e.g., resize). */
    _bindWindowEvents() {
        const debouncedReposition = debounce(() => {
            this.validateAndRepositionController();
        }, 250);
        window.addEventListener('resize', debouncedReposition);
    }

    applyPreferences(prefs) {
        if (!this.shadowRoot || !this.controllerHost) return; // UI not ready

        const mode = prefs?.mode || 'full';
        const logVisible = prefs?.logVisible ?? true;
        const pinned = prefs?.pinned ?? false;
        const logFilters = prefs?.logFilters ?? { info: true, error: true };
        const position = prefs?.position;
        const showPlayNew = prefs?.show_play_new_button ?? false;

        // Apply the "Play New" button visibility
        const playNewBtn = this.shadowRoot?.getElementById('btn-play-new');
        const playbackControls = this.shadowRoot?.getElementById('playback-controls');
        if (playNewBtn && playbackControls) {
            playNewBtn.style.display = showPlayNew ? 'flex' : 'none';
            // Adjust grid layout based on button visibility for proper sizing
            playbackControls.style.gridTemplateColumns = showPlayNew ? '1fr 1fr auto' : '1fr auto';
        }

        // Determine minimized state. The per-domain `minimized` boolean takes precedence.
        // If it's undefined, we fall back to the global `mode` setting.
        let shouldBeMinimized;
        if (typeof prefs.minimized === 'boolean') {
            shouldBeMinimized = prefs.minimized;
        } else {
            shouldBeMinimized = (mode === 'minimized');
        }

        // Apply minimized state first, as it controls visibility of the whole element.
        this.controllerHost.style.display = shouldBeMinimized ? 'none' : 'block';

        // Apply changes without re-saving state to prevent loops.
        // Don't try to switch to a 'minimized' view, as it doesn't exist. Default to 'full'.
        this.switchUi(mode === 'minimized' ? 'full' : mode, false);
        this.setLogVisibility(logVisible, false);
        this.setPinState(pinned, false);
        this.setLogFilters(logFilters, false);

        if (position) {
            this.controllerHost.style.left = position.left;
            this.controllerHost.style.top = position.top;
            this.controllerHost.style.right = position.right;
            this.controllerHost.style.bottom = position.bottom;
        }

        // If the controller is being shown, validate its position to ensure it's on-screen.
        // This must be called *after* setting the position.
        if (!shouldBeMinimized) {
            this.validateAndRepositionController();
        }
    }

    /**
     * Loads saved state from localStorage and applies it to the UI.
     */
    async applyInitialState() {
        const response = await chrome.runtime.sendMessage({ action: 'get_ui_preferences' });
        this.applyPreferences(response?.preferences);
    }

    // --- Main Initialization Orchestrator ---
    async initializeMpvController() {
        if (document.getElementById('m3u8-controller-host')) return;
        await this.createAndInjectUi();
        this.bindEventListeners();
        await this.applyInitialState(); // Apply position, UI mode, etc.
        await this.updateFolderDropdowns(); // This will fetch folders, populate dropdowns, and call refreshPlaylist
        // After everything is ready, notify the background script to check if we should be visible.
        chrome.runtime.sendMessage({ action: 'content_script_init' });
        console.log("MPV Controller content script initialized and ready.");

        // After initializing, check if we are in fullscreen mode and hide the UI if so.
        // This handles cases where the UI is re-injected on a page that is already fullscreen.
        if (document.fullscreenElement && this.controllerHost) {
            this.controllerHost.style.display = 'none';
        }
    }

    // --- Global UI Update Functions ---
    // These functions are called by the message listener and find the UI elements each time.
    // This makes them resilient to the UI being destroyed and recreated.

    updateStatusBanner(text, isSuccess = false) {
        const statusBanner = this.shadowRoot?.getElementById('status-banner');
        const streamStatus = this.shadowRoot?.getElementById('stream-status');
        const addBtn = this.shadowRoot?.getElementById('btn-add');
        const compactAddBtn = this.shadowRoot?.getElementById('btn-compact-add');

        if (!statusBanner || !streamStatus) return; // UI not present, do nothing.

        streamStatus.textContent = text;
        if (isSuccess) {
            statusBanner.classList.add("detected");
            // Add a class to the add buttons to make them glow
            addBtn?.classList.add('stream-present');
            compactAddBtn?.classList.add('stream-present');
        } else {
            statusBanner.classList.remove("detected");
            addBtn?.classList.remove('stream-present');
            compactAddBtn?.classList.remove('stream-present');
        }
    }

    addLogEntry(logObject, clear = false) {
        const logContainer = this.shadowRoot?.getElementById('log-container');
        if (!logContainer) return; // UI not present, do nothing.

        if (clear) {
            while (logContainer.firstChild) {
                logContainer.removeChild(logContainer.firstChild);
            }
        }
        const placeholder = this.shadowRoot.getElementById('log-placeholder');
        if (placeholder) placeholder.remove();

        const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

        const logEntry = document.createElement('div');
        logEntry.className = 'log-item';
        if (logObject.type === 'error') logEntry.classList.add('log-item-error');

        // Apply filter immediately to the new log entry
        const logType = logObject.type === 'error' ? 'error' : 'info';
        if (!this.activeLogFilters[logType]) {
            logEntry.classList.add('hidden-by-filter');
        }

        const timeSpan = document.createElement('span');
        timeSpan.className = 'log-timestamp';
        timeSpan.textContent = `[${timestamp}]`;

        const textSpan = document.createElement('span');
        textSpan.className = 'log-text';
        textSpan.textContent = logObject.text;

        logEntry.append(timeSpan, textSpan);

        logContainer.appendChild(logEntry);
        logContainer.scrollTop = logContainer.scrollHeight;
    }

    async updateFolderDropdowns() {
        chrome.runtime.sendMessage({ action: 'get_all_folder_ids' }, (response) => {
            if (!response?.success) {
                if (response) this.addLogEntry({ text: `[Content]: Failed to get folder list: ${response.error}`, type: 'error' });
                return;
            }

            const fullSelect = this.shadowRoot?.getElementById('folder-select');
            const compactSelect = this.shadowRoot?.getElementById('compact-folder-select');
            if (!fullSelect || !compactSelect) return;

            // Clear existing options and build new ones
            fullSelect.innerHTML = '';
            compactSelect.innerHTML = '';
            const optionsFragment = document.createDocumentFragment();
            response.folderIds.forEach(id => {
                const option = document.createElement('option');
                option.value = id;
                option.textContent = id;
                optionsFragment.appendChild(option);
            });
            fullSelect.appendChild(optionsFragment.cloneNode(true));
            compactSelect.appendChild(optionsFragment);

            // Ask the background script for the last used folder ID to restore selection
            chrome.runtime.sendMessage({ action: 'get_last_folder_id' }, (res) => {
                if (res?.success && res.folderId) {
                    fullSelect.value = res.folderId;
                    compactSelect.value = res.folderId;
                }
                // After setting the correct folder, refresh the playlist view
                this.refreshPlaylist();
            });
        });
    }

    refreshPlaylist() {
        // The folder dropdowns are always kept in sync, so we can reliably get the
        // current folder ID from the main dropdown without checking the UI mode.
        const folderSelect = this.shadowRoot?.getElementById('folder-select');
        if (!folderSelect || !folderSelect.value) {
            return; // UI not ready or no folder selected.
        }
        const currentFolderId = folderSelect.value;
        this.sendCommandToBackground('get_playlist', currentFolderId);
    }

    renderPlaylist(playlist) {
        const fullContainer = this.shadowRoot?.getElementById('playlist-container');
        const itemCountSpan = this.shadowRoot?.getElementById('compact-item-count');

        // Update compact UI count
        if (itemCountSpan) {
            itemCountSpan.textContent = playlist?.length || 0;
        }

        // Update full UI list
        if (!fullContainer) return;
        while (fullContainer.firstChild) fullContainer.removeChild(fullContainer.firstChild);

        if (playlist?.length > 0) {
            playlist.forEach((url, index) => {
                const itemDiv = document.createElement('div');
                itemDiv.className = 'list-item';
                itemDiv.title = url; // Show full URL on hover

                // --- Secure Element Creation ---
                // Create elements programmatically and use .textContent to prevent XSS.
                const indexSpan = document.createElement('span');
                indexSpan.className = 'url-index';
                indexSpan.textContent = `${index + 1}.`;

                const urlSpan = document.createElement('span');
                urlSpan.className = 'url-text';
                urlSpan.textContent = url; // This is the safe way to insert the URL

                const removeBtn = document.createElement('button');
                removeBtn.className = 'btn-remove-item';
                removeBtn.dataset.index = index;
                removeBtn.title = 'Remove Item';
                removeBtn.innerHTML = '&times;'; // Using innerHTML here is safe for a known HTML entity

                itemDiv.append(indexSpan, urlSpan, removeBtn);
                fullContainer.appendChild(itemDiv);
            });
        } else {
            const placeholder = document.createElement('p');
            placeholder.id = 'playlist-placeholder';
            placeholder.textContent = 'Playlist is empty.';
            fullContainer.appendChild(placeholder);
        }
        fullContainer.scrollTop = fullContainer.scrollHeight;
    }

    /**
     * Checks if MPV is running by querying the background script.
     * @returns {Promise<boolean>} A promise that resolves to true if MPV is running, false otherwise.
     */
    async isMpvRunningFromBackground() {
        return new Promise((resolve) => {
            chrome.runtime.sendMessage({ action: 'is_mpv_running' }, (response) => {
                if (chrome.runtime.lastError) {
                    this.addLogEntry({ text: `[Content]: Error checking MPV status: ${chrome.runtime.lastError.message}`, type: 'error' });
                    return resolve(false);
                }
                if (response?.success) {
                    resolve(response.is_running);
                } else {
                    this.addLogEntry({ text: `[Content]: Failed to get MPV status: ${response?.error || 'Unknown error'}`, type: 'error' });
                    resolve(false);
                }
            });
        });
    }

    /**
     * Retrieves the current playlist from the background script.
     * @param {string} folderId - The ID of the folder to get the playlist for.
     * @returns {Promise<string[]>} A promise that resolves with the array of URLs.
     */
    async getPlaylistFromBackground(folderId) {
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ action: 'get_playlist', folderId }, (response) => {
                if (chrome.runtime.lastError) {
                    return reject(new Error(chrome.runtime.lastError.message));
                }
                if (response?.success) {
                    resolve(response.list || []);
                } else {
                    reject(new Error(response?.error || 'Failed to get playlist.'));
                }
            });
        });
    }

    /**
     * Sends a command to the background script and handles the response.
     * @param {string} action - The command to perform (e.g., 'add', 'list').
     * @param {string} folderId - The ID of the folder to act upon.
     * @param {object} data - Additional data for the action (e.g., {url: '...'} or {data: {index: 1}}).
     */
    sendCommandToBackground(action, folderId, data = {}) {
        const payload = { action, folderId, ...data };

        chrome.runtime.sendMessage(payload, (response) => {
            if (chrome.runtime.lastError) {
                this.addLogEntry({ text: `[Content]: Error sending '${action}': ${chrome.runtime.lastError.message}`, type: 'error' });
                return;
            }

            if (response) {
                // The 'get_playlist' command is the only one that returns a list to render.
                if (action === 'get_playlist' && response.success) {
                    this.renderPlaylist(response.list);
                }
                // Log success/info messages from the background script.
                if (response.message && action !== 'get_playlist') {
                    this.addLogEntry({ text: `[Background]: ${response.message}`, type: 'info' });
                }
                // Also log any error messages from the background script.
                if (response.error) {
                    this.addLogEntry({ text: `[Background]: ${response.error}`, type: 'error' });
                }
            }
        });
    }
    async fetchAniListReleases() {
        const anilistContent = this.anilistShadowRoot.getElementById('anilist-releases-list');
        if (!anilistContent) return;

        anilistContent.innerHTML = '<div class="loading-spinner"></div>'; // Show spinner
        try {
            const response = await sendMessageAsync({ action: 'get_anilist_releases' });
            if (response.success) {
                try {
                    const releases = JSON.parse(response.output);
                    this.renderAniListReleases(releases);
                } catch (e) {
                    anilistContent.innerHTML = '<li class="anilist-error">Error: Failed to parse releases data.</li>';
                }
            } else {
                anilistContent.innerHTML = `<li class="anilist-error">Error: ${response.error || 'Failed to fetch releases.'}</li>`;
            }
        } catch (error) {
            anilistContent.innerHTML = `<li class="anilist-error">Error: ${error.message || 'An unknown error occurred.'}</li>`;
        }
    }

    renderAniListReleases(releases) {
        const list = this.anilistShadowRoot.getElementById('anilist-releases-list');
        if (!list) return;
        list.innerHTML = ''; // Clear spinner or old content

        if (!releases || releases.length === 0) {
            const noReleasesItem = document.createElement('li');
            noReleasesItem.textContent = 'No anime episodes found releasing today.';
            noReleasesItem.style.textAlign = 'center';
            noReleasesItem.style.color = 'var(--text-secondary)';
            list.appendChild(noReleasesItem);
            return;
        }

        releases.forEach(item => {
            const listItem = document.createElement('li');
            listItem.className = 'anilist-release-item';

            const coverLink = document.createElement('a');
            coverLink.href = `https://anilist.co/anime/${item.id}`;
            coverLink.target = '_blank';
            coverLink.title = 'View on AniList';

            const coverImage = document.createElement('img');
            coverImage.src = item.cover_image;
            coverImage.alt = `${item.title} cover`;
            coverImage.className = 'release-cover-image';
            coverLink.appendChild(coverImage);

            const itemDetails = document.createElement('div');
            itemDetails.className = 'release-details';

            const title = document.createElement('div');
            title.className = 'release-title';
            title.textContent = item.title;
            title.title = item.title;

            const episodeInfo = document.createElement('div');
            episodeInfo.className = 'release-episode-info';
            episodeInfo.textContent = `Ep ${item.episode}`;

            const airingTime = document.createElement('div');
            airingTime.className = 'release-airing-time';
            airingTime.textContent = item.airing_at;

            itemDetails.appendChild(title);
            itemDetails.appendChild(episodeInfo);
            itemDetails.appendChild(airingTime);

            listItem.appendChild(coverLink);
            listItem.appendChild(itemDetails);
            list.appendChild(listItem);
        });
    }

    handleFullscreenChange() {
        // Re-query the host from the DOM to ensure we have a live reference.
        const host = document.getElementById('m3u8-controller-host');
        if (host) {
            if (document.fullscreenElement) {
                // Entering fullscreen, always hide the controller.
                host.style.display = 'none';
            } else {
                // Exiting fullscreen. Tell background script to check if we should be visible.
                // This is more robust than checking localStorage directly, as it respects the
                // centralized state in background.js.
                chrome.runtime.sendMessage({ action: 'content_script_init' });
            }
        }
    }


    // --- Robustness for Single-Page Applications (like YouTube) ---
    // This function handles all updates needed after a potential page navigation on an SPA.
    handlePageUpdate() {
        // First, ensure the controller is still on the page. If not, re-inject it.
        // Using the cached `this.controllerHost` element is more direct than re-querying the DOM.
        if (!this.controllerHost || !document.body.contains(this.controllerHost)) {
            console.log("MPV Controller not found after DOM mutation, re-injecting.");
            this.initializeMpvController();
            return; // The initialization will handle the rest.
        }

        const currentUrl = window.location.href;
        const urlChanged = currentUrl !== this.lastUrl;

        // Check if the URL has changed, which indicates a navigation event.
        if (urlChanged) {
            this.lastUrl = currentUrl;
            this.detectedUrl = null; // Reset the detected URL.
        }

        // Only perform detection logic if we haven't already found a stream URL.
        // This prevents redundant checks on every minor DOM change.
        if (!this.detectedUrl) {
            const isYouTubeVideo = currentUrl.includes('youtube.com/watch?v=') || currentUrl.includes('youtu.be/');
            if (isYouTubeVideo) {
                this.detectedUrl = currentUrl;
                chrome.runtime.sendMessage({ action: 'report_detected_url', url: this.detectedUrl });
                this.updateStatusBanner('YouTube video detected', true);
            } else if (urlChanged) {
                // If the URL changed and it wasn't a YouTube video, ensure state is reset.
                chrome.runtime.sendMessage({ action: 'report_detected_url', url: null });
                this.updateStatusBanner('No stream detected', false);
            }
        }
    }

    /**
     * Main entry point. Initializes the UI and sets up the observer to handle
     * dynamic page changes (like on YouTube).
     */
    async init() {
        // Register the single message handler for the lifetime of the page.
        // This will survive all UI re-injections by the MutationObserver.
        chrome.runtime.onMessage.addListener(this.handleMessage);

        // Initial injection.
        await this.initializeMpvController();

        // --- Fullscreen Change Handler ---
        // This will hide the controller when a video goes fullscreen and show it again when it exits.
        document.addEventListener('fullscreenchange', this.handleFullscreenChange);

        // --- Primary re-injection mechanism: MutationObserver ---
        // This is fast and efficient for reacting to DOM changes on SPAs like YouTube.
        const observer = new MutationObserver(this.handlePageUpdate);
        observer.observe(document.documentElement, { childList: true, subtree: true });

    }

}
(function () {
    'use strict';
    // Wait for the DOM to be fully loaded before trying to inject the UI.
    // This prevents errors on pages that are slow to load.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => new MpvController().init());
    } else {
        new MpvController().init(); // The DOM is already ready.
    }
})();
