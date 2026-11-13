/**
 * @class ControllerActions
 * Handles playlist, playback, folder dropdown, and UI action bindings for MpvController.
 */
window.MPV_INTERNAL = window.MPV_INTERNAL || {};

(() => {
	const MPV = window.MPV_INTERNAL;

	MPV.ControllerActions = class ControllerActions {
		constructor(controller) {
			this.controller = controller;
		}

		/**
		 * Safely sets a button's emoji icon and optional label using DOM nodes (no innerHTML).
		 */
		setButtonContent(btn, emoji, labelText = "") {
			if (!btn) return;
			const span = document.createElement("span");
			span.className = "emoji";
			span.textContent = emoji;
			if (labelText) {
				btn.replaceChildren(span, document.createTextNode(` ${labelText}`));
			} else {
				btn.replaceChildren(span);
			}
		}

		async updateFolderDropdowns(targetId, targetLastPlayed, targetIsActive, targetIsPaused, targetNeedsAppend) {
			const c = this.controller;
			const response = await c.bridge.send("get_all_folder_ids");
			if (!response?.success) return;

			const fullSelect = c.ui.shadowRoot?.getElementById("folder-select");
			const compactSelect = c.ui.shadowRoot?.getElementById("compact-folder-select");
			if (!fullSelect || !compactSelect) return;

			const fragment = document.createDocumentFragment();
			response.folderIds.forEach((id, i) => {
				const opt = document.createElement("option");
				opt.value = id;
				opt.textContent = `${i + 1}. ${id}`;
				fragment.appendChild(opt);
			});

			fullSelect.replaceChildren(fragment.cloneNode(true));
			compactSelect.replaceChildren(fragment);

			const selectedId = targetId || response.lastUsedFolderId;
			if (selectedId) {
				fullSelect.value = selectedId;
				compactSelect.value = selectedId;
				c._updateFolderSubscription(selectedId);
			}

			this.refreshPlaylist(targetLastPlayed, targetIsActive, targetIsPaused, targetNeedsAppend);
		}

		refreshPlaylist(targetLastPlayed, targetIsActive, targetIsPaused, targetNeedsAppend, completedIds = []) {
			const c = this.controller;
			const folderId = c.ui.shadowRoot?.getElementById("folder-select")?.value;

			if (folderId) {
				c._updateFolderSubscription(folderId);

				const folderKey = `mpv_folder_data_${folderId}`;
				chrome.storage.local.get([folderKey, "active_playback_state"], (result) => {
					if (c.isTearingDown) return;
					const folderData = result[folderKey] || { playlist: [], lastPlayedId: null };
					const pbState = result.active_playback_state || {};
					const list = folderData.playlist || [];
					const isFolderMatch = pbState.folderId && folderId && pbState.folderId.toLowerCase() === folderId.toLowerCase();
					let computedNeedsAppend = targetNeedsAppend !== undefined
						? targetNeedsAppend
						: (isFolderMatch ? pbState.needsAppend : false);

					if (targetNeedsAppend === undefined && isFolderMatch && pbState.isRunning && Array.isArray(pbState.sessionIds)) {
						const sessionIdsSet = new Set(pbState.sessionIds);
						computedNeedsAppend = list.some(item => !sessionIdsSet.has(item.id));
					}

					const isThisFolderActive = isFolderMatch && (targetIsActive !== undefined ? targetIsActive : pbState.isRunning);
					const isThisFolderPaused = isFolderMatch && (targetIsPaused !== undefined ? targetIsPaused : pbState.isPaused);

					// 1. Update Unified Manager State (only if target is active or folder matches active session)
					if (isFolderMatch || targetIsActive !== undefined) {
						MPV.playbackStateManager.update({
							folderId: folderId,
							lastPlayedId: targetLastPlayed || folderData.lastPlayedId || (isFolderMatch ? pbState.lastPlayedId : null),
							isRunning: targetIsActive !== undefined ? targetIsActive : (isFolderMatch ? pbState.isRunning : false),
							isPaused: targetIsPaused !== undefined ? targetIsPaused : (isFolderMatch ? pbState.isPaused : false),
							needsAppend: computedNeedsAppend,
							sessionIds: isFolderMatch ? pbState.sessionIds : [],
						});
					}

					// Update local controller state and play button visual directly for this folder
					c.state.update({
						isFolderActive: !!isThisFolderActive,
						lastPlayedId: targetLastPlayed || folderData.lastPlayedId || null,
					}, true);
					this.setPlaybackActive(!!isThisFolderActive, isThisFolderActive ? computedNeedsAppend : false, !!isThisFolderPaused);

					// 2. Structural Check: Only re-render if fingerprint changed or completed items need to be hidden
					const newFingerprint = c._getPlaylistFingerprint(list);
					if (newFingerprint !== c._lastPlaylistFingerprint || completedIds.length > 0) {
						c._lastPlaylistFingerprint = newFingerprint;
						c.playlistUI?.render(
							list,
							c.state.state.lastPlayedId,
							c.state.state.isFolderActive,
							completedIds
						);
					} else {
						// Surgical highlight update
						c.playlistUI?.syncActiveHighlight(
							c.state.state.lastPlayedId,
							c.state.state.isFolderActive
						);
					}

					// 3. Sync Add Button State
					c.updateAddButtonState();
				});
			}
		}

		handleWatchedToggle(itemId, isChecked) {
			const c = this.controller;
			const folderId = c.ui.shadowRoot?.getElementById("folder-select")?.value;
			if (!folderId) return;

			const isMarked = isChecked;
			// Manual UI toggle: strictly only update the SYNC flag
			c.bridge.send("update_item_marked_as_watched", folderId, {
				itemId: itemId,
				markedAsWatched: isMarked,
			});

			c.addLogEntry({
				text: `[Content]: ${isMarked ? "Marked" : "Unmarked"} item as synced to YouTube.`,
				type: "info",
			});
		}

		setPlaybackLoading(isLoading) {
			const c = this.controller;
			if (!c.ui.shadowRoot) return;

			// Guard: Do not show loading state if we are already closing.
			if (c.state.state.isClosing) return;

			const isCurrentlyLoading = c.ui.shadowRoot.getElementById("btn-play")?.classList.contains("btn-loading");
			if (isCurrentlyLoading === isLoading) return;

			const playBtns = [
				c.ui.shadowRoot.getElementById("btn-play"),
				c.ui.shadowRoot.getElementById("btn-compact-play"),
				c.ui.minimizedHost?.shadowRoot?.getElementById("m3u8-minimized-play-btn"),
			];
			playBtns.forEach((btn) => {
				if (btn) {
					btn.classList.toggle("btn-loading", isLoading);
					if (isLoading) {
						btn.classList.remove("btn-playing");
					} else {
						const pbState = MPV.playbackStateManager.state;
						if (pbState.isRunning || pbState.needsAppend) {
							btn.classList.add("btn-playing");
						}
					}
				}
			});
		}

		setPlaybackClosing(isClosing) {
			const c = this.controller;
			if (!c.ui.shadowRoot) return;
			c.state.update({ isClosing: isClosing });

			const playBtn = c.ui.shadowRoot.getElementById("btn-play");
			const compactPlayBtn = c.ui.shadowRoot.getElementById("btn-compact-play");
			const minimizedPlayBtn = c.ui.minimizedHost?.shadowRoot?.getElementById("m3u8-minimized-play-btn");

			const playBtns = [playBtn, compactPlayBtn, minimizedPlayBtn];

			playBtns.forEach((btn) => {
				if (btn) {
					btn.classList.toggle("btn-closing", isClosing);
					if (isClosing) {
						btn.classList.remove("btn-playing");
						btn.classList.remove("btn-loading");
						btn.title = "MPV is closing...";
					}
				}
			});

			if (playBtn) {
				if (isClosing) {
					this.setButtonContent(playBtn, "⏳", "Closing...");
				} else if (!c.state.state.isFolderActive) {
					this.setButtonContent(playBtn, "▶️", "Play");
				}
			}
		}

		setPlaybackActive(isActive, needsAppend = false, isPaused = false) {
			const c = this.controller;
			if (!c.ui.shadowRoot) return;

			// If not active, force needsAppend to false to clean up UI
			const effectiveNeedsAppend = isActive ? needsAppend : false;

			c.state.update({
				isFolderActive: isActive,
				needsAppend: effectiveNeedsAppend
			});

			// Guard: If we are in the closing state, do not update UI button text
			// as 'isClosing' has higher visual priority.
			if (c.state.state.isClosing) return;

			const playBtn = c.ui.shadowRoot.getElementById("btn-play");
			const compactPlayBtn = c.ui.shadowRoot.getElementById("btn-compact-play");
			const minimizedPlayBtn = c.ui.minimizedHost?.shadowRoot?.getElementById("m3u8-minimized-play-btn");

			const playBtns = [playBtn, compactPlayBtn, minimizedPlayBtn];
			const visual = MPV.domUtils?.getPlayButtonVisual ? MPV.domUtils.getPlayButtonVisual({
				isActive,
				needsAppend: effectiveNeedsAppend
			}) : {
				isPlaying: !!isActive || (!!isActive && !!effectiveNeedsAppend),
				title: (isActive && effectiveNeedsAppend) ? "Queue to Playlist" : (isActive ? "Play/Pause Playlist" : "Play Playlist"),
				stateKey: (isActive && effectiveNeedsAppend) ? "queue" : (isActive ? "pause" : "play")
			};

			playBtns.forEach((btn) => {
				if (btn) {
					btn.classList.toggle("btn-playing", visual.isPlaying);
					if (visual.isPlaying) {
						this.setPlaybackLoading(false);
					}
					btn.title = visual.title;
				}
			});

			if (!c.state.state.isClosing) {
				if (playBtn) {
					if (visual.stateKey === "queue") {
						this.setButtonContent(playBtn, "➕", "Queue");
					} else if (visual.stateKey === "pause") {
						this.setButtonContent(playBtn, "⏸️", "Play/Pause");
					} else {
						this.setButtonContent(playBtn, "▶️", "Play");
					}
				}
				if (compactPlayBtn) {
					if (visual.stateKey === "queue") {
						this.setButtonContent(compactPlayBtn, "➕");
					} else if (visual.stateKey === "pause") {
						this.setButtonContent(compactPlayBtn, "⏸️");
					} else {
						this.setButtonContent(compactPlayBtn, "▶️");
					}
				}
			}
		}

		async handleSmartReorder(e, btn) {
			const c = this.controller;
			e.preventDefault();
			e.stopPropagation();
			const folderId = c.ui.shadowRoot?.getElementById("folder-select")?.value;
			if (!folderId) return;

			// Stage 2: Sync to MPV (if already glowing)
			if (btn.classList.contains("smart-sync-pending")) {
				const itemIds = c.playlistUI?.currentPlaylist?.map(item => item.id);
				if (!itemIds) return;

				const res = await MPV.MpvInterface.reorderLive(folderId, itemIds);
				if (res.success) {
					c.addLogEntry({ text: "[Content]: MPV playlist synchronized.", type: "info" });
					btn.classList.remove("smart-sync-pending");
					if (btn.dataset.originalTitle) {
						btn.title = btn.dataset.originalTitle;
						delete btn.dataset.originalTitle;
					}
				} else {
					c.addLogEntry({ text: `[Content]: Sync failed: ${res.error}`, type: "error" });
				}
				return;
			}

			// Stage 1: Sort UI
			c.addLogEntry({ text: "[Content]: Calculating smart order...", type: "info" });
			const res = await MPV.MpvInterface.getSmartReorder(folderId);
			if (res.success && res.playlist) {
				c.playlistUI?.render(
					res.playlist,
					c.state.state.lastPlayedId,
					c.state.state.isFolderActive
				);
				c.addLogEntry({ text: "[Content]: Playlist organized. Right-click again to sync MPV.", type: "info" });

				if (c.state.state.isFolderActive) {
					btn.classList.add("smart-sync-pending");
					btn.dataset.originalTitle = btn.title;
					btn.title = "Right-click again to sync MPV playlist";
				}
			} else {
				c.addLogEntry({ text: `[Content]: Smart reorder failed: ${res.error}`, type: "error" });
			}
		}

		sendCommandToBackground(action, folderId, data = {}) {
			const c = this.controller;

			const interfaceMap = {
				play: () => MPV.MpvInterface.play(folderId, data),
				close_mpv: () => MPV.MpvInterface.closeMpv(folderId),
				add: () => MPV.MpvInterface.add(folderId, data.data || data),
				clear: () => MPV.MpvInterface.clear(folderId),
				remove_item: () => MPV.MpvInterface.removeItem(folderId, data.data || data),
				set_playlist_order: () => MPV.MpvInterface.setPlaylistOrder(folderId, data.data?.order || data.order || data),
			};

			if (interfaceMap[action]) {
				return interfaceMap[action]().then(response => {
					if (response?.success && response.list) {
						c.playlistUI?.render(
							response.list,
							response.lastPlayedId || c.state.state.lastPlayedId,
							c.state.state.isFolderActive
						);
					} else if (response?.success && ["add", "clear", "remove_item", "set_playlist_order"].includes(action)) {
						this.refreshPlaylist();
					}
					return response;
				}).catch(err => {
					console.error(`[Controller] MpvInterface error for '${action}':`, err);
					MPV.logger?.error?.(`[Controller] MpvInterface error for '${action}': ${err?.message || err}`, { persist: true, stack: err?.stack });
					c.updateStatusBanner?.(`Error in ${action}`, false);
				});
			}

			return c.bridge.send(action, folderId, data);
		}

		updateAutoAddVisuals(isActive) {
			const c = this.controller;
			if (!c.ui.shadowRoot) return;
			const root = c.ui.shadowRoot;
			const btn = root.getElementById("btn-add");
			const compactBtn = root.getElementById("btn-compact-add");

			if (isActive) {
				btn?.classList.add("auto-add-active");
				compactBtn?.classList.add("auto-add-active");
			} else {
				btn?.classList.remove("auto-add-active");
				compactBtn?.classList.remove("auto-add-active");
			}
		}

		bindControllerEvents() {
			const c = this.controller;
			if (!c.ui.shadowRoot) return;

			const root = c.ui.shadowRoot;
			const minRoot = c.ui.minimizedHost?.shadowRoot;

			// --- Core UI Toggles ---
			root
				.getElementById("btn-toggle-minimize")
				?.addEventListener("click", () => c.setMinimizedState(true));
			root
				.getElementById("btn-toggle-pin")
				?.addEventListener("click", () =>
					c.setPinState(!c.state.state.pinned),
				);
			root.getElementById("btn-toggle-stub")?.addEventListener("click", () => {
				const newVal = !c.state.state.settings.showMinimizedStub;
				c.state.update({
					settings: {
						...c.state.state.settings,
						showMinimizedStub: newVal,
					},
				});
				c.savePreference({ showMinimizedStub: newVal });
			});
			root
				.getElementById("btn-toggle-ui-mode")
				?.addEventListener("click", () => {
					const newMode =
						c.state.state.uiMode === "full" ? "compact" : "full";
					c.state.update({ uiMode: newMode });
					c.savePreference({ mode: newMode });
				});

			// --- Playback & List Actions ---
			const getFolderId = () => root.getElementById("folder-select")?.value;

			root.getElementById("btn-play")?.addEventListener("click", () => {
				const fid = getFolderId();
				if (fid) this.sendCommandToBackground("play", fid);
			});
			root
				.getElementById("btn-play-new")
				?.addEventListener("click", async () => {
					const fid = getFolderId();
					if (!fid) return;
					const confirmed =
						!c.state.state.settings.confirmPlayNew ||
						(await c.showPageLevelConfirmation(
							"Launching a new MPV instance while another is running may cause issues. Continue?",
						));
					if (confirmed) {
						this.sendCommandToBackground("play", fid, {
							playNewInstance: true,
						});
					}
				});
			root
				.getElementById("btn-close-mpv")
				?.addEventListener("click", async () => {
					const fid = getFolderId();
					if (!fid) return;

					const confirmed =
						!c.state.state.settings.confirmCloseMpv ||
						(await c.showPageLevelConfirmation(
							"Are you sure you want to close MPV?",
						));
					if (confirmed) this.sendCommandToBackground("close_mpv", fid);
				});
			root.getElementById("btn-add")?.addEventListener("click", async () => {
				const fid = getFolderId();
				if (fid && c.state.state.detectedUrl) {
					const result = await this.sendCommandToBackground("add", fid, {
						data: c.pageScraper.scrapePageDetails(
							c.state.state.detectedUrl,
						),
					});
					if (result?.success) {
						c.timers.scheduleTimeout(() => this.refreshPlaylist(), 50);
					}
				}
			});
			root.getElementById("btn-clear")?.addEventListener("click", async () => {
				const fid = getFolderId();
				if (!fid) return;
				const confirmed =
					!c.state.state.settings.confirmClearPlaylist ||
					(await c.showPageLevelConfirmation(
						`Are you sure you want to clear the playlist in "${fid}"?`,
					));
				if (confirmed) this.sendCommandToBackground("clear", fid);
			});

			// Compact equivalents
			root.getElementById("btn-compact-play")?.addEventListener("click", () => {
				const fid = root.getElementById("compact-folder-select")?.value;
				if (fid) this.sendCommandToBackground("play", fid);
			});
			root
				.getElementById("btn-compact-add")
				?.addEventListener("click", async () => {
					const fid = root.getElementById("compact-folder-select")?.value;
					if (fid && c.state.state.detectedUrl) {
						const result = await this.sendCommandToBackground("add", fid, {
							data: c.pageScraper.scrapePageDetails(
								c.state.state.detectedUrl,
							),
						});
						if (result?.success) {
							c.timers.scheduleTimeout(() => this.refreshPlaylist(), 50);
						}
					}
				});
			root
				.getElementById("btn-compact-clear")
				?.addEventListener("click", async () => {
					const fid = root.getElementById("compact-folder-select")?.value;
					if (!fid) return;
					const confirmed =
						!c.state.state.settings.confirmClearPlaylist ||
						(await c.showPageLevelConfirmation(
							`Are you sure you want to clear the playlist in "${fid}"?`,
						));
					if (confirmed) this.sendCommandToBackground("clear", fid);
				});
			root.getElementById("btn-compact-close-mpv")
				?.addEventListener("click", async () => {
					const fid = root.getElementById("compact-folder-select")?.value;
					if (!fid) return;

					const confirmed =
						!c.state.state.settings.confirmCloseMpv ||
						(await c.showPageLevelConfirmation(
							"Are you sure you want to close MPV?",
						));
					if (confirmed) this.sendCommandToBackground("close_mpv", fid);
				});

			// --- Log Controls ---
			root
				.getElementById("btn-toggle-log")
				?.addEventListener("click", () =>
					c.state.update({ logVisible: !c.state.state.logVisible }),
				);
			root.getElementById("btn-clear-log")?.addEventListener("click", () => {
				const logContainer = root.getElementById("log-container");
				if (logContainer) logContainer.replaceChildren();
			});

			// Auto-Add Toggle (Right Click)
			const toggleAutoAdd = (e) => {
				e.preventDefault();
				c.bridge.send("toggle_auto_add").then(res => {
					if (res?.success) {
						this.updateAutoAddVisuals(res.active);
					}
				});
			};
			root.getElementById("btn-add")?.addEventListener("contextmenu", toggleAutoAdd);
			root.getElementById("btn-compact-add")?.addEventListener("contextmenu", toggleAutoAdd);

			// Initial state check
			c.bridge.send("get_auto_add_state").then(res => {
				if (res?.success) this.updateAutoAddVisuals(res.active);
			});
			root.getElementById("btn-filter-info")?.addEventListener("click", () => {
				const filters = {
					...c.state.state.logFilters,
					info: !c.state.state.logFilters.info,
				};
				c.state.update({ logFilters: filters });
			});
			root.getElementById("btn-filter-error")?.addEventListener("click", () => {
				const filters = {
					...c.state.state.logFilters,
					error: !c.state.state.logFilters.error,
				};
				c.state.update({ logFilters: filters });
			});

			// --- Minimized Stub Events ---
			minRoot
				?.getElementById("m3u8-minimized-stub")
				?.addEventListener("click", async (e) => {
					if (e.button !== 0 && e.button !== undefined) return;

					const stub = e.currentTarget;
					const isStreamPresent = stub?.classList.contains("stream-present");
					const isAlreadyInPlaylist = stub?.classList.contains("url-in-playlist");

					if (isStreamPresent && !isAlreadyInPlaylist && e.button === 0) {
						const hostname = window.location.hostname;
						const isYouTube =
							hostname.includes("youtube.com") &&
							window.location.pathname.includes("/watch");
						const urlToUse =
							c.state.state.detectedUrl ||
							(isYouTube ? window.location.href : null);

						if (!urlToUse) {
							c.setMinimizedState(false);
							return;
						}

						let targetFolderId = getFolderId();

						if (!targetFolderId) {
							const response = await c.bridge.send("get_last_folder_id");
							if (response?.success && response.folderId) {
								targetFolderId = response.folderId;
							}
						}

						if (targetFolderId) {
							const result = await c.bridge.send("add", targetFolderId, {
								data: c.pageScraper.scrapePageDetails(urlToUse),
							});
							c.addLogEntry({
								text: `[Content]: Adding detected stream via minimized stub...`,
								type: "info",
							});
							if (result?.success) this.refreshPlaylist();
						} else {
							console.warn("[Stub Click] Could not determine target folder.");
							c.setMinimizedState(false);
						}
					} else {
						c.setMinimizedState(false);
					}
				});
			minRoot
				?.getElementById("m3u8-minimized-play-btn")
				?.addEventListener("click", () => {
					const fid = getFolderId();
					if (fid) this.sendCommandToBackground("play", fid);
				});

			// --- Global Listeners ---
			document.addEventListener(
				"fullscreenchange",
				c.handleFullscreenChange,
			);
			window.addEventListener("keydown", c.handleGlobalKeydown, true);
			c.resizeListener = MPV.debounce(() => c._handleResize(), 250);
			window.addEventListener("resize", c.resizeListener);

			// --- Draggable Init ---
			const banner = root.getElementById("status-banner");
			if (banner) {
				c.draggableController = new MPV.Draggable(c.ui.controllerHost, banner, {
					dragButton: 0,
					onDragStart: () => !c.state.state.pinned,
					onDragMove: () => c.updateAdaptiveElements(),
					onDragEnd: (e, pos) => {
						c.preResizePosition = null;
						c.savePreference({ position: pos }).then(() => {
							this.refreshPlaylist();
						});
					},
				});
			}

			const minStub = minRoot?.getElementById("m3u8-minimized-wrapper");
			if (minStub) {
				const minHandle = minRoot.getElementById("m3u8-minimized-stub");
				if (minHandle)
					minHandle.title =
						"Left-click: Open Controller\nRight-click: Drag to move";

				c.draggableMinimized = new MPV.Draggable(c.ui.minimizedHost, minStub, {
					dragButton: 2,
					onDragEnd: (e, pos) => {
						c.ui.minimizedHost.classList.remove("top-left", "top-right");
						c.savePreference({ minimizedStubPosition: pos }).then(() => {
							this.refreshPlaylist();
						});
					},
				});
			}
		}
	};
})();
