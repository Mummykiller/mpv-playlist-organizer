document.addEventListener('DOMContentLoaded', () => {

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
    const customHeightInput = document.getElementById('custom-height');
    const geometrySelect = document.getElementById('geometry-select');
    const customMpvFlagsTextarea = document.getElementById('custom-mpv-flags');
    const showPlayNewButtonCheckbox = document.getElementById('show-play-new-button-checkbox');
    const duplicateBehaviorSelect = document.getElementById('duplicate-behavior-select');
    const defaultUiModeSelect = document.getElementById('default-ui-mode-select');
    const scannerTimeoutInput = document.getElementById('scanner-timeout-input');
    const confirmRemoveFolderCheckbox = document.getElementById('confirm-remove-folder-checkbox');
    const confirmClearPlaylistCheckbox = document.getElementById('confirm-clear-playlist-checkbox');
    const confirmCloseMpvCheckbox = document.getElementById('confirm-close-mpv-checkbox');
    const confirmPlayNewCheckbox = document.getElementById('confirm-play-new-checkbox');
    const clearOnCompletionCheckbox = document.getElementById('clear-on-completion-checkbox');
    const autofocusNewFolderCheckbox = document.getElementById('autofocus-new-folder-checkbox');
    const autoReattachAnilistCheckbox = document.getElementById('auto-reattach-anilist-checkbox');

    // Mini Controller View Elements
    const miniFolderSelect = document.getElementById('mini-folder-select');
    const miniAddBtn = document.getElementById('btn-mini-add');
    const miniPlayBtn = document.getElementById('btn-mini-play');
    const miniClearBtn = document.getElementById('btn-mini-clear');
    const miniCloseMpvBtn = document.getElementById('btn-mini-close-mpv');
    const showOnPageControllerBtn = document.getElementById('btn-show-on-page-controller');
    const miniManageFoldersBtn = document.getElementById('btn-mini-manage-folders');
    const miniFolderManagementControls = document.getElementById('mini-folder-management-controls');
    const btnMiniToggleSettings = document.getElementById('btn-mini-toggle-settings');
    const miniSettingsControls = document.getElementById('mini-settings-controls');
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

    // Shared Settings Elements (moved via JS)
    const sharedSettingsContainer = document.getElementById('shared-settings-container');
    const miniSettingsPlaceholder = document.getElementById('mini-settings-placeholder');
    const fullSettingsPlaceholder = document.getElementById('full-settings-placeholder');
    const sharedAnilistSection = document.getElementById('shared-anilist-section');
    const miniAnilistPlaceholder = document.getElementById('mini-anilist-placeholder');
    const fullAnilistPlaceholder = document.getElementById('full-anilist-placeholder');
    const miniStatusPlaceholder = document.getElementById('mini-status-placeholder');
    const fullStatusPlaceholder = document.getElementById('full-status-placeholder');


    let folderToRename = null;

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
     * Checks if the mini-controller view is currently active.
     * @returns {boolean} True if the mini view is active, false otherwise.
     */
    function isMiniViewActive() {
        return miniControllerView.style.display === 'flex';
    }

    function getActiveFolderSelect() {
        return isMiniViewActive() ? miniFolderSelect : removeFolderSelect;
    }

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

    // --- Log Functions for Popup ---
    /**
     * Displays log messages in the status area.
     * @param {object} logObject - The log object containing text and type.
     */
    function addPopupLogEntry(logObject) {
        const isError = logObject.type === 'error';
        showStatus(logObject.text, isError);
    }


    /**
     * Displays a message to the user and fades it out.
     * @param {string} text - The message to display.
     * @param {boolean} isError - If true, styles the message as an error.
     */
    function showStatus(text, isError = false) {
        statusMessage.textContent = text;
        statusMessage.style.color = isError ? 'var(--accent-negative)' : 'var(--accent-positive)';
        setTimeout(() => {
            statusMessage.textContent = '';
        }, 3000);
    }

    /**
     * Fetches all folder IDs and populates all folder dropdowns in the popup.
     */
    function populateFolderDropdowns() {
        chrome.runtime.sendMessage({ action: 'get_all_folder_ids' }, (response) => {
            if (response && response.success) {
                // Clear existing options
                removeFolderSelect.innerHTML = '<option value="">Select folder to remove...</option>';
                miniFolderSelect.innerHTML = '';

                response.folderIds.forEach(id => {
                    const option = document.createElement('option');
                    option.value = id;
                    option.textContent = id;
                    // Add to both dropdowns
                    removeFolderSelect.appendChild(option.cloneNode(true));
                    miniFolderSelect.appendChild(option);
                });

                // After populating, set the selected value to the last used folder.
                if (response.lastUsedFolderId && response.folderIds.includes(response.lastUsedFolderId)) {
                    miniFolderSelect.value = response.lastUsedFolderId;
                    removeFolderSelect.value = response.lastUsedFolderId;
                }

                // Ensure the remove button state is correct after populating
                updateRemoveButtonState();
                updateItemCount(miniFolderSelect.value); // Update count after populating
            }
        });
    }

    /**
     * Handles the logic for creating a new folder.
     * @param {HTMLInputElement} inputElement The input element containing the new folder name.
     */
    function handleCreateFolder(inputElement) {
        const newName = inputElement.value.trim();
        if (!newName) {
            showStatus('Folder name cannot be empty.', true);
            return;
        }

        // Add validation for folder name characters.
        // This regex allows letters, numbers, spaces, hyphens, and underscores.
        const validFolderNameRegex = /^[a-zA-Z0-9\s_-]+$/;
        if (!validFolderNameRegex.test(newName)) {
            showStatus('Folder name can only contain letters, numbers, spaces, hyphens, and underscores.', true);
            return;
        }

        chrome.runtime.sendMessage({ action: 'create_folder', folderId: newName }, (response) => {
            if (response.success) {
                showStatus(`Folder "${newName}" created!`);
                inputElement.value = '';
                populateFolderDropdowns(); // Refresh the list
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

        const prefs = await sendMessageAsync({ action: 'get_ui_preferences' });
        if (prefs?.preferences?.confirm_remove_folder ?? true) {
            const confirmed = await showPopupConfirmation(`Are you sure you want to remove the folder "${folderId}"? This action cannot be undone.`);
            if (!confirmed) return;
        }

        chrome.runtime.sendMessage({ action: 'remove_folder', folderId: folderId }, (response) => {
            if (response.success) {
                showStatus(`Folder "${folderId}" removed.`);
                populateFolderDropdowns(); // Refresh the list
            } else {
                showStatus(response.error || 'An unknown error occurred.', true);
            }
        });
    }

    async function handleRenameFolder() {
        const selectedFolder = getActiveFolderSelect().value;

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

        // Add validation for folder name characters.
        const validFolderNameRegex = /^[a-zA-Z0-9\s_-]+$/;
        if (!validFolderNameRegex.test(newFolderId)) {
            showStatus('Folder name can only contain letters, numbers, spaces, hyphens, and underscores.', true);
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
        chrome.runtime.sendMessage({ action: 'get_playlist', folderId }, (response) => {
            if (response?.success) {
                miniItemCountSpan.textContent = response.list.length;
            }
        });
    }

    // --- Event Listeners ---

    showOnPageControllerBtn.addEventListener('click', () => {
        // Find the currently active tab in the current window.
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0] && tabs[0].id) {
                // Send a message to the content script in that tab.
                chrome.tabs.sendMessage(tabs[0].id, { action: 'show_ui' })
                    .then(() => {
                        // If the message is sent successfully, the UI was shown. Close the popup.
                        window.close();
                    })
                    .catch(error => {
                        // This error is expected if the content script isn't on the page.
                        if (error.message.includes('Receiving end does not exist')) {
                            showStatus('Controller not available on this page.', true);
                        } else {
                            showStatus('An error occurred.', true);
                        }
                    });
            }
        });
    });

    // --- Folder Management Event Listeners (Refactored) ---

    // Create Folder Logic (for both main and mini views)
    [
        { btn: createFolderBtn, input: newFolderNameInput },
        { btn: miniCreateFolderBtn, input: miniNewFolderNameInput }
    ].forEach(({ btn, input }) => {
        if (btn && input) {
            btn.addEventListener('click', () => handleCreateFolder(input));
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') btn.click();
            });
        }
    });

    // Remove Folder Logic (for both main and mini views)
    removeFolderBtn.addEventListener('click', () => handleRemoveFolder(removeFolderSelect.value));
    renameFolderBtn.addEventListener('click', handleRenameFolder);
    miniRemoveFolderBtn.addEventListener('click', () => handleRemoveFolder(miniFolderSelect.value));

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

    // --- Initial Setup ---
    // Populate dropdowns first
    populateFolderDropdowns();

    // --- Reorder Logic ---

    function getActiveReorderControls() {
        const isMiniView = miniControllerView.style.display === 'flex';
        if (isMiniView) {
            return {
                container: miniReorderContainer,
                toggleBtn: miniToggleReorderBtn,
                elementsToHide: [
                    document.getElementById('mini-folder-select'),
                    document.getElementById('btn-mini-manage-folders'),
                    document.getElementById('mini-item-count-container')
                ]
            };
        }
        return {
            container: reorderContainer,
            toggleBtn: toggleReorderBtn,
            elementsToHide: [
                document.getElementById('remove-folder-select'),
                document.getElementById('rename-remove-controls')
            ]
        };
    }

    async function toggleReorderMode() {
        isReorderModeActive = !isReorderModeActive;
        const controls = getActiveReorderControls();

        controls.toggleBtn.classList.toggle('active', isReorderModeActive);

        if (isReorderModeActive) {
            // Enter reorder mode
            // For the main view, change text to be more descriptive for a full-width button
            if (controls.toggleBtn === toggleReorderBtn) {
                controls.toggleBtn.textContent = 'Save Order';
            }

            controls.elementsToHide.forEach(el => el.style.display = 'none');
            controls.container.style.display = 'block';
            const response = await sendMessageAsync({ action: 'get_all_folder_ids' });
            if (response.success) {
                renderReorderList(controls.container, response.folderIds);
            }
        } else {
            // Exit reorder mode
            const list = controls.container.querySelector('.reorder-list');
            if (list) {
                const newOrder = [...list.children].map(item => item.dataset.folderId);
                await sendMessageAsync({ action: 'set_folder_order', order: newOrder });
                showStatus('Folder order saved.');
            }

            // For the main view, restore the original button text
            if (controls.toggleBtn === toggleReorderBtn) {
                controls.toggleBtn.textContent = 'Reorder';
            }

            controls.container.innerHTML = ''; // Clear the list
            controls.container.style.display = 'none';
            controls.elementsToHide.forEach(el => el.style.display = ''); // Reset display style
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
            const afterElement = getDragAfterElement(list, e.clientY);
            if (afterElement == null) list.appendChild(draggedItem);
            else list.insertBefore(draggedItem, afterElement);
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
        const folderId = getActiveFolderSelect().value;

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
        if (!/^[a-zA-Z0-9_-]+$/.test(filename)) {
            return showStatus('Filename can only contain letters, numbers, hyphens, and underscores.', true);
        }

        const folderId = getActiveFolderSelect().value;

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
        chrome.runtime.sendMessage({ action: 'list_import_files' }, (response) => {
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
                    showStatus('Exporting all playlists...'); // Give immediate feedback
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
        // This action isn't destructive, so no confirmation is needed.
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

    exportDataBtn.addEventListener('click', handleExport);
    miniExportDataBtn.addEventListener('click', handleExport);

    exportSaveBtn.addEventListener('click', handleSaveExport);
    exportFilenameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') exportSaveBtn.click();
    });

    if (exportAllDataBtn) exportAllDataBtn.addEventListener('click', handleExportAll);
    if (miniExportAllDataBtn) miniExportAllDataBtn.addEventListener('click', handleExportAll);

    if (openExportFolderBtn) openExportFolderBtn.addEventListener('click', handleOpenExportFolder);
    if (miniOpenExportFolderBtn) miniOpenExportFolderBtn.addEventListener('click', handleOpenExportFolder);

    importDataBtn.addEventListener('click', handleImport);
    miniImportDataBtn.addEventListener('click', handleImport);

    miniRenameFolderBtn.addEventListener('click', handleRenameFolder);

    renameCancelBtn.addEventListener('click', () => {
        renameFolderModal.style.display = 'none';
        folderToRename = null;
    });
    renameSaveBtn.addEventListener('click', saveRename);
    renameFolderInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') saveRename();
    });

    toggleReorderBtn.addEventListener('click', toggleReorderMode);
    miniToggleReorderBtn.addEventListener('click', toggleReorderMode);

    importCancelBtn.addEventListener('click', () => { importSelectionModal.style.display = 'none'; });

    // --- Preferences & Settings Logic (Refactored) ---

    function updateAllPreferencesUI(prefs) {
        const isCustom = prefs.launch_geometry === 'custom';

        // Update shared controls
        geometrySelect.value = prefs.launch_geometry || '';
        customWidthInput.value = prefs.custom_geometry_width || '';
        customHeightInput.value = prefs.custom_geometry_height || '';
        customMpvFlagsTextarea.value = prefs.custom_mpv_flags || '';

        // Show/hide custom input containers
        customGeometryContainer.style.display = isCustom ? 'flex' : 'none';

        showPlayNewButtonCheckbox.checked = prefs.show_play_new_button ?? false;

        // --- NEW SETTINGS ---
        duplicateBehaviorSelect.value = prefs.duplicate_url_behavior || 'ask';

        defaultUiModeSelect.value = prefs.mode || 'full';

        scannerTimeoutInput.value = prefs.stream_scanner_timeout;

        confirmRemoveFolderCheckbox.checked = prefs.confirm_remove_folder ?? true;

        confirmClearPlaylistCheckbox.checked = prefs.confirm_clear_playlist ?? true;

        confirmCloseMpvCheckbox.checked = prefs.confirm_close_mpv ?? true;

        confirmPlayNewCheckbox.checked = prefs.confirm_play_new ?? true;

        clearOnCompletionCheckbox.checked = prefs.clear_on_completion ?? false;

        autofocusNewFolderCheckbox.checked = prefs.autofocus_new_folder ?? false;

        autoReattachAnilistCheckbox.checked = prefs.autoReattachAnilistPanel ?? true;
    }

    function saveAllPreferences() {
        const preferences = {
            launch_geometry: geometrySelect.value,
            custom_geometry_width: customWidthInput.value.trim(),
            custom_geometry_height: customHeightInput.value.trim(),
            custom_mpv_flags: customMpvFlagsTextarea.value.trim(),
            show_play_new_button: showPlayNewButtonCheckbox.checked,
            duplicate_url_behavior: duplicateBehaviorSelect.value,
            mode: defaultUiModeSelect.value,
            // Ensure the timeout is saved as a number, with a fallback to the default.
            stream_scanner_timeout: Number(scannerTimeoutInput.value) || 60,
            confirm_remove_folder: confirmRemoveFolderCheckbox.checked,
            confirm_clear_playlist: confirmClearPlaylistCheckbox.checked,
            confirm_close_mpv: confirmCloseMpvCheckbox.checked,
            confirm_play_new: confirmPlayNewCheckbox.checked,
            clear_on_completion: clearOnCompletionCheckbox.checked,
            autofocus_new_folder: autofocusNewFolderCheckbox.checked,
            autoReattachAnilistPanel: autoReattachAnilistCheckbox.checked
        };

        chrome.runtime.sendMessage({ action: 'set_ui_preferences', preferences: preferences }, (response) => {
            if (response?.success) {
                // The save was successful. We can now update the UI with the values we just sent.
                // This is faster than re-fetching and achieves the same goal of syncing both views.
                updateAllPreferencesUI(preferences);
            } else {
                showStatus('Failed to save settings.', true);
            }
        });
    }

    const debouncedSaveAllPreferences = debounce(saveAllPreferences, 400);

    /**
     * Handles changes to the geometry dropdown, providing immediate UI feedback
     * by showing/hiding the custom input fields before saving.
     */
    function handleGeometryChange() {
        const isCustom = geometrySelect.value === 'custom';
        customGeometryContainer.style.display = isCustom ? 'flex' : 'none';
        debouncedSaveAllPreferences();
    }

    geometrySelect.addEventListener('change', handleGeometryChange);

    // Add listeners to all other preference controls in a loop to reduce repetition.
    const preferenceControls = [
        customWidthInput, customHeightInput,
        customMpvFlagsTextarea,
        showPlayNewButtonCheckbox,
        duplicateBehaviorSelect,
        defaultUiModeSelect,
        scannerTimeoutInput,
        confirmRemoveFolderCheckbox,
        confirmClearPlaylistCheckbox,
        confirmCloseMpvCheckbox,
        confirmPlayNewCheckbox,
        clearOnCompletionCheckbox,
        autofocusNewFolderCheckbox,
        autoReattachAnilistCheckbox
    ];

    preferenceControls.forEach(control => {
        const eventType = (control.tagName === 'TEXTAREA' || control.type === 'text' || control.type === 'number') ? 'input' : 'change';
        control.addEventListener(eventType, debouncedSaveAllPreferences);
    });

    // On load, get preferences and set the dropdowns
    chrome.runtime.sendMessage({ action: 'get_ui_preferences' }, (response) => {
        if (response?.success && response.preferences) {
            updateAllPreferencesUI(response.preferences);

            // Now that preferences are loaded, apply focus if needed.
            if (folderManagementView.style.display === 'block' && response.preferences.autofocus_new_folder) {
                newFolderNameInput.focus();
            }
        }
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
        // Also save this as the last used folder so the selection persists.
        chrome.runtime.sendMessage({ action: 'set_last_folder_id', folderId: newFolderId });
    });

    // --- Mini Controller Logic (Refactored for Clarity) ---

    const sendMessageAsync = (payload) => new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(payload, (response) => {
            if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
            resolve(response);
        });
    });

    async function handleMiniAdd() {
        try {
            const folderId = miniFolderSelect.value;
            if (!folderId) return showStatus('Please select a folder.', true);

            const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            const tabId = activeTab?.id;
            if (!tabId) return showStatus('Could not find an active tab.', true);

            // Fetch preferences, tab state, and playlist in parallel
            const [prefsResponse, stateResponse, playlistResponse] = await Promise.all([
                sendMessageAsync({ action: 'get_ui_preferences' }),
                sendMessageAsync({ action: 'get_ui_state_for_tab', tabId }),
                sendMessageAsync({ action: 'get_playlist', folderId })
            ]);

            if (!stateResponse?.success || !stateResponse.state.detectedUrl) {
                return showStatus('No URL detected on the page to add.', true);
            }
            const urlToAdd = stateResponse.state.detectedUrl;

            if (!playlistResponse?.success) {
                return showStatus(playlistResponse.error || 'Could not get playlist.', true);
            }

            const duplicateBehavior = prefsResponse?.preferences?.duplicate_url_behavior || 'ask';
            const isDuplicate = playlistResponse.list.includes(urlToAdd);

            if (isDuplicate) {
                if (duplicateBehavior === 'never') {
                    return showStatus('URL exists. "Never Add" is on.', false);
                }
                if (duplicateBehavior === 'ask') {
                    const confirmed = await showPopupConfirmation('This URL is already in the playlist. Are you sure you want to add it again?');
                    if (!confirmed) return showStatus('Add action cancelled.');
                }
            }
            const addResponse = await sendMessageAsync({ action: 'add', folderId, tabId });
            if (addResponse.success) {
                if (addResponse.message) showStatus(addResponse.message);
                updateItemCount(folderId);
            } else if (addResponse.error) {
                showStatus(addResponse.error, true);
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

    // Find the active tab to determine which UI to show and configure it.
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const activeTab = tabs[0];

        // Guard against pages where the content script can't run.
        if (!activeTab || !activeTab.id || !activeTab.url?.startsWith('http')) {
            // On a non-compatible page, default to the folder management view.
            folderManagementView.style.display = 'block';
            miniControllerView.style.display = 'none';
            // Move shared settings into the visible view
            fullSettingsPlaceholder.appendChild(sharedSettingsContainer);
            sharedSettingsContainer.style.display = 'block';
            // Move anilist section into the visible view
            fullAnilistPlaceholder.appendChild(sharedAnilistSection);
            // Move status message into the visible view
            fullStatusPlaceholder.appendChild(statusMessage);

            updateRemoveButtonState(); // Ensure remove button state is correct
                // We can't apply focus here because the preferences might not be loaded yet.
                // The logic inside the `get_ui_preferences` callback at the end of the
                // script will handle applying the focus after settings are loaded.
            return;
        }

        // Ask the background script for the UI state of this tab.
        chrome.runtime.sendMessage({ action: 'get_ui_state_for_tab', tabId: activeTab.id }, (response) => {
            if (chrome.runtime.lastError || !response?.success) {
                // If we can't get state, default to the folder management view.
                folderManagementView.style.display = 'block';
                miniControllerView.style.display = 'none';
                // Move shared settings into the visible view
                fullSettingsPlaceholder.appendChild(sharedSettingsContainer);
                sharedSettingsContainer.style.display = 'block';
                // Move anilist section into the visible view
                fullAnilistPlaceholder.appendChild(sharedAnilistSection);
                // Move status message into the visible view
                fullStatusPlaceholder.appendChild(statusMessage);

                updateRemoveButtonState();
                return;
            }

            // Existing logic if MPV is running
            if (response.state.minimized) {
                miniControllerView.style.display = 'flex';
                folderManagementView.style.display = 'none';

                // Move shared settings into the mini view's placeholder
                miniSettingsPlaceholder.appendChild(sharedSettingsContainer);
                sharedSettingsContainer.style.display = 'block';
                // Move anilist section into the mini view's placeholder
                miniAnilistPlaceholder.appendChild(sharedAnilistSection);
                // Move status message into the mini view's placeholder
                miniStatusPlaceholder.appendChild(statusMessage);

                // Update the item count for the currently selected folder.
                updateItemCount(miniFolderSelect.value);

                // The "Show On-Page Controller" button is only relevant in this view.
                showOnPageControllerBtn.style.display = 'block';

                // Update the 'Add' button's appearance based on whether a URL was detected.
                if (miniAddBtn) {
                    const hasUrl = !!response.state.detectedUrl;
                    miniAddBtn.classList.toggle('url-detected', hasUrl);
                }
            } else {
                // If the on-page UI is visible, show the folder management view.
                folderManagementView.style.display = 'block';
                miniControllerView.style.display = 'none';

                // Move shared settings into the full view's placeholder
                fullSettingsPlaceholder.appendChild(sharedSettingsContainer);
                sharedSettingsContainer.style.display = 'block';
                // Move anilist section into the full view's placeholder
                fullAnilistPlaceholder.appendChild(sharedAnilistSection);
                // Move status message into the full view's placeholder
                fullStatusPlaceholder.appendChild(statusMessage);

                updateRemoveButtonState();
            }
        });
    });

    // Close the popup whenever it loses focus. This handles both clicking away
    // within the browser and switching to another application, which is the
    // standard and expected behavior for extension popups.
    window.addEventListener('blur', () => {
        window.close();
    });

    // Add a listener for log messages from the background script.
    // This will only receive messages while the popup is open.
    chrome.runtime.onMessage.addListener((request) => {
        // Handle log messages for the status bar
        if (request.log) {
            addPopupLogEntry(request.log);
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
                if (activeTab && activeTab.id === request.tabId && miniAddBtn) {
                    miniAddBtn.classList.toggle('url-detected', !!request.url);
                }
            });
        }

        // If preferences changed in another context (e.g., dragging the anilist panel), update our UI.
        if (request.action === 'preferences_changed') {
            chrome.runtime.sendMessage({ action: 'get_ui_preferences' }, (response) => {
                if (response?.success && response.preferences) {
                    updateAllPreferencesUI(response.preferences);
                }
            });
        }
    });

    // AniList Releases Logic
    const anilistReleasesSection = document.querySelector('.anilist-releases-section');
    const anilistReleasesContent = document.getElementById('anilist-releases-content');

    async function fetchAniListReleases() {
        anilistReleasesContent.innerHTML = '<div class="loading-spinner"></div>'; // Show spinner
        try {
            const response = await sendMessageAsync({ action: 'get_anilist_releases' });
            if (response.success) {
                try {
                    const releases = JSON.parse(response.output);
                    renderAniListReleases(releases);
                } catch (e) {
                    anilistReleasesContent.textContent = 'Error: Failed to parse releases data.';
                }
            } else {
                anilistReleasesContent.textContent = `Error: ${response.error || 'Failed to fetch releases.'}`;
            }
        } catch (error) {
            anilistReleasesContent.textContent = `Error: ${error.message || 'An unknown error occurred.'}`;
        }
    }

    function renderAniListReleases(releases) {
        anilistReleasesContent.innerHTML = ''; // Clear spinner or old content

        if (!releases || releases.length === 0) {
            anilistReleasesContent.textContent = 'No anime episodes found releasing today.';
            return;
        }

        const list = document.createElement('ul');
        list.className = 'anilist-releases-list';

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

        anilistReleasesContent.appendChild(list);
    }

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
        }
    });
});