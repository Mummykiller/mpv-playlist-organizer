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
			this.isLiveReorderModeActive = false;
			this.reorderDebounceTimer = null;
			this._renderGeneration = 0;
			this._transientTimers = new Set();
			this._isDestroyed = false;
		}

		_scheduleTransientTimer(fn, delayMs) {
			const id = setTimeout(() => {
				this._transientTimers.delete(id);
				if (!this._isDestroyed) fn();
			}, delayMs);
			this._transientTimers.add(id);
			return id;
		}

		bindEvents() {
			this._bindPlaylistControls();
			this._bindPlaylistDragAndDrop();
		}

		render(playlist, lastPlayedId, isFolderActive = false, completedIds = []) {
			const renderGen = (this._renderGeneration = (this._renderGeneration || 0) + 1);
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

			if (!this.fullContainer || !this.controller.checkContext()) return;

			// Optimization: Fetch all potentially relevant cache shards in one go
			const domains = new Set(effectivePlaylist.map(item => {
				try { return new URL(item.url).hostname; } catch(e) { return null; }
			}).filter(Boolean));
			
			const storageKeys = Array.from(domains).map(d => `mpv_meta_cache_${d.replace(/[^a-zA-Z0-9.-]/g, "_")}`);
			
			chrome.storage.local.get(storageKeys, (cacheData) => {
				if (renderGen !== this._renderGeneration || !this.controller.checkContext()) return;
				const oldItemCount =
					this.fullContainer.querySelectorAll(".list-item").length;
				const scrollPosition = this.fullContainer.scrollTop;

				// Clear container efficiently
				while (this.fullContainer.firstChild) {
					this.fullContainer.removeChild(this.fullContainer.lastChild);
				}

				this._renderQuickActions();

				if (effectivePlaylist && effectivePlaylist.length > 0) {
					const highlightEnabled =
						this.controller.state.state.settings?.enableActiveItemHighlight ??
						true;
					const showWatchedGUI =
						this.controller.state.state.settings?.showWatchedStatusGui ?? true;

					const fragment = document.createDocumentFragment();

					effectivePlaylist.forEach((item, index) => {
						// LAYER 0: ENRICH FROM CACHE INSTANTLY
						if (!item.title || item.title === item.url) {
							try {
								const domain = new URL(item.url).hostname;
								const storageKey = `mpv_meta_cache_${domain.replace(/[^a-zA-Z0-9.-]/g, "_")}`;
								const shard = cacheData[storageKey];
								if (shard && shard[item.url]) {
									const cached = shard[item.url];
									item.title = cached.title || item.title;
									// Optionally pull headers/covers if we add them to UI later
								}
							} catch(e) {
								console.debug("[PlaylistUI] Failed to parse URL for cache lookup:", e);
							}
						}

						const itemDiv = MPV.domUtils.createPlaylistItemElement(item, index, {
							highlightEnabled,
							lastPlayedId,
							isActive: isFolderActive,
							showCopyButton: !!this.controller.state.state.settings.showCopyTitleButton,
							showWatchedGui: showWatchedGUI,
							setUrlTitle: true,
							checkboxBeforeTitle: true,
							onWatchedToggle: (id, checked) => {
								this.controller.handleWatchedToggle(id, checked);
							},
						});

						fragment.appendChild(itemDiv);
					});

					this.fullContainer.appendChild(fragment);
				} else {
					const placeholder = document.createElement("p");
					placeholder.id = "playlist-placeholder";
					placeholder.textContent = "Playlist is empty.";
					this.fullContainer.appendChild(placeholder);
				}

				const newItemCount = effectivePlaylist ? effectivePlaylist.length : 0;
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
			});
		}

		_renderQuickActions() {
			const bar = this.uiManager.shadowRoot?.getElementById("quick-actions-bar");
			if (!bar) return;
			
			bar.innerHTML = "";
			// Reset classes to ensure mutual exclusivity
			bar.className = "quick-actions-bar";

			const labels = ["A", "C", "⚡"];
			labels.forEach((label, index) => {
				const btn = document.createElement("button");
				btn.className = "quick-action-btn";
				
				const isA = label === "A";
				const isLast = label === "⚡";

				if (isA) {
					btn.id = "btn-osc-quick-a";
					btn.innerHTML = `
						<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<polygon points="19 20 9 12 19 4 19 20"></polygon>
							<line x1="5" y1="19" x2="5" y2="5"></line>
						</svg>
					`;
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
						this.isLiveReorderModeActive = false;
						this.isPickStartModeActive = !this.isPickStartModeActive;
						this._refreshQuickActionsBar();
					};
				} else if (label === "C") {
					btn.id = "btn-osc-quick-c";
					btn.innerHTML = `
						<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<line x1="3" y1="12" x2="21" y2="12"></line>
							<line x1="3" y1="6" x2="21" y2="6"></line>
							<line x1="3" y1="18" x2="21" y2="18"></line>
						</svg>
					`;
					btn.title = "Live Reorder: Mirror changes to MPV | Right-click: Smart Reorder";
					btn.onclick = (e) => {
						e.stopPropagation();
						// ENFORCE MUTUAL EXCLUSIVITY
						this.isPickStartModeActive = false;
						this.isSelectionModeActive = false;
						this.isLiveReorderModeActive = !this.isLiveReorderModeActive;
						this._refreshQuickActionsBar();
					};

					btn.oncontextmenu = (e) => {
						this.controller.handleSmartReorder(e, btn);
					};
				} else if (isLast) {
					btn.id = "btn-osc-quick-d";
					btn.innerHTML = `
						<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
						</svg>
					`;
					btn.title = "Detached Launch (Selection Mode): Click here, then click any item below to open it in a separate MPV window";
					btn.classList.add("btn-disconnected-toggle");
					btn.onclick = (e) => {
						e.stopPropagation();
						
						// ENFORCE MUTUAL EXCLUSIVITY
						this.isPickStartModeActive = false;
						this.isLiveReorderModeActive = false;
						this.isSelectionModeActive = !this.isSelectionModeActive;
						this._refreshQuickActionsBar();
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
			bar.classList.toggle("live-reorder-active", this.isLiveReorderModeActive);
			
			// Handle Container Classes (Global observer for list items)
			const container = this.fullContainer || this.uiManager.shadowRoot?.getElementById("playlist-container");
			if (container) {
				container.classList.toggle("selection-mode-active", this.isSelectionModeActive);
				container.classList.toggle("pick-start-mode-active", this.isPickStartModeActive);
				container.classList.toggle("live-reorder-active", this.isLiveReorderModeActive);
			}

			// Handle individual button active states
			const buttons = bar.querySelectorAll(".quick-action-btn");
			buttons.forEach(btn => {
				if (btn.id === "btn-osc-quick-a") {
					btn.classList.toggle("active", this.isPickStartModeActive);
				} else if (btn.id === "btn-osc-quick-c") {
					btn.classList.toggle("active", this.isLiveReorderModeActive);
				} else if (btn.classList.contains("btn-disconnected-toggle")) {
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
						this._refreshQuickActionsBar();
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
							this._scheduleTransientTimer(() => listItem.classList.remove("title-copied"), 1500);
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
					this._scheduleTransientTimer(() => this.draggedItem?.classList.add("dragging"), 0);
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
				if (!this.draggedItem) return;
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
				
				const playlistItems = [...this.fullContainer.querySelectorAll(".list-item")];
				playlistItems.forEach((item, idx) => {
					item.dataset.index = idx;
					const indexSpan = item.querySelector(".url-index");
					if (indexSpan) indexSpan.textContent = `${idx + 1}.`;
					const removeBtn = item.querySelector(".btn-remove-item");
					if (removeBtn) removeBtn.dataset.index = idx;
				});
				const newOrder = playlistItems.map((item) => {
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
				this.currentPlaylist = newOrder;
				
				// Always save to browser storage immediately
				this.controller.sendCommandToBackground(
					"set_playlist_order",
					folderId,
					{ data: { order: newOrder } },
				);

				// If Live Reorder mode is active, also sync to MPV with a 2s debounce
				if (this.isLiveReorderModeActive) {
					if (this.reorderDebounceTimer) clearTimeout(this.reorderDebounceTimer);
					
					this.reorderDebounceTimer = setTimeout(() => {
						this.reorderDebounceTimer = null;
						if (this._isDestroyed || !this.controller.checkContext()) return;
						const itemIds = newOrder.map(item => item.id);
						this.controller.sendCommandToBackground("reorder_live", folderId, {
							new_order: itemIds
						}).catch((err) => {
							this.controller.addLogEntry({ text: "[UI]: Live reorder sync failed: " + err.message, type: "error" });
						});
					}, 2000);
				}
			});
		}

		_getDragAfterElement(container, y) {
			return MPV.domUtils.getDragAfterElement(container, y);
		}

		/**
		 * Delta update for a single item DOM node.
		 */
		updateItemDelta(itemId, delta) {
			if (!this.fullContainer) return;
			const safeId = typeof CSS !== "undefined" && typeof CSS.escape === "function"
				? CSS.escape(String(itemId ?? ""))
				: String(itemId ?? "").replace(/["\\]/g, "\\$&");
			const itemDiv = this.fullContainer.querySelector(`[data-id="${safeId}"]`);
			if (!itemDiv) return;

			// Update internal state copy if it exists
			const internalItem = this.currentPlaylist.find(i => i.id === itemId);
			if (internalItem) Object.assign(internalItem, delta);

			MPV.domUtils.updateItemDelta(itemDiv, delta);
		}

		destroy() {
			this._isDestroyed = true;
			this._renderGeneration++;
			if (this.reorderDebounceTimer) {
				clearTimeout(this.reorderDebounceTimer);
				this.reorderDebounceTimer = null;
			}
			for (const id of this._transientTimers) {
				clearTimeout(id);
			}
			this._transientTimers.clear();
			this.draggedItem = null;
		}
	};
})();
