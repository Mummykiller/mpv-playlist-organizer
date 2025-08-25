document.addEventListener('DOMContentLoaded', () => {

    // Views
    const miniControllerView = document.getElementById('mini-controller-view');
    const folderManagementView = document.getElementById('folder-management-view');

    // Folder Management View Elements
    const newFolderNameInput = document.getElementById('new-folder-name');
    const createFolderBtn = document.getElementById('btn-create-folder');
    const removeFolderSelect = document.getElementById('remove-folder-select');
    const removeFolderBtn = document.getElementById('btn-remove-folder');
    const customGeometryContainer = document.getElementById('custom-geometry-container');
    const customWidthInput = document.getElementById('custom-width');
    const customHeightInput = document.getElementById('custom-height');
    const geometrySelect = document.getElementById('geometry-select');

    // Mini Controller View Elements
    const miniFolderSelect = document.getElementById('mini-folder-select');
    const miniAddBtn = document.getElementById('btn-mini-add');
    const miniPlayBtn = document.getElementById('btn-mini-play');
    const miniClearBtn = document.getElementById('btn-mini-clear');
    const miniCloseMpvBtn = document.getElementById('btn-mini-close-mpv');
    const showOnPageControllerBtn = document.getElementById('btn-show-on-page-controller');
    const miniManageFoldersBtn = document.getElementById('btn-mini-manage-folders');
    const miniFolderManagementControls = document.getElementById('mini-folder-management-controls');
    const miniNewFolderNameInput = document.getElementById('mini-new-folder-name');
    const miniCreateFolderBtn = document.getElementById('btn-mini-create-folder');
    const miniRemoveFolderBtn = document.getElementById('btn-mini-remove-folder');
    const miniItemCountSpan = document.getElementById('mini-item-count');
    const miniCustomGeometryContainer = document.getElementById('mini-custom-geometry-container');
    const miniCustomWidthInput = document.getElementById('mini-custom-width');
    const miniCustomHeightInput = document.getElementById('mini-custom-height');
    const miniGeometrySelect = document.getElementById('mini-geometry-select');

    const statusMessage = document.getElementById('status-message');

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
     * Enables or disables the remove button based on selection.
     */
    function updateRemoveButtonState() {
        removeFolderBtn.disabled = !removeFolderSelect.value;
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

    removeFolderSelect.addEventListener('change', updateRemoveButtonState);

    newFolderNameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            // Check if the button exists and is enabled before clicking
            if (createFolderBtn) createFolderBtn.click();
        }
    });

    createFolderBtn.addEventListener('click', () => { // This is already async-safe
        handleCreateFolder(newFolderNameInput);
    });

    removeFolderBtn.addEventListener('click', async () => { // Make listener async
        const folderToRemove = removeFolderSelect.value;
        if (!folderToRemove) return; // Should be blocked by disabled state, but good practice

        // Add a confirmation dialog for a better user experience.
        const confirmed = await showPopupConfirmation(`Are you sure you want to remove the folder "${folderToRemove}"? This action cannot be undone.`);
        if (confirmed) {
            chrome.runtime.sendMessage({ action: 'remove_folder', folderId: folderToRemove }, (response) => {
                if (response.success) {
                    showStatus(`Folder "${folderToRemove}" removed.`);
                    populateFolderDropdowns(); // Refresh the list
                } else {
                    showStatus(response.error || 'An unknown error occurred.', true);
                }
            });
        }
    });

    // --- Initial Setup ---
    // Populate dropdowns first
    populateFolderDropdowns();

    // --- Geometry Settings Logic ---
    function updateGeometryInputs(selectedGeometry, customWidth = '', customHeight = '') {
        const isCustom = selectedGeometry === 'custom';

        // Update dropdowns
        geometrySelect.value = selectedGeometry;
        miniGeometrySelect.value = selectedGeometry;

        // Update custom input fields
        customWidthInput.value = customWidth;
        customHeightInput.value = customHeight;
        miniCustomWidthInput.value = customWidth;
        miniCustomHeightInput.value = customHeight;

        // Show/hide custom input containers
        customGeometryContainer.style.display = isCustom ? 'flex' : 'none';
        miniCustomGeometryContainer.style.display = isCustom ? 'flex' : 'none';
    }

    function saveGeometryPreferences() {
        const selectedGeometry = geometrySelect.value;
        const preferences = { launch_geometry: selectedGeometry };

        if (selectedGeometry === 'custom') {
            preferences.custom_geometry_width = customWidthInput.value;
            preferences.custom_geometry_height = customHeightInput.value;
        }
        // By not having an `else` block, we don't send empty custom values
        // when a predefined option is selected. The background script's merge
        // logic will preserve the existing custom values in storage.

        chrome.runtime.sendMessage({ action: 'set_ui_preferences', preferences: preferences });

        // After saving, also update the UI to reflect the change (show/hide inputs)
        // We read the values directly from the inputs to ensure they are preserved in the UI even when hidden.
        updateGeometryInputs(selectedGeometry, customWidthInput.value, customHeightInput.value);
    }

    geometrySelect.addEventListener('change', saveGeometryPreferences);
    miniGeometrySelect.addEventListener('change', saveGeometryPreferences);
    customWidthInput.addEventListener('input', saveGeometryPreferences);
    customHeightInput.addEventListener('input', saveGeometryPreferences);
    miniCustomWidthInput.addEventListener('input', saveGeometryPreferences);
    miniCustomHeightInput.addEventListener('input', saveGeometryPreferences);

    // On load, get preferences and set the dropdowns
    chrome.runtime.sendMessage({ action: 'get_ui_preferences' }, (response) => {
        if (response?.success && response.preferences) {
            const prefs = response.preferences;
            const geometry = prefs.launch_geometry || '';
            const customWidth = prefs.custom_geometry_width || '';
            const customHeight = prefs.custom_geometry_height || '';

            updateGeometryInputs(geometry, customWidth, customHeight);
        }
    });

    miniFolderSelect.addEventListener('change', () => updateItemCount(miniFolderSelect.value));

    // --- Mini Controller Folder Management Logic ---
    miniManageFoldersBtn.addEventListener('click', () => {
        const isVisible = miniFolderManagementControls.style.display === 'block';
        miniFolderManagementControls.style.display = isVisible ? 'none' : 'block';
    });

    miniCreateFolderBtn.addEventListener('click', () => { // This is already async-safe
        handleCreateFolder(miniNewFolderNameInput);
    });

    miniRemoveFolderBtn.addEventListener('click', async () => { // Make listener async
        const folderToRemove = miniFolderSelect.value;
        if (!folderToRemove) {
            showStatus('No folder selected to remove.', true);
            return;
        }
        // Confirmation dialog as requested
        const confirmed = await showPopupConfirmation(`Are you sure you want to remove the folder "${folderToRemove}"? This action cannot be undone.`);
        if (confirmed) {
            chrome.runtime.sendMessage({ action: 'remove_folder', folderId: folderToRemove }, (response) => {
                if (response.success) {
                    showStatus(`Folder "${folderToRemove}" removed.`);
                    populateFolderDropdowns(); // Refresh the list
                } else {
                    showStatus(response.error || 'An unknown error occurred.', true);
                }
            });
        }
    });

    /**
     * A promisified version of chrome.runtime.sendMessage for use with async/await.
     * @param {object} payload The message to send.
     * @returns {Promise<object>} A promise that resolves with the response.
     */
    function sendMessageAsync(payload) {
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(payload, (response) => {
                if (chrome.runtime.lastError) {
                    return reject(chrome.runtime.lastError);
                }
                resolve(response);
            });
        });
    }

    // --- Mini Controller Button Logic ---
    async function sendMiniControllerCommand(action) {
        const folderId = miniFolderSelect.value;
        if (!folderId) {
            showStatus('Please select a folder.', true);
            return;
        }

        try {
            const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            const tabId = activeTab?.id;
            if (!tabId) {
                showStatus('Could not find an active tab.', true);
                return;
            }

            if (action === 'add') {
                const stateResponse = await sendMessageAsync({ action: 'get_ui_state_for_tab', tabId });
                if (!stateResponse?.success || !stateResponse.state.detectedUrl) {
                    showStatus('No URL detected on the page to add.', true);
                    return;
                }
                const urlToAdd = stateResponse.state.detectedUrl;

                const playlistResponse = await sendMessageAsync({ action: 'get_playlist', folderId });
                if (!playlistResponse?.success) {
                    showStatus(playlistResponse.error || 'Could not get playlist.', true);
                    return;
                }

                if (playlistResponse.list.includes(urlToAdd)) {
                    const confirmed = await showPopupConfirmation('This URL is already in the playlist. Are you sure you want to add it again?');
                    if (!confirmed) {
                        showStatus('Add action cancelled.');
                        return;
                    }
                }

                const addResponse = await sendMessageAsync({ action: 'add', folderId, tabId });
                if (addResponse.success) {
                    if (addResponse.message) showStatus(addResponse.message);
                    updateItemCount(folderId);
                } else if (addResponse.error) {
                    showStatus(addResponse.error, true);
                }
            } else if (action === 'close_mpv') {
                const statusResponse = await sendMessageAsync({ action: 'is_mpv_running' });
                if (!statusResponse?.success) {
                    showStatus('Could not check MPV status.', true);
                    return;
                }
                if (!statusResponse.is_running) {
                    showStatus('MPV is not running.', false);
                    return;
                }
                const confirmed = await showPopupConfirmation('Are you sure you want to close MPV?');
                if (!confirmed) {
                    showStatus('Close MPV action cancelled.');
                    return;
                }
                const response = await sendMessageAsync({ action: 'close_mpv', folderId, tabId });
                if (response.success) showStatus(response.message);
                else showStatus(response.error, true);
            } else {
                const response = await sendMessageAsync({ action, folderId, tabId });
                if (response.success) {
                    if (response.message) showStatus(response.message);
                    if (action === 'clear') {
                        updateItemCount(folderId);
                    }
                } else if (response.error) {
                    showStatus(response.error, true);
                }
            }
        } catch (error) {
            showStatus(`An error occurred: ${error.message}`, true);
        }
    }

    miniAddBtn.addEventListener('click', () => sendMiniControllerCommand('add'));
    miniPlayBtn.addEventListener('click', () => sendMiniControllerCommand('play'));
    miniClearBtn.addEventListener('click', () => sendMiniControllerCommand('clear'));
    miniCloseMpvBtn.addEventListener('click', () => sendMiniControllerCommand('close_mpv'));

    // Find the active tab to determine which UI to show and configure it.
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const activeTab = tabs[0];

        // Guard against pages where the content script can't run.
        if (!activeTab || !activeTab.id || !activeTab.url?.startsWith('http')) {
            // On a non-compatible page, default to the folder management view.
            folderManagementView.style.display = 'block';
            miniControllerView.style.display = 'none';
            updateRemoveButtonState(); // Ensure remove button state is correct
            return;
        }

        // Ask the background script for the UI state of this tab.
        chrome.runtime.sendMessage({ action: 'get_ui_state_for_tab', tabId: activeTab.id }, (response) => {
            if (chrome.runtime.lastError || !response?.success) {
                // If we can't get state, default to the folder management view.
                folderManagementView.style.display = 'block';
                miniControllerView.style.display = 'none';
                updateRemoveButtonState();
                return;
            }

            // Existing logic if MPV is running
            if (response.state.minimized) {
                miniControllerView.style.display = 'flex';
                folderManagementView.style.display = 'none';

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
                updateRemoveButtonState();
            }
        });
    });

    // Add a listener for log messages from the background script.
    // This will only receive messages while the popup is open.
    chrome.runtime.onMessage.addListener((request) => {
        if (request.log) {
            addPopupLogEntry(request.log);
        }
    });
});