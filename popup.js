document.addEventListener('DOMContentLoaded', async () => {
    try { // This line is intentionally kept for the diff

    // IMPORTANT: You must include settings.js in your popup.html before this script, like so:
    // <script src="settings.js"></script>

    /**
     * Smoothly scrolls the window to a target vertical position with a custom animation.
     * @param {number} to - The target Y position to scroll to.
     * @param {number} duration - The duration of the scroll in milliseconds.
     */
    function smoothScrollTo(to, duration) {
        const start = window.scrollY;
        const change = to - start;
        let startTime = null;

        // Easing function: easeInOutQuad for a gentle acceleration and deceleration.
        const easeInOutQuad = (t, b, c, d) => {
            t /= d / 2;
            if (t < 1) return c / 2 * t * t + b;
            t--;
            return -c / 2 * (t * (t - 2) - 1) + b;
        };

        const animateScroll = (currentTime) => {
            if (startTime === null) startTime = currentTime;
            const timeElapsed = currentTime - startTime;
            const run = easeInOutQuad(timeElapsed, start, change, duration);
            window.scrollTo(0, run);
            if (timeElapsed < duration) {
                requestAnimationFrame(animateScroll);
            }
        };
        requestAnimationFrame(animateScroll);
    }

    // --- Element Definitions ---
    const sharedAnilistSection = document.getElementById('shared-anilist-section');

    // This needs to be defined before UIModeManager which uses it.
    const statusMessageElement = document.getElementById('status-message');

    /**
     * Displays a message to the user and fades it out.
     * @param {string} text - The message to display.
     * @param {boolean} isError - If true, styles the message as an error.
     */
    function showStatus(text, isError = false) {
        statusMessageElement.textContent = text;
        statusMessageElement.style.color = isError ? 'var(--accent-danger)' : 'var(--accent-positive)';
        setTimeout(() => {
            statusMessageElement.textContent = '';
        }, 3000);
    }

    // --- UI Mode Manager ---
    // This class centralizes the logic for handling the two different UI views (mini and full).
    class UIModeManager {
        constructor() {
            this.views = {
                mini: document.getElementById('mini-controller-view'),
                full: document.getElementById('folder-management-view')
            };
            this.activeMode = null;

            // Placeholders for shared content
            this.placeholders = {
                settings: {
                    mini: document.getElementById('mini-settings-placeholder'),
                    full: document.getElementById('full-settings-placeholder')
                },
                anilist: {
                    mini: document.getElementById('mini-anilist-placeholder'),
                    full: document.getElementById('full-anilist-placeholder')
                },
                status: {
                    mini: document.getElementById('mini-status-placeholder'),
                    full: document.getElementById('full-status-placeholder')
                }
            };

            // Shared content elements
            this.sharedElements = {
                settings: document.getElementById('shared-settings-container'),
                anilist: sharedAnilistSection,
                status: statusMessageElement
            };
        }

        /**
         * Sets the active UI mode and moves shared elements to the correct view.
         * @param {'mini' | 'full'} mode The mode to activate.
         */
        setMode(mode) {
            if (mode !== 'mini' && mode !== 'full') return;

            this.activeMode = mode;
            this.views.mini.style.display = mode === 'mini' ? 'flex' : 'none';
            this.views.full.style.display = mode === 'full' ? 'block' : 'none';

            // Move shared elements into the active view's placeholder
            this.placeholders.settings[mode].appendChild(this.sharedElements.settings);
            this.placeholders.anilist[mode].appendChild(this.sharedElements.anilist);
            this.placeholders.status[mode].appendChild(this.sharedElements.status);

            this.sharedElements.settings.style.display = 'block';
        }

        isMiniView() {
            return this.activeMode === 'mini';
        }

        /**
         * Determines the initial UI mode based on tab state and user preferences,
         * then activates it.
         * @param {boolean} isHttp - Whether the current tab is on an HTTP/S page.
         * @param {object} uiState - The saved UI state for the current tab.
         * @param {object} prefs - The user's global preferences.
         */
        determineAndSetInitialMode(isHttp, uiState, prefs) {
            let showMiniView = false;
            if (isHttp) {
                showMiniView = uiState?.minimized ?? (prefs?.mode === 'minimized');
            } else {
                // On restricted pages (like brave://), use the global preference.
                // This allows users to access playback controls via the mini-popup
                // even when the on-page controller cannot be injected.
                showMiniView = (prefs?.mode === 'minimized');
            }
            this.setMode(showMiniView ? 'mini' : 'full');
        }

        // --- Getters for Active Elements ---
        // These getters return the element from the currently active view, simplifying event handlers.
        get folderSelect() {
            return this.isMiniView() ?
                document.getElementById('mini-folder-select') :
                document.getElementById('remove-folder-select');
        }

        get newFolderNameInput() {
            return this.isMiniView() ?
                document.getElementById('mini-new-folder-name') :
                document.getElementById('new-folder-name');
        }

        get reorderContainer() {
            return this.isMiniView() ?
                document.getElementById('mini-reorder-container') :
                document.getElementById('reorder-container');
        }

        get reorderToggleBtn() {
            return this.isMiniView() ?
                document.getElementById('btn-mini-toggle-reorder') :
                document.getElementById('btn-toggle-reorder');
        }
    }

    const uiManager = new UIModeManager();

    // Views
    const miniControllerView = document.getElementById('mini-controller-view');
    const folderManagementView = document.getElementById('folder-management-view');

    // Folder Management View Elements
    const newFolderNameInput = document.getElementById('new-folder-name');
    const createFolderBtn = document.getElementById('btn-create-folder');
    const removeFolderSelect = document.getElementById('remove-folder-select');
    const renameFolderBtn = document.getElementById('btn-rename-folder');
    const removeFolderBtn = document.getElementById('btn-remove-folder');
    const customGeometryContainer = document.getElementById('custom-geometry-container');
    const customWidthInput = document.getElementById('custom-width');

    // Mini Controller View Elements
    const miniFolderSelect = document.getElementById('mini-folder-select');
    const miniAddBtn = document.getElementById('btn-mini-add');
    const miniPlayBtn = document.getElementById('btn-mini-play');
    const miniClearBtn = document.getElementById('btn-mini-clear');
    const miniCloseMpvBtn = document.getElementById('btn-mini-close-mpv');
    const showOnPageControllerBtn = document.getElementById('btn-show-on-page-controller');
    const miniManageFoldersBtn = document.getElementById('btn-mini-manage-folders');
    const hideOnPageControllerBtn = document.getElementById('btn-hide-on-page-controller');
    const miniFolderManagementControls = document.getElementById('mini-folder-management-controls');
    const btnMiniToggleSettings = document.getElementById('btn-mini-toggle-settings');
    const miniSettingsControls = document.getElementById('mini-settings-controls');
    const btnMiniToggleStub = document.getElementById('btn-mini-toggle-stub');
    const miniNewFolderNameInput = document.getElementById('mini-new-folder-name');
    const miniCreateFolderBtn = document.getElementById('btn-mini-create-folder');
    const miniRenameFolderBtn = document.getElementById('btn-mini-rename-folder');
    const miniRemoveFolderBtn = document.getElementById('btn-mini-remove-folder');
    const miniItemCountSpan = document.getElementById('mini-item-count');

    // Playlist Elements
    const playlistContainer = document.getElementById('popup-playlist-container');

    // Export/Import Elements
    const exportDataBtn = document.getElementById('btn-export-data');
    const exportAllDataBtn = document.getElementById('btn-export-all');
    const importDataBtn = document.getElementById('btn-import-data');
    const openExportFolderBtn = document.getElementById('btn-open-export-folder');
    const miniExportDataBtn = document.getElementById('btn-mini-export-data');
    const miniExportAllDataBtn = document.getElementById('btn-mini-export-all');
    const miniImportDataBtn = document.getElementById('btn-mini-import-data');
    const miniOpenExportFolderBtn = document.getElementById('btn-mini-open-export-folder');
    const importSelectionModal = document.getElementById('import-selection-modal');
    const importFileSelect = document.getElementById('import-file-select');
    const importConfirmBtn = document.getElementById('import-confirm-btn');
    const importCancelBtn = document.getElementById('import-cancel-btn');
    const exportFilenameModal = document.getElementById('export-filename-modal');
    const exportFilenameInput = document.getElementById('export-filename-input');
    const exportSaveBtn = document.getElementById('export-save-btn');
    const exportCancelBtn = document.getElementById('export-cancel-btn');
    const renameFolderModal = document.getElementById('rename-folder-modal');
    const renameFolderInput = document.getElementById('rename-folder-input');
    const renameSaveBtn = document.getElementById('rename-save-btn');
    const renameCancelBtn = document.getElementById('rename-cancel-btn');


    let folderToRename = null;
    let currentDetectedUrl = null;

    // Reorder Elements
    const reorderContainer = document.getElementById('reorder-container');
    const miniReorderContainer = document.getElementById('mini-reorder-container');
    const toggleReorderBtn = document.getElementById('btn-toggle-reorder');
    const miniToggleReorderBtn = document.getElementById('btn-mini-toggle-reorder');

    // Reorder State
    let isReorderModeActive = false;
    let draggedItem = null;
    const statusMessage = document.getElementById('status-message');

    // --- UI Helper Functions ---

    /**
     * Displays a custom confirmation modal inside the popup.
     * @param {string} message The message to display in the modal.
     * @returns {Promise<boolean>} A promise that resolves to true if confirmed, false if cancelled.
     */
    function showPopupConfirmation(message) {
        return new Promise((resolve) => {
            const modal = document.getElementById('popup-confirmation-modal');
            const messageEl = document.getElementById('popup-modal-message');
            const confirmBtn = document.getElementById('popup-modal-confirm-btn');
            const cancelBtn = document.getElementById('popup-modal-cancel-btn');

            if (!modal || !messageEl || !confirmBtn || !cancelBtn) {
                // Fallback to browser confirm if the modal elements are not found
                resolve(confirm(message));
                return;
            }

            messageEl.textContent = message;
            modal.style.display = 'flex';

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
                modal.style.display = 'none';
                // Remove listeners to prevent memory leaks
                confirmBtn.onclick = null;
                cancelBtn.onclick = null;
                window.removeEventListener('keydown', handleKeyDown, true);
                resolve(result);
            };

            // Assign new click handlers
            confirmBtn.onclick = () => close(true);
            cancelBtn.onclick = () => close(false);

            // Add keydown listener to the window, using capture to get it before other listeners.
            window.addEventListener('keydown', handleKeyDown, true);
            confirmBtn.focus(); // Set focus to the confirm button
        });
    }

    /**
     * Fetches all folder IDs and populates all folder dropdowns in the popup.
     */
    function populateFolderDropdowns() {
        sendMessageAsync({ action: 'get_all_folder_ids' }).then(response => {
            if (!response?.success) return;

            // Clear existing options
            removeFolderSelect.innerHTML = '<option value="">Select folder to remove...</option>';
            miniFolderSelect.innerHTML = '';

            response.folderIds.forEach((id, index) => {
                const option = document.createElement('option');
                option.value = id;
                option.textContent = `${index + 1}. ${id}`;
                removeFolderSelect.appendChild(option.cloneNode(true));
                miniFolderSelect.appendChild(option);
            });

            if (response.lastUsedFolderId && response.folderIds.includes(response.lastUsedFolderId)) {
                miniFolderSelect.value = response.lastUsedFolderId;
                removeFolderSelect.value = response.lastUsedFolderId;
            }

            updateRemoveButtonState();
            refreshPlaylist(); // Now fetches the full playlist
        }).catch(e => {
            console.error("Failed to populate folder dropdowns:", e);
            showStatus("Connection to background script lost.", true);
        });
    }

    /**
     * Handles the logic for creating a new folder.
     */
    function handleCreateFolder() {
        const inputElement = uiManager.newFolderNameInput;
        const newName = inputElement.value.trim();
        if (!newName) {
            showStatus('Folder name cannot be empty.', true);
            return;
        }

        // Add validation for folder name characters by disallowing invalid filename chars.
        const invalidCharsRegex = /[\\/:*?"<>|]/;
        if (invalidCharsRegex.test(newName)) {
            showStatus('Folder name cannot contain / \ : * ? " < > |', true);
            return;
        }

        sendMessageAsync({ action: 'create_folder', folderId: newName }).then(response => {
            if (response.success) {
                showStatus(`Folder "${newName}" created!`);
                inputElement.value = '';
                populateFolderDropdowns();
            } else {
                showStatus(response.error || 'An unknown error occurred.', true);
            }
        }).catch(e => {
            showStatus("Failed to create folder: " + e.message, true);
        });
    }

    /**
     * Handles the logic for removing a folder after confirmation.
     * @param {string} folderId The ID of the folder to remove.
     */
    async function handleRemoveFolder(folderId) {
        if (!folderId) {
            return showStatus('No folder selected to remove.', true);
        }

        try {
            const prefsResponse = await sendMessageAsync({ action: 'get_ui_preferences' });
            const prefs = prefsResponse?.preferences;
            if (prefs?.preferences?.confirm_remove_folder ?? true) {
                const confirmed = await showPopupConfirmation(`Are you sure you want to remove the folder "${folderId}"? This action cannot be undone.`);
                if (!confirmed) return;
            }

            const response = await sendMessageAsync({ action: 'remove_folder', folderId: folderId });
            if (response.success) {
                showStatus(`Folder "${folderId}" removed.`);
                populateFolderDropdowns();
            } else {
                showStatus(response.error || 'An unknown error occurred.', true);
            }
        } catch (e) {
            showStatus("Failed to remove folder: " + e.message, true);
        }
    }

    function handleRenameFolder() {
        const selectedFolder = uiManager.folderSelect.value;

        if (!selectedFolder) {
            return showStatus('No folder selected to rename.', true);
        }

        folderToRename = selectedFolder;
        renameFolderInput.value = selectedFolder;
        renameFolderModal.style.display = 'flex';
        renameFolderInput.focus();
        renameFolderInput.select();
    }

    async function saveRename() {
        const oldFolderId = folderToRename;
        const newFolderId = renameFolderInput.value.trim();

        if (!newFolderId) {
            return showStatus('New folder name cannot be empty.', true);
        }
        if (oldFolderId === newFolderId) {
            renameFolderModal.style.display = 'none';
            return; // No change
        }

        // Add validation for folder name characters by disallowing invalid filename chars.
        const invalidCharsRegex = /[\\/:*?"<>|]/;
        if (invalidCharsRegex.test(newFolderId)) {
            showStatus('New folder name cannot contain / \ : * ? " < > |', true);
            return;
        }

        try {
            const response = await sendMessageAsync({ action: 'rename_folder', oldFolderId, newFolderId });

            if (response.success) {
                showStatus(response.message);
                populateFolderDropdowns();
            } else {
                showStatus(response.error || 'Failed to rename folder.', true);
            }
        } catch (e) {
            showStatus("Failed to rename folder: " + e.message, true);
        }

        renameFolderModal.style.display = 'none';
        folderToRename = null;
    }

    /**
     * Enables or disables the remove button based on selection.
     */
    function updateRemoveButtonState() {
        const hasSelection = !!removeFolderSelect.value;
        removeFolderBtn.disabled = !hasSelection;
        renameFolderBtn.disabled = !hasSelection;
    }

    /**
     * Fetches the playlist for a given folder and renders it.
     */
    async function refreshPlaylist() {
        const folderId = miniFolderSelect.value;
        if (!folderId) return;

        try {
            const response = await sendMessageAsync({ action: 'get_playlist', folderId });
            if (response?.success) {
                renderPlaylist(response.list, response.last_played_id, response.isFolderActive);
            }
        } catch (e) {
            console.error("Failed to refresh playlist:", e);
        }
    }

    /**
     * Renders the items of the currently selected folder into the playlist container.
     * @param {Array} playlist - The array of URL items to render.
     * @param {string} lastPlayedId - The ID of the item that was last played in this folder.
     * @param {boolean} isFolderActive - Whether this folder is currently being played in MPV.
     */
    async function renderPlaylist(playlist, lastPlayedId, isFolderActive = false) {
        const oldItemCount = playlistContainer.querySelectorAll('.list-item').length;
        const scrollPosition = playlistContainer.scrollTop;
        playlistContainer.innerHTML = ''; // Clear current content

        if (playlist && playlist.length > 0) {
            const prefsResponse = await sendMessageAsync({ action: 'get_ui_preferences' });
            const highlightEnabled = prefsResponse?.preferences?.enable_active_item_highlight ?? true;
            const showCopyButton = prefsResponse?.preferences?.show_copy_title_button ?? false;

            playlist.forEach((item, index) => {
                const itemDiv = document.createElement('div');
                itemDiv.className = 'list-item';
                
                if (highlightEnabled && lastPlayedId && item.id === lastPlayedId) {
                    if (isFolderActive) {
                        itemDiv.classList.add('active-item');
                    } else {
                        itemDiv.classList.add('last-played-item');
                    }
                }

                itemDiv.draggable = true;
                itemDiv.title = item.url;
                itemDiv.dataset.url = item.url;
                itemDiv.dataset.title = item.title;
                itemDiv.dataset.index = index;
                itemDiv.dataset.id = item.id || ""; // Attach ID to dataset

                const indexSpan = document.createElement('span');
                indexSpan.className = 'url-index';
                indexSpan.textContent = `${index + 1}.`;

                const urlSpan = document.createElement('span');
                urlSpan.className = 'url-text';
                _formatTitle(urlSpan, item); // Use the title formatting function

                const removeBtn = document.createElement('button');
                removeBtn.className = 'btn-remove-item';
                removeBtn.dataset.index = index;
                removeBtn.title = 'Remove Item';
                removeBtn.innerHTML = '&times;';

                itemDiv.append(indexSpan, urlSpan, removeBtn);
                playlistContainer.appendChild(itemDiv);
            });
        } else {
            const placeholder = document.createElement('p');
            placeholder.className = 'playlist-placeholder';
            placeholder.textContent = 'Playlist is empty.';
            playlistContainer.appendChild(placeholder);
        }

        const newItemCount = playlist ? playlist.length : 0;
        const wasItemAdded = newItemCount > oldItemCount;
        const isScrollable = playlistContainer.scrollHeight > playlistContainer.clientHeight;

        if (wasItemAdded && isScrollable) {
            // If a new item was added and the list is scrollable, scroll to the bottom.
            playlistContainer.scrollTop = playlistContainer.scrollHeight;
        } else if (isFolderActive && lastPlayedId) {
            // If the folder is active, find the active item and scroll it into view (centered).
            const activeItem = playlistContainer.querySelector('.active-item');
            if (activeItem) {
                activeItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
            } else {
                playlistContainer.scrollTop = scrollPosition;
            }
        } else {
            // Otherwise, restore the previous scroll position.
            playlistContainer.scrollTop = scrollPosition;
        }
    }

    /**
     * Formats the title for display, highlighting episode numbers or channel names.
     * @param {HTMLElement} urlSpan The span element to populate.
     * @param {object} item The playlist item containing title and url.
     */
    function _formatTitle(urlSpan, item) {
        const titleParts = item.title.split(' - ');
        const isYouTubeVideoUrl = item.url.includes('youtube.com/watch');
        const isYouTubePlaylistUrl = item.url.includes('youtube.com/playlist');

        if (titleParts.length > 1 && /^(s\d+)?e\d+(\.\d+)?$/i.test(titleParts[0].trim())) {
            const episodePrefixSpan = document.createElement('span');
            episodePrefixSpan.textContent = titleParts.shift() + ' - ';
            const mainTitleSpan = document.createElement('span');
            mainTitleSpan.className = 'main-title-highlight';
            mainTitleSpan.textContent = titleParts.join(' - ');
            urlSpan.append(episodePrefixSpan, mainTitleSpan);
        } else if ((isYouTubeVideoUrl || isYouTubePlaylistUrl) && titleParts.length > 1) {
            const channelPrefixSpan = document.createElement('span');
            channelPrefixSpan.textContent = titleParts.shift() + ' - ';
            const videoTitleSpan = document.createElement('span');
            videoTitleSpan.className = 'main-title-highlight';
            videoTitleSpan.textContent = titleParts.join(' - ');
            urlSpan.append(channelPrefixSpan, videoTitleSpan);
        } else {
            urlSpan.textContent = item.title;
        }
    }



    // --- Event Listeners ---

    showOnPageControllerBtn.addEventListener('click', () => {
        // Send a message to the background script to update the minimized state for the current tab.
        // The background script will then relay this to the correct content script.
        sendMessageAsync({
            action: 'set_minimized_state',
            minimized: false
        }).then(response => {
            if (response?.success) {
                window.close(); // Close the popup on success
            } else {
                // Show an error if the background script couldn't find the tab or another error occurred.
                showStatus(response?.error || 'Could not show controller.', true);
            }
        });
    });

    hideOnPageControllerBtn.addEventListener('click', () => {
        // Send a message to the background script to update the minimized state for the current tab.
        // The background script will then relay this to the correct content script.
        sendMessageAsync({
            action: 'set_minimized_state',
            minimized: true
        }).then(response => {
            if (response?.success) {
                window.close(); // Close the popup on success
            } else {
                // Show an error if the background script couldn't find the tab or another error occurred.
                showStatus(response?.error || 'Could not hide controller.', true);
            }
        });
    });
    // --- Folder Management Event Listeners (Refactored) ---

    // Create Folder
    createFolderBtn.addEventListener('click', handleCreateFolder);
    newFolderNameInput.addEventListener('keydown', (e) => e.key === 'Enter' && createFolderBtn.click());
    miniCreateFolderBtn.addEventListener('click', handleCreateFolder);
    miniNewFolderNameInput.addEventListener('keydown', (e) => e.key === 'Enter' && miniCreateFolderBtn.click());

    // Remove Folder
    removeFolderBtn.addEventListener('click', () => handleRemoveFolder(removeFolderSelect.value));
    miniRemoveFolderBtn.addEventListener('click', () => handleRemoveFolder(miniFolderSelect.value));

    // Rename Folder
    renameFolderBtn.addEventListener('click', handleRenameFolder);
    miniRenameFolderBtn.addEventListener('click', handleRenameFolder);


    // Listeners unique to each view
    removeFolderSelect.addEventListener('change', updateRemoveButtonState);
    miniManageFoldersBtn.addEventListener('click', () => {
        const isVisible = miniFolderManagementControls.style.display === 'block';
        miniFolderManagementControls.style.display = isVisible ? 'none' : 'block';
    });
    btnMiniToggleSettings.addEventListener('click', () => {
        const isVisible = miniSettingsControls.style.display === 'block';
        miniSettingsControls.style.display = isVisible ? 'none' : 'block';
    });
    if (btnMiniToggleStub) {
        btnMiniToggleStub.addEventListener('click', async () => {
            const prefs = await sendMessageAsync({ action: 'get_ui_preferences' });
            const currentVal = prefs?.preferences?.show_minimized_stub ?? true;
            const newVal = !currentVal;
            await sendMessageAsync({ action: 'set_ui_preferences', preferences: { show_minimized_stub: newVal } });
            // UI update will happen via preferences_changed listener
        });
    }

    // --- Reorder Logic ---

    function getActiveReorderControls() {
        if (uiManager.isMiniView()) {
            return {
                elementsToHide: [
                    document.getElementById('mini-folder-select'),
                    document.getElementById('btn-mini-manage-folders'),
                    document.getElementById('mini-item-count-container')
                ]
            };
        }
        // Full view
        return {
            elementsToHide: [
                document.getElementById('remove-folder-select'),
                document.getElementById('rename-remove-controls')
            ]
        };
    }

    async function toggleReorderMode() {
        isReorderModeActive = !isReorderModeActive;
        const { elementsToHide } = getActiveReorderControls();
        const toggleBtn = uiManager.reorderToggleBtn;
        const container = uiManager.reorderContainer;

        toggleBtn.classList.toggle('active', isReorderModeActive);

        if (isReorderModeActive) {
            if (toggleBtn === toggleReorderBtn) { // Main view only
                toggleBtn.textContent = 'Save Order';
            }

            elementsToHide.forEach(el => el.style.display = 'none');
            container.style.display = 'block';
            try {
                const response = await sendMessageAsync({ action: 'get_all_folder_ids' });
                if (response.success) {
                    renderReorderList(container, response.folderIds);
                }
            } catch (e) {
                showStatus("Failed to load folders for reordering.", true);
            }

        } else {
            const list = container.querySelector('.reorder-list');
            if (list) {
                const newOrder = [...list.children].map(item => item.dataset.folderId);
                try {
                    await sendMessageAsync({ action: 'set_folder_order', order: newOrder });
                    showStatus('Folder order saved.');
                } catch (e) {
                    showStatus("Failed to save folder order.", true);
                }
            }

            if (toggleBtn === toggleReorderBtn) { // Main view only
                toggleBtn.textContent = 'Reorder';
            }

            container.innerHTML = '';
            container.style.display = 'none';
            elementsToHide.forEach(el => el.style.display = '');
            populateFolderDropdowns(); // Refresh dropdowns with new order
        }
    }

    function renderReorderList(container, folderIds) {
        container.innerHTML = ''; // Clear previous list
        const list = document.createElement('ul');
        list.className = 'reorder-list';

        folderIds.forEach(id => {
            const item = document.createElement('li');
            item.className = 'reorder-item';
            item.draggable = true;
            item.dataset.folderId = id;

            const handle = document.createElement('span');
            handle.className = 'drag-handle';
            handle.innerHTML = '&#9776;'; // Hamburger icon

            const text = document.createTextNode(id);

            item.appendChild(handle);
            item.appendChild(text);
            list.appendChild(item);
        });

        addDragDropListeners(list);
        container.appendChild(list);
    }

    function addDragDropListeners(list) {
        list.addEventListener('dragstart', e => {
            draggedItem = e.target;
            setTimeout(() => e.target.classList.add('dragging'), 0);
        });

        list.addEventListener('dragend', () => {
            if (!draggedItem) return;
            draggedItem.classList.remove('dragging');
            draggedItem = null;
        });

        list.addEventListener('dragover', e => {
            e.preventDefault();
            
            const afterElement = getDragAfterElement(list, e.clientY);
            const existingIndicator = list.querySelector('.drag-over');

            if (afterElement) {
                if (existingIndicator && existingIndicator !== afterElement) {
                    existingIndicator.classList.remove('drag-over');
                }
                afterElement.classList.add('drag-over');
            } else {
                if (existingIndicator) {
                     existingIndicator.classList.remove('drag-over');
                }
            }
        });

        list.addEventListener('drop', e => {
            e.preventDefault();
            const dropTarget = list.querySelector('.drag-over');
            if (dropTarget) {
                dropTarget.classList.remove('drag-over');
            }
            if (draggedItem && draggedItem.parentElement === list) {
                list.insertBefore(draggedItem, dropTarget);
            }
        });
    }

    function getDragAfterElement(container, y) {
        const draggableElements = [...container.querySelectorAll('.reorder-item:not(.dragging), .list-item:not(.dragging)')];
        return draggableElements.reduce((closest, child) => {
            const box = child.getBoundingClientRect();
            const offset = y - box.top - box.height / 2;
            if (offset < 0 && offset > closest.offset) {
                return { offset: offset, element: child };
            } else {
                return closest;
            }
        }, { offset: Number.NEGATIVE_INFINITY }).element;
    }

    // --- Export/Import Logic ---

    function handleExport() {
        const folderId = uiManager.folderSelect.value;

        if (!folderId) {
            return showStatus('Please select a folder to export.', true);
        }

        // Suggest a default filename with a timestamp, without the extension.
        const date = new Date();
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');
        const safeFolderId = folderId.replace(/[^a-zA-Z0-9_-]/g, '_');
        const suggestedFilename = `mpv_playlist_${safeFolderId}_${year}${month}${day}_${hours}${minutes}${seconds}`;

        exportFilenameInput.value = suggestedFilename;
        exportFilenameModal.style.display = 'flex';
        exportFilenameInput.focus();
        exportFilenameInput.select();
    }

    exportCancelBtn.addEventListener('click', () => {
        exportFilenameModal.style.display = 'none';
    });

    const handleSaveExport = async () => {
        let filename = exportFilenameInput.value.trim();
        if (!filename) {
            return showStatus('Filename cannot be empty.', true);
        }

        // Basic validation: allow letters, numbers, hyphens, underscores.
        if (!/^[a-zA-Z0-9_.-]+$/.test(filename)) {
            return showStatus('Filename can only contain letters, numbers, hyphens, and underscores.', true);
        }

        const folderId = uiManager.folderSelect.value;

        if (!folderId) {
            return showStatus('Please select a folder to export.', true);
        }

        try {
            const response = await sendMessageAsync({
                action: 'export_folder_playlist',
                filename: filename,
                folderId: folderId
            });
            if (response?.success) {
                showStatus(response.message);
            } else {
                showStatus(response?.error || 'Export failed.', true);
            }
        } catch (e) {
            showStatus("Export failed: " + e.message, true);
        }
        exportFilenameModal.style.display = 'none';
    };
    
    function handleImport() {
        sendMessageAsync({ action: 'list_import_files' }).then(response => {
            if (response?.success) {
                importFileSelect.innerHTML = ''; // Clear old options
                if (response.files.length === 0) {
                    importFileSelect.innerHTML = '<option disabled>No backup files found.</option>';
                    importConfirmBtn.disabled = true;
                } else {
                    response.files.forEach(file => {
                        const option = document.createElement('option');
                        option.value = file;
                        option.textContent = file;
                        importFileSelect.appendChild(option);
                    });
                    importConfirmBtn.disabled = false;
                }
                importSelectionModal.style.display = 'flex';
            } else {
                showStatus(response?.error || 'Could not list import files.', true);
            }
        }).catch(e => {
            showStatus("Failed to list import files: " + e.message, true);
        });
    }

    function handleExportAll() {
        showPopupConfirmation('This will export each playlist into a separate JSON file in the "exported" directory. Continue?')
            .then(confirmed => {
                if (confirmed) {
                    showStatus('Exporting all playlists...');
                    chrome.runtime.sendMessage({ action: 'export_all_playlists_separately' }, (response) => {
                        if (response?.success) {
                            showStatus(response.message);
                        } else {
                            showStatus(response?.error || 'Export all failed.', true);
                        }
                    });
                }
            }).catch(e => {
                showStatus("Export all failed: " + e.message, true);
            });
    }

    function handleOpenExportFolder() {
        showStatus('Requesting to open folder...');
        chrome.runtime.sendMessage({ action: 'open_export_folder' }, (response) => {
            if (response?.success) {
                // The native host handles opening the folder. We can close the popup
                // for a seamless experience.
                window.close();
            } else {
                showStatus(response?.error || 'Could not open folder.', true);
            }
        });
    }

    // Consolidate event listeners for similar actions
    [exportDataBtn, miniExportDataBtn].forEach(btn => btn.addEventListener('click', handleExport));
    [exportAllDataBtn, miniExportAllDataBtn].forEach(btn => btn.addEventListener('click', handleExportAll));
    [openExportFolderBtn, miniOpenExportFolderBtn].forEach(btn => btn.addEventListener('click', handleOpenExportFolder));
    [importDataBtn, miniImportDataBtn].forEach(btn => btn.addEventListener('click', handleImport));

    // Modal specific listeners
    exportSaveBtn.addEventListener('click', handleSaveExport);
    exportFilenameInput.addEventListener('keydown', (e) => e.key === 'Enter' && exportSaveBtn.click());
    renameCancelBtn.addEventListener('click', () => {
        renameFolderModal.style.display = 'none';
        folderToRename = null;
    });
    renameSaveBtn.addEventListener('click', saveRename);
    renameFolderInput.addEventListener('keydown', (e) => e.key === 'Enter' && saveRename());
    importCancelBtn.addEventListener('click', () => { importSelectionModal.style.display = 'none'; });

    // Reorder listeners
    [toggleReorderBtn, miniToggleReorderBtn].forEach(btn => btn.addEventListener('click', toggleReorderMode));

    importCancelBtn.addEventListener('click', () => { importSelectionModal.style.display = 'none'; });
    
    const optionsManager = new OptionsManager({
        sendMessageAsync,
        showStatus,
        fetchAniListReleases
    });

    importConfirmBtn.addEventListener('click', () => {
        const filename = importFileSelect.value;
        if (!filename || importFileSelect.options[importFileSelect.selectedIndex].disabled) return;

        chrome.runtime.sendMessage({ action: 'import_from_file', filename }, (response) => {
            if (response?.success) {
                showStatus(response.message);
                populateFolderDropdowns(); // Refresh folder list to show new/updated folders
            } else {
                showStatus(response?.error || 'Import failed.', true);
            }
        });
        importSelectionModal.style.display = 'none';
    });
    miniFolderSelect.addEventListener('change', async () => {
        const newFolderId = miniFolderSelect.value;
        refreshPlaylist();
        try {
            await sendMessageAsync({ action: 'set_last_folder_id', folderId: newFolderId });
        } catch (e) {
            console.error("Failed to set last folder ID:", e);
        }
    });

    // Helper to scrape page details directly from popup
    const getPageDetails = (tabId) => new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, { action: 'scrape_and_get_details' }, (response) => {
            if (chrome.runtime.lastError) return resolve(null);
            resolve(response);
        });
    });

    /**
     * Fetches the native host status from the background script and updates the UI.
     */
    async function updateNativeHostStatusUI() {
        const diagEl = document.querySelector('#diag-native-host-status .dependency-value');
        if (!diagEl) return;

        try {
            const response = await sendMessageAsync({ action: 'get_native_host_status' });
            if (response?.success) {
                const status = response.status || 'unknown';
                diagEl.textContent = status.charAt(0).toUpperCase() + status.slice(1);
                
                if (status === 'online') {
                    diagEl.style.color = 'var(--accent-positive)';
                    if (response.info?.python) {
                        diagEl.title = `Python: ${response.info.python}\nPlatform: ${response.info.platform}`;
                    }
                } else if (status === 'offline') {
                    diagEl.style.color = 'var(--accent-danger)';
                    diagEl.title = 'Native host is not running or not installed.';
                } else {
                    diagEl.style.color = 'var(--text-secondary)';
                }
            }
        } catch (e) {
            diagEl.textContent = 'Error';
            diagEl.style.color = 'var(--accent-danger)';
        }
    }

    // --- Mini Controller Logic (Refactored for Clarity) ---

    async function handleMiniAdd() {
        const folderId = miniFolderSelect.value;
        if (!folderId) return showStatus('Please select a folder.', true);

        try {
            const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            const tabId = activeTab?.id;
            if (!tabId) return showStatus('Could not find an active tab.', true);

            const payload = { action: 'add', folderId, tabId, tab: activeTab };

            // If we have a detected URL, try to construct a payload with it.
            if (currentDetectedUrl) {
                // Try to get a title from the page content script
                const details = await getPageDetails(tabId);
                if (details && details.title) {
                    payload.data = { url: currentDetectedUrl, title: details.title };
                } else {
                    // Fallback: use the URL as the title if content script is unreachable
                    payload.data = { url: currentDetectedUrl, title: currentDetectedUrl };
                }
            }

            // The 'add' action now triggers the scraper in the background script.
            // We just need to provide the folderId and the tabId.
            // We also pass the full tab object so the background script can show a confirmation dialog on that tab if needed.
            const addResponse = await sendMessageAsync(payload);
            if (addResponse.success) {
                if (addResponse.message) showStatus(addResponse.message);
            }
        } catch (error) {
            showStatus(`An error occurred: ${error.message}`, true);
        }
    }

    async function handleMiniCloseMpv() {
        try {
            const [statusResponse, prefsResponse] = await Promise.all([
                sendMessageAsync({ action: 'is_mpv_running' }),
                sendMessageAsync({ action: 'get_ui_preferences' })
            ]);

            if (!statusResponse?.success) return showStatus('Could not check MPV status.', true);
            if (!statusResponse.is_running) return showStatus('MPV is not running.', false);

            if (prefsResponse?.preferences?.confirm_close_mpv ?? true) {
                const confirmed = await showPopupConfirmation('Are you sure you want to close MPV?');
                if (!confirmed) {
                    return showStatus('Close MPV action cancelled.');
                }
            }

            // The background 'close_mpv' action doesn't require folderId or tabId.
            const response = await sendMessageAsync({ action: 'close_mpv' });
            if (response.success) showStatus(response.message);
            else showStatus(response.error, true);
        } catch (error) {
            showStatus(`An error occurred: ${error.message}`, true);
        }
    }

    async function handleMiniSimpleCommand(action) {
        const folderId = miniFolderSelect.value;
        if (!folderId) return showStatus('Please select a folder.', true);

        if (action === 'clear') {
            try {
                const prefs = await sendMessageAsync({ action: 'get_ui_preferences' });
                if (prefs?.preferences?.confirm_clear_playlist ?? true) {
                    const confirmed = await showPopupConfirmation(`Are you sure you want to clear the playlist in "${folderId}"?`);
                    if (!confirmed) {
                        return showStatus('Clear action cancelled.');
                    }
                }
            } catch (e) {
                console.error("Failed to get preferences for clear action:", e);
            }
        }

        try {
            // These actions only need the folderId.
            const response = await sendMessageAsync({ action, folderId });
            if (response.success) {
                if (response.message) showStatus(response.message);
                if (action === 'clear') {
                    // When clearing, also update the item count in the UI.
                    refreshPlaylist();
                }
            } else if (response.error) {
                showStatus(response.error, true);
            }
        } catch (error) {
            showStatus(`An error occurred: ${error.message}`, true);
        }
    }

    async function handlePlaySelectedPlaylist(folderId) {
        if (!folderId) {
            return showStatus('Please select a folder.', true);
        }
        try {
            // Send the 'play_m3u' action with m3u_data type 'folderId'.
            // The background script will then fetch the playlist for this folder and construct the M3U.
            const response = await sendMessageAsync({ 
                action: 'play', // Changed back to 'play'
                folderId: folderId,
                // m3u_data parameter is removed; handlePlay will resolve folderId into M3U content.
            });
            
            if (response.success) {
                showStatus(response.message);
            } else {
                showStatus(response.error || 'Failed to start playback.', true);
            }

        } catch (error) {
            showStatus(`An error occurred while playing playlist: ${error.message}`, true);
        }
    }

    // --- Playlist Event Binding ---
    playlistContainer.addEventListener('click', (e) => {
        const removeBtn = e.target.closest('.btn-remove-item');
        if (removeBtn) {
            const index = parseInt(removeBtn.dataset.index, 10);
            const folderId = miniFolderSelect.value;
            if (!isNaN(index)) {
                 sendMessageAsync({ action: 'remove_item', folderId, data: { index } }).catch(err => {
                     showStatus("Failed to remove item: " + err.message, true);
                 });
            }
        }
    });
    addDragDropListeners(playlistContainer);
    playlistContainer.addEventListener('drop', (e) => {
        e.preventDefault();
        const dropTarget = playlistContainer.querySelector('.drag-over');
        if (dropTarget) {
            dropTarget.classList.remove('drag-over');
        }
        if (draggedItem && draggedItem.parentElement === playlistContainer) {
            const folderId = miniFolderSelect.value;
            if (!folderId) return;

            const newOrder = [...playlistContainer.querySelectorAll('.list-item')].map(item => ({ 
                url: item.dataset.url, 
                title: item.dataset.title,
                id: item.dataset.id 
            }));
            sendMessageAsync({ action: 'set_playlist_order', folderId, data: { order: newOrder } }).catch(err => {
                showStatus("Failed to save playlist order: " + err.message, true);
            });
        }
    });

        miniAddBtn.addEventListener('click', handleMiniAdd);

        miniPlayBtn.addEventListener('click', () => handlePlaySelectedPlaylist(miniFolderSelect.value));

        miniClearBtn.addEventListener('click', () => handleMiniSimpleCommand('clear'));
    miniCloseMpvBtn.addEventListener('click', handleMiniCloseMpv);

    const popupKeybinds = { openPopup: null };

    /**
     * Handles global keyboard shortcuts for the popup.
     * Allows toggling the popup closed with the same keybind used to open it.
     */
    function handleGlobalKeydown(e) {
        if (!popupKeybinds.openPopup) return;
        
        // Ignore if typing in an input
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || e.target.isContentEditable) {
            // Special case: recording a new keybind in OptionsManager. 
            // We shouldn't close the popup if the user is literally setting the shortcut.
            if (e.target.classList.contains('recording-active')) return;
        }

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

        if (combo === normalize(popupKeybinds.openPopup)) {
            e.preventDefault();
            e.stopPropagation();
            window.close();
        }
    }

    // Attach global listener
    window.addEventListener('keydown', handleGlobalKeydown, true);

    // --- Main Initialization ---
    async function initializePopup() {
        try {
            // Update native host status immediately
            updateNativeHostStatusUI();

            // Fetch all necessary data in parallel for faster startup
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
            const activeTab = tabs && tabs.length > 0 ? tabs[0] : null;
            const isHttp = activeTab?.url?.startsWith('http');

            const [uiStateResponse, prefsResponse] = await Promise.all([
                isHttp ? sendMessageAsync({ action: 'get_ui_state_for_tab', tabId: activeTab.id }) : Promise.resolve({ success: false }),
                sendMessageAsync({ action: 'get_ui_preferences' })
            ]);

            const prefs = prefsResponse?.preferences;
            const uiState = uiStateResponse?.state;

            // Store the open-popup keybind for toggle behavior
            if (prefs?.kb_open_popup) {
                popupKeybinds.openPopup = prefs.kb_open_popup;
            }

            // New: Check for a detected URL on initialization and update the button state.
            if (uiState?.detectedUrl) {
                currentDetectedUrl = uiState.detectedUrl;
                miniAddBtn.classList.add('stream-present');
            }

            uiManager.determineAndSetInitialMode(isHttp, uiState, prefs);

            // Populate UI with data
            populateFolderDropdowns();
            if (prefs) {
                optionsManager.updateAllPreferencesUI(prefs);
            }
            
            if (btnMiniToggleStub) {
                const isStubEnabled = prefs?.show_minimized_stub ?? true;
                btnMiniToggleStub.style.opacity = isStubEnabled ? '1' : '0.5';
            }
            updateRemoveButtonState();

            if (uiManager.isMiniView()) {
                refreshPlaylist();
                showOnPageControllerBtn.style.display = isHttp ? 'block' : 'none';
                hideOnPageControllerBtn.style.display = 'none';
                if (miniAddBtn) miniAddBtn.focus();
            } else {
                // Apply focus to the new folder input if the setting is enabled
                if (prefs?.autofocus_new_folder) {
                    newFolderNameInput.focus();
                }
                // Hide the 'hide' button if the full view is active, show it otherwise.
                // Only show if on an HTTP page.
                hideOnPageControllerBtn.style.display = isHttp ? 'block' : 'none';
            }

        } catch (error) {
            // Fallback to the full management view on any error
            uiManager.setMode('full');
            populateFolderDropdowns();
            updateRemoveButtonState();
            showStatus(`Error initializing popup: ${error.message}`, true);
        }
    }

    // --- Popup Lifecycle Port ---
    // This allows the background script to detect if the popup is open
    // and send a message to close it, enabling the "toggle" keybind.
    const lifecyclePort = chrome.runtime.connect({ name: "popup-lifecycle" });
    lifecyclePort.onMessage.addListener((msg) => {
        if (msg.action === 'close_popup') {
            window.close();
        }
    });

    // Close the popup whenever it loses focus. This handles both clicking away
    // within the browser and switching to another application, which is the
    // standard and expected behavior for extension popups.
    window.addEventListener('blur', () => {
        window.close();
    });

    // Add a listener for log messages from the background script.
    // This will only receive messages while the popup is open.
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        // Handle log messages for the status bar
        if (request.log) {
            showStatus(request.log.text, request.log.type === 'error');
        }

        // Handle live playlist updates to keep the item count and playlist view in sync
        if (request.action === 'render_playlist') {
            const isMiniView = miniControllerView.style.display === 'flex';
            const currentFolderId = miniFolderSelect.value;
            if (isMiniView && currentFolderId === request.folderId) {
                renderPlaylist(request.playlist, request.last_played_id, request.isFolderActive);
            }
        }

        // Handle folder data changes (e.g. IDs assigned after playback starts)
        if (request.foldersChanged) {
            populateFolderDropdowns();
            // If we are in the mini view, refresh the playlist to ensure we have the latest IDs
            if (uiManager.isMiniView()) {
                refreshPlaylist();
            }
        }

        // Handle live changes to the detected URL to update the "Add" button's state
        if (request.action === 'detected_url_changed') {
            chrome.tabs.query({ active: true, currentWindow: true }).then(([activeTab]) => {
                // The miniAddBtn is for the mini-controller view.
                // We check if the message is for the currently active tab.
                if (activeTab && activeTab.id === request.tabId && miniAddBtn) {
                    currentDetectedUrl = request.url;
                    miniAddBtn.classList.toggle('stream-present', !!request.url);
                }
            }).catch(e => console.error("Failed to query tabs for detected_url_changed:", e));
        }

        // If preferences changed in another context (e.g., dragging the anilist panel), update our UI.
        if (request.action === 'preferences_changed') {
            sendMessageAsync({ action: 'get_ui_preferences' }).then(response => {
                if (response?.success && response.preferences) optionsManager.updateAllPreferencesUI(response.preferences);
                if (btnMiniToggleStub && response?.preferences) {
                    const isStubEnabled = response.preferences.show_minimized_stub ?? true;
                    btnMiniToggleStub.style.opacity = isStubEnabled ? '1' : '0.5';
                }
            }).catch(e => console.error("Failed to get preferences for preferences_changed:", e));
        }

        // New: Handle confirmation requests from the background script
        if (request.action === 'show_popup_confirmation') {
            // This is an async action, so we must return true.
            (async () => {
                try {
                    const confirmed = await showPopupConfirmation(request.message);
                    sendResponse({ confirmed });
                } catch (e) {
                    sendResponse({ confirmed: false });
                }
            })();
            return true;
        }
    });
    
    // AniList Releases Logic
    const anilistReleasesSection = document.querySelector('.anilist-releases-section');
    const anilistReleasesContent = document.getElementById('anilist-releases-content');
    const refreshAnilistBtn = document.getElementById('btn-refresh-anilist');

    async function fetchAniListReleases(forceRefresh = false) {
        anilistReleasesContent.innerHTML = '<div class="loading-spinner"></div>';
        try {
            const releases = await AniListRenderer.fetchReleases(forceRefresh);
            AniListRenderer.render(anilistReleasesContent, releases);
            // After a refresh, if the section is open, scroll to the bottom to ensure
            // the new content is visible. This fixes the issue in the mini-view.
            if (anilistReleasesSection.open) {
                // Use a short timeout to allow the new content to render first.
                setTimeout(() => smoothScrollTo(document.body.scrollHeight, 400), 50);
            }
        } catch (error) {
            const errorElement = document.createElement('li');
            errorElement.className = 'anilist-error';
            errorElement.textContent = `Error: ${error.message}`;
            anilistReleasesContent.innerHTML = '';
            anilistReleasesContent.appendChild(errorElement);
        }
    }

    refreshAnilistBtn.addEventListener('click', (e) => {
        e.preventDefault(); // Prevent the <details> from toggling
        e.stopPropagation();
        fetchAniListReleases(true); // Force a refresh
    });

    anilistReleasesSection.addEventListener('toggle', (event) => {
        if (event.target.open) {
            // Ensure the note is present and correct when the section is opened.
            let noteElement = anilistReleasesSection.querySelector('.anilist-release-delay-info');
            if (!noteElement) {
                noteElement = document.createElement('p');
                noteElement.className = 'anilist-release-delay-info';
                // Insert it after the summary, before the content div.
                anilistReleasesContent.insertAdjacentElement('beforebegin', noteElement);
            }
            noteElement.textContent = 'Note: There may be a 30 minute to 3 hour delay on release times.';

            fetchAniListReleases();

            // After a short delay to allow the content to render and the popup to resize,
            // scroll the entire window to the bottom to ensure the new content is visible.
            setTimeout(() => {
                smoothScrollTo(document.body.scrollHeight, 400); // Scroll over 400ms
            }, 50);
        }
    });

    // Force Reload Settings Button
    const forceReloadSettingsBtn = document.getElementById('btn-force-reload-settings');
    if (forceReloadSettingsBtn) {
        forceReloadSettingsBtn.addEventListener('click', () => {
            sendMessageAsync({ action: 'force_reload_settings' }).then(() => {
                showStatus('Settings reloaded on all tabs.');
            });
        });
    }

    // Start the initialization process
    optionsManager.initializeEventListeners();
    initializePopup();
    } catch (e) {
        console.error("Error in DOMContentLoaded handler:", e);
        showStatus(`Critical error: ${e.message}`, true);
    }
});
