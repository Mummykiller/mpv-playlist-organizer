/**
 * @class PlaylistUI
 */
window.MPV_INTERNAL = window.MPV_INTERNAL || {};

(() => {
	const MPV = window.MPV_INTERNAL;
	window.MPV_INTERNAL.PlaylistUI = class PlaylistUI {
		constructor(controller, uiManager) {
			this.controller = controller;
			this.uiManager = uiManager;
			this.fullContainer =
				this.uiManager.shadowRoot?.getElementById("playlist-container");
			this.itemCountSpan =
				this.uiManager.shadowRoot?.getElementById("compact-item-count");
			this.minimizedPlayBtn =
				this.uiManager.minimizedHost?.shadowRoot?.getElementById(
					"m3u8-minimized-play-btn",
				);
			this.minimizedCountSpan =
				this.uiManager.minimizedHost?.shadowRoot?.getElementById(
					"m3u8-minimized-item-count",
				);
			this.folderSelect =
				this.uiManager.shadowRoot?.getElementById("folder-select");
			this.compactFolderSelect = this.uiManager.shadowRoot?.getElementById(
				"compact-folder-select",
			);
			this.draggedItem = null;
			this.currentPlaylist = [];
			this.isSelectionModeActive = false;
			this.isPickStartModeActive = false;
		}

		bindEvents() {
			this._bindPlaylistControls();
			this._bindPlaylistDragAndDrop();
		}

		render(playlist, lastPlayedId, isFolderActive = false, completedIds = []) {
			const completedSet = new Set(completedIds || []);
			let effectivePlaylist = playlist || [];
			
			// Visual filtering for staged items
			if (completedSet.size > 0) {
				effectivePlaylist = effectivePlaylist.filter(item => !completedSet.has(item.id));
			}

			this.currentPlaylist = effectivePlaylist;
			if (this.itemCountSpan)
				this.itemCountSpan.textContent = effectivePlaylist?.length || 0;
			if (this.minimizedPlayBtn && this.minimizedCountSpan) {
				const count = effectivePlaylist?.length || 0;
				this.minimizedCountSpan.textContent = count;
				this.minimizedCountSpan.style.display = "inline";
				this.minimizedPlayBtn.classList.add("with-counter");
			}

			// Proactively update state with the latest IDs
			if (lastPlayedId) {
				this.controller.state.update({ lastPlayedId: lastPlayedId }, true);
			}

			if (!this.fullContainer) return;

			const oldItemCount =
				this.fullContainer.querySelectorAll(".list-item").length;
			const scrollPosition = this.fullContainer.scrollTop;

			// Clear container efficiently
			while (this.fullContainer.firstChild) {
				this.fullContainer.removeChild(this.fullContainer.lastChild);
			}

			this._renderQuickActions();

			if (playlist && playlist.length > 0) {
				const highlightEnabled =
					this.controller.state.state.settings?.enableActiveItemHighlight ??
					true;
				const showWatchedGUI =
					this.controller.state.state.settings?.showWatchedStatusGui ?? true;

				// Use DocumentFragment to minimize reflows during bulk DOM updates
				const fragment = document.createDocumentFragment();

				playlist.forEach((item, index) => {
					const itemDiv = document.createElement("div");
					itemDiv.className = "list-item";
					
					// UI Change: Only gray out if PERSONALLY watched
					if (item.watched) {
						itemDiv.classList.add("item-watched");
					}
					
					const isCurrent = item.currentlyPlaying || (lastPlayedId && item.id === lastPlayedId);
					if (highlightEnabled && isCurrent) {
						itemDiv.classList.add(
							isFolderActive ? "active-item" : "last-played-item",
						);
					}
					itemDiv.draggable = true;
					itemDiv.title = item.url;
					itemDiv.dataset.url = item.url;
					itemDiv.dataset.title = item.title;
					itemDiv.dataset.id = item.id || "";

					// 1. Copy URL Button
					if (this.controller.state.state.settings.showCopyTitleButton) {
						const copyBtn = document.createElement("button");
						copyBtn.className = "btn-copy-item";
						copyBtn.dataset.url = item.url;
						copyBtn.title = "Copy URL";
						copyBtn.innerHTML =
							'<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
						itemDiv.appendChild(copyBtn);
					}

					const indexSpan = document.createElement("span");
					indexSpan.className = "url-index";
					indexSpan.textContent = `${index + 1}.`;
					itemDiv.appendChild(indexSpan);

					const isYouTube = item.url.includes("youtube.com/") || item.url.includes("youtu.be/");

					if (item.watched && !isYouTube) {
						const check = document.createElement("span");
						check.className = "watched-checkmark index-checkmark";
						check.innerHTML = "✔";
						itemDiv.appendChild(check);
					}

					const urlSpan = document.createElement("span");
					urlSpan.className = "url-text";
					this._formatTitle(urlSpan, item);

					// --- Watched Status Checkbox ---
					if (
						showWatchedGUI &&
						(item.url.includes("youtube.com/") ||
							item.url.includes("youtu.be/"))
					) {
						const watchedCheckbox = document.createElement("input");
						watchedCheckbox.type = "checkbox";
						watchedCheckbox.className = "item-watched-checkbox";
						// UI Change: Checkbox only reflects SYNC status
						watchedCheckbox.checked = !!item.markedAsWatched;
						watchedCheckbox.title = watchedCheckbox.checked
							? "Already marked as watched"
							: "Click to mark as watched on YouTube";

						watchedCheckbox.addEventListener("change", (e) => {
							e.stopPropagation();
							this.controller.handleWatchedToggle(
								item.id,
								watchedCheckbox.checked,
							);
						});
						itemDiv.appendChild(watchedCheckbox);

						if (item.watched) {
							const check = document.createElement("span");
							check.className = "watched-checkmark checkbox-checkmark";
							check.innerHTML = "✔";
							itemDiv.appendChild(check);
						}
					}

					itemDiv.appendChild(urlSpan);

					const removeBtn = document.createElement("button");
					removeBtn.className = "btn-remove-item";
					removeBtn.dataset.index = index;
					removeBtn.title = "Remove Item";
					removeBtn.textContent = "×";
					itemDiv.appendChild(removeBtn);

					fragment.appendChild(itemDiv);
				});

				this.fullContainer.appendChild(fragment);
			} else {
				const placeholder = document.createElement("p");
				placeholder.id = "playlist-placeholder";
				placeholder.textContent = "Playlist is empty.";
				this.fullContainer.appendChild(placeholder);
			}

			const newItemCount = playlist ? playlist.length : 0;
			if (
				newItemCount > oldItemCount &&
				this.fullContainer.scrollHeight > this.fullContainer.clientHeight
			) {
				this.fullContainer.scrollTop = this.fullContainer.scrollHeight;
			} else if (isFolderActive && lastPlayedId) {
				const activeItem = this.fullContainer.querySelector(".active-item");
				if (activeItem)
					activeItem.scrollIntoView({ behavior: "smooth", block: "center" });
				else this.fullContainer.scrollTop = scrollPosition;
			} else {
				this.fullContainer.scrollTop = scrollPosition;
			}
			this.controller.updateAddButtonState();
		}

		_renderQuickActions() {
			const bar = this.uiManager.shadowRoot?.getElementById("quick-actions-bar");
			if (!bar) return;
			
			bar.innerHTML = "";
			// Reset classes to ensure mutual exclusivity
			bar.className = "quick-actions-bar";

			const labels = ["A", "B", "C", "⚡"];
			labels.forEach((label, index) => {
				const btn = document.createElement("button");
				btn.className = "quick-action-btn";
				btn.textContent = label;
				
				const isA = label === "A";
				const isLast = label === "⚡";

				if (isA) {
					btn.title = "Left-click: Play from start | Right-click: Pick start item";
					btn.classList.add("btn-start-from-beginning");

					btn.onclick = (e) => {
						e.stopPropagation();
						if (this.isPickStartModeActive) {
							this.isPickStartModeActive = false;
							this._refreshQuickActionsBar();
							return;
						}
						
						if (this.currentPlaylist.length > 0) {
							const firstItem = this.currentPlaylist[0];
							this.controller.sendCommandToBackground("play", this.folderSelect.value, {
								urlItem: firstItem,
								playlistStartId: firstItem.id
							});
						} else {
							this.controller.addLogEntry({ text: "[UI]: Cannot play from start - Playlist is empty.", type: "warning" });
						}
					};

					btn.oncontextmenu = (e) => {
						e.preventDefault();
						e.stopPropagation();
						
						// ENFORCE MUTUAL EXCLUSIVITY
						this.isSelectionModeActive = false;
						this.isPickStartModeActive = !this.isPickStartModeActive;
						this._refreshQuickActionsBar();
					};
				} else if (isLast) {
					btn.title = "Toggle Disconnected Launch (Selection Mode)";
					btn.classList.add("btn-disconnected-toggle");
					btn.onclick = (e) => {
						e.stopPropagation();
						
						// ENFORCE MUTUAL EXCLUSIVITY
						this.isPickStartModeActive = false;
						this.isSelectionModeActive = !this.isSelectionModeActive;
						this._refreshQuickActionsBar();
					};
				} else {
					btn.title = "Placeholder " + label;
					btn.onclick = (e) => {
						e.stopPropagation();
						console.log(`Quick Action ${label} clicked`);
					};
				}
				bar.appendChild(btn);
			});

			this._refreshQuickActionsBar();
		}

		/**
		 * Helper to refresh the visual state of the quick actions bar and playlist container.
		 */
		_refreshQuickActionsBar() {
			const bar = this.uiManager.shadowRoot?.getElementById("quick-actions-bar");
			if (!bar) return;

			// Handle Bar Classes
			bar.classList.toggle("selection-mode-active", this.isSelectionModeActive);
			bar.classList.toggle("pick-start-mode-active", this.isPickStartModeActive);
			
			// Handle Container Classes (Global observer for list items)
			const container = this.fullContainer || this.uiManager.shadowRoot?.getElementById("playlist-container");
			if (container) {
				container.classList.toggle("selection-mode-active", this.isSelectionModeActive);
				container.classList.toggle("pick-start-mode-active", this.isPickStartModeActive);
			}

			// Handle individual button active states
			const buttons = bar.querySelectorAll(".quick-action-btn");
			buttons.forEach(btn => {
				if (btn.textContent === "A") {
					btn.classList.toggle("active", this.isPickStartModeActive);
				} else if (btn.textContent === "⚡") {
					btn.classList.toggle("active", this.isSelectionModeActive);
				}
			});
		}

		/**
		 * Efficiently updates the active/last-played highlight classes without a full re-render.
		 */
		syncActiveHighlight(lastPlayedId, isFolderActive) {
			if (!this.fullContainer) return;

			const highlightEnabled =
				this.controller.state.state.settings?.enableActiveItemHighlight ??
				true;

			this.fullContainer.querySelectorAll(".list-item").forEach((item) => {
				const itemId = item.dataset.id;
				item.classList.remove("active-item", "last-played-item");

				if (highlightEnabled && lastPlayedId && itemId === lastPlayedId) {
					item.classList.add(
						isFolderActive ? "active-item" : "last-played-item",
					);
					if (isFolderActive) {
						item.scrollIntoView({ behavior: "smooth", block: "center" });
					}
				}
			});
		}

		_bindPlaylistControls() {
			if (
				!this.fullContainer ||
				!this.folderSelect ||
				!this.compactFolderSelect
			)
				return;
			const handleFolderChange = (newFolderId) => {
				if (!this.controller.checkContext()) return;
				this.folderSelect.value = newFolderId;
				this.compactFolderSelect.value = newFolderId;

				// Reset UI state for the new folder
				MPV.playbackStateManager.update({
					folderId: newFolderId,
					isRunning: false,
					isIdle: false,
					isPaused: false,
					isClosing: false
				});

				chrome.runtime.sendMessage({
					action: "set_last_folder_id",
					folderId: newFolderId,
				});
				this.controller.refreshPlaylist();
			};
			this.folderSelect.addEventListener("change", () =>
				handleFolderChange(this.folderSelect.value),
			);
			this.compactFolderSelect.addEventListener("change", () =>
				handleFolderChange(this.compactFolderSelect.value),
			);
			this.fullContainer.addEventListener("click", (e) => {
				const listItem = e.target.closest(".list-item");
				if (!listItem) return;

				const removeBtn = e.target.closest(".btn-remove-item");
				const copyBtn = e.target.closest(".btn-copy-item");
				const watchedCheckbox = e.target.closest(".item-watched-checkbox");

				// Handle Button A selection mode (Pick Start Item)
				if (this.isPickStartModeActive && !removeBtn && !copyBtn && !watchedCheckbox) {
					const id = listItem.dataset.id;
					const fullItem = this.currentPlaylist.find(i => i.id === id);

					if (fullItem) {
						this.controller.sendCommandToBackground("play", this.folderSelect.value, {
							urlItem: fullItem,
							playlistStartId: fullItem.id
						});
						this.isPickStartModeActive = false;
						this._refreshQuickActionsBar();
					}
					return;
				}

				// Handle Selection Mode (Disconnected Launch)
				if (this.isSelectionModeActive && !removeBtn && !copyBtn && !watchedCheckbox) {
					const id = listItem.dataset.id;
					const fullItem = this.currentPlaylist.find(i => i.id === id);

					if (fullItem) {
						this.controller.sendCommandToBackground("play_new_instance", this.folderSelect.value, {
							urlItem: fullItem,
							playNewInstance: true,
							folderId: this.folderSelect.value
						});
						this.isSelectionModeActive = false;
						this.fullContainer?.classList.remove("selection-mode-active");
						this.uiManager.shadowRoot?.querySelectorAll(".quick-action-btn.selection-mode-active").forEach(el => el.classList.remove("selection-mode-active"));
						this.uiManager.shadowRoot?.getElementById("quick-actions-bar")?.classList.remove("selection-mode-active");
					}
					return;
				}

				// Standard Actions
				if (removeBtn) {
					const index = parseInt(removeBtn.dataset.index, 10);
					const itemId = listItem.dataset.id;
					const folderId = this.folderSelect.value;

					if (!isNaN(index)) {
						// Optimistic UI update: fade out immediately
						listItem.classList.add("removing");

						// Send both index and ID for robustness
						this.controller
							.sendCommandToBackground("remove_item", folderId, {
								data: { index, id: itemId },
							})
							.catch((err) => {
								// Rollback on error
								listItem.classList.remove("removing");
								this.controller.addLogEntry({
									text: `[Content]: Failed to remove item: ${err.message}`,
									type: "error",
								});
							});
					}
				} else if (copyBtn) {
					const url = copyBtn.dataset.url;
					if (url) {
						navigator.clipboard
							.writeText(url)
							.then(() =>
								this.controller.addLogEntry({
									text: "[Content]: Copied URL to clipboard.",
									type: "info",
								}),
							)
							.catch((err) =>
								this.controller.addLogEntry({
									text: `[Content]: Failed to copy URL: ${err}`,
									type: "error",
								}),
							);
					}
				}
			});

			this.fullContainer.addEventListener("dblclick", (e) => {
				if (!this.controller.state.state.settings.enableDblclickCopy) return;
				const listItem = e.target.closest(".list-item");
				if (listItem && listItem.dataset.title) {
					navigator.clipboard
						.writeText(listItem.dataset.title)
						.then(() => {
							this.controller.addLogEntry({
								text: "[Content]: Copied title to clipboard.",
								type: "info",
							});
							listItem.classList.add("title-copied");
							setTimeout(() => listItem.classList.remove("title-copied"), 1500);
						})
						.catch((err) =>
							this.controller.addLogEntry({
								text: `[Content]: Failed to copy title: ${err}`,
								type: "error",
							}),
						);
				}
			});
		}

		_bindPlaylistDragAndDrop() {
			if (!this.fullContainer) return;
			this.fullContainer.addEventListener("dragstart", (e) => {
				if (e.target.classList.contains("list-item")) {
					this.draggedItem = e.target;
					setTimeout(() => this.draggedItem.classList.add("dragging"), 0);
					const url = e.target.dataset.url;
					if (url) {
						e.dataTransfer.setData("text/plain", url);
					}
				}
			});
			this.fullContainer.addEventListener("dragend", () => {
				if (this.draggedItem) {
					this.draggedItem.classList.remove("dragging");
					this.draggedItem = null;
				}
			});
			this.fullContainer.addEventListener("dragover", (e) => {
				e.preventDefault();
				const existingIndicator =
					this.fullContainer.querySelector(".drag-over");
				if (existingIndicator) existingIndicator.classList.remove("drag-over");
				const afterElement = this._getDragAfterElement(
					this.fullContainer,
					e.clientY,
				);
				if (afterElement) afterElement.classList.add("drag-over");
			});
			this.fullContainer.addEventListener("drop", (e) => {
				e.preventDefault();
				if (!this.draggedItem || !this.controller.checkContext()) return;
				const dropTarget = this.fullContainer.querySelector(".drag-over");
				if (dropTarget) dropTarget.classList.remove("drag-over");
				this.fullContainer.insertBefore(this.draggedItem, dropTarget);
				const folderId = this.folderSelect.value;
				if (!folderId) return;
				const newOrder = [
					...this.fullContainer.querySelectorAll(".list-item"),
				].map((item) => {
					const originalItem = this.currentPlaylist.find(
						(i) => i.id === item.dataset.id,
					);
					// Return the full original item to preserve metadata, or fallback to basic data
					return (
						originalItem || {
							url: item.dataset.url,
							title: item.dataset.title,
							id: item.dataset.id,
						}
					);
				});
				this.controller.sendCommandToBackground(
					"set_playlist_order",
					folderId,
					{ data: { order: newOrder } },
				);
			});
		}

		_getDragAfterElement(container, y) {
			const draggableElements = [
				...container.querySelectorAll(".list-item:not(.dragging)"),
			];
			return draggableElements.reduce(
				(closest, child) => {
					const box = child.getBoundingClientRect();
					const offset = y - box.top - box.height / 2;
					if (offset < 0 && offset > closest.offset)
						return { offset: offset, element: child };
					else return closest;
				},
				{ offset: Number.NEGATIVE_INFINITY },
			).element;
		}

	_formatTitle(urlSpan, item) {
			if (!item.title) {
				urlSpan.textContent = item.url;
				return;
			}
			const titleParts = item.title.split(" - ");
			const isYT = item.url.includes("youtube.com/");
			if (
				titleParts.length > 1 &&
				(/^(s\d+)?e\d+(\.\d+)?$/i.test(titleParts[0].trim()) || isYT)
			) {
				const prefix = document.createElement("span");
				prefix.textContent = titleParts.shift() + " - ";
				const main = document.createElement("span");
				main.className = "main-title-highlight";
				main.textContent = titleParts.join(" - ");
				urlSpan.append(prefix, main);
			} else {
				urlSpan.textContent = item.title;
			}
		}

		/**
		 * Delta update for a single item DOM node.
		 */
		updateItemDelta(itemId, delta) {
			if (!this.fullContainer) return;
			const itemDiv = this.fullContainer.querySelector(`[data-id="${itemId}"]`);
			if (!itemDiv) return;

			// Update internal state copy if it exists
			const internalItem = this.currentPlaylist.find(i => i.id === itemId);
			if (internalItem) Object.assign(internalItem, delta);

			const isYouTube = itemDiv.dataset.url?.includes("youtube.com") || itemDiv.dataset.url?.includes("youtu.be");

			// 1. Gray out (watched)
			if (delta.watched !== undefined) {
				itemDiv.classList.toggle("item-watched", !!delta.watched);
				
				const existingIndexCheck = itemDiv.querySelector(".index-checkmark");
				if (delta.watched && !isYouTube && !existingIndexCheck) {
					const check = document.createElement("span");
					check.className = "watched-checkmark index-checkmark";
					check.innerHTML = "✔";
					const indexSpan = itemDiv.querySelector(".url-index");
					if (indexSpan) indexSpan.after(check);
				} else if (!delta.watched && existingIndexCheck) {
					existingIndexCheck.remove();
				}
			}

			// 2. Checkbox & Checkmark (markedAsWatched vs watched)
			if (delta.markedAsWatched !== undefined || delta.watched !== undefined) {
				const checkbox = itemDiv.querySelector(".item-watched-checkbox");
				
				// Checkbox strictly follows sync status
				if (delta.markedAsWatched !== undefined && checkbox) {
					checkbox.checked = !!delta.markedAsWatched;
					checkbox.title = delta.markedAsWatched ? "Already marked as watched" : "Click to mark as watched on YouTube";
				}

				// Checkmark strictly follows local watched status
				const existingCheckboxCheck = itemDiv.querySelector(".checkbox-checkmark");
				if (isYouTube && checkbox) {
					const currentlyWatched = delta.watched !== undefined ? delta.watched : !!itemDiv.classList.contains("item-watched");
					
					if (currentlyWatched && !existingCheckboxCheck) {
						const check = document.createElement("span");
						check.className = "watched-checkmark checkbox-checkmark";
						check.innerHTML = "✔";
						checkbox.after(check);
					} else if (!currentlyWatched && existingCheckboxCheck) {
						existingCheckboxCheck.remove();
					}
				}
			}
		}
	};
})();
