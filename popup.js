document.addEventListener('DOMContentLoaded', async () => { // This line is intentionally kept for the diff

    // IMPORTANT: You must include settings.js in your popup.html before this script, like so:
    // <script src="settings.js"></script>

    /**
     * Creates a debounced function that delays invoking `func` until after `wait`
     * milliseconds have elapsed since the last time the debounced function was
     * invoked.
     * @param {Function} func The function to debounce.
     * @param {number} wait The number of milliseconds to delay.
     * @returns {Function} Returns the new debounced function.
     */
    function debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func.apply(this, args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }

    /**
     * A promise-based wrapper for chrome.runtime.sendMessage.
     * @param {object} payload The message to send.
     * @returns {Promise<any>} A promise that resolves with the response.
     */
    const sendMessageAsync = (payload) => new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(payload, (response) => {
            if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
            resolve(response);
        });
    });

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
        statusMessageElement.style.color = isError ? 'var(--accent-negative)' : 'var(--accent-positive)';
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
     * Asks the content script on the active tab to show a page-level confirmation.
     * This unifies the confirmation experience.
     * @param {string} message The message to display in the modal.
     * @returns {Promise<boolean>} A promise that resolves to true if confirmed, false if cancelled.
     */
    async function showConfirmationOnActiveTab(message) {
        try {
            const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!activeTab || !activeTab.id) {
                // Fallback to the popup's own confirmation if no active tab is found.
                return await showPopupConfirmation(message);
            }
            const response = await sendMessageAsync({
                action: 'show_confirmation',
                message: message,
                tabId: activeTab.id // Explicitly target the active tab
            });
            return response?.confirmed || false;
        } catch (error) {
            return await showPopupConfirmation(message); // Fallback on error
        }
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

            response.folderIds.forEach(id => {
                const option = document.createElement('option');
                option.value = id;
                option.textContent = id;
                removeFolderSelect.appendChild(option.cloneNode(true));
                miniFolderSelect.appendChild(option);
            });

            if (response.lastUsedFolderId && response.folderIds.includes(response.lastUsedFolderId)) {
                miniFolderSelect.value = response.lastUsedFolderId;
                removeFolderSelect.value = response.lastUsedFolderId;
            }

            updateRemoveButtonState();
            updateItemCount(miniFolderSelect.value);
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
        const invalidCharsRegex = /[\\/:\*?"<>|]/;
        if (invalidCharsRegex.test(newName)) {
            showStatus('Folder name cannot contain / \\ : * ? " < > |', true);
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

        const prefs = (await sendMessageAsync({ action: 'get_ui_preferences' })).preferences;
        if (prefs?.preferences?.confirm_remove_folder ?? true) {
            const confirmed = await showPopupConfirmation(`Are you sure you want to remove the folder "${folderId}"? This action cannot be undone.`);
            if (!confirmed) return;
        }

        sendMessageAsync({ action: 'remove_folder', folderId: folderId }).then(response => {
            if (response.success) {
                showStatus(`Folder "${folderId}" removed.`);
                populateFolderDropdowns();
            } else {
                showStatus(response.error || 'An unknown error occurred.', true);
            }
        });
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
        const invalidCharsRegex = /[\\/:\*?"<>|]/;
        if (invalidCharsRegex.test(newFolderId)) {
            showStatus('New folder name cannot contain / \\ : * ? " < > |', true);
            return;
        }

        const response = await sendMessageAsync({ action: 'rename_folder', oldFolderId, newFolderId });

        if (response.success) {
            showStatus(response.message);
            populateFolderDropdowns();
        } else {
            showStatus(response.error || 'Failed to rename folder.', true);
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
     * Fetches the playlist for a given folder and updates the item count display.
     * @param {string} folderId The ID of the folder to check.
     */
    function updateItemCount(folderId) {
        if (!folderId) {
            miniItemCountSpan.textContent = '0';
            return;
        }
        sendMessageAsync({ action: 'get_playlist', folderId }).then(response => {
            if (response?.success) {
                miniItemCountSpan.textContent = response.list.length;
            }
        });
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
            const response = await sendMessageAsync({ action: 'get_all_folder_ids' });
            if (response.success) {
                renderReorderList(container, response.folderIds);
            }

        } else {
            const list = container.querySelector('.reorder-list');
            if (list) {
                const newOrder = [...list.children].map(item => item.dataset.folderId);
                await sendMessageAsync({ action: 'set_folder_order', order: newOrder });
                showStatus('Folder order saved.');
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
            draggedItem.classList.remove('dragging');
        });

        list.addEventListener('dragover', e => {
            e.preventDefault();
            
            // Remove any existing drop indicators to prevent multiple lines
            const existingIndicator = list.querySelector('.drag-over');
            if (existingIndicator) {
                existingIndicator.classList.remove('drag-over');
            }

            const afterElement = getDragAfterElement(list, e.clientY);
            if (afterElement) {
                afterElement.classList.add('drag-over');
            }
        });

        list.addEventListener('drop', e => {
            e.preventDefault();
            if (!draggedItem) return;

            const dropTarget = list.querySelector('.drag-over');
            if (dropTarget) {
                dropTarget.classList.remove('drag-over');
            }

            // Perform the actual DOM move on drop
            list.insertBefore(draggedItem, dropTarget); // dropTarget can be null, which correctly appends to the end.
        });
    }

    function getDragAfterElement(container, y) {
        const draggableElements = [...container.querySelectorAll('.reorder-item:not(.dragging)')];
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

    const handleSaveExport = () => {
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

        chrome.runtime.sendMessage({
            action: 'export_folder_playlist',
            filename: filename,
            folderId: folderId
        }, (response) => {
            if (response?.success) {
                showStatus(response.message);
            } else {
                showStatus(response?.error || 'Export failed.', true);
            }
        });
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
    miniFolderSelect.addEventListener('change', () => {
        const newFolderId = miniFolderSelect.value;
        updateItemCount(newFolderId);
        sendMessageAsync({ action: 'set_last_folder_id', folderId: newFolderId });
    });

    // Helper to scrape page details directly from popup
    const getPageDetails = (tabId) => new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, { action: 'scrape_and_get_details' }, (response) => {
            if (chrome.runtime.lastError) return resolve(null);
            resolve(response);
        });
    });

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
            const prefs = await sendMessageAsync({ action: 'get_ui_preferences' });
            if (prefs?.preferences?.confirm_clear_playlist ?? true) {
                const confirmed = await showPopupConfirmation(`Are you sure you want to clear the playlist in "${folderId}"?`);
                if (!confirmed) {
                    return showStatus('Clear action cancelled.');
                }
            }
        }

        try {
            // These actions only need the folderId.
            const response = await sendMessageAsync({ action, folderId });
            if (response.success) {
                if (response.message) showStatus(response.message);
                if (action === 'clear') {
                    // When clearing, also update the item count in the UI.
                    updateItemCount(folderId);
                }
            } else if (response.error) {
                showStatus(response.error, true);
            }
        } catch (error) {
            showStatus(`An error occurred: ${error.message}`, true);
        }
    }

    miniAddBtn.addEventListener('click', handleMiniAdd);
    miniPlayBtn.addEventListener('click', () => handleMiniSimpleCommand('play'));
    miniClearBtn.addEventListener('click', () => handleMiniSimpleCommand('clear'));
    miniCloseMpvBtn.addEventListener('click', handleMiniCloseMpv);

    // --- Main Initialization ---
    async function initializePopup() {
        try {
            // Fetch all necessary data in parallel for faster startup
            const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            const isHttp = activeTab?.url?.startsWith('http');

            const [uiStateResponse, prefsResponse] = await Promise.all([
                isHttp ? sendMessageAsync({ action: 'get_ui_state_for_tab', tabId: activeTab.id }) : Promise.resolve({ success: false }),
                sendMessageAsync({ action: 'get_ui_preferences' })
            ]);

            const prefs = prefsResponse?.preferences;
            const uiState = uiStateResponse?.state;

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
                updateItemCount(miniFolderSelect.value);
                showOnPageControllerBtn.style.display = 'block';
                hideOnPageControllerBtn.style.display = 'none';
                if (miniAddBtn) miniAddBtn.focus();
            } else {
                // Apply focus to the new folder input if the setting is enabled
                if (prefs?.autofocus_new_folder) {
                    newFolderNameInput.focus();
                }
                // Hide the 'hide' button if the full view is active, show it otherwise.
                hideOnPageControllerBtn.style.display = 'block';
            }

        } catch (error) {
            // Fallback to the full management view on any error
            uiManager.setMode('full');
            populateFolderDropdowns();
            updateRemoveButtonState();
            showStatus(`Error initializing popup: ${error.message}`, true);
        }
    }

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

        // Handle live playlist updates to keep the item count in sync
        if (request.action === 'render_playlist') {
            const isMiniView = miniControllerView.style.display === 'flex';
            const currentFolderId = miniFolderSelect.value;
            if (isMiniView && currentFolderId === request.folderId) {
                miniItemCountSpan.textContent = request.playlist.length;
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
            });
        }

        // If preferences changed in another context (e.g., dragging the anilist panel), update our UI.
        if (request.action === 'preferences_changed') {
            sendMessageAsync({ action: 'get_ui_preferences' }).then(response => {
                if (response?.success && response.preferences) optionsManager.updateAllPreferencesUI(response.preferences);
                if (btnMiniToggleStub && response?.preferences) {
                    const isStubEnabled = response.preferences.show_minimized_stub ?? true;
                    btnMiniToggleStub.style.opacity = isStubEnabled ? '1' : '0.5';
                }
            });
        }

        // New: Handle confirmation requests from the background script
        if (request.action === 'show_popup_confirmation') {
            // This is an async action, so we must return true.
            (async () => {
                const confirmed = await showPopupConfirmation(request.message);
                sendResponse({ confirmed });
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
});