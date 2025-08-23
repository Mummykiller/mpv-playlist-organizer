document.addEventListener('DOMContentLoaded', () => {
    const newFolderNameInput = document.getElementById('new-folder-name');
    const createFolderBtn = document.getElementById('btn-create-folder');
    const removeFolderSelect = document.getElementById('remove-folder-select');
    const removeFolderBtn = document.getElementById('btn-remove-folder');
    const statusMessage = document.getElementById('status-message');
    const showControllerBtn = document.getElementById('btn-show-controller');

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
     * Fetches all folder IDs and populates the remove dropdown.
     */
    function populateRemoveDropdown() {
        chrome.runtime.sendMessage({ action: 'get_all_folder_ids' }, (response) => {
            if (response && response.success) {
                // Clear existing options but keep the placeholder
                removeFolderSelect.innerHTML = '<option value="">Select folder to remove...</option>';

                response.folderIds.forEach(id => {
                    const option = document.createElement('option');
                    option.value = id;
                    option.textContent = id;
                    removeFolderSelect.appendChild(option);
                });
                // Ensure the remove button state is correct after populating
                updateRemoveButtonState();
            }
        });
    }

    /**
     * Enables or disables the remove button based on selection.
     */
    function updateRemoveButtonState() {
        removeFolderBtn.disabled = !removeFolderSelect.value;
    }

    // --- Event Listeners ---

    showControllerBtn.addEventListener('click', () => {
        // Find the currently active tab in the current window.
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0] && tabs[0].id) {
                // Send a message to the content script in that tab.
                chrome.tabs.sendMessage(tabs[0].id, { action: 'show_ui' })
                    .then(() => {
                        // If the message is sent successfully, it means the UI was shown.
                        // We can now close the popup.
                        window.close();
                    })
                    .catch(error => {
                        // This error is expected if the content script isn't on the page.
                        if (error.message.includes('Receiving end does not exist')) {
                            showStatus('Controller not available on this page.', true);
                        }
                    });
            }
        });
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
                populateRemoveDropdown(); // Refresh the list
            } else {
                showStatus(response.error || 'An unknown error occurred.', true);
            }
        });
    });

    newFolderNameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            createFolderBtn.click();
        }
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
                populateRemoveDropdown(); // Refresh the list
            } else {
                showStatus(response.error || 'An unknown error occurred.', true);
            }
        });
    });

    removeFolderSelect.addEventListener('change', updateRemoveButtonState);

    // --- Initial Setup ---
    populateRemoveDropdown();
    updateRemoveButtonState(); // Set initial state
});