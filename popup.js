document.addEventListener('DOMContentLoaded', () => {

    // Views
    const miniControllerView = document.getElementById('mini-controller-view');
    const folderManagementView = document.getElementById('folder-management-view');

    // Folder Management View Elements
    const newFolderNameInput = document.getElementById('new-folder-name');
    const createFolderBtn = document.getElementById('btn-create-folder');
    const removeFolderSelect = document.getElementById('remove-folder-select');
    const removeFolderBtn = document.getElementById('btn-remove-folder');

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

    const statusMessage = document.getElementById('status-message');

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

    createFolderBtn.addEventListener('click', () => {
        const newName = newFolderNameInput.value.trim();
        if (!newName) {
            showStatus('Folder name cannot be empty.', true);
            return;
        }

        chrome.runtime.sendMessage({ action: 'create_folder', folderId: newName }, (response) => {
            if (response.success) {
                showStatus(`Folder "${newName}" created!`);
                newFolderNameInput.value = '';
                populateFolderDropdowns(); // Refresh the list
            } else {
                showStatus(response.error || 'An unknown error occurred.', true);
            }
        });
    });

    removeFolderBtn.addEventListener('click', () => {
        const folderToRemove = removeFolderSelect.value;
        if (!folderToRemove) return; // Should be blocked by disabled state, but good practice

        // Add a confirmation dialog for a better user experience.
        if (!confirm(`Are you sure you want to remove the folder "${folderToRemove}"? This action cannot be undone.`)) {
            return;
        }

        chrome.runtime.sendMessage({ action: 'remove_folder', folderId: folderToRemove }, (response) => {
            if (response.success) {
                showStatus(`Folder "${folderToRemove}" removed.`);
                populateFolderDropdowns(); // Refresh the list
            } else {
                showStatus(response.error || 'An unknown error occurred.', true);
            }
        });
    });

    // --- Initial Setup ---
    // Populate dropdowns first
    populateFolderDropdowns();

    miniFolderSelect.addEventListener('change', () => updateItemCount(miniFolderSelect.value));

    // --- Mini Controller Folder Management Logic ---
    miniManageFoldersBtn.addEventListener('click', () => {
        const isVisible = miniFolderManagementControls.style.display === 'block';
        miniFolderManagementControls.style.display = isVisible ? 'none' : 'block';
    });

    miniCreateFolderBtn.addEventListener('click', () => {
        const newName = miniNewFolderNameInput.value.trim();
        if (!newName) {
            showStatus('Folder name cannot be empty.', true);
            return;
        }
        chrome.runtime.sendMessage({ action: 'create_folder', folderId: newName }, (response) => {
            if (response.success) {
                showStatus(`Folder "${newName}" created!`);
                miniNewFolderNameInput.value = '';
                populateFolderDropdowns(); // Refresh the list
            } else {
                showStatus(response.error || 'An unknown error occurred.', true);
            }
        });
    });

    miniRemoveFolderBtn.addEventListener('click', () => {
        const folderToRemove = miniFolderSelect.value;
        if (!folderToRemove) {
            showStatus('No folder selected to remove.', true);
            return;
        }
        // Confirmation dialog as requested
        if (confirm(`Are you sure you want to remove the folder "${folderToRemove}"? This action cannot be undone.`)) {
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

    // --- Mini Controller Button Logic ---
    async function sendMiniControllerCommand(action) {
        const folderId = miniFolderSelect.value;
        if (!folderId) {
            showStatus('Please select a folder.', true);
            return;
        }

        // Get the active tab ID to provide context for the command, as the popup
        // itself doesn't have a tab context.
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const tabId = activeTab?.id;

        if (!tabId) {
            showStatus('Could not find an active tab.', true);
            return;
        }

        chrome.runtime.sendMessage({ action, folderId, tabId }, (response) => {
            if (response.success) {
                if (response.message) showStatus(response.message);
                if (action === 'add' || action === 'play') window.close();
            } else {
                if (response.error) showStatus(response.error, true);
            }
        });
    }

    miniAddBtn.addEventListener('click', () => sendMiniControllerCommand('add'));
    miniPlayBtn.addEventListener('click', () => sendMiniControllerCommand('play'));
    miniClearBtn.addEventListener('click', () => sendMiniControllerCommand('clear'));
    miniCloseMpvBtn.addEventListener('click', () => sendMiniControllerCommand('close_mpv'));

    // Find the active tab to determine which UI to show.
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const activeTab = tabs[0];
        // Guard against pages where the logic shouldn't run (e.g., chrome:// pages)
        if (!activeTab || !activeTab.id || !activeTab.url?.startsWith('http')) {
            folderManagementView.style.display = 'block';
            updateRemoveButtonState();
            return;
        }

        // Ask the background script for the UI state of this tab.
        chrome.runtime.sendMessage({ action: 'get_ui_state_for_tab', tabId: activeTab.id }, (response) => {
            if (chrome.runtime.lastError || !response?.success) {
                folderManagementView.style.display = 'block';
                return;
            }

            if (response.state.minimized) {
                miniControllerView.style.display = 'flex';
                // Update the UI based on the state received from the background script
                updateItemCount(miniFolderSelect.value);
                if (miniAddBtn) {
                    const hasUrl = !!response.state.detectedUrl;
                    miniAddBtn.classList.toggle('url-detected', hasUrl);
                }
            } else {
                folderManagementView.style.display = 'block';
            }
        });
    });
});