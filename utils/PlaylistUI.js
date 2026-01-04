/**
 * @class PlaylistUI
 * Manages the rendering and event handling for the playlist component.
 */
class PlaylistUI {
    /**
     * @param {MpvController} controller - The main controller instance.
     * @param {UIManager} uiManager - The UI manager instance.
     */
    constructor(controller, uiManager) {
        this.controller = controller;
        this.uiManager = uiManager;

        // --- Element References ---
        this.fullContainer = this.uiManager.shadowRoot?.getElementById('playlist-container');
        this.itemCountSpan = this.uiManager.shadowRoot?.getElementById('compact-item-count');
        this.minimizedPlayBtn = this.uiManager.minimizedHost?.shadowRoot?.getElementById('m3u8-minimized-play-btn');
        this.minimizedCountSpan = this.uiManager.minimizedHost?.shadowRoot?.getElementById('m3u8-minimized-item-count');
        this.folderSelect = this.uiManager.shadowRoot?.getElementById('folder-select');
        this.compactFolderSelect = this.uiManager.shadowRoot?.getElementById('compact-folder-select');

        // --- State ---
        this.draggedItem = null;
        this.currentPlaylist = [];
    }

    /**
     * Binds all event listeners related to the playlist.
     */
    bindEvents() {
        this._bindPlaylistControls();
        this._bindPlaylistDragAndDrop();
    }

    /**
     * Renders the playlist items in the UI and updates counts.
     * @param {Array<object>} playlist - The array of playlist items.
     * @param {string} [lastPlayedId] - The ID of the last played item to highlight.
     * @param {boolean} [isFolderActive] - Whether this folder is currently being played.
     */
    render(playlist, lastPlayedId, isFolderActive = false) {
        this.currentPlaylist = playlist || [];
        // Update compact UI count
        if (this.itemCountSpan) this.itemCountSpan.textContent = playlist?.length || 0;

        // Update minimized UI count
        if (this.minimizedPlayBtn && this.minimizedCountSpan) {
            const count = playlist?.length || 0;
            this.minimizedCountSpan.textContent = count;
            this.minimizedCountSpan.style.display = 'inline';
            this.minimizedPlayBtn.classList.add('with-counter');
        }

        if (!this.fullContainer) return;

        const oldItemCount = this.fullContainer.querySelectorAll('.list-item').length;
        const scrollPosition = this.fullContainer.scrollTop;
        this.fullContainer.innerHTML = ''; // Clear existing content

        if (playlist && playlist.length > 0) {
            const highlightEnabled = this.controller.settings?.enable_active_item_highlight ?? true;
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

                const indexSpan = document.createElement('span');
                indexSpan.className = 'url-index';
                indexSpan.textContent = `${index + 1}.`;

                const copyBtn = document.createElement('button');
                if (this.controller.showCopyTitleButton) {
                    copyBtn.className = 'btn-copy-item';
                    copyBtn.dataset.url = item.url;
                    copyBtn.title = 'Copy URL';
                    copyBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
                }

                const urlSpan = document.createElement('span');
                urlSpan.className = 'url-text';
                this._formatTitle(urlSpan, item);

                const removeBtn = document.createElement('button');
                removeBtn.className = 'btn-remove-item';
                removeBtn.dataset.index = index;
                removeBtn.title = 'Remove Item';
                removeBtn.innerHTML = '&times;';

                if (this.controller.showCopyTitleButton) {
                    itemDiv.appendChild(copyBtn);
                }
                itemDiv.append(indexSpan, urlSpan, removeBtn);
                this.fullContainer.appendChild(itemDiv);
            });
        } else {
            const placeholder = document.createElement('p');
            placeholder.id = 'playlist-placeholder';
            placeholder.textContent = 'Playlist is empty.';
            this.fullContainer.appendChild(placeholder);
        }

        const newItemCount = playlist ? playlist.length : 0;
        const wasItemAdded = newItemCount > oldItemCount;
        const isScrollable = this.fullContainer.scrollHeight > this.fullContainer.clientHeight;

        if (wasItemAdded && isScrollable) {
            // If a new item was added and the list is scrollable, scroll to the bottom.
            this.fullContainer.scrollTop = this.fullContainer.scrollHeight;
        } else if (isFolderActive && lastPlayedId) {
            // If the folder is active, find the active item and scroll it into view (centered).
            const activeItem = this.fullContainer.querySelector('.active-item');
            if (activeItem) {
                activeItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
            } else {
                this.fullContainer.scrollTop = scrollPosition;
            }
        } else {
            // Otherwise, restore the previous scroll position.
            this.fullContainer.scrollTop = scrollPosition;
        }

        this.controller.updateAddButtonState();
    }

    /** @private */
    _bindPlaylistControls() {
        if (!this.fullContainer || !this.folderSelect || !this.compactFolderSelect) return;

        const handleFolderChange = (newFolderId) => {
            if (!this.controller.checkContext()) return;
            this.folderSelect.value = newFolderId;
            this.compactFolderSelect.value = newFolderId;
            chrome.runtime.sendMessage({ action: 'set_last_folder_id', folderId: newFolderId });
            this.controller.refreshPlaylist();
        };
        this.folderSelect.addEventListener('change', () => handleFolderChange(this.folderSelect.value));
        this.compactFolderSelect.addEventListener('change', () => handleFolderChange(this.compactFolderSelect.value));

        this.fullContainer.addEventListener('click', (e) => {
            const removeBtn = e.target.closest('.btn-remove-item');
            const copyBtn = e.target.closest('.btn-copy-item');

            if (removeBtn) {
                const index = parseInt(removeBtn.dataset.index, 10);
                const folderId = this.folderSelect.value;
                if (!isNaN(index)) this.controller.sendCommandToBackground('remove_item', folderId, { data: { index } });
            } else if (copyBtn) {
                const urlToCopy = copyBtn.dataset.url;
                if (urlToCopy) {
                    navigator.clipboard.writeText(urlToCopy)
                        .then(() => this.controller.addLogEntry({ text: `[Content]: Copied URL to clipboard.`, type: 'info' }))
                        .catch(err => this.controller.addLogEntry({ text: `[Content]: Failed to copy URL: ${err}`, type: 'error' }));
                }
            }
        });

        this.fullContainer.addEventListener('dblclick', (e) => {
            if (!this.controller.enableDblclickCopy) return;
            const listItem = e.target.closest('.list-item');
            if (listItem && listItem.dataset.title) {
                navigator.clipboard.writeText(listItem.dataset.title)
                    .then(() => {
                        this.controller.addLogEntry({ text: `[Content]: Copied title to clipboard.`, type: 'info' });
                        listItem.classList.add('title-copied');
                        setTimeout(() => listItem.classList.remove('title-copied'), 1500);
                    })
                    .catch(err => this.controller.addLogEntry({ text: `[Content]: Failed to copy title: ${err}`, type: 'error' }));
            }
        });
    }

    /** @private */
    _bindPlaylistDragAndDrop() {
        if (!this.fullContainer) return;

        this.fullContainer.addEventListener('dragstart', (e) => {
            if (e.target.classList.contains('list-item')) {
                this.draggedItem = e.target;
                setTimeout(() => this.draggedItem.classList.add('dragging'), 0);
                const url = e.target.dataset.url;
                if (url) {
                    e.dataTransfer.setData('text/x-moz-url', url);
                    e.dataTransfer.setData('text/uri-list', url + '\r\n');
                    e.dataTransfer.setData('text/plain', url);
                }
            }
        });

        this.fullContainer.addEventListener('dragend', () => {
            if (this.draggedItem) {
                this.draggedItem.classList.remove('dragging');
                this.draggedItem = null;
            }
        });

        this.fullContainer.addEventListener('dragover', (e) => {
            e.preventDefault();
            const existingIndicator = this.fullContainer.querySelector('.drag-over');
            if (existingIndicator) existingIndicator.classList.remove('drag-over');
            const afterElement = this._getDragAfterElement(this.fullContainer, e.clientY);
            if (afterElement) afterElement.classList.add('drag-over');
        });

        this.fullContainer.addEventListener('drop', (e) => {
            e.preventDefault();
            if (!this.draggedItem || !this.controller.checkContext()) return;

            const dropTarget = this.fullContainer.querySelector('.drag-over');
            if (dropTarget) dropTarget.classList.remove('drag-over');

            this.fullContainer.insertBefore(this.draggedItem, dropTarget);

            const folderId = this.folderSelect.value;
            if (!folderId) return;

            const newOrder = [...this.fullContainer.querySelectorAll('.list-item')].map(item => ({ url: item.dataset.url, title: item.dataset.title }));
            this.controller.sendCommandToBackground('set_playlist_order', folderId, { data: { order: newOrder } });
        });
    }

    /** @private */
    _getDragAfterElement(container, y) {
        const draggableElements = [...container.querySelectorAll('.list-item:not(.dragging)')];
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

    /** @private */
    _formatTitle(urlSpan, item) {
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
}