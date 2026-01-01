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
        this.uiManager = new UIManager();
        this.playlistUI = null; // Will be initialized after UI is created
        this.anilistUI = null; // Will be initialized after UI is created
        this.pageScraper = new PageScraper();
        this.currentUiMode = 'full';
        this.isPinned = false;
        this.lastUrl = window.location.href;
        this.activeLogFilters = { info: true, error: true };
        this.preFullscreenPosition = null; // New: Store position before fullscreen
        this.showAnilistReleases = true; // Default value
        this.preResizePosition = null; // New: Store position before a resize forces a move
        this.showMinimizedStub = true; // Default value
        this.isTearingDown = false; // Flag to prevent race conditions during teardown
        this.heartbeatInterval = null; // For checking background script connection
        this.enableDblclickCopy = false; // New: Preference for double-click copy
        this.showCopyTitleButton = false; // New: Preference for the copy title button
        this.lastRightClickedElement = null; // New: To track right-clicks for context menu actions
        this.keybinds = { add: null, playPlaylist: null, toggle: null, openPopup: null };

        // Bind `this` for methods that are used as event listeners or callbacks
        this.handleMessage = this.handleMessage.bind(this);
        this.handleFullscreenChange = this.handleFullscreenChange.bind(this); // This is correct
        this.handlePageUpdate = debounce(this.handlePageUpdate.bind(this), 250); // Debounce the handler
    }

    /**
     * Handles messages from the background script.
     * @param {object} request - The message object.
     * @param {object} sender - The sender of the message.
     * @param {Function} sendResponse - Function to call to send a response.
     */
    handleMessage(request, sender, sendResponse) {
        if (request.action === 'init_ui_state' && this.uiManager.controllerHost) {
            // The background script has sent the initial state. Apply it now.
            // This is the single point of truth for whether the UI should be visible on load.
            const { shouldBeMinimized } = request;
            // We must apply the initial state (including AniList visibility) *before*
            // setting the minimized state. This ensures the AniList panel's visibility
            // is restored correctly even when the main UI starts as minimized.
            this.applyInitialState();
            this.setMinimizedState(shouldBeMinimized, false);
        } else if (request.m3u8) {
            this.detectedUrl = request.m3u8;
            // Report the detected stream URL to the background script
            chrome.runtime.sendMessage({ action: 'report_detected_url', url: this.detectedUrl });
            // Call the global UI update function
            // Update the button state, which will also update the status banner.
            this.updateAddButtonState();
        } else if (request.action === 'render_playlist') {
            // The background has sent an updated list. Render it only if it
            // matches the currently selected folder.
            const currentFolderId = this.uiManager.shadowRoot?.getElementById('folder-select')?.value;
            if (currentFolderId === request.action_folder_id || currentFolderId === request.folderId) {
                this.playlistUI?.render(request.playlist, request.last_played_id, request.isFolderActive);
            } else if (request.fromContextMenu) {
                // If the update came from a context menu action for a *different* folder,
                // the user might switch to that folder later and expect to see the new item.
                // To ensure this, we'll silently refresh the folder dropdowns and the playlist for the *new* folder.
                this.updateFolderDropdowns();
                this.updateAddButtonState(); // Re-check if the URL is in the newly updated list
            }
        } else if (request.foldersChanged) {
            // The list of available folders has changed (e.g., a new one was created)
            this.updateFolderDropdowns();
        } else if (request.action === 'last_folder_changed') {
            // The selected folder was changed in another context (e.g., the popup).
            // We need to sync our dropdowns to reflect this change.
            const fullSelect = this.uiManager.shadowRoot?.getElementById('folder-select');
            const compactSelect = this.uiManager.shadowRoot?.getElementById('compact-folder-select');
            if (fullSelect && compactSelect && request.folderId) {
                // Check if the value is different to avoid redundant playlist refreshes.
                if (fullSelect.value !== request.folderId) {
                    fullSelect.value = request.folderId;
                    compactSelect.value = request.folderId;
                    this.refreshPlaylist(); // Refresh the playlist view for the new folder.
                    this.updateAddButtonState(); // Re-check against the new folder's playlist
                }
            }
        } else if (request.log) {
            // Call the global UI update function
            this.addLogEntry(request.log);
        } else if (request.action === 'preferences_changed') {
            const changedPrefs = request.preferences; // This will now contain the specific preferences that changed
            
            // Update the settings object if relevant keys changed
            if (this.settings) {
                if (changedPrefs.enable_active_item_highlight !== undefined) this.settings.enable_active_item_highlight = changedPrefs.enable_active_item_highlight;
                if (changedPrefs.enable_smart_resume !== undefined) this.settings.enable_smart_resume = changedPrefs.enable_smart_resume;
            }

            const changeDomain = request.domain; // The domain this change was for. Can be null for global changes.
            const myDomain = this.uiManager.getDomain(); // Get the current tab's domain.

            const isDomainSpecificChange = Object.keys(changedPrefs).some(k => ['position', 'anilistPanelPosition', 'anilistPanelSize', 'minimizedStubPosition', 'anilistPanelVisible', 'lockAnilistPanel', 'minimized'].includes(k));

            // If the change is domain-specific (like panel position/visibility), only apply it if the domains match.
            if (isDomainSpecificChange) {
                if (myDomain === changeDomain) {
                    // This change is for our domain, apply it directly.
                    if (changedPrefs.position && this.uiManager.controllerHost) {
                        this.uiManager.controllerHost.style.left = changedPrefs.position.left;
                        this.uiManager.controllerHost.style.top = changedPrefs.position.top;
                        this.uiManager.controllerHost.style.right = changedPrefs.position.right;
                        this.uiManager.controllerHost.style.bottom = changedPrefs.position.bottom;
                        this.validateAndRepositionController();
                    }
                    if (changedPrefs.anilistPanelPosition && this.anilistUI?.panelHost) {
                        this.anilistUI.panelHost.style.left = changedPrefs.anilistPanelPosition.left;
                        this.anilistUI.panelHost.style.top = changedPrefs.anilistPanelPosition.top;
                        this.anilistUI.panelHost.style.right = changedPrefs.anilistPanelPosition.right;
                        this.anilistUI.panelHost.style.bottom = changedPrefs.anilistPanelPosition.bottom;
                        this.anilistUI.isManuallyPositioned = true;
                        this.anilistUI.validatePosition();
                    }
                    if (changedPrefs.anilistPanelSize && this.anilistUI?.panelHost) {
                        this.anilistUI.panelHost.style.width = changedPrefs.anilistPanelSize.width;
                        this.anilistUI.panelHost.style.height = changedPrefs.anilistPanelSize.height;
                    }
                    if (changedPrefs.minimizedStubPosition && this.uiManager.minimizedHost) {
                        this.uiManager.minimizedHost.style.left = changedPrefs.minimizedStubPosition.left;
                        this.uiManager.minimizedHost.style.top = changedPrefs.minimizedStubPosition.top;
                        this.uiManager.minimizedHost.style.right = changedPrefs.minimizedStubPosition.right;
                        this.uiManager.minimizedHost.style.bottom = changedPrefs.minimizedStubPosition.bottom;
                        this.validateAndRepositionMinimizedStub();
                    }
                    if (changedPrefs.anilistPanelVisible !== undefined && this.anilistUI) {
                        this.anilistUI.toggleVisibility(changedPrefs.anilistPanelVisible, false);
                    }
                    if (changedPrefs.lockAnilistPanel !== undefined && this.anilistUI) {
                        this.anilistUI.isLocked = changedPrefs.lockAnilistPanel;
                        this.anilistUI.updateDynamicStyles();
                    }
                    if (changedPrefs.minimized !== undefined) {
                        this.setMinimizedState(changedPrefs.minimized, false);
                    }
                    this.updateAdaptiveElements();
                }
            } else {
                // If it's a global change (or not a domain-specific one), re-apply the initial state
                // to ensure all settings (like AniList image size, etc.) are updated everywhere.
                this.applyInitialState();
            }
        } else if (request.action === 'show_confirmation') {
            // This is an async action that requires a response, so we must return true.
            (async () => {
                try {
                    // Use a page-level confirmation modal that doesn't depend on the controller UI state.
                    const confirmed = await this.showPageLevelConfirmation(request.message);
                    sendResponse({ confirmed });
                } catch (e) {
                    // If something goes wrong, send a negative confirmation.
                    sendResponse({ confirmed: false });
                }
            })();
            return true; // Indicate async response.
        } else if (request.action === 'scrape_and_get_details') {
            // The background script is asking for the page title and URL.
            // Use the current page URL for scraping, not just the detected stream URL,
            // as the latter may be null when the request is made.
            const scrapedDetails = this.pageScraper.scrapePageDetails(window.location.href);
            sendResponse(scrapedDetails);
            return true; // Indicate async response.
        } else if (request.action === 'set_minimized_state') {
            // The background script (relaying from the popup) is telling us to show or hide the UI.
            this.setMinimizedState(request.minimized);
            sendResponse({ success: true }); // Acknowledge the command
        } else if (request.action === 'ytdlp_update_confirm') {
            // This is triggered by the background script when an update is recommended and the user preference is 'ask'.
            (async () => {
                const confirmed = await this.showPageLevelConfirmation(
                    "YouTube playback failed. This is often caused by an outdated yt-dlp. Would you like to attempt to automatically update it now?"
                );
                if (confirmed) {
                    // If the user confirms, send a message back to the background script to trigger the update.
                    chrome.runtime.sendMessage({ action: 'user_confirmed_ytdlp_update' });
                }
            })();
            // No response needed, so we don't return true.
        } else if (request.action === 'get_details_for_last_right_click') {
            // The background script is asking for the title of the item that was just right-clicked.
            // This avoids a network request by scraping the current page.
            const linkElement = this.lastRightClickedElement?.closest('a'); // Find the link that was clicked on
            const url = linkElement ? linkElement.href : window.location.href; // Use link URL or page URL
            let title;

            if (window.location.hostname.includes('youtube.com') && this.lastRightClickedElement) {
                // --- YouTube-Specific Thumbnail Scraping ---
                // This logic is highly specific to finding titles from YouTube thumbnails on pages
                // like the homepage or subscription feed.
                const videoContainer = this.lastRightClickedElement.closest('ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer');
                const titleSelectors = ['#video-title', '#title-text', 'span#video-title'];
                const channelSelectors = ['#channel-name .yt-formatted-string', '.ytd-channel-name .yt-formatted-string', '#byline-container .yt-formatted-string'];
    
                if (videoContainer) {
                    let videoTitle = null;
                    for (const selector of titleSelectors) {
                        const el = videoContainer.querySelector(selector);
                        if (el) { videoTitle = el.textContent.trim(); break; }
                    }
    
                    let channelName = null;
                    for (const selector of channelSelectors) {
                        const el = videoContainer.querySelector(selector);
                        if (el) { channelName = el.textContent.trim(); break; }
                    }
    
                    if (videoTitle) {
                        title = channelName ? `${channelName} - ${videoTitle}` : videoTitle;
                    }
                }
            }

            // If thumbnail scraping fails or it's not YouTube, fall back to the main page scraper.
            // This ensures that for all non-YouTube sites, we use the exact same robust scraping
            // logic as the on-page "Add" button.
            if (!title) {
                title = this.pageScraper.scrapePageDetails(url).title;
            }
            sendResponse({ url: url, title: title });
            return true; // Indicate async response.
        }
    }

    /**
     * Creates the controller container and injects the UI's HTML into the DOM.
     */
    async createAndInjectUi() {
        this.uiManager.createAndInjectUi();
    }

    switchUi(uiMode, saveState = true) {
        const fullUiContainer = this.uiManager.shadowRoot?.getElementById('full-ui-container');
        const compactUiContainer = this.uiManager.shadowRoot?.getElementById('compact-ui-container');
        const toggleBtn = this.uiManager.shadowRoot?.getElementById('btn-toggle-ui-mode');
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
     * Displays a page-level confirmation modal, independent of the controller UI.
     * @param {string} message The message to display in the modal.
     * @returns {Promise<boolean>} A promise that resolves to true if confirmed, false if cancelled.
     */
    showPageLevelConfirmation(message) {
        return new Promise((resolve) => {
            // Check if a modal already exists to prevent duplicates
            if (document.getElementById('mpv-page-level-modal-host')) {
                resolve(false);
                return;
            }

            const modalHost = document.createElement('div');
            modalHost.id = 'mpv-page-level-modal-host';
            // The host itself needs a high z-index to appear over everything.
            modalHost.style.position = 'fixed';
            modalHost.style.top = '0';
            modalHost.style.left = '0';
            modalHost.style.width = '100%';
            modalHost.style.height = '100%';
            modalHost.style.zIndex = '2147483647';

            const shadowRoot = modalHost.attachShadow({ mode: 'open' });

            const style = document.createElement('style');
            style.textContent = `
                /* These variables are copied from the extension's theme for consistency */
                :host {
                    --surface-color: #1d1f23;
                    --border-color: #33363b;
                    --text-primary: #e1e1e1;
                    --accent-primary: #5865f2;
                    --accent-primary-hover: #4f5bda;
                    --surface-hover-color: #2c2e33;
                    --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
                    --border-radius: 6px;
                }
                #page-level-confirmation-overlay {
                    position: absolute;
                    top: 0; left: 0; right: 0; bottom: 0;
                    background-color: rgba(0, 0, 0, 0.8);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-family: var(--font-sans);
                }
                .modal-content {
                    background-color: var(--surface-color);
                    color: var(--text-primary);
                    padding: 24px;
                    border-radius: var(--border-radius);
                    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
                    text-align: center;
                    border: 1px solid var(--border-color);
                    display: flex;
                    flex-direction: column;
                    gap: 20px;
                    max-width: 400px;
                    width: 90%;
                }
                p { margin: 0; font-size: 16px; line-height: 1.5; }
                .modal-actions { display: flex; justify-content: center; gap: 12px; }
                button {
                    color: #fff; border: none; border-radius: var(--border-radius);
                    padding: 10px 20px; font-size: 14px; font-weight: 600;
                    cursor: pointer; transition: all 0.15s ease;
                }
                #page-level-modal-confirm-btn { background-color: var(--accent-primary); }
                #page-level-modal-confirm-btn:hover { background-color: var(--accent-primary-hover); }
                #page-level-modal-cancel-btn { background-color: var(--surface-hover-color); }
                #page-level-modal-cancel-btn:hover { background-color: var(--border-color); }
            `;

            const modalWrapper = document.createElement('div');
            modalWrapper.id = 'page-level-confirmation-overlay';
            modalWrapper.innerHTML = `
                <div class="modal-content">
                    <p id="page-level-modal-message"></p>
                    <div class="modal-actions">
                        <button id="page-level-modal-confirm-btn">Confirm</button>
                        <button id="page-level-modal-cancel-btn">Cancel</button>
                    </div>
                </div>
            `;

            shadowRoot.append(style, modalWrapper);
            shadowRoot.getElementById('page-level-modal-message').textContent = message;
            const confirmBtn = shadowRoot.getElementById('page-level-modal-confirm-btn');
            const cancelBtn = shadowRoot.getElementById('page-level-modal-cancel-btn');

            const handleKeyDown = (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    close(true);
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    close(false);
                }
            };

            const close = (result) => {
                window.removeEventListener('keydown', handleKeyDown, true);
                document.body.removeChild(modalHost);
                resolve(result);
            };

            confirmBtn.onclick = () => close(true);
            cancelBtn.onclick = () => close(false);

            // Add keydown listener to the window, using capture to get it before other listeners.
            window.addEventListener('keydown', handleKeyDown, true);

            document.body.appendChild(modalHost);
            confirmBtn.focus(); // Set focus to the confirm button
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

            // Clamp the values
            const newLeft = Math.min(maxX, Math.max(0, currentLeft));
            const newTop = Math.min(maxY, Math.max(0, currentTop));

            // Only update if a change was necessary.
            if (newLeft !== currentLeft || newTop !== currentTop) {
                this.controllerHost.style.left = `${newLeft}px`;
                this.controllerHost.style.top = `${newTop}px`;
                this.controllerHost.style.right = 'auto'; // Ensure we are using left/top positioning
                this.controllerHost.style.bottom = 'auto';

            }

            if (this.anilistUI && !this.anilistUI.autoReattach && this.anilistUI.isManuallyPositioned) {
                // If AniList panel is manually positioned, don't snap it.
                // Just validate the stub.
                this.validateAndRepositionMinimizedStub();
            } else {
                // Otherwise, run the full adaptive update.
                setTimeout(() => {
                    this.updateAdaptiveElements();
                    this.validateAndRepositionMinimizedStub();
                }, 10);
            }
        }, 10); // 10ms is a safe, small delay.
    }

    /**
     * Toggles the minimized state of the UI, showing a stub in the corner.
     * @param {boolean} shouldBeMinimized - True to minimize, false to restore.
     * @param {boolean} [savePref=true] - Whether to save the state to preferences.
     * @param {object} [initialPrefs=null] - Optional preferences object to avoid re-fetching.
     */
    async setMinimizedState(shouldBeMinimized, savePref = true, initialPrefs = null) {
        // Re-query hosts to ensure we have live references.
        const controllerHost = this.uiManager.controllerHost;
        const minimizedHost = this.uiManager.minimizedHost;
        const anilistPanelHost = this.uiManager.anilistPanelHost;

        if (!controllerHost || !minimizedHost || !anilistPanelHost) return;

        // Update instance properties in case they were stale from a re-injection.
        this.controllerHost = controllerHost;
        this.minimizedHost = minimizedHost;
        this.anilistPanelHost = anilistPanelHost;

        let prefs = initialPrefs;
        // Only fetch preferences if not provided and if we need them (either to save or to decide position when minimizing).
        if (!prefs && (savePref || shouldBeMinimized)) {
            const response = await chrome.runtime.sendMessage({ action: 'get_ui_preferences' });
            if (response?.success && response.preferences) {
                prefs = response.preferences;
            }
        }

        if (shouldBeMinimized) {
            this.controllerHost.style.display = 'none';

            // Only show the minimized stub if the setting is enabled.
            if (this.showMinimizedStub) {
                // Determine which corner to attach to based on the main controller's last position.
                const savedStubPosition = prefs?.minimizedStubPosition;
                if (savedStubPosition && savedStubPosition.left && savedStubPosition.top) {
                    this.minimizedHost.style.left = savedStubPosition.left;
                    this.minimizedHost.style.top = savedStubPosition.top;
                    this.minimizedHost.style.right = savedStubPosition.right;
                    this.minimizedHost.style.bottom = savedStubPosition.bottom;
                } else { // Fallback to corner-based positioning if no manual position is saved.
                    minimizedHost.classList.remove('top-left', 'top-right');
                    const rect = this.controllerHost.getBoundingClientRect();
                    const controllerCenter = rect.left + (rect.width / 2);
                    const screenCenter = window.innerWidth / 2;
                    const isControllerOnLeft = controllerCenter < screenCenter;

                    minimizedHost.classList.toggle('top-left', isControllerOnLeft);
                    minimizedHost.classList.toggle('top-right', !isControllerOnLeft);
                    // Clear explicit positioning if using class-based positioning
                    this.minimizedHost.style.left = '';
                    this.minimizedHost.style.top = '';
                    this.minimizedHost.style.right = '';
                    this.minimizedHost.style.bottom = '';
                }

                this.minimizedHost.style.display = 'block';
            }

            if (savePref) {
                this.savePreference({ minimized: true });
            }
        } else { // Restore
            this.minimizedHost.style.display = 'none';
            this.controllerHost.style.display = 'block';

            const prefsToSave = { minimized: false };

            // If auto-reattach is enabled, reset the manual positioning flag
            // so it snaps back to the controller on the next position update. Also clear saved position.
            this.anilistUI.validatePosition(); // Re-validate anilist panel position
            this.validateAndRepositionController(); // Make sure it's on screen
            if (savePref) {
                // When restoring the controller, if the AniList panel is force-attached,
                // it should also reappear.
                if (this.anilistUI.forceAttached) {
                    this.anilistUI.toggleVisibility(true, false);
                }
                this.savePreference(prefsToSave);
            }
        }
    }

    /**
     * Ensures the minimized stub is within the visible viewport boundaries.
     * This is called after window resizes.
     */
    validateAndRepositionMinimizedStub() {
        if (!this.uiManager.minimizedHost || this.uiManager.minimizedHost.style.display === 'none') return;

        setTimeout(() => {
            const hostWidth = this.uiManager.minimizedHost.offsetWidth;
            const hostHeight = this.uiManager.minimizedHost.offsetHeight;

            if (hostWidth === 0 || hostHeight === 0) return;

            const maxX = window.innerWidth - hostWidth;
            const maxY = window.innerHeight - hostHeight;

            const currentLeft = this.uiManager.minimizedHost.offsetLeft;
            const currentTop = this.uiManager.minimizedHost.offsetTop;

            const newLeft = Math.min(maxX, Math.max(0, currentLeft));
            const newTop = Math.min(maxY, Math.max(0, currentTop));

            if (newLeft !== currentLeft || newTop !== currentTop) {
                this.uiManager.minimizedHost.style.left = `${newLeft}px`;
                this.uiManager.minimizedHost.style.top = `${newTop}px`;
                this.uiManager.minimizedHost.style.right = 'auto';
                this.uiManager.minimizedHost.style.bottom = 'auto';

                const newPosition = { left: this.uiManager.minimizedHost.style.left, top: this.uiManager.minimizedHost.style.top, right: this.uiManager.minimizedHost.style.right, bottom: this.uiManager.minimizedHost.style.bottom };
                this.savePreference({ minimizedStubPosition: newPosition });
            }
        }, 10);
    }
    // --- UI State Management Functions ---
    // These functions update the UI and, by default, save the state to storage.
    // They can be called with `saveState = false` during initialization to prevent
    // a redundant write operation.

    setLogVisibility(isVisible, saveState = true) {
        const logContainer = this.uiManager.shadowRoot?.getElementById('log-container');
        const toggleLogBtn = this.uiManager.shadowRoot?.getElementById('btn-toggle-log');
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
        const togglePinBtn = this.uiManager.shadowRoot?.getElementById('btn-toggle-pin');
        const dragHandle = this.uiManager.shadowRoot?.getElementById('status-banner');
        if (!this.uiManager.controllerHost || !togglePinBtn || !dragHandle) return;

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

        const infoBtn = this.uiManager.shadowRoot?.getElementById('btn-filter-info');
        const errorBtn = this.uiManager.shadowRoot?.getElementById('btn-filter-error');

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
        const logContainer = this.uiManager.shadowRoot?.getElementById('log-container');
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

    updateAdaptiveElements() {
        if (!this.uiManager.controllerHost || !this.uiManager.shadowRoot) return;

        const anilistBtnLeft = this.uiManager.shadowRoot.getElementById('btn-toggle-anilist-left');
        const anilistBtnRight = this.uiManager.shadowRoot.getElementById('btn-toggle-anilist-right');
        if (!anilistBtnLeft || !anilistBtnRight) return;
        
        if (!this.anilistUI?.isEnabled) {
            anilistBtnLeft.style.display = 'none';
            anilistBtnRight.style.display = 'none';
            this.anilistUI?.toggleVisibility(false, false);
            return;
        }

        const rect = this.uiManager.controllerHost.getBoundingClientRect();
        const controllerCenter = rect.left + (rect.width / 2);
        const screenCenter = window.innerWidth / 2;

        if (controllerCenter < screenCenter) {
            anilistBtnLeft.style.display = 'none';
            anilistBtnRight.style.display = 'flex';
        } else {
            anilistBtnLeft.style.display = 'flex';
            anilistBtnRight.style.display = 'none';
        }
        this.anilistUI?.snapToController();
    }
    /**
     * Finds all interactive UI elements and attaches their corresponding event listeners.
     */
    bindEventListeners() {
        this._bindHeaderControls();
        this._bindActionControls();
        this._bindLogControls();
        this._bindWindowEvents();
        this._bindMinimizedControls();
        this._bindGlobalShortcuts();
        this._initializeDraggables(); // New centralized method
    }

    /** Binds listeners for the main header (minimize, pin, UI mode, AniList). */
    _bindHeaderControls() {
        this.uiManager.shadowRoot.getElementById('btn-toggle-minimize').addEventListener('click', () => this.setMinimizedState(true));

        this.uiManager.shadowRoot.getElementById('btn-toggle-pin').addEventListener('click', () => this.setPinState(!this.isPinned));

        this.uiManager.shadowRoot.getElementById('btn-toggle-stub').addEventListener('click', () => {
            this.showMinimizedStub = !this.showMinimizedStub;
            this.savePreference({ show_minimized_stub: this.showMinimizedStub });
            this._updateStubButtonState();
        });

        this.uiManager.shadowRoot.getElementById('btn-toggle-ui-mode').addEventListener('click', () => {
            const newMode = this.currentUiMode === 'full' ? 'compact' : 'full';
            this.switchUi(newMode);
        });

    }

    /**
     * Updates the visual state of the toggle stub button.
     * @private
     */
    _updateStubButtonState() {
        const btn = this.uiManager.shadowRoot?.getElementById('btn-toggle-stub');
        if (!btn) return;
        btn.classList.toggle('active-toggle', this.showMinimizedStub);
    }

    /** Binds listeners for the primary action buttons (Play, Add, Clear, etc.). */
    _bindActionControls() {
        const getCurrentFolderId = () => {
            const folderSelect = this.uiManager.shadowRoot.getElementById('folder-select');
            const compactFolderSelect = this.uiManager.shadowRoot.getElementById('compact-folder-select');
            return this.currentUiMode === 'full' ? folderSelect.value : compactFolderSelect.value;
        };

        const handleAddClick = async () => {
            await this.addDetectedUrlToFolder(getCurrentFolderId(), { isUiVisible: true });
        };

        const handlePlayClick = () => {
            const folderId = getCurrentFolderId();
            if (!folderId) return this.addLogEntry({ text: `[Content]: No folder selected to play.`, type: 'error' });
            this.sendCommandToBackground('play', folderId); // Changed to 'play' action, folderId is enough
        };

        const handleClearClick = async () => {
            const folderId = getCurrentFolderId();
            const prefsResponse = await sendMessageAsync({ action: 'get_ui_preferences' });
            if (prefsResponse?.preferences?.confirm_clear_playlist ?? true) {
                const confirmed = await this.showPageLevelConfirmation(`Are you sure you want to clear the playlist in "${folderId}"?`);
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
                const confirmed = await this.showPageLevelConfirmation('Are you sure you want to close MPV?');
                if (!confirmed) return this.addLogEntry({ text: `[Content]: Close MPV action cancelled by user.`, type: 'info' });
            }
            this.sendCommandToBackground('close_mpv', getCurrentFolderId());
        };

        const handlePlayNewClick = async () => {
            const folderId = getCurrentFolderId();
            const prefsResponse = await sendMessageAsync({ action: 'get_ui_preferences' });
            if (prefsResponse?.preferences?.confirm_play_new ?? true) {
                const confirmed = await this.showPageLevelConfirmation("Launching a new MPV instance while another is running may cause issues. Continue?");
                if (!confirmed) return this.addLogEntry({ text: `[Content]: 'Play New' action cancelled by user.`, type: 'info' });
            }
            // Send the 'play' action with a flag for a new instance
            this.sendCommandToBackground('play', folderId, { 
                play_new_instance: true // Flag to launch in a new instance
            });
        };

        const actionMap = { add: handleAddClick, play: handlePlayClick, clear: handleClearClick, 'close-mpv': handleCloseMpvClick };
        for (const [action, handler] of Object.entries(actionMap)) {
            this.uiManager.shadowRoot.getElementById(`btn-${action}`).addEventListener('click', handler);
            this.uiManager.shadowRoot.getElementById(`btn-compact-${action}`).addEventListener('click', handler);
        }
        this.uiManager.shadowRoot.getElementById('btn-play-new').addEventListener('click', handlePlayNewClick);
    }

    /**
     * A helper function to add the currently detected URL to a specified folder.
     * This encapsulates the logic for checking duplicates and sending the 'add' command.
     * @param {string} folderId The ID of the folder to add the URL to.
     * @param {object} options - Additional options.
     * @param {boolean} options.isUiVisible - Whether the full UI is visible, allowing for modals.
     */
    async addDetectedUrlToFolder(folderId, { isUiVisible = false } = {}) {
        if (!this.detectedUrl) {
            this.addLogEntry({ text: `[Content]: No stream/video detected to add.`, type: 'error' });
            return 'error';
        }
    
        try {
            // For the on-page button, we always have access to the page content.
            // Perform the scrape here and send the complete details to the background.
            // This is more efficient than having the background script open a new scanner window.
            const { url, title } = this.pageScraper.scrapePageDetails(this.detectedUrl);
            this.sendCommandToBackground('add', folderId, { data: { url, title } });

            return 'success';
        } catch (error) {
            this.addLogEntry({ text: `[Content]: Error checking for duplicates: ${error.message}`, type: 'error' });
            return 'error';
        }
    }
    /**
     * Binds listeners for the log panel (filtering, clearing, toggling visibility).
     * @private
     */
    _bindLogControls() {
        this.uiManager.shadowRoot.getElementById('btn-toggle-log').addEventListener('click', () => {
            const logContainer = this.uiManager.shadowRoot.getElementById('log-container');
            const isCurrentlyVisible = !logContainer.classList.contains('log-hidden');
            this.setLogVisibility(!isCurrentlyVisible);
        });

        this.uiManager.shadowRoot.getElementById('btn-clear-log').addEventListener('click', () => {
            this.addLogEntry({ text: '[Content]: Log cleared.', type: 'info' }, true);
        });

        this.uiManager.shadowRoot.getElementById('btn-filter-info').addEventListener('click', () => {
            this.setLogFilters({ info: !this.activeLogFilters.info });
        });

        this.uiManager.shadowRoot.getElementById('btn-filter-error').addEventListener('click', () => {
            this.setLogFilters({ error: !this.activeLogFilters.error });
        });
    }

    /**
     * Binds listeners for the minimized stub.
     * @private
     */
    _bindMinimizedControls() {
        const minimizedHost = this.uiManager.minimizedHost;
        if (minimizedHost && minimizedHost.shadowRoot) {
            const restoreBtn = minimizedHost.shadowRoot.getElementById('m3u8-minimized-stub');
            const playBtn = minimizedHost.shadowRoot.getElementById('m3u8-minimized-play-btn');

            if (restoreBtn && playBtn) {
                restoreBtn.addEventListener('click', async (e) => {
                    // Prevent default behavior, especially if it's a right-click for dragging
                    e.preventDefault();

                    // If the button is green (stream detected), a left-click adds the URL.
                    if (restoreBtn.classList.contains('stream-present') && e.button === 0) {
                        try {
                            const folderResponse = await sendMessageAsync({ action: 'get_last_folder_id' });
                            if (folderResponse?.success && folderResponse.folderId) {
                                // This helper now returns a status: 'success', 'duplicate', 'cancelled', or 'error'.
                                const result = await this.addDetectedUrlToFolder(folderResponse.folderId, { isUiVisible: false });

                                if (result === 'success') {
                                    // On success, clear the state and revert the button to default.
                                    // The button state will be updated to yellow ("in playlist") automatically
                                    // by the 'render_playlist' message handler.
                                    this.addLogEntry({ text: `[Content]: URL added to '${folderResponse.folderId}'.`, type: 'info' });
                                    this.refreshPlaylist(); // Refresh count in popup
                                } else if (result === 'duplicate' && minimizedStub) {
                                    // On duplicate, flash yellow and then revert.
                                    restoreBtn.classList.remove('stream-present');
                                    restoreBtn.classList.add('url-duplicate');
                                    setTimeout(() => {
                                        restoreBtn.classList.remove('url-duplicate');
                                        // Don't clear detectedUrl, so the user can try restoring the UI to add it again.
                                    }, 1500);
                                }
                                // For 'cancelled' or 'error', we do nothing and let the log entry be the feedback.
                            }
                        } catch (error) {
                            this.addLogEntry({ text: `[Content]: Error adding from minimized button: ${error.message}`, type: 'error' });
                        }
                    } else {
                        // If no stream is detected, or it's not a left-click, the default action is to restore the UI.
                        this.setMinimizedState(false);
                    }
                });
            }

            if (playBtn) { // This listener remains separate
                playBtn.addEventListener('click', (e) => {
                    // Get the last used folder and send a 'play' command.
                    (async () => {
                        try {
                            const folderResponse = await sendMessageAsync({ action: 'get_last_folder_id' });
                            if (folderResponse?.success && folderResponse.folderId) {
                                this.sendCommandToBackground('play', folderResponse.folderId);
                            }
                        } catch (error) {
                            this.addLogEntry({ text: `[Content]: Error playing from minimized button: ${error.message}`, type: 'error' });
                        }
                    })();
                });
            }
        }
    }

    /**
     * Binds global keyboard shortcuts for the controller.
     * @private
     */
    _bindGlobalShortcuts() {
        window.addEventListener('keydown', (e) => {
            if (!this.keybinds.add && !this.keybinds.toggle && !this.keybinds.openPopup) return;
            
            // Ignore if typing in an input
            if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || e.target.isContentEditable) return;

            const modifiers = [];
            if (e.ctrlKey) modifiers.push('Ctrl');
            if (e.shiftKey) modifiers.push('Shift');
            if (e.altKey) modifiers.push('Alt');
            if (e.metaKey) modifiers.push('Meta');
            
            let key = e.key;
            if (key === ' ') key = 'Space';
            if (key.length === 1) key = key.toUpperCase();
            
            if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;

            const combo = [...modifiers, key].join('+').toLowerCase();
            const normalize = (str) => {
                if (!str) return '';
                return str.replace(/\s+/g, '')
                          .toLowerCase()
                          .replace('control', 'ctrl')
                          .replace('command', 'meta')
                          .replace('cmd', 'meta')
                          .replace('option', 'alt');
            };

            if (this.keybinds.add && combo === normalize(this.keybinds.add)) {
                e.preventDefault();
                e.stopPropagation();
                const folderSelect = this.uiManager.shadowRoot?.getElementById('folder-select');
                const folderId = folderSelect?.value;
                if (folderId) {
                    this.addDetectedUrlToFolder(folderId, { isUiVisible: this.uiManager.controllerHost.style.display !== 'none' });
                }
            } else if (this.keybinds.playPlaylist && combo === normalize(this.keybinds.playPlaylist)) {
                e.preventDefault();
                e.stopPropagation();
                const folderSelect = this.uiManager.shadowRoot?.getElementById('folder-select');
                const folderId = folderSelect?.value;
                if (folderId) {
                    this.sendCommandToBackground('play', folderId);
                }
            } else if (this.keybinds.toggle && combo === normalize(this.keybinds.toggle)) {
                e.preventDefault();
                e.stopPropagation();
                const isMinimized = this.uiManager.controllerHost.style.display === 'none';
                this.setMinimizedState(!isMinimized);
            } else if (this.keybinds.openPopup && combo === normalize(this.keybinds.openPopup)) {
                e.preventDefault();
                e.stopPropagation();
                sendMessageAsync({ action: 'open_popup' }).then(response => {
                    if (!response || !response.success) {
                        this.addLogEntry({ text: `[Content]: Failed to open popup: ${response?.error || 'Unknown error'}`, type: 'error' });
                    }
                });
            }
        }, true);
    }

    /**
     * Initializes all draggable UI components using the Draggable utility class.
     * @private
     */
    _initializeDraggables() {
        // 1. Main Controller
        const controllerHandle = this.uiManager.shadowRoot?.getElementById('status-banner');
        if (this.uiManager.controllerHost && controllerHandle) {
            new Draggable(this.uiManager.controllerHost, controllerHandle, {
                onDragStart: () => !this.isPinned,
                onDragMove: (e, { newLeft, newTop }) => {
                    // Snap the anilist panel while dragging the controller
                    this.anilistUI?.snapToController();
                    this.updateAdaptiveElements();
                },
                onDragEnd: (e, newPosition) => {
                    // Apply the new position styles calculated by Draggable.js
                    this.uiManager.controllerHost.style.left = newPosition.left;
                    this.uiManager.controllerHost.style.top = newPosition.top;
                    this.uiManager.controllerHost.style.right = newPosition.right;
                    this.uiManager.controllerHost.style.bottom = newPosition.bottom;
                    this.preFullscreenPosition = null;
                    this.preResizePosition = null;
                    this.savePreference({ position: newPosition });
                }
            });
        }

        // 2. Minimized Stub
        const minimizedHandle = this.uiManager.minimizedHost?.shadowRoot?.getElementById('m3u8-minimized-stub');
        if (this.uiManager.minimizedHost && minimizedHandle) {
            new Draggable(this.uiManager.minimizedHost, minimizedHandle, {
                dragButton: 2, // Right-click drag
                onDragEnd: (e, newPosition) => {
                    // Apply the new position styles calculated by Draggable.js
                    this.uiManager.minimizedHost.style.left = newPosition.left;
                    this.uiManager.minimizedHost.style.top = newPosition.top;
                    this.uiManager.minimizedHost.style.right = newPosition.right;
                    this.uiManager.minimizedHost.style.bottom = newPosition.bottom;

                    // After dragging, remove corner classes to ensure style-based positioning takes precedence.
                    this.uiManager.minimizedHost.classList.remove('top-left', 'top-right');
                    this.savePreference({ minimizedStubPosition: newPosition });
                }
            });
        }
    }

    /**
     * Binds listeners to the main window object (e.g., resize).
     * @private
     */
    _bindWindowEvents() {
        if (!this.uiManager.controllerHost) return;
        const debouncedReposition = debounce(() => {
            // --- New Resize Logic ---
            if (this.uiManager.controllerHost.style.display === 'none') {
                // If the main controller is hidden, just validate the minimized stub.
                this.validateAndRepositionMinimizedStub();
                return;
            }

            const hostWidth = this.uiManager.controllerHost.offsetWidth;
            const hostHeight = this.uiManager.controllerHost.offsetHeight;
            const currentLeft = this.uiManager.controllerHost.offsetLeft;
            const currentTop = this.uiManager.controllerHost.offsetTop;

            // Calculate the maximum allowed coordinates.
            const maxX = window.innerWidth - hostWidth;
            const maxY = window.innerHeight - hostHeight;

            // Check if the controller is currently off-screen.
            const isOffScreen = currentLeft > maxX || currentTop > maxY;

            if (isOffScreen) {
                // If the controller is off-screen and we haven't stored a pre-resize position yet,
                // it means this resize is the one forcing it to move. Store its current position.
                if (!this.preResizePosition) {
                this.preResizePosition = { left: `${currentLeft}px`, top: `${currentTop}px`, right: 'auto', bottom: 'auto' };
                }
                // Now, force the controller back into the viewport.
                this.validateAndRepositionController();
            } else if (this.preResizePosition) {
                // If the controller is on-screen AND we have a stored pre-resize position,
                // it means the window has been made larger again.
            const originalLeft = parseFloat(this.preResizePosition.left) || 0;
            const originalTop = parseFloat(this.preResizePosition.top) || 0; // We no longer save this automatically, preventing cross-tab interference.
                // Check if the original position is now back within the valid viewport. If so, restore it.
                // We no longer save this automatically, preventing cross-tab interference.
                // The position is only saved on an explicit user drag.
                if (originalLeft <= maxX && originalTop <= maxY) this.preResizePosition = null;
            }
        }, 250);
        window.addEventListener('resize', debouncedReposition);
    }

    /**
     * Loads saved state from localStorage and applies it to the UI.
     * @param {object|null} positionOverride - An optional position object to use instead of fetching from storage.
     */
    async applyInitialState(positionOverride = null) {
        const response = await chrome.runtime.sendMessage({ action: 'get_ui_preferences' });
        if (!this.uiManager.shadowRoot || !this.uiManager.controllerHost) return; // UI not ready

        const prefs = response?.preferences;

        // Use the position override if provided (from exiting fullscreen),
        // otherwise use the position from saved preferences.
        const position = positionOverride || prefs?.position;

        const mode = prefs?.mode || 'full'; // This part remains the same
        const logVisible = prefs?.logVisible ?? true;
        const pinned = prefs?.pinned ?? false;
        const logFilters = prefs?.logFilters ?? { info: true, error: true };
        const showPlayNew = prefs?.show_play_new_button ?? false;
        const anilistPosition = prefs?.anilistPanelPosition; 
        const anilistImageHeight = prefs?.anilist_image_height;
        const anilistSize = prefs?.anilistPanelSize;        
        this.anilistUI.isEnabled = prefs?.enable_anilist_integration ?? true;
        this.anilistUI.isLocked = prefs?.lockAnilistPanel ?? false;
        this.settings = {
            enable_active_item_highlight: prefs?.enable_active_item_highlight ?? true,
            enable_smart_resume: prefs?.enable_smart_resume ?? true
        };
        this.anilistUI.updateDynamicStyles(); // Apply lock style
        this.anilistUI.forceAttached = prefs?.forcePanelAttached ?? false;
        this.anilistUI.attachOnOpen = prefs?.anilistAttachOnOpen ?? true;
        const minimizedStubPosition = prefs?.minimizedStubPosition;
        this.enableDblclickCopy = prefs?.enable_dblclick_copy ?? false; // New: Apply preference
        this.showMinimizedStub = prefs?.show_minimized_stub ?? true;
        this.showCopyTitleButton = prefs?.show_copy_title_button ?? false;
        this.pageScraper.updateFilterWords(prefs?.scraper_filter_words || ['watch', 'online', 'free', 'episode', 'season', 'full', 'hd', 'eng sub', 'subbed', 'dubbed', 'animepahe']);
        this._updateStubButtonState();
        this.keybinds.add = prefs?.kb_add_playlist || null;
        this.keybinds.playPlaylist = prefs?.kb_play_playlist || null;
        this.keybinds.toggle = prefs?.kb_toggle_controller || null;
        this.keybinds.openPopup = prefs?.kb_open_popup || null;

        // Restore AniList panel position first.
        if (this.anilistUI.panelHost && anilistPosition?.left && anilistPosition?.top) {
            this.anilistUI.panelHost.style.left = anilistPosition.left;
            this.anilistUI.panelHost.style.top = anilistPosition.top;
            this.anilistUI.panelHost.style.right = anilistPosition.right;
            this.anilistUI.panelHost.style.bottom = anilistPosition.bottom;
            this.anilistUI.isManuallyPositioned = true;
        } else {
            this.anilistUI.isManuallyPositioned = false;
        }

        // Restore AniList panel size
        if (this.anilistUI.panelHost && anilistSize?.width && anilistSize?.height) {
            this.anilistUI.panelHost.style.width = anilistSize.width;
            this.anilistUI.panelHost.style.height = anilistSize.height;
        }
 
        // New: Restore AniList image size
        if (this.anilistUI.panelHost && anilistImageHeight) {
            const baseWidth = 50;
            const defaultHeight = 70; // The original default height for aspect ratio calculation
            const effectiveHeight = Number(anilistImageHeight || defaultHeight);
            const scalingFactor = effectiveHeight / defaultHeight;
            const effectiveWidth = Math.round(baseWidth * scalingFactor);
    
            this.anilistUI.panelHost.style.setProperty('--anilist-item-width', `${effectiveWidth}px`);
            this.anilistUI.panelHost.style.setProperty('--anilist-image-height', `${effectiveHeight}px`);
        }

        // Restore Minimized Stub position
        if (minimizedStubPosition?.left && minimizedStubPosition?.top) {
            this.uiManager.minimizedHost.style.left = minimizedStubPosition.left;
            this.uiManager.minimizedHost.style.top = minimizedStubPosition.top;
            this.uiManager.minimizedHost.style.right = minimizedStubPosition.right;
            this.uiManager.minimizedHost.style.bottom = minimizedStubPosition.bottom;
        }

        // Restore AniList panel visibility, passing its initial position to prevent re-snapping on load.
        // Only show the panel if the master toggle is also on.
        const anilistVisible = prefs?.anilistPanelVisible ?? false;
        this.anilistUI.toggleVisibility(anilistVisible, false);
        
        // After applying the saved position, validate it to ensure it's on-screen.
        this.anilistUI.validatePosition();

        if (position) {
            this.uiManager.controllerHost.style.left = position.left;
            this.uiManager.controllerHost.style.top = position.top;
            this.uiManager.controllerHost.style.right = position.right;
            this.uiManager.controllerHost.style.bottom = position.bottom;
        }

        const playNewBtn = this.uiManager.shadowRoot?.getElementById('btn-play-new');
        const playbackControls = this.uiManager.shadowRoot?.getElementById('playback-controls');
        if (playNewBtn && playbackControls) {
            playNewBtn.style.display = showPlayNew ? 'flex' : 'none';
            playbackControls.style.gridTemplateColumns = showPlayNew ? '1fr 1fr auto' : '1fr auto';
        }

        let shouldBeMinimized;
        if (typeof prefs?.minimized === 'boolean') {
            shouldBeMinimized = prefs.minimized;
        } else {
            shouldBeMinimized = (prefs?.mode === 'minimized');
        }

        this.setMinimizedState(shouldBeMinimized, false, prefs); // Pass prefs to avoid re-fetching
        this.switchUi(mode === 'minimized' ? 'full' : mode, false);
        this.setLogVisibility(logVisible, false);
        this.setPinState(pinned, false);
        this.setLogFilters(logFilters, false);

        // If the controller is being shown, validate its position to ensure it's on-screen.
        // This must be called *after* setting the position.
        if (!shouldBeMinimized) {
            this.validateAndRepositionController();
        }
        this.updateAdaptiveElements();
    }

    // --- Main Initialization Orchestrator ---
    async initializeMpvController() {
        if (document.getElementById('m3u8-controller-host')) return;
        // Create UI, but it remains hidden by default (display: none).
        this.uiManager.createAndInjectUi();
        // Now that the UI is created, we can initialize the PlaylistUI manager.
        this.playlistUI = new PlaylistUI(this, this.uiManager);
        this.anilistUI = new AniListUI(this, this.uiManager);
        this.playlistUI.bindEvents();
        this.anilistUI.bindEvents();
        this.bindEventListeners();
        await this.updateFolderDropdowns();
        chrome.runtime.sendMessage({ action: 'content_script_init' });
        console.log("MPV Controller content script initialized and ready.");

        // After initializing, check if we are in fullscreen mode and hide the UI if so.
        // This handles cases where the UI is re-injected on a page that is already fullscreen
        if (document.fullscreenElement && this.uiManager.controllerHost) {
            this.uiManager.controllerHost.style.display = 'none';
        }
    }

    // --- Global UI Update Functions ---
    // These functions are called by the message listener and find the UI elements each time.
    // This makes them resilient to the UI being destroyed and recreated.

    updateStatusBanner(text, isSuccess = false) {
        const statusBanner = this.uiManager.shadowRoot?.getElementById('status-banner');
        const streamStatus = this.uiManager.shadowRoot?.getElementById('stream-status');
        if (!statusBanner || !streamStatus) return;

        streamStatus.textContent = text;
        statusBanner.classList.toggle("detected", isSuccess);
    }

    async updateAddButtonState(isPlaylist = false) {
        const addBtn = this.uiManager.shadowRoot?.getElementById('btn-add');
        const compactAddBtn = this.uiManager.shadowRoot?.getElementById('btn-compact-add');
        const minimizedStub = this.uiManager.minimizedHost?.shadowRoot?.getElementById('m3u8-minimized-stub');
        const folderSelect = this.uiManager.shadowRoot?.getElementById('folder-select');

        // Reset button states, but preserve the detected state if a URL is present.
        addBtn?.classList.remove('url-in-playlist');
        compactAddBtn?.classList.remove('url-in-playlist');
        minimizedStub?.classList.remove('url-in-playlist');

        if (!this.detectedUrl) {
            // Explicitly remove the 'stream-present' class if no URL is detected.
            addBtn?.classList.remove('stream-present');
            compactAddBtn?.classList.remove('stream-present');
            minimizedStub?.classList.remove('stream-present');

            this.updateStatusBanner('No stream/playlist detected', false);
            if (minimizedStub) minimizedStub.title = 'Show MPV Controller';
        } else {
            this.updateStatusBanner(isPlaylist ? 'Playlist detected' : 'Stream/video detected', true);

            const currentFolderId = folderSelect?.value;
            if (!currentFolderId) return; // Can't check playlist if no folder is selected.

            try {
                const playlistObjects = await this.getPlaylistFromBackground(currentFolderId);
                const isUrlInPlaylist = playlistObjects.some(item => item.url === this.detectedUrl);

                // Set the green 'detected' state first.
                addBtn?.classList.add('stream-present');
                compactAddBtn?.classList.add('stream-present');
                minimizedStub?.classList.add('stream-present');
                if (minimizedStub) minimizedStub.title = 'Click to add URL to playlist';

                if (isUrlInPlaylist) {
                    // URL is already in the list, make buttons yellow.
                    addBtn?.classList.remove('stream-present');
                    compactAddBtn?.classList.remove('stream-present');
                    minimizedStub?.classList.remove('stream-present');
                    addBtn?.classList.add('url-in-playlist');
                    compactAddBtn?.classList.add('url-in-playlist');
                    minimizedStub?.classList.add('url-in-playlist');
                    if (minimizedStub) minimizedStub.title = 'URL is already in this playlist';
                }
            } catch (error) {
                // If there's an error checking the playlist, do nothing. The buttons will keep their default state.
            }
        }
    }

    addLogEntry(logObject, clear = false) {
        const logContainer = this.uiManager.shadowRoot?.getElementById('log-container');
        if (!logContainer) return; // UI not present, do nothing.
        const placeholder = this.uiManager.shadowRoot.getElementById('log-placeholder');

        if (clear) {
            while (logContainer.firstChild) {
                logContainer.removeChild(logContainer.firstChild);
            }
        }
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
        if (!this.uiManager.shadowRoot) return;
    
        try {
            const folderResponse = await sendMessageAsync({ action: 'get_all_folder_ids' });
            if (!folderResponse ?.success) {
                this.addLogEntry({ text: `[Content]: Failed to get folder list: ${folderResponse?.error || 'Unknown error'}`, type: 'error' });
                return;
            }
    
            const fullSelect = this.uiManager.shadowRoot?.getElementById('folder-select');
            const compactSelect = this.uiManager.shadowRoot?.getElementById('compact-folder-select');
            if (!fullSelect || !compactSelect) return;
    
            // Clear existing options and build new ones
            fullSelect.innerHTML = '';
            compactSelect.innerHTML = '';
            const optionsFragment = document.createDocumentFragment();
            folderResponse.folderIds.forEach(id => {
                const option = document.createElement('option');
                option.value = id;
                option.textContent = id;
                optionsFragment.appendChild(option);
            });
            fullSelect.appendChild(optionsFragment.cloneNode(true));
            compactSelect.appendChild(optionsFragment);
    
            const lastFolderResponse = await sendMessageAsync({ action: 'get_last_folder_id' });
            if (lastFolderResponse ?.success && lastFolderResponse.folderId) {
                fullSelect.value = lastFolderResponse.folderId;
                compactSelect.value = lastFolderResponse.folderId;
            }
    
            // After the dropdowns are populated and the correct folder is selected,
            // we must explicitly refresh the playlist for that folder. This will, in turn,
            // call updateAddButtonState with the fresh playlist data, ensuring the UI is correct.
            // This is the key to fixing the SPA navigation race condition.
            this.refreshPlaylist(); // This also calls updateAddButtonState()

        } catch (error) {
            this.addLogEntry({ text: `[Content]: Error updating folders: ${error.message}`, type: 'error' });
        }
    }

    refreshPlaylist() {
        // The folder dropdowns are always kept in sync, so we can reliably get the
        // current folder ID from the main dropdown without checking the UI mode.
        const folderSelect = this.uiManager.shadowRoot?.getElementById('folder-select');
        if (!folderSelect || !folderSelect.value) {
            return; // UI not ready or no folder selected.
        }
        const currentFolderId = folderSelect.value;
        // Fetch the playlist and then render it. The render call will also update the button state.
        this.sendCommandToBackground('get_playlist', currentFolderId); // This will trigger a 'render_playlist' message
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
     * @returns {Promise<Array<{url: string, title: string}>>} A promise that resolves with the array of playlist items.
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
        const payload = { action, folderId, ...data, tabId: this.tabId };

        chrome.runtime.sendMessage(payload, (response) => {
            if (chrome.runtime.lastError) {
                this.addLogEntry({ text: `[Content]: Error sending '${action}': ${chrome.runtime.lastError.message}`, type: 'error' });
                return;
            }

            if (response) {
                // The 'get_playlist' command is the only one that returns a list to render.
                if (action === 'get_playlist' && response.success) {
                    this.playlistUI?.render(response.list, response.last_played_id);
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

    handleFullscreenChange() {
        // Re-query the host from the DOM to ensure we have a live reference.
        const controllerHost = this.uiManager.controllerHost;
        const minimizedHost = this.uiManager.minimizedHost;

        if (document.fullscreenElement) {
            // --- Entering Fullscreen ---
            // Store the current position if it hasn't been stored already.
            if (controllerHost && !this.preFullscreenPosition) {
                this.preFullscreenPosition = {
                    left: controllerHost.style.left,
                    top: controllerHost.style.top,
                    right: controllerHost.style.right,
                    bottom: controllerHost.style.bottom,
                };
            }
            // Always hide both UI elements when entering fullscreen.
            if (controllerHost) controllerHost.style.display = 'none';
            if (minimizedHost) minimizedHost.style.display = 'none';
        } else {
            // --- Exiting Fullscreen ---
            // Restore the UI using the pre-fullscreen position if it exists.
            // This bypasses fetching from storage, preserving the original position.
            if (this.preFullscreenPosition) {
                this.applyInitialState(this.preFullscreenPosition);
                this.preFullscreenPosition = null; // Reset after use
            }
        }
    }

    /**
     * Checks if the current page is a YouTube video or playlist page and updates the detected URL.
     */
    checkForYouTubeURL() {
        const YOUTUBE_VIDEO_REGEX = /^https?:\/\/((www|music)\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]+)/;
        const YOUTUBE_PLAYLIST_REGEX = /^https?:\/\/((www|music)\.)?youtube\.com\/playlist\?list=([a-zA-Z0-9_-]+)/;
        const currentUrl = window.location.href;

        let isPlaylist = false;

        if (YOUTUBE_PLAYLIST_REGEX.test(currentUrl)) {
            this.detectedUrl = currentUrl;
            isPlaylist = true;
        } else if (YOUTUBE_VIDEO_REGEX.test(currentUrl)) {
            this.detectedUrl = currentUrl;
        } else {
            // Not a YT video or playlist page, do nothing with this.detectedUrl
            return;
        }

        // Report to background and update UI state.
        chrome.runtime.sendMessage({ action: 'report_detected_url', url: this.detectedUrl });
        this.updateAddButtonState(isPlaylist);
    }

    // --- Robustness for Single-Page Applications ---
    // This function handles all updates needed after a potential page navigation on an SPA.
    handlePageUpdate() {
        // If the host element is gone, the SPA has likely removed it. Re-inject.
        // This is the most critical check for SPA navigation.
        if (!document.getElementById('m3u8-controller-host')) {
            console.log("MPV Controller host has been removed from the DOM. Re-injecting UI.");
            this.teardownAndReinitialize();
            return;
        }

        const urlChanged = window.location.href !== this.lastUrl;

        // Only clear the detected URL if the page has actually navigated.
        // This prevents a detected M3U8 stream from being cleared by the timer.
        if (urlChanged) {
            this.detectedUrl = null;
        }

        // Always check if the current page is a YouTube video. This fixes detection on page load/reload.
        // We only do this if a stream hasn't already been detected, to avoid overwriting an m3u8.
        if (!this.detectedUrl) {
            this.checkForYouTubeURL();
        }

        // Always update the button state to reflect the current status of detectedUrl.
        this.updateAddButtonState(/^https?:\/\/((www|music)\.)?youtube\.com\/playlist\?list=/.test(this.detectedUrl));

        // Only proceed with the more expensive folder/playlist updates if the URL has actually changed.
        if (urlChanged) {
            this.lastUrl = window.location.href;
            // Report the new state to the background script and refresh the UI.
            sendMessageAsync({ action: 'report_detected_url', url: this.detectedUrl });
            this.updateFolderDropdowns();
        }
    }

    /**
     * Safely tears down and re-initializes the controller.
     * This is used when the UI is removed from the DOM by an SPA.
     */
    teardownAndReinitialize() {
        // Prevent multiple teardowns from running at once.
        if (this.isTearingDown) return;
        this.isTearingDown = true;

        this.uiManager.teardown();

        // Re-run the global initialization function after a short delay to ensure the DOM is clean.
        setTimeout(() => {
            startInitialization();
        }, 100);
    }

    /**
     * Starts a periodic check to ensure the background script is still alive.
     * If the connection is lost (e.g., extension reloaded), it triggers a self-reload.
     */
    startHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
        }

        this.heartbeatInterval = setInterval(async () => {
            try {
                // Sending a message to the background script. If it throws an error,
                // it means the background script is gone (e.g., extension was reloaded).
                const response = await sendMessageAsync({ action: 'heartbeat' });
                if (!response?.success) throw new Error("Invalid heartbeat response.");
            } catch (e) {
                // The background script is unresponsive.
                console.warn("MPV Controller: Heartbeat failed. Background script may have been reloaded. Refreshing content script.");

                // Stop the heartbeat to prevent an infinite loop of reloads.
                if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);

                // Instead of reloading the page, tear down and re-initialize the controller.
                this.teardownAndReinitialize();
            }
        }, 15000); // Check every 15 seconds.
    }

    /**
     * Main entry point. Initializes the UI and sets up observers/timers to handle
     * dynamic page changes on Single-Page Applications.
     */
    init() {
        if (window.mpvControllerInitialized) return;
        window.mpvControllerInitialized = true;

        this.tabId = null; // Will be set by background script
        document.addEventListener('fullscreenchange', this.handleFullscreenChange);

        // New: Listen for right-clicks to capture the target element.
        // We use the 'capture' phase to ensure our listener runs before any other
        // that might stop the event's propagation.
        document.addEventListener('mousedown', (event) => {
            if (event.button === 2) { // Right-click
                 this.lastRightClickedElement = event.target;
            }
        }, true);

       
        // This block contains scraping logic specifically for a YouTube video watch page (`/watch`).
        // It is intentionally placed here to act as a high-priority scraper that runs before
        // the generic title scrapers. This logic is now handled inside the scrapePageDetails function.
        // DO NOT move or generalize this code. Its purpose is to provide a clean title
        // for YouTube video pages, which have a predictable structure, preventing the less
        // reliable generic scrapers from running and producing a messy title.
        const isYouTubeVideoPage = window.location.hostname.includes('youtube.com') && window.location.pathname === '/watch';
        // --- END AI GUARD ---

        // --- SPA Handling using MutationObserver ---
        const observer = new MutationObserver(() => this.handlePageUpdate());
        observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

        // Also, poll the URL periodically. This is more reliable for SPA navigations. This interval is cleared in teardown().
        this.pageUpdateInterval = setInterval(this.handlePageUpdate, 500);
        this.initializeMpvController();

        // Start the heartbeat to detect extension reloads.
        this.startHeartbeat();
    }

}
(function () {
  'use strict';

  // Check if this is the special scanner window. If so, do not inject any UI.
  // This is identified by a URL parameter added by the background script.
  try {
    // This must be included in the final script.
    if (new URL(window.location.href).searchParams.get('mpv_playlist_scanner') === 'true') {
      // The scanner window doesn't need a controller UI, but it still needs to
      // listen for messages from the background script (e.g., to perform a scrape).
      const controller = new MpvController();
      chrome.runtime.onMessage.addListener(controller.handleMessage);
      return; // Abort UI injection.
    }
  } catch (e) { /* Ignore invalid URLs */ }

  const startInitialization = () => {
    // Create a single, authoritative instance of the controller.
    const controller = new MpvController();
    // Expose the controller instance to the window for debugging from the console.

    // Initialize the controller.
    controller.init();

    // Attach the message listener to the single controller instance.
    chrome.runtime.onMessage.addListener(controller.handleMessage);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startInitialization);
  } else {
    startInitialization();
  }
})();
