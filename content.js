/* ------------------------------------------------------------------
 * content.js (fully fixed and now draggable, with saved position)
 * UI + messaging with the local MPV server.
 * ------------------------------------------------------------------*/

(function () {
    'use strict';

    // --- Global State & Background Message Handler ---
    // These are defined once and live for the entire page session.

    let detectedUrl = null;
    let controllerHost = null; // The host element in the main DOM
    let shadowRoot = null; // The shadow root for UI isolation
    let currentUiMode = 'full'; // Default UI mode, will be updated by UI interactions.
    let isPinned = false; // Default to unpinned to allow dragging on first load.
    let lastUrl = window.location.href; // Track URL for SPA navigation

    // This listener is now defined in the top-level scope and registered only once.
    // It will survive all UI re-injections by the MutationObserver.
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'show_ui') {
            // Re-query the host from the DOM to ensure we have a live reference,
            // as the global `controllerHost` variable could be stale if the UI was re-injected.
            const host = document.getElementById('m3u8-controller-host');
            if (host) {
                host.style.display = 'block';
                // When explicitly shown, tell the background script we are no longer minimized.
                chrome.runtime.sendMessage({ action: 'set_ui_minimized_state', minimized: false });
            }
        } else if (request.m3u8) {
            detectedUrl = request.m3u8;
            // Report the detected stream URL to the background script
            chrome.runtime.sendMessage({ action: 'report_detected_url', url: detectedUrl });
            // Call the global UI update function
            updateStatusBanner(`Stream detected`);
        } else if (request.action === 'render_playlist') {
            // The background has sent an updated list. Render it only if it
            // matches the currently selected folder.
            const currentFolderId = shadowRoot ?.getElementById('folder-select') ?.value;
            if (currentFolderId === request.folderId) {
                renderPlaylist(request.playlist);
            }
        } else if (request.foldersChanged) {
            // The list of available folders has changed (e.g., a new one was created)
            updateFolderDropdowns();
        } else if (request.log) {
            // Call the global UI update function
            addLogEntry(request.log);
        } else if (request.action === 'apply_ui_preferences') {
            const prefs = request.preferences;
            if (prefs && shadowRoot) { // Ensure UI is present
                // Apply changes without re-saving state to prevent loops.
                switchUi(prefs.mode || 'full', false);
                setLogVisibility(prefs.logVisible === null ? true : prefs.logVisible, false);
                setPinState(prefs.pinned === null ? false : prefs.pinned, false);

                if (prefs.position && controllerHost) {
                    controllerHost.style.left = prefs.position.left;
                    controllerHost.style.top = prefs.position.top;
                    controllerHost.style.right = prefs.position.right;
                    controllerHost.style.bottom = prefs.position.bottom;
                }
            }
        } else if (request.action === 'apply_minimize_state') {
            // This message is broadcast when the minimized state changes on another tab.
            const host = document.getElementById('m3u8-controller-host');
            if (host) {
                host.style.display = request.minimized ? 'none' : 'block';
            }
        }
    });

    /**
     * Creates the controller container and injects the UI's HTML into the DOM.
     */
    async function createAndInjectUi() {
        // Create the host element that will live in the main DOM.
        // All styling and positioning will be applied to this host.
        controllerHost = document.createElement('div');
        controllerHost.id = 'm3u8-controller-host';
        controllerHost.style.display = 'none'; // Start hidden, background script will tell us to show.

        // Attach the shadow root for isolation.
        shadowRoot = controllerHost.attachShadow({ mode: 'open' });

        // Inject styles for the host element and the dragging class into the main document's head.
        // The host element needs to handle positioning in the main document.
        const hostAndDragStyle = document.createElement('style');
        hostAndDragStyle.textContent = `
            #m3u8-controller-host {
                /* This is the element that gets positioned on the page */
                position: fixed;
                top: 10px;
                right: 10px;
                z-index: 2147483647;
                /* The width and height are determined by the content inside */
            }

            body.mpv-controller-dragging, body.mpv-controller-dragging * {
                user-select: none;
                -webkit-user-select: none;
                -moz-user-select: none;
                -ms-user-select: none;
                cursor: grabbing !important;
            }`;
        document.head.appendChild(hostAndDragStyle);

        // The UI container now lives inside the shadow DOM.
        const uiWrapper = document.createElement('div');
        uiWrapper.id = 'm3u8-controller';
        // Get the URL for the stylesheet, which is made available via web_accessible_resources.
        const cssUrl = chrome.runtime.getURL('content.css');
        uiWrapper.innerHTML = `
        <link rel="stylesheet" type="text/css" href="${cssUrl}">
        <style>
            /* Fix for long text overflowing its container */
            .title-text { /* Keep header title truncated */
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                /* These properties are crucial for flexbox truncation */
                flex-grow: 1;
                min-width: 0;
            }

            .list-item .url-text { /* Allow URL to overflow for horizontal scrolling */
                white-space: nowrap;
                flex-grow: 1;
                min-width: 0; /* Still important for flex behavior */
            }

            /* Adjust icon and title position */
            #m3u8-url > svg {
                /* This moves the icon and the title that follows it slightly to the left */
                margin-left: -4px;
            }
        </style>
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
                <button id="btn-toggle-full" class="active-toggle" title="Full UI">
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                        <line x1="3" y1="9" x2="21" y2="9"></line>
                        <line x1="3" y1="15" x2="21" y2="15"></line>
                        <line x1="9" y1="3" x2="9" y2="21"></line>
                        <line x1="15" y1="3" x2="15" y2="21"></line>
                    </svg>
                </button>
                <button id="btn-toggle-compact" title="Compact UI">
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                        <line x1="3" y1="9" x2="21" y2="9"></line>
                        <line x1="9" y1="9" x2="9" y2="21"></line>
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
        shadowRoot.appendChild(uiWrapper);

        // Append the host to the body *after* the shadow DOM is populated
        document.body.appendChild(controllerHost);
    }

    function switchUi(uiMode, saveState = true) {
        const fullUiContainer = shadowRoot?.getElementById('full-ui-container');
        const compactUiContainer = shadowRoot?.getElementById('compact-ui-container');
        const toggleFullBtn = shadowRoot?.getElementById('btn-toggle-full');
        const toggleCompactBtn = shadowRoot?.getElementById('btn-toggle-compact');
        if (!fullUiContainer || !compactUiContainer || !toggleFullBtn || !toggleCompactBtn) return;

        currentUiMode = uiMode;
        if (uiMode === 'full') {
            fullUiContainer.style.display = 'flex';
            compactUiContainer.style.display = 'none';
            toggleFullBtn.classList.add('active-toggle');
            toggleCompactBtn.classList.remove('active-toggle');
        } else if (uiMode === 'compact') {
            fullUiContainer.style.display = 'none';
            compactUiContainer.style.display = 'flex';
            toggleFullBtn.classList.remove('active-toggle');
            toggleCompactBtn.classList.add('active-toggle');
        }
        if (saveState) {
            chrome.runtime.sendMessage({ action: 'set_ui_preferences', preferences: { mode: uiMode } });
        }
        refreshPlaylist();
    }

    /**
     * Displays a custom confirmation modal inside the controller UI.
     * @param {string} message The message to display in the modal.
     * @returns {Promise<boolean>} A promise that resolves to true if confirmed, false if cancelled.
     */
    function showConfirmationModal(message) {
        return new Promise((resolve) => {
            const modal = shadowRoot.getElementById('confirmation-modal');
            const messageEl = shadowRoot.getElementById('modal-message');
            const confirmBtn = shadowRoot.getElementById('modal-confirm-btn');
            const cancelBtn = shadowRoot.getElementById('modal-cancel-btn');

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

    // --- UI State Setters ---
    // These functions update the UI and, by default, save the state to storage.
    // They can be called with `saveState = false` during initialization to prevent
    // a redundant write operation.

    function setLogVisibility(isVisible, saveState = true) {
        const logContainer = shadowRoot?.getElementById('log-container');
        const toggleLogBtn = shadowRoot?.getElementById('btn-toggle-log');
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
            chrome.runtime.sendMessage({ action: 'set_ui_preferences', preferences: { logVisible: isVisible } });
        }
    }

    function setPinState(shouldBePinned, saveState = true) {
        const togglePinBtn = shadowRoot?.getElementById('btn-toggle-pin');
        const dragHandle = shadowRoot?.getElementById('status-banner');
        if (!controllerHost || !togglePinBtn || !dragHandle) return;

        isPinned = shouldBePinned; // Update global state variable

        if (shouldBePinned) {
            controllerHost.classList.add('pinned');
            togglePinBtn.classList.add('active-toggle');
            togglePinBtn.title = 'Unpin UI (allows dragging)';
            dragHandle.style.cursor = 'default';
        } else {
            controllerHost.classList.remove('pinned');
            togglePinBtn.classList.remove('active-toggle');
            togglePinBtn.title = 'Pin UI (locks at current position)';
            dragHandle.style.cursor = 'grab';
        }
        if (saveState) {
            chrome.runtime.sendMessage({ action: 'set_ui_preferences', preferences: { pinned: shouldBePinned } });
        }
    }

    /**
     * Finds all interactive UI elements and attaches their corresponding event listeners.
     */
    function bindEventListeners() {
        // --- Minimize Button ---
        shadowRoot.getElementById('btn-toggle-minimize').addEventListener('click', () => {
            controllerHost.style.display = 'none';
            // Tell the background script we are now minimized.
            chrome.runtime.sendMessage({ action: 'set_ui_minimized_state', minimized: true });
        });

        const logContainer = shadowRoot.getElementById('log-container');
        const toggleLogBtn = shadowRoot.getElementById('btn-toggle-log');
        const dragHandle = shadowRoot.getElementById('status-banner');

        function clearLog() {
            // addLogEntry will clear the log and handle the placeholder
            addLogEntry({ text: '[Content]: Log cleared.', type: 'info' }, true);
        }
        const folderSelect = shadowRoot.getElementById('folder-select');
        const compactFolderSelect = shadowRoot.getElementById('compact-folder-select');

        function getCurrentFolderId() {
        return currentUiMode === 'full' ? folderSelect.value : compactFolderSelect.value;
        }

        // --- Refactored Event Handlers to reduce duplication ---
        const handleAddClick = async () => {
            const folderId = getCurrentFolderId();
            // The detectedUrl is now correctly set for both M3U8 streams and YouTube pages
            // by the handlePageUpdate and message listener functions.
            const urlToAdd = detectedUrl; // Use the globally tracked URL for this tab.

            if (!urlToAdd) {
                // If no specific stream or valid page was found, inform the user and do nothing.
                addLogEntry({ text: `[Content]: No stream/video detected to add.`, type: 'error' });
                return; // Stop execution here.
            }

            try {
                const currentPlaylist = await getPlaylistFromBackground(folderId);
                const isDuplicate = currentPlaylist.includes(urlToAdd);

                if (isDuplicate) {
                    const confirmed = await showConfirmationModal('This URL is already in the playlist. Are you sure you want to add it again?');
                    if (!confirmed) {
                        addLogEntry({ text: `[Content]: Add action cancelled by user.`, type: 'info' });
                        return; // User cancelled the action.
                    }
                }
                // If not a duplicate, or if user confirmed, proceed.
                sendCommandToBackground('add', folderId); // Background will get the URL from its state
            } catch (error) {
                addLogEntry({ text: `[Content]: Error checking for duplicates: ${error.message}`, type: 'error' });
            }
        };
        const handlePlayClick = () => sendCommandToBackground('play', getCurrentFolderId());
        const handleClearClick = () => sendCommandToBackground('clear', getCurrentFolderId());
        const handleCloseMpvClick = async () => {
            const isRunning = await isMpvRunningFromBackground();
            if (!isRunning) {
                addLogEntry({ text: `[Content]: Close command ignored, MPV is not running.`, type: 'info' });
                return;
            }

            const confirmed = await showConfirmationModal('Are you sure you want to close MPV?');
            if (!confirmed) {
                addLogEntry({ text: `[Content]: Close MPV action cancelled by user.`, type: 'info' });
                return;
            }

            sendCommandToBackground('close_mpv', getCurrentFolderId());
        };

        // Assigning handlers to both full and compact UI buttons
        shadowRoot.getElementById('btn-add').addEventListener('click', handleAddClick);
        shadowRoot.getElementById('btn-compact-add').addEventListener('click', handleAddClick);
        shadowRoot.getElementById('btn-play').addEventListener('click', handlePlayClick);
        shadowRoot.getElementById('btn-compact-play').addEventListener('click', handlePlayClick);
        shadowRoot.getElementById('btn-clear').addEventListener('click', handleClearClick);
        shadowRoot.getElementById('btn-compact-clear').addEventListener('click', handleClearClick);
        shadowRoot.getElementById('btn-close-mpv').addEventListener('click', handleCloseMpvClick);
        shadowRoot.getElementById('btn-compact-close-mpv').addEventListener('click', handleCloseMpvClick);

        // --- Event Delegation for Removing Playlist Items ---
        const playlistContainer = shadowRoot.getElementById('playlist-container');

        const handleRemoveItemClick = (e) => {
            if (e.target.classList.contains('btn-remove-item')) {
                const index = parseInt(e.target.dataset.index, 10);
                const folderId = getCurrentFolderId();
                if (!isNaN(index)) {
                    // The payload must match what background.js expects: { data: { index: ... } }
                    sendCommandToBackground('remove_item', folderId, { data: { index } });
                }
            }
        };

        playlistContainer.addEventListener('click', handleRemoveItemClick);

        // This function ensures both dropdowns are always in sync
        function handleFolderChange(newFolderId) {
            folderSelect.value = newFolderId;
            compactFolderSelect.value = newFolderId;
            // Save the last used folder in secure extension storage, not page-accessible localStorage
            chrome.runtime.sendMessage({ action: 'set_last_folder_id', folderId: newFolderId });
            refreshPlaylist();
        }

        folderSelect.addEventListener('change', () => handleFolderChange(folderSelect.value));
        compactFolderSelect.addEventListener('change', () => handleFolderChange(compactFolderSelect.value));

        const fullUiContainer = shadowRoot.getElementById('full-ui-container');
        const compactUiContainer = shadowRoot.getElementById('compact-ui-container');
        const toggleFullBtn = shadowRoot.getElementById('btn-toggle-full');
        const toggleCompactBtn = shadowRoot.getElementById('btn-toggle-compact');

        toggleLogBtn.addEventListener('click', () => {
        const isCurrentlyVisible = !logContainer.classList.contains('log-hidden');
        setLogVisibility(!isCurrentlyVisible);
        });
        const clearLogBtn = shadowRoot.getElementById('btn-clear-log');
        clearLogBtn.addEventListener('click', clearLog);
        const togglePinBtn = shadowRoot.getElementById('btn-toggle-pin');
        togglePinBtn.addEventListener('click', () => setPinState(!isPinned));
        toggleFullBtn.addEventListener('click', () => switchUi('full'));
        toggleCompactBtn.addEventListener('click', () => switchUi('compact'));

        // Draggable functionality
        let isDragging = false;
        let offsetX, offsetY;

        dragHandle.addEventListener('mousedown', (e) => {
            if (isPinned) return; // Do not allow dragging if pinned
            e.preventDefault(); // Prevent text selection during drag
            isDragging = true;
            document.body.classList.add('mpv-controller-dragging');
        // Calculate the initial offset of the mouse from the host element's top-left corner
        offsetX = e.clientX - controllerHost.offsetLeft;
        offsetY = e.clientY - controllerHost.offsetTop;
        controllerHost.style.transition = 'none'; // Disable transition during drag
        });

        document.addEventListener('mousemove', (e) => {
        if (!isDragging || isPinned) return;

        // Update the position of the controller
        const newLeft = e.clientX - offsetX;
        const newTop = e.clientY - offsetY;

        // Ensure the controller stays within the viewport boundaries
        const maxX = window.innerWidth - controllerHost.offsetWidth;
        const maxY = window.innerHeight - controllerHost.offsetHeight;

        controllerHost.style.left = `${Math.min(maxX, Math.max(0, newLeft))}px`;
        controllerHost.style.top = `${Math.min(maxY, Math.max(0, newTop))}px`;
        controllerHost.style.right = 'auto';
        controllerHost.style.bottom = 'auto';
        });

        document.addEventListener('mouseup', () => {
        if (!isDragging) return; // Only act if a drag was in progress
        isDragging = false;
        document.body.classList.remove('mpv-controller-dragging');
        controllerHost.style.transition = ''; // Re-enable transition for smooth placement
        // Save the current position to global storage
        const newPosition = {
            left: controllerHost.style.left,
            top: controllerHost.style.top,
            right: controllerHost.style.right,
            bottom: controllerHost.style.bottom
        };
        chrome.runtime.sendMessage({ action: 'set_ui_preferences', preferences: { position: newPosition } });
    });

        // Debounced function to handle repositioning on window resize
        const debouncedReposition = debounce(() => {
            if (!controllerHost) return;

            const maxX = window.innerWidth - controllerHost.offsetWidth;
            const maxY = window.innerHeight - controllerHost.offsetHeight;

            const currentLeft = controllerHost.offsetLeft;
            const currentTop = controllerHost.offsetTop;

            const newLeft = Math.min(maxX, Math.max(0, currentLeft));
            const newTop = Math.min(maxY, Math.max(0, currentTop));

            if (newLeft !== currentLeft || newTop !== currentTop) {
                controllerHost.style.left = `${newLeft}px`;
                controllerHost.style.top = `${newTop}px`;
                const newPosition = {
                    left: controllerHost.style.left,
                    top: controllerHost.style.top,
                    right: controllerHost.style.right,
                    bottom: controllerHost.style.bottom
                };
                // Only update position, don't overwrite other preferences
                chrome.runtime.sendMessage({ action: 'set_ui_preferences', preferences: { position: newPosition } });
            }
        }, 250); // 250ms debounce delay

        window.addEventListener('resize', debouncedReposition);

        // Return an object containing functions that might be needed externally (by applyInitialState)
        return;
    }

    /**
     * Loads saved state from localStorage and applies it to the UI.
     */
    async function applyInitialState() {
        const response = await chrome.runtime.sendMessage({ action: 'get_ui_preferences' });
        if (response?.success && response.preferences) {
            const prefs = response.preferences;

            // Apply UI mode, log visibility, and pin state
            switchUi(prefs.mode || 'full', false);
            // Apply state without re-saving it.
            setLogVisibility(prefs.logVisible === null ? true : prefs.logVisible, false);
            setPinState(prefs.pinned === null ? false : prefs.pinned, false);

            // Apply position
            if (prefs.position) {
                controllerHost.style.left = prefs.position.left;
                controllerHost.style.top = prefs.position.top;
                controllerHost.style.right = prefs.position.right;
                controllerHost.style.bottom = prefs.position.bottom;
            }
        } else {
            // Fallback to defaults if message fails
            switchUi('full', false);
            setLogVisibility(true, false);
            setPinState(false, false);
        }
    }

    // --- Main Initialization Orchestrator ---
    async function initializeMpvController() {
        if (document.getElementById('m3u8-controller-host')) return;
        await createAndInjectUi();
        bindEventListeners();
        await applyInitialState(); // Apply position, UI mode, etc.
        await updateFolderDropdowns(); // This will fetch folders, populate dropdowns, and call refreshPlaylist
        // After everything is ready, notify the background script to check if we should be visible.
        chrome.runtime.sendMessage({ action: 'content_script_init' });
        console.log("MPV Controller content script initialized and ready.");

        // After initializing, check if we are in fullscreen mode and hide the UI if so.
        // This handles cases where the UI is re-injected on a page that is already fullscreen.
        if (document.fullscreenElement && controllerHost) {
            controllerHost.style.display = 'none';
        }
    }

    // --- Global UI Update Functions ---
    // These functions are called by the message listener and find the UI elements each time.
    // This makes them resilient to the UI being destroyed and recreated.

    function updateStatusBanner(text) {
        const statusBanner = shadowRoot?.getElementById('status-banner');
        const streamStatus = shadowRoot?.getElementById('stream-status');
        if (!statusBanner || !streamStatus) return; // UI not present, do nothing.

        streamStatus.textContent = text;
        if (text.includes("detected")) {
            statusBanner.classList.add("detected");
        } else {
            statusBanner.classList.remove("detected");
        }
    }

    function addLogEntry(logObject, clear = false) {
        const logContainer = shadowRoot?.getElementById('log-container');
        if (!logContainer) return; // UI not present, do nothing.

        if (clear) {
            while (logContainer.firstChild) {
                logContainer.removeChild(logContainer.firstChild);
            }
        }
        const placeholder = shadowRoot.getElementById('log-placeholder');
        if (placeholder) placeholder.remove();

        const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

        const logEntry = document.createElement('div');
        logEntry.className = 'log-item';
        if (logObject.type === 'error') logEntry.classList.add('log-item-error');

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

    async function updateFolderDropdowns() {
        chrome.runtime.sendMessage({ action: 'get_all_folder_ids' }, (response) => {
            if (!response?.success) {
                if (response) addLogEntry({ text: `[Content]: Failed to get folder list: ${response.error}`, type: 'error' });
                return;
            }

            const fullSelect = shadowRoot?.getElementById('folder-select');
            const compactSelect = shadowRoot?.getElementById('compact-folder-select');
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
                refreshPlaylist();
            });
        });
    }

    function refreshPlaylist() {
        // The folder dropdowns are always kept in sync, so we can reliably get the
        // current folder ID from the main dropdown without checking the UI mode.
        const folderSelect = shadowRoot?.getElementById('folder-select');
        if (!folderSelect || !folderSelect.value) {
            return; // UI not ready or no folder selected.
        }
        const currentFolderId = folderSelect.value;
        sendCommandToBackground('get_playlist', currentFolderId);
    }

    function renderPlaylist(playlist) {
        const fullContainer = shadowRoot?.getElementById('playlist-container');
        const itemCountSpan = shadowRoot?.getElementById('compact-item-count');

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
    async function isMpvRunningFromBackground() {
        return new Promise((resolve) => {
            chrome.runtime.sendMessage({ action: 'is_mpv_running' }, (response) => {
                if (chrome.runtime.lastError) {
                    addLogEntry({ text: `[Content]: Error checking MPV status: ${chrome.runtime.lastError.message}`, type: 'error' });
                    return resolve(false);
                }
                if (response?.success) {
                    resolve(response.is_running);
                } else {
                    addLogEntry({ text: `[Content]: Failed to get MPV status: ${response?.error || 'Unknown error'}`, type: 'error' });
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
    async function getPlaylistFromBackground(folderId) {
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
    function sendCommandToBackground(action, folderId, data = {}) {
        const payload = { action, folderId, ...data };

        chrome.runtime.sendMessage(payload, (response) => {
            if (chrome.runtime.lastError) {
                addLogEntry({ text: `[Content]: Error sending '${action}': ${chrome.runtime.lastError.message}`, type: 'error' });
                return;
            }

            if (response) {
                // The 'get_playlist' command is the only one that returns a list to render.
                if (action === 'get_playlist' && response.success) {
                    renderPlaylist(response.list);
                }
                // Log success/info messages from the background script.
                if (response.message && action !== 'get_playlist') {
                    addLogEntry({ text: `[Background]: ${response.message}`, type: 'info' });
                }
                // Also log any error messages from the background script.
                if (response.error) {
                    addLogEntry({ text: `[Background]: ${response.error}`, type: 'error' });
                }
            }
        });
    }
    // --- Robustness for Single-Page Applications (like YouTube) ---

    // Debounce function to prevent re-initialization from firing too rapidly
    // during the "mutation storm" of a site like YouTube changing pages.
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

    // This function handles all updates needed after a potential page navigation on an SPA.
    const handlePageUpdate = debounce(() => {
        // First, ensure the controller is still on the page. If not, re-inject it.
        if (!document.getElementById('m3u8-controller-host')) {
            console.log("MPV Controller not found after DOM mutation, re-injecting.");
            initializeMpvController();
            return; // The initialization will handle the rest.
        }

        // Check if the URL has changed, which indicates a navigation event.
        if (window.location.href !== lastUrl) {
            lastUrl = window.location.href;
            detectedUrl = null; // Reset the detected URL.
            chrome.runtime.sendMessage({ action: 'report_detected_url', url: null });
            updateStatusBanner('No stream detected'); // Reset banner to default.
        }

        // Now, check for special cases like YouTube video pages.
        const isYouTubeVideo = window.location.href.includes('youtube.com/watch?v=') || window.location.href.includes('youtu.be/');
        if (isYouTubeVideo && !detectedUrl) {
            detectedUrl = window.location.href;
            chrome.runtime.sendMessage({ action: 'report_detected_url', url: detectedUrl });
            updateStatusBanner('YouTube video detected');
        }

        // If an M3U8 stream hasn't been detected, but we're on a YouTube page,
        // treat the page URL as the "detected" URL and update the banner.
        if (isYouTubeVideo && !detectedUrl) {
            detectedUrl = window.location.href;
            updateStatusBanner('YouTube video detected');
        }
    }, 250); // Reduced delay for faster detection on SPAs.

    /**
     * Main entry point. Initializes the UI and sets up the observer to handle
     * dynamic page changes (like on YouTube).
     */
    async function main() {
        // Initial injection.
        await initializeMpvController();

        // --- Fullscreen Change Handler ---
        // This will hide the controller when a video goes fullscreen and show it again when it exits.
        document.addEventListener('fullscreenchange', () => {
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
        });

        // --- Primary re-injection mechanism: MutationObserver ---
        // This is fast and efficient for reacting to DOM changes on SPAs like YouTube.
        const observer = new MutationObserver(handlePageUpdate);
        observer.observe(document.documentElement, { childList: true, subtree: true });

        // --- Fallback re-injection mechanism: Interval Check ---
        // This is a robust fallback for cases where the MutationObserver might fail
        // or on sites with very unusual DOM manipulation patterns. It ensures that
        // if the controller is ever removed, it will be restored.
        // This check is NOT debounced, making it a more reliable final check.
        setInterval(() => {
            if (!document.getElementById('m3u8-controller-host')) {
                console.log("MPV Controller not found during interval check, re-injecting.");
                initializeMpvController();
            }
        }, 2000); // Check every 2 seconds.
    }

    // Wait for the DOM to be fully loaded before trying to inject the UI.
    // This prevents errors on pages that are slow to load.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', main);
    } else {
        main(); // The DOM is already ready.
    }
})();
