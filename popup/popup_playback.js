// popup/popup_playback.js
// Playlist rendering, playback state visuals, mini controller actions, and quick actions bar for popup.js.

import { domUtils } from "../utils/domUtils.module.js";
import { sendMessageAsync } from "../utils/commUtils.module.js";
import { MpvInterface } from "../utils/MpvInterface.module.js";

export function createPlaybackManager(ctx) {
	const {
		popupState,
		showStatus,
		showPopupConfirmation,
		miniFolderSelect,
		miniPlayBtn,
		miniAddBtn,
		miniClearBtn,
		miniCloseMpvBtn,
		miniItemCountSpan,
		playlistContainer,
		getPlaylistRenderer,
		getCachedPrefs,
		getCurrentDetectedUrl,
		addDragDropListeners,
		getDraggedItem,
	} = ctx;

	let isPlaybackLoading = false;
	let isPlaybackClosing = false;
	let loadingTimeout = null;
	let isSelectionModeActive = false;
	let isPickStartModeActive = false;
	let isLiveReorderModeActive = false;
	let reorderDebounceTimer = null;

	function setPlaybackLoading(isLoading) {
		isPlaybackLoading = isLoading;
		if (!miniPlayBtn) return;

		miniPlayBtn.classList.toggle("btn-loading", isLoading);
		if (isLoading) {
			miniPlayBtn.classList.remove("btn-playing");
			if (loadingTimeout) clearTimeout(loadingTimeout);
			loadingTimeout = setTimeout(() => {
				if (isPlaybackLoading) {
					setPlaybackLoading(false);
					showStatus("Playback sync timed out.", true);
				}
			}, 30000);
		} else {
			if (loadingTimeout) clearTimeout(loadingTimeout);
		}
	}

	function setPlaybackClosing(isClosing) {
		if (!miniPlayBtn) return;
		isPlaybackClosing = isClosing;
		if (isClosing) isPlaybackLoading = false;

		miniPlayBtn.classList.toggle("btn-closing", isClosing);

		if (isClosing) {
			miniPlayBtn.classList.remove("btn-playing");
			miniPlayBtn.classList.remove("btn-loading");
			miniPlayBtn.title = "MPV is closing...";
			miniPlayBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>`;
		}
	}

	function updateAutoAddVisuals(isActive) {
		if (!miniAddBtn) return;
		miniAddBtn.classList.toggle("auto-add-active", isActive);
	}

	function renderPlaylist(
		playlist,
		lastPlayedId,
		isFolderActive = null,
		isPaused = null,
		needsAppend = null,
		completedIds = null,
		preventScroll = false,
	) {
		if (playlist) popupState.currentPlaylist = playlist;
		if (lastPlayedId) popupState.lastPlayedId = lastPlayedId;
		if (typeof isFolderActive === "boolean") popupState.isFolderActive = isFolderActive;
		if (typeof isPaused === "boolean") popupState.isPaused = isPaused;
		if (typeof needsAppend === "boolean") popupState.needsAppend = needsAppend;
		if (completedIds) popupState.completedIds = completedIds;

		const effectivePlaylist = playlist || popupState.currentPlaylist || [];
		const effectiveLastPlayedId = lastPlayedId || popupState.lastPlayedId;
		const effectiveIsFolderActive =
			typeof isFolderActive === "boolean"
				? isFolderActive
				: popupState.isFolderActive;
		const effectiveIsPaused =
			typeof isPaused === "boolean" ? isPaused : popupState.isPaused || false;
		const effectiveNeedsAppend =
			typeof needsAppend === "boolean"
				? needsAppend
				: popupState.needsAppend || false;
		const effectiveCompletedIds = completedIds || popupState.completedIds || [];

		if (isPlaybackClosing) return;

		const playlistRenderer = getPlaylistRenderer();
		if (!playlistRenderer) return;
		playlistRenderer.updatePrefs(getCachedPrefs() || {});
		playlistRenderer.render({
			playlist: effectivePlaylist,
			lastPlayedId: effectiveLastPlayedId,
			isActive: effectiveIsFolderActive,
			isPaused: effectiveIsPaused,
			needsAppend: effectiveNeedsAppend,
			completedIds: effectiveCompletedIds,
			preventScroll,
		});

		const renderedCount =
			playlistRenderer.lastRenderedIds?.size ?? effectivePlaylist.length;
		if (miniItemCountSpan) {
			miniItemCountSpan.textContent = String(renderedCount);
		}

		if (miniPlayBtn) {
			const visual = domUtils.getPlayButtonVisual({
				isActive: effectiveIsFolderActive,
				needsAppend: effectiveNeedsAppend,
			});

			miniPlayBtn.classList.toggle("btn-playing", visual.isPlaying);
			miniPlayBtn.title = visual.title;

			if (!isPlaybackLoading || visual.isPlaying) {
				setPlaybackLoading(false);
			}

			if (visual.stateKey === "queue") {
				miniPlayBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`;
			} else if (visual.stateKey === "pause") {
				miniPlayBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`;
			} else {
				miniPlayBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;
			}
		}
	}

	async function refreshPlaylist(data = null, preventScroll = false) {
		const MPV = window.MPV_INTERNAL;
		const processResponse = (response) => {
			if (response?.success) {
				const currentFolder = miniFolderSelect?.value;
				const pbActive = MPV.playbackStateManager.state;
				const isFolderMatch =
					pbActive?.folderId &&
					currentFolder &&
					pbActive.folderId.toLowerCase() === currentFolder.toLowerCase();

				if (response.isRunning || isFolderMatch) {
					MPV.playbackStateManager.update({
						folderId: currentFolder,
						isRunning: response.isRunning,
						isPaused: response.isPaused,
						isIdle: response.isIdle,
						lastPlayedId: response.lastPlayedId,
						needsAppend: response.needsAppend,
						sessionIds: response.sessionIds,
					});
				}

				renderPlaylist(
					response.list,
					response.lastPlayedId,
					response.isRunning,
					response.isPaused,
					response.needsAppend,
					null,
					preventScroll,
				);
			}
		};

		if (data) {
			processResponse(data);
			return;
		}

		const folderId = miniFolderSelect.value;
		if (!folderId) return;

		try {
			const response = await sendMessageAsync({
				action: "get_playlist",
				folderId,
			});
			processResponse(response);
		} catch (e) {
			console.error("Failed to refresh playlist:", e);
		}
	}

	function updateItemDelta(itemId, delta) {
		const playlistRenderer = getPlaylistRenderer();
		if (!playlistRenderer) return;
		playlistRenderer.updateItemDelta(itemId, delta);
	}

	async function getPageDetails(tabId, url) {
		const maxRetries = 2;
		for (let i = 0; i <= maxRetries; i++) {
			try {
				const response = await new Promise((resolve, reject) => {
					chrome.tabs.sendMessage(
						tabId,
						{ action: "scrape_and_get_details", detectedUrl: url },
						(res) => {
							if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
							else resolve(res);
						},
					);
				});

				if (response && response.title && !response.isProvisional) {
					return response;
				}

				if (i < maxRetries) {
					await new Promise((r) => setTimeout(r, 1000));
				} else {
					return response;
				}
			} catch (e) {
				if (i < maxRetries) await new Promise((r) => setTimeout(r, 800));
				else return null;
			}
		}
		return null;
	}

	async function updateNativeHostStatusUI() {
		const diagEl = document.querySelector(
			"#diag-native-host-status .dependency-value",
		);
		const setupBanner = document.getElementById("native-host-setup-banner");
		if (!diagEl && !setupBanner) return;

		try {
			const response = await sendMessageAsync({
				action: "get_native_host_status",
			});
			if (response?.success) {
				const status = response.status || "unknown";
				if (diagEl) {
					diagEl.textContent = status.charAt(0).toUpperCase() + status.slice(1);
				}

				if (status === "online") {
					if (diagEl) {
						diagEl.style.color = "var(--accent-positive)";
						if (response.info?.python) {
							diagEl.title = `Python: ${response.info.python}\nPlatform: ${response.info.platform}`;
						}
					}
					if (setupBanner) setupBanner.style.display = "none";
				} else if (status === "offline" || status === "error") {
					if (diagEl) {
						diagEl.style.color = "var(--accent-danger)";
						diagEl.title = "Native host is not running or not installed.";
					}
					if (setupBanner) setupBanner.style.display = "block";
				} else {
					if (diagEl) {
						diagEl.style.color = "var(--text-secondary)";
					}
					if (setupBanner) setupBanner.style.display = "none";
				}
			}
		} catch (e) {
			if (diagEl) {
				diagEl.textContent = "Error";
				diagEl.style.color = "var(--accent-danger)";
			}
			if (setupBanner) setupBanner.style.display = "block";
		}
	}

	async function handleMiniAdd() {
		const folderId = miniFolderSelect.value;
		if (!folderId) return showStatus("Please select a folder.", true);

		const addBtn = document.getElementById("btn-mini-add");
		if (!addBtn) return;

		const originalIcon = addBtn.innerHTML;

		try {
			const [activeTab] = await chrome.tabs.query({
				active: true,
				currentWindow: true,
			});
			const tabId = activeTab?.id;
			if (!tabId) {
				showStatus("Could not find an active tab.", true);
				throw new Error("No active tab");
			}

			const isYouTube = !!activeTab?.url?.includes("youtube.com/watch");
			const streamUrl =
				getCurrentDetectedUrl() || (isYouTube ? activeTab.url : null);

			const details = await getPageDetails(tabId, streamUrl);
			const finalStreamUrl = details?.url || streamUrl;

			if (!finalStreamUrl) {
				console.log(
					"[Popup] No stream detected. Add action ignored to match OSC behavior.",
				);
				showStatus("No stream detected on this page.", true);
				return;
			}

			addBtn.disabled = true;
			addBtn.innerHTML = `<svg class="spin-animation" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>`;

			let title = details?.title || activeTab.title || finalStreamUrl;
			if (title && title.length > 255) {
				title = title.substring(0, 252) + "...";
			}

			const addResponse = await MpvInterface.add(
				folderId,
				{ url: finalStreamUrl, title },
				{ tabId, tab: activeTab },
			);

			if (addResponse.success) {
				if (addResponse.message) showStatus(addResponse.message);

				addBtn.classList.add("url-in-playlist");
				addBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;

				setTimeout(() => refreshPlaylist(), 50);

				setTimeout(() => {
					addBtn.innerHTML = originalIcon;
					addBtn.disabled = !addBtn.classList.contains("stream-present");
				}, 2000);
			} else {
				showStatus(addResponse.error || "Failed to add URL.", true);
				addBtn.innerHTML = originalIcon;
				addBtn.disabled = false;
			}
		} catch (error) {
			console.error("[Popup] MiniAdd Error:", error);
			if (error.message !== "No active tab") {
				showStatus(`An error occurred: ${error.message}`, true);
			}
			if (addBtn) {
				addBtn.innerHTML = originalIcon;
				addBtn.disabled = false;
			}
		}
	}

	async function handleMiniCloseMpv() {
		try {
			const [statusResponse, prefsResponse] = await Promise.all([
				sendMessageAsync({ action: "is_mpv_running" }),
				sendMessageAsync({ action: "get_ui_preferences" }),
			]);

			if (!statusResponse?.success)
				return showStatus("Could not check MPV status.", true);

			if (!statusResponse.isRunning && !isPlaybackLoading)
				return showStatus("MPV is not running.", false);

			if (prefsResponse?.preferences?.confirmCloseMpv ?? true) {
				const confirmed = await showPopupConfirmation(
					"Are you sure you want to close MPV?",
				);
				if (!confirmed) {
					return showStatus("Close MPV action cancelled.");
				}
			}

			const response = await MpvInterface.closeMpv(miniFolderSelect.value);
			if (response.success) showStatus(response.message);
			else showStatus(response.error, true);
		} catch (error) {
			showStatus(`An error occurred: ${error.message}`, true);
		}
	}

	async function handleMiniSimpleCommand(action) {
		const folderId = miniFolderSelect.value;
		if (!folderId) return showStatus("Please select a folder.", true);

		if (action === "clear") {
			try {
				const prefs = await sendMessageAsync({
					action: "get_ui_preferences",
				});
				if (prefs?.preferences?.confirmClearPlaylist ?? true) {
					const confirmed = await showPopupConfirmation(
						`Are you sure you want to clear the playlist in "${folderId}"?`,
					);
					if (!confirmed) {
						return showStatus("Clear action cancelled.");
					}
				}
			} catch (e) {
				console.error("Failed to get preferences for clear action:", e);
			}
		}

		try {
			const response = await (action === "clear"
				? MpvInterface.clear(folderId)
				: sendMessageAsync({ action, folderId }));
			if (response.success) {
				if (response.message) showStatus(response.message);
				if (action === "clear") {
					refreshPlaylist();
				}
			} else if (response.error) {
				showStatus(response.error, true);
			}
		} catch (error) {
			showStatus(`An error occurred: ${error.message}`, true);
		}
	}

	async function handlePlaySelectedPlaylist(folderId) {
		if (!folderId) {
			return showStatus("Please select a folder.", true);
		}

		try {
			const response = await MpvInterface.play(folderId);

			if (response.success) {
				if (response.message) showStatus(response.message);
				refreshPlaylist();
			} else {
				showStatus(response.error || "Failed to start playback.", true);
			}
		} catch (error) {
			showStatus(
				`An error occurred while playing playlist: ${error.message}`,
				true,
			);
		}
	}

	function bindPlaybackListeners() {
		const quickActionButtons = document.querySelectorAll(".quick-action-btn");

		const refreshQuickActionsBar = () => {
			const bar = document.getElementById("quick-actions-bar");
			if (!bar) return;

			bar.classList.toggle("selection-mode-active", isSelectionModeActive);
			bar.classList.toggle("pick-start-mode-active", isPickStartModeActive);
			bar.classList.toggle("live-reorder-active", isLiveReorderModeActive);

			playlistContainer.classList.toggle(
				"selection-mode-active",
				isSelectionModeActive,
			);
			playlistContainer.classList.toggle(
				"pick-start-mode-active",
				isPickStartModeActive,
			);
			playlistContainer.classList.toggle(
				"live-reorder-active",
				isLiveReorderModeActive,
			);

			quickActionButtons.forEach((btn) => {
				if (btn.id === "btn-quick-a") {
					btn.classList.toggle("active", isPickStartModeActive);
				} else if (btn.id === "btn-quick-c") {
					btn.classList.toggle("active", isLiveReorderModeActive);
				} else if (btn.classList.contains("btn-disconnected-toggle")) {
					btn.classList.toggle("active", isSelectionModeActive);
				}
			});
		};

		playlistContainer.addEventListener("click", (e) => {
			const listItem = e.target.closest(".list-item");
			if (!listItem) return;

			const removeBtn = e.target.closest(".btn-remove-item");
			const copyBtn = e.target.closest(".btn-copy-item");
			const watchedCheckbox = e.target.closest(".item-watched-checkbox");

			if (isPickStartModeActive && !removeBtn && !copyBtn && !watchedCheckbox) {
				const id = listItem.dataset.id;
				const fullItem = popupState.currentPlaylist.find((i) => i.id === id);

				if (fullItem) {
					MpvInterface.play(miniFolderSelect.value, {
						urlItem: fullItem,
						playlistStartId: fullItem.id,
					}).catch((err) => showStatus("Playback error: " + err.message, true));
					isPickStartModeActive = false;
					refreshQuickActionsBar();
				}
				return;
			}

			if (isSelectionModeActive && !removeBtn && !copyBtn && !watchedCheckbox) {
				const id = listItem.dataset.id;
				const fullItem = popupState.currentPlaylist.find((i) => i.id === id);

				if (fullItem) {
					sendMessageAsync({
						action: "play_new_instance",
						urlItem: fullItem,
						playNewInstance: true,
						folderId: miniFolderSelect.value,
					}).catch((err) => showStatus("Playback error: " + err.message, true));

					isSelectionModeActive = false;
					playlistContainer.classList.remove("selection-mode-active");
					document
						.querySelectorAll(".quick-action-btn.selection-mode-active")
						.forEach((el) => el.classList.remove("selection-mode-active"));
					document
						.getElementById("quick-actions-bar")
						?.classList.remove("selection-mode-active");
					refreshQuickActionsBar();
				}
			}
		});

		addDragDropListeners(playlistContainer);
		playlistContainer.addEventListener("drop", (e) => {
			e.preventDefault();
			const dropTarget = playlistContainer.querySelector(".drag-over");
			if (dropTarget) {
				dropTarget.classList.remove("drag-over");
			}
			const draggedItem = getDraggedItem();
			if (draggedItem && draggedItem.parentElement === playlistContainer) {
				const folderId = miniFolderSelect.value;
				if (!folderId) return;

				const playlistItems = [
					...playlistContainer.querySelectorAll(".list-item"),
				];
				playlistItems.forEach((item, idx) => {
					item.dataset.index = idx;
					const indexSpan = item.querySelector(".url-index");
					if (indexSpan) indexSpan.textContent = `${idx + 1}.`;
					const removeBtn = item.querySelector(".btn-remove-item");
					if (removeBtn) removeBtn.dataset.index = idx;
				});
				const newOrder = playlistItems.map((item) => {
					const originalItem = popupState.currentPlaylist.find(
						(i) => i.id === item.dataset.id,
					);
					return (
						originalItem || {
							url: item.dataset.url,
							title: item.dataset.title,
							id: item.dataset.id,
						}
					);
				});
				popupState.currentPlaylist = newOrder;

				MpvInterface.setPlaylistOrder(folderId, newOrder).catch((err) => {
					showStatus("Failed to save playlist order: " + err.message, true);
				});

				if (isLiveReorderModeActive) {
					if (reorderDebounceTimer) clearTimeout(reorderDebounceTimer);

					reorderDebounceTimer = setTimeout(() => {
						const itemIds = newOrder.map((item) => item.id);
						MpvInterface.reorderLive(folderId, itemIds).catch((err) => {
							showStatus("Live reorder sync failed: " + err.message, true);
						});
						reorderDebounceTimer = null;
					}, 2000);
				}
			}
		});

		miniAddBtn.addEventListener("click", handleMiniAdd);
		miniAddBtn.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			sendMessageAsync({ action: "toggle_auto_add" })
				.then((res) => {
					if (res?.success) updateAutoAddVisuals(res.active);
				})
				.catch((err) =>
					showStatus("Failed to toggle auto-add: " + err.message, true),
				);
		});

		miniPlayBtn.addEventListener("click", () =>
			handlePlaySelectedPlaylist(miniFolderSelect.value),
		);

		miniClearBtn.addEventListener("click", () =>
			handleMiniSimpleCommand("clear"),
		);
		miniCloseMpvBtn.addEventListener("click", handleMiniCloseMpv);

		quickActionButtons.forEach((btn, index) => {
			const isA = btn.id === "btn-quick-a" || index === 0;
			const isLast =
				btn.classList.contains("btn-disconnected-toggle") ||
				index === quickActionButtons.length - 1;

			if (isA) {
				btn.classList.add("btn-start-from-beginning");

				btn.onclick = (e) => {
					e.stopPropagation();
					if (isPickStartModeActive) {
						isPickStartModeActive = false;
						refreshQuickActionsBar();
						return;
					}

					if (popupState.currentPlaylist.length > 0) {
						const firstItem = popupState.currentPlaylist[0];
						MpvInterface.play(miniFolderSelect.value, {
							urlItem: firstItem,
							playlistStartId: firstItem.id,
						}).catch((err) =>
							showStatus("Playback error: " + err.message, true),
						);
					} else {
						showStatus("Cannot play from start - Playlist is empty.", true);
					}
				};

				btn.oncontextmenu = (e) => {
					e.preventDefault();
					e.stopPropagation();
					isSelectionModeActive = false;
					isLiveReorderModeActive = false;
					isPickStartModeActive = !isPickStartModeActive;
					refreshQuickActionsBar();
				};
			} else if (btn.id === "btn-quick-c") {
				btn.onclick = (e) => {
					e.stopPropagation();
					isPickStartModeActive = false;
					isSelectionModeActive = false;
					isLiveReorderModeActive = !isLiveReorderModeActive;
					refreshQuickActionsBar();
				};

				btn.oncontextmenu = (e) => {
					e.preventDefault();
					e.stopPropagation();
					const folderId = miniFolderSelect.value;
					if (!folderId) return;

					if (btn.classList.contains("smart-sync-pending")) {
						const itemIds = popupState.currentPlaylist.map((item) => item.id);
						MpvInterface.reorderLive(folderId, itemIds)
							.then((res) => {
								if (res.success) {
									showStatus("MPV playlist synchronized.");
									btn.classList.remove("smart-sync-pending");
									btn.title =
										btn.dataset.originalTitle ||
										"Live Reorder: Mirror changes to MPV | Right-click: Smart Reorder";
								} else {
									showStatus(res.error || "Sync failed.", true);
								}
							})
							.catch((err) => showStatus("Sync error: " + err.message, true));
						return;
					}

					showStatus("Calculating smart order...");
					MpvInterface.getSmartReorder(folderId)
						.then((res) => {
							if (res.success && res.playlist) {
								renderPlaylist(
									res.playlist,
									popupState.lastPlayedId,
									popupState.isFolderActive,
								);
								showStatus(
									"Playlist organized. Right-click again to sync MPV.",
								);

								if (popupState.isFolderActive) {
									btn.classList.add("smart-sync-pending");
									btn.dataset.originalTitle = btn.title;
									btn.title = "Right-click again to sync MPV playlist";
								}
							} else {
								showStatus(res.error || "Smart reorder failed.", true);
							}
						})
						.catch((err) => showStatus("Reorder error: " + err.message, true));
				};
			} else if (isLast) {
				if (!btn.querySelector("svg")) {
					btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>`;
				}
				btn.title = "Detached Launch (Selection Mode): Click here, then click any item below to open it in a separate MPV window";
				btn.classList.add("btn-disconnected-toggle");

				btn.onclick = (e) => {
					e.stopPropagation();
					isPickStartModeActive = false;
					isLiveReorderModeActive = false;
					isSelectionModeActive = !isSelectionModeActive;
					refreshQuickActionsBar();
				};
			}
		});
	}

	return {
		setPlaybackLoading,
		setPlaybackClosing,
		updateAutoAddVisuals,
		renderPlaylist,
		refreshPlaylist,
		updateItemDelta,
		updateNativeHostStatusUI,
		bindPlaybackListeners,
	};
}
