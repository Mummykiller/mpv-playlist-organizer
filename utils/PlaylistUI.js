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
		}

		bindEvents() {
			this._bindPlaylistControls();
			this._bindPlaylistDragAndDrop();
		}

		render(playlist, lastPlayedId, isFolderActive = false) {
			this.currentPlaylist = playlist || [];
			if (this.itemCountSpan)
				this.itemCountSpan.textContent = playlist?.length || 0;
			if (this.minimizedPlayBtn && this.minimizedCountSpan) {
				const count = playlist?.length || 0;
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

			if (playlist && playlist.length > 0) {
				const highlightEnabled =
					this.controller.state.state.settings?.enable_active_item_highlight ??
					true;
				const showWatchedGUI =
					this.controller.state.state.settings?.show_watched_status_gui ?? true;

				// Use DocumentFragment to minimize reflows during bulk DOM updates
				const fragment = document.createDocumentFragment();

				playlist.forEach((item, index) => {
					const itemDiv = document.createElement("div");
					itemDiv.className = "list-item";
					
					const isCurrent = item.currently_playing || (lastPlayedId && item.id === lastPlayedId);
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
					if (this.controller.state.state.settings.show_copy_title_button) {
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
						watchedCheckbox.checked = !item.marked_as_watched;
						watchedCheckbox.title = watchedCheckbox.checked
							? "Will mark as watched on YouTube"
							: "Already marked or skipped";

						watchedCheckbox.addEventListener("change", (e) => {
							e.stopPropagation();
							this.controller.handleWatchedToggle(
								item.id,
								watchedCheckbox.checked,
							);
						});
						itemDiv.appendChild(watchedCheckbox);
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

		/**
		 * Efficiently updates the active/last-played highlight classes without a full re-render.
		 */
		syncActiveHighlight(lastPlayedId, isFolderActive) {
			if (!this.fullContainer) return;

			const highlightEnabled =
				this.controller.state.state.settings?.enable_active_item_highlight ??
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
				const removeBtn = e.target.closest(".btn-remove-item");
				const copyBtn = e.target.closest(".btn-copy-item");

				if (removeBtn) {
					const listItem = removeBtn.closest(".list-item");
					const index = parseInt(removeBtn.dataset.index, 10);
					const itemId = listItem?.dataset.id;
					const folderId = this.folderSelect.value;

					if (!isNaN(index) && listItem) {
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
				if (!this.controller.state.state.settings.enable_dblclick_copy) return;
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
	};
})();
