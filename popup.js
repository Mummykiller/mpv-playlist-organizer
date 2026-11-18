import { domUtils } from "./utils/domUtils.module.js";
import {
	getActiveTab,
	sendMessageAsync,
	reportBrowserError,
} from "./utils/commUtils.module.js";
import { logger } from "./utils/SystemLogger.module.js";
import { OptionsManager } from "./utils/settings.js";
import { MpvInterface } from "./utils/MpvInterface.module.js";
import { PlaylistRenderer } from "./utils/PlaylistRenderer.js";
import { createFolderManager } from "./popup/popup_folders.js";
import { createBackupManager } from "./popup/popup_backup.js";
import { createAniListManager } from "./popup/popup_anilist.js";
import { createPlaybackManager } from "./popup/popup_playback.js";
import { createYouTubeToolsManager } from "./popup/popup_youtube.js";

// Global Popup Error Handlers (Forward uncaught exceptions to browser_errors.log)
window.addEventListener("error", (event) => {
	const err = event.error;
	const msg = err ? (err.message || String(err)) : (event.message || "Unknown error");
	const stack = err?.stack || "";
	reportBrowserError("Popup", msg, { stack, data: err }).catch((e) => {
		logger?.warn?.("[Popup] Failed to report error to logger:", { data: e });
	});
	const statusEl = document.getElementById("status-message");
	domUtils.updateStatusBanner(statusEl, `Error: ${msg}`, { isError: true });
});

window.addEventListener("unhandledrejection", (event) => {
	const reason = event.reason;
	const msg = reason ? (reason.message || String(reason)) : String(reason);
	const stack = reason?.stack || "";
	reportBrowserError("Popup", msg, { stack, data: reason }).catch((e) => {
		logger?.warn?.("[Popup] Failed to report rejection to logger:", { data: e });
	});
	const statusEl = document.getElementById("status-message");
	domUtils.updateStatusBanner(statusEl, `Error: ${msg}`, { isError: true });
});

document.addEventListener("DOMContentLoaded", async () => {
	// Status message element and showStatus defined before try block so they are available in catch handlers
	const statusMessageElement = document.getElementById("status-message");

	/**
	 * SHOW STATUS (LOG BAR)
	 * This function handles the text that appears in the fixed bottom bar.
	 * 
	 * @param {string} text - The message to display.
	 * @param {boolean} isError - If true, styles the message as an error (red).
	 */
	function showStatus(text, isError = false) {
		domUtils.updateStatusBanner(statusMessageElement, text, { isError });
	}

	try {
		// This line is intentionally kept for the diff

		// --- Element Definitions ---
		const sharedAnilistSection = document.getElementById(
			"shared-anilist-section",
		);

		// --- UI Mode Manager ---
		// This class centralizes the logic for handling the two different UI views (mini and full).
		class UIModeManager {
			constructor() {
				this.views = {
					mini: document.getElementById("mini-controller-view"),
					full: document.getElementById("folder-management-view"),
				};
				this.activeMode = null;
				this.isMpvViewHidden = () => false;

				// Placeholders for shared content
				this.placeholders = {
					settings: {
						mini: document.getElementById("mini-settings-placeholder"),
						full: document.getElementById("full-settings-placeholder"),
					},
					anilist: {
						mini: document.getElementById("mini-anilist-placeholder"),
						full: document.getElementById("full-anilist-placeholder"),
					},
					// Status bar is now fixed at the bottom, no placeholders needed!
				};

				// Shared content elements
				this.sharedElements = {
					settings: document.getElementById("shared-settings-container"),
					anilist: sharedAnilistSection,
				};
			}

			/**
			 * Sets the active UI mode and moves shared elements to the correct view.
			 * @param {'mini' | 'full'} mode The mode to activate.
			 */
			setMode(mode) {
				if (mode !== "mini" && mode !== "full") return;
				if (this.activeMode && this.activeMode !== mode && typeof cancelReorderMode === "function") {
					cancelReorderMode();
				}

				this.activeMode = mode;
				const hideMpvViews = typeof this.isMpvViewHidden === "function" && this.isMpvViewHidden();
				this.views.mini.style.display = !hideMpvViews && mode === "mini" ? "flex" : "none";
				this.views.full.style.display = !hideMpvViews && mode === "full" ? "block" : "none";

				// Move shared elements into the active view's placeholder
				this.placeholders.settings[mode].appendChild(
					this.sharedElements.settings,
				);
				this.placeholders.anilist[mode].appendChild(
					this.sharedElements.anilist,
				);

				// Only show settings if it was already visible or if we are in full mode
				if (mode === "full") {
					this.sharedElements.settings.style.display = "block";
				}

				const hideBtn = document.getElementById("btn-hide-on-page-controller");
				if (hideBtn) {
					hideBtn.style.display = isCurrentTabHttp && mode === "full" ? "block" : "none";
				}
			}

			isMiniView() {
				return this.activeMode === "mini";
			}

			/**
			 * Determines the initial UI mode based on tab state and user preferences,
			 * then activates it.
			 * @param {boolean} isHttp - Whether the current tab is on an HTTP/S page.
			 * @param {object} uiState - The saved UI state for the current tab.
			 * @param {object} prefs - The user's global preferences.
			 * @param {boolean} isContentScriptDead - Whether the content script on page is dead/blocked.
			 */
			determineAndSetInitialMode(isHttp, uiState, prefs, isContentScriptDead) {
				const prevMode = this.activeMode;
				let showMiniView = false;
				if (isHttp) {
					// If the content script is dead/blocked, we MUST use the mini-popup view.
					showMiniView = isContentScriptDead || (uiState?.minimized ?? prefs?.mode === "minimized");
				} else {
					// On restricted pages (like brave://), use the global preference.
					showMiniView = prefs?.mode === "minimized";
				}
				const nextMode = showMiniView ? "mini" : "full";
				this.setMode(nextMode);
				if (prevMode === "full" && nextMode === "mini") {
					playbackManager?.refreshPlaylist?.(null, true);
				}
			}

			// --- Getters for Active Elements ---
			// These getters return the element from the currently active view, simplifying event handlers.
			get folderSelect() {
				return this.isMiniView()
					? document.getElementById("mini-folder-select")
					: document.getElementById("remove-folder-select");
			}

			get newFolderNameInput() {
				return this.isMiniView()
					? document.getElementById("mini-new-folder-name")
					: document.getElementById("new-folder-name");
			}

			get reorderContainer() {
				return this.isMiniView()
					? document.getElementById("mini-reorder-container")
					: document.getElementById("reorder-container");
			}

			get reorderToggleBtn() {
				return this.isMiniView()
					? document.getElementById("btn-mini-toggle-reorder")
					: document.getElementById("btn-toggle-reorder");
			}
		}

		const uiManager = new UIModeManager();

		// Folder Management View Elements
		const newFolderNameInput = document.getElementById("new-folder-name");
		const createFolderBtn = document.getElementById("btn-create-folder");
		const removeFolderSelect = document.getElementById("remove-folder-select");
		const renameFolderBtn = document.getElementById("btn-rename-folder");
		const removeFolderBtn = document.getElementById("btn-remove-folder");

		// Mini Controller View Elements
		const miniFolderSelect = document.getElementById("mini-folder-select");
		const miniAddBtn = document.getElementById("btn-mini-add");
		const miniPlayBtn = document.getElementById("btn-mini-play");
		const miniClearBtn = document.getElementById("btn-mini-clear");
		const miniCloseMpvBtn = document.getElementById("btn-mini-close-mpv");
		const showOnPageControllerBtn = document.getElementById(
			"btn-show-on-page-controller",
		);
		const miniManageFoldersBtn = document.getElementById(
			"btn-mini-manage-folders",
		);
		const hideOnPageControllerBtn = document.getElementById(
			"btn-hide-on-page-controller",
		);
		const miniFolderManagementControls = document.getElementById(
			"mini-folder-management-controls",
		);
		const btnMiniToggleSettings = document.getElementById("btn-mini-toggle-settings");
		const miniSettingsControls = document.getElementById("mini-settings-controls");
		const btnMiniToggleStub = document.getElementById("btn-mini-toggle-stub");
		const miniNewFolderNameInput = document.getElementById("mini-new-folder-name");
		const miniCreateFolderBtn = document.getElementById(
			"btn-mini-create-folder",
		);
		const miniRenameFolderBtn = document.getElementById(
			"btn-mini-rename-folder",
		);
		const miniRemoveFolderBtn = document.getElementById(
			"btn-mini-remove-folder",
		);
		const miniItemCountSpan = document.getElementById("mini-item-count");

		// Playlist Elements
		const playlistContainer = document.getElementById(
			"playlist-container",
		);
		let playlistRenderer = null;
		let playbackUnsubscribe = null;

		// Export/Import Elements
		const exportDataBtn = document.getElementById("btn-export-data");
		const exportAllDataBtn = document.getElementById("btn-export-all");
		const importDataBtn = document.getElementById("btn-import-data");
		const openExportFolderBtn = document.getElementById(
			"btn-open-export-folder",
		);
		const miniExportDataBtn = document.getElementById("btn-mini-export-data");
		const miniExportAllDataBtn = document.getElementById("btn-mini-export-all");
		const miniImportDataBtn = document.getElementById("btn-mini-import-data");
		const miniOpenExportFolderBtn = document.getElementById(
			"btn-mini-open-export-folder",
		);
		const exportSettingsBtn = document.getElementById("btn-export-settings");
		const importSettingsBtn = document.getElementById("btn-import-settings");
		const openExportFolderBtnAlt = document.getElementById(
			"btn-open-export-folder-alt",
		);
		const importSelectionModal = document.getElementById(
			"import-selection-modal",
		);
		const importFileSelect = document.getElementById("import-file-select");
		const importConfirmBtn = document.getElementById("import-confirm-btn");
		const importCancelBtn = document.getElementById("import-cancel-btn");
		const exportFilenameModal = document.getElementById(
			"export-filename-modal",
		);
		const exportFilenameInput = document.getElementById(
			"export-filename-input",
		);
		const exportSaveBtn = document.getElementById("export-save-btn");
		const exportCancelBtn = document.getElementById("export-cancel-btn");
		const renameFolderModal = document.getElementById("rename-folder-modal");
		const renameFolderInput = document.getElementById("rename-folder-input");
		const renameSaveBtn = document.getElementById("rename-save-btn");
		const renameCancelBtn = document.getElementById("rename-cancel-btn");

		let currentDetectedUrl = null;
		let cachedPrefs = null;
		let isCurrentTabHttp = false;

		// Persistent state for UI consistency
		const popupState = {
			isFolderActive: false,
			lastPlayedId: null,
			isPaused: false,
			needsAppend: false,
			currentPlaylist: [],
		};

		// Reorder Elements
		const reorderContainer = document.getElementById("reorder-container");
		const miniReorderContainer = document.getElementById(
			"mini-reorder-container",
		);
		const toggleReorderBtn = document.getElementById("btn-toggle-reorder");
		const miniToggleReorderBtn = document.getElementById(
			"btn-mini-toggle-reorder",
		);

		// --- UI Helper Functions ---

		/**
		 * Displays a custom confirmation modal inside the popup.
		 * @param {string} message The message to display in the modal.
		 * @returns {Promise<boolean>} A promise that resolves to true if confirmed, false if cancelled.
		 */
		function showPopupConfirmation(message) {
			return domUtils.confirm(message, {
				modalId: "popup-confirmation-modal",
				messageId: "popup-modal-message",
				confirmId: "popup-modal-confirm-btn",
				cancelId: "popup-modal-cancel-btn",
			});
		}

		let playbackManager = null;

		const folderManager = createFolderManager({
			uiManager,
			showStatus,
			showPopupConfirmation,
			removeFolderSelect,
			miniFolderSelect,
			removeFolderBtn,
			renameFolderBtn,
			renameFolderModal,
			renameFolderInput,
			renameSaveBtn,
			renameCancelBtn,
			toggleReorderBtn,
			miniToggleReorderBtn,
			reorderContainer,
			miniReorderContainer,
			getRefreshPlaylist: () => playbackManager.refreshPlaylist,
		});

		const {
			updateRemoveButtonState,
			populateFolderDropdowns,
			handleCreateFolder,
			handleRemoveFolder,
			handleRenameFolder,
			cancelReorderMode,
			addDragDropListeners,
		} = folderManager;

		playbackManager = createPlaybackManager({
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
			getPlaylistRenderer: () => playlistRenderer,
			getCachedPrefs: () => cachedPrefs,
			getCurrentDetectedUrl: () => currentDetectedUrl,
			addDragDropListeners,
			getDraggedItem: folderManager.getDraggedItem,
		});

		const {
			setPlaybackLoading,
			setPlaybackClosing,
			updateAutoAddVisuals,
			renderPlaylist,
			refreshPlaylist,
			updateItemDelta,
			updateNativeHostStatusUI,
		} = playbackManager;

		const refreshPreferences = async () => {
			try {
				const res = await sendMessageAsync({ action: "get_ui_preferences" });
				if (res?.success && res.preferences) {
					cachedPrefs = res.preferences;
					optionsManager.updateAllPreferencesUI(res.preferences);
					if (btnMiniToggleStub) {
						const isStubEnabled = res.preferences.showMinimizedStub ?? true;
						btnMiniToggleStub.classList.toggle("active-toggle", isStubEnabled);
					}
					if (res.preferences.kbOpenPopup) {
						popupKeybinds.openPopup = res.preferences.kbOpenPopup;
					}
				}
			} catch (err) {
				console.error("[Popup] Failed to refresh preferences:", err);
			}
		};

		const backupManager = createBackupManager({
			uiManager,
			showStatus,
			populateFolderDropdowns,
			refreshPreferences,
			exportFilenameModal,
			exportFilenameInput,
			exportSaveBtn,
			exportCancelBtn,
			importSelectionModal,
			importFileSelect,
			importConfirmBtn,
			importCancelBtn,
			exportDataBtn,
			miniExportDataBtn,
			exportAllDataBtn,
			miniExportAllDataBtn,
			openExportFolderBtn,
			miniOpenExportFolderBtn,
			openExportFolderBtnAlt,
			importDataBtn,
			miniImportDataBtn,
			importSettingsBtn,
			exportSettingsBtn,
		});
						// Quick Action Bar Listeners
				

		showOnPageControllerBtn.addEventListener("click", async () => {
			try {
				const activeTab = await getActiveTab();
				const tabId = activeTab?.id;

				const response = await sendMessageAsync({
					action: "set_minimized_state",
					minimized: false,
					tabId: tabId,
				});
				if (response?.success) {
					uiManager.setMode("full");
				} else {
					showStatus(response?.error || "Could not show controller.", true);
				}
			} catch (err) {
				showStatus("Could not show controller: " + err.message, true);
			}
		});

		hideOnPageControllerBtn.addEventListener("click", async () => {
			try {
				const activeTab = await getActiveTab();
				const tabId = activeTab?.id;

				const response = await sendMessageAsync({
					action: "set_minimized_state",
					minimized: true,
					tabId: tabId,
				});
				if (response?.success) {
					uiManager.setMode("mini");
					refreshPlaylist(null, true);
				} else {
					showStatus(response?.error || "Could not hide controller.", true);
				}
			} catch (err) {
				showStatus("Could not hide controller: " + err.message, true);
			}
		});
		// --- Folder Management Event Listeners (Refactored) ---

		// Real-time character counts
		const updateCharCount = (input, spanId) => {
			const span = document.getElementById(spanId);
			if (span) span.textContent = `${input.value.length}/64`;
		};
		newFolderNameInput.addEventListener("input", () =>
			updateCharCount(newFolderNameInput, "new-folder-char-count"),
		);
		miniNewFolderNameInput.addEventListener("input", () =>
			updateCharCount(miniNewFolderNameInput, "mini-new-folder-char-count"),
		);

		// Create Folder
		createFolderBtn.addEventListener("click", handleCreateFolder);
		newFolderNameInput.addEventListener(
			"keydown",
			(e) => e.key === "Enter" && createFolderBtn.click(),
		);
		miniCreateFolderBtn.addEventListener("click", handleCreateFolder);
		miniNewFolderNameInput.addEventListener(
			"keydown",
			(e) => e.key === "Enter" && miniCreateFolderBtn.click(),
		);

		// Remove Folder
		removeFolderBtn.addEventListener("click", () =>
			handleRemoveFolder(removeFolderSelect.value),
		);
		miniRemoveFolderBtn.addEventListener("click", () =>
			handleRemoveFolder(miniFolderSelect.value),
		);

		// Rename Folder
		renameFolderBtn.addEventListener("click", handleRenameFolder);
		miniRenameFolderBtn.addEventListener("click", handleRenameFolder);

		// Listeners unique to each view
		removeFolderSelect.addEventListener("change", updateRemoveButtonState);
		miniManageFoldersBtn.addEventListener("click", () => {
			const isVisible = miniFolderManagementControls.style.display === "block";
			miniFolderManagementControls.style.display = isVisible ? "none" : "block";
		});
		btnMiniToggleSettings.addEventListener("click", () => {
			const isVisible = miniSettingsControls.style.display !== "none";
			miniSettingsControls.style.display = isVisible ? "none" : "block";
			
			// Ensure shared elements are visible when container opens
			if (!isVisible) {
				uiManager.sharedElements.settings.style.display = "block";
			}
		});

		const btnFullToggleSettings = document.getElementById("btn-full-toggle-settings");
		const fullSettingsControls = document.getElementById("full-settings-controls");
		if (btnFullToggleSettings && fullSettingsControls) {
			let isInitiallyOpen = false;
			try {
				isInitiallyOpen = localStorage.getItem("mpv_full_settings_open") === "true";
			} catch (e) {
				logger?.debug?.("[Popup] Failed to read full_settings_open from localStorage:", { data: e });
			}

			fullSettingsControls.style.display = isInitiallyOpen ? "block" : "none";
			btnFullToggleSettings.classList.toggle("active", isInitiallyOpen);

			btnFullToggleSettings.addEventListener("click", () => {
				const isCurrentlyOpen = fullSettingsControls.style.display !== "none";
				const willBeOpen = !isCurrentlyOpen;
				fullSettingsControls.style.display = willBeOpen ? "block" : "none";
				btnFullToggleSettings.classList.toggle("active", willBeOpen);
				try {
					localStorage.setItem("mpv_full_settings_open", willBeOpen ? "true" : "false");
				} catch (e) {
					logger?.debug?.("[Popup] Failed to write full_settings_open to localStorage:", { data: e });
				}

				if (willBeOpen) {
					uiManager.sharedElements.settings.style.display = "block";
				}
			});
		}
		if (btnMiniToggleStub) {
			btnMiniToggleStub.addEventListener("click", async () => {
				const currentVal = cachedPrefs?.showMinimizedStub ?? true;
				const newVal = !currentVal;
				
				// Optimistic local update
				if (cachedPrefs) cachedPrefs.showMinimizedStub = newVal;
				btnMiniToggleStub.classList.toggle("active-toggle", newVal);

				try {
					const response = await sendMessageAsync({
						action: "set_ui_preferences",
						preferences: { showMinimizedStub: newVal },
					});
					if (!response?.success) {
						throw new Error(response?.error || "Failed to update stub preference.");
					}
				} catch (err) {
					if (cachedPrefs) cachedPrefs.showMinimizedStub = currentVal;
					btnMiniToggleStub.classList.toggle("active-toggle", currentVal);
					showStatus("Failed to update minimized stub setting.", true);
				}
			});
		}

		folderManager.bindFolderListeners();
		backupManager.bindBackupListeners();

		const optionsManager = new OptionsManager({
			sendMessageAsync,
			showStatus,
			fetchAniListReleases: (...args) => aniListManager.fetchAniListReleases(...args),
		});

		playlistRenderer = new PlaylistRenderer(playlistContainer, {
			callbacks: {
				onRemove: (index, id) => {
					MpvInterface.removeItem(miniFolderSelect.value, { index, id }).catch(err => {
						showStatus("Failed to remove item: " + err.message, true);
						refreshPlaylist(); // Rollback
					});
				},
				onCopy: (url) => {
					navigator.clipboard.writeText(url)
						.then(() => showStatus("Copied URL to clipboard."))
						.catch(() => showStatus("Failed to copy URL.", true));
				},
				onWatchedToggle: (itemId, isMarked) => {
					MpvInterface.updateMarkedAsWatched(miniFolderSelect.value, itemId, isMarked).catch(err => {
						showStatus("Failed to update watched status.", true);
						refreshPlaylist(); // Rollback
					});
				},
				onLog: (log) => showStatus(log.text, log.type === "error")
			},
			prefs: cachedPrefs || {}
		});

		// Unified Playback State Subscription (Runs AFTER playlistRenderer initialization)
		const MPV = window.MPV_INTERNAL;
		playbackUnsubscribe = MPV.playbackStateManager.subscribe((pbState) => {
			const currentFolderId = miniFolderSelect?.value;
			const isCurrentFolder = pbState.folderId && currentFolderId && pbState.folderId.toLowerCase() === currentFolderId.toLowerCase();

			if (isCurrentFolder) {
				// Update local persistent state
				popupState.isFolderActive = pbState.status !== "stopped";
				popupState.lastPlayedId = pbState.lastPlayedId;
				popupState.isPaused = pbState.status === "paused";
				popupState.needsAppend = pbState.needsAppend;

				setPlaybackLoading(pbState.status === "loading");
				setPlaybackClosing(pbState.isClosing);
				
				// Ensure the play button and list highlights are correct
				renderPlaylist(
					null, // Use cached playlist
					pbState.lastPlayedId,
					pbState.status !== "stopped",
					pbState.status === "paused",
					pbState.needsAppend
				);
			} else {
				// Inactive folder view: reset local playback visual state
				popupState.isFolderActive = false;
				popupState.isPaused = false;
				popupState.needsAppend = false;
				setPlaybackLoading(false);
				setPlaybackClosing(false);
				renderPlaylist(
					null,
					popupState.lastPlayedId,
					false,
					false,
					false
				);
			}
		});

		miniFolderSelect.addEventListener("change", async () => {
			const newFolderId = miniFolderSelect.value;
			setPlaybackLoading(false);
			setPlaybackClosing(false);
			refreshPlaylist();
			try {
				await sendMessageAsync({
					action: "set_last_folder_id",
					folderId: newFolderId,
				});
			} catch (e) {
				console.error("Failed to set last folder ID:", e);
			}
		});

		playbackManager.bindPlaybackListeners();

		const popupKeybinds = { openPopup: null };

		/**
		 * Handles global keyboard shortcuts for the popup.
		 * Allows toggling the popup closed with the same keybind used to open it.
		 */
		function handleGlobalKeydown(e) {
			if (!popupKeybinds.openPopup) return;

			// Ignore if typing in an input
			if (
				["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName) ||
				e.target.isContentEditable
			) {
				// Special case: recording a new keybind in OptionsManager.
				// We shouldn't close the popup if the user is literally setting the shortcut.
				if (e.target.classList.contains("recording-active")) return;
			}

			const modifiers = [];
			if (e.ctrlKey) modifiers.push("Ctrl");
			if (e.shiftKey) modifiers.push("Shift");
			if (e.altKey) modifiers.push("Alt");
			if (e.metaKey) modifiers.push("Meta");

			let key = e.key;
			if (key === " ") key = "Space";
			if (key.length === 1) key = key.toUpperCase();

			if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;

			const combo = [...modifiers, key].join("+").toLowerCase();
			const normalize = (str) => {
				if (!str) return "";
				return str
					.replace(/\s+/g, "")
					.toLowerCase()
					.replace("control", "ctrl")
					.replace("command", "meta")
					.replace("cmd", "meta")
					.replace("option", "alt");
			};

			if (combo === normalize(popupKeybinds.openPopup)) {
				e.preventDefault();
				e.stopPropagation();
				window.close();
			}
		}

		// Attach global listener
		window.addEventListener("keydown", handleGlobalKeydown, true);

		// --- Main Initialization ---
		async function initializePopup() {
			try {
				// 1. INSTANT RENDER: Direct storage access (No Background Script required)
				// This bypasses Service Worker wakeup lag completely.
				const initialStorage = await chrome.storage.local.get([
					"mpv_settings",
					"mpv_folder_index",
					"mpv_playback_cache",
				]);

				// Reconstruct minimal baseline data for instant render
				const prefs = initialStorage.mpv_settings?.uiPreferences?.global;
				cachedPrefs = prefs;
				const folderIds = initialStorage.mpv_folder_index || ["Default"];
				const playbackCache = initialStorage.mpv_playback_cache || {};
				
				// Priority for initial folder:
				// 1. If MPV is running (active/not idle), show THAT folder instantly.
				// 2. Otherwise use last used folder.
				const isCacheActive = playbackCache.folderId && (playbackCache.isRunning || !playbackCache.isIdle);
				const lastUsedFolderId = (isCacheActive ? playbackCache.folderId : (initialStorage.mpv_settings?.lastUsedFolderId || folderIds[0]));

				// Get initial playlist for the target folder instantly
				const initialPlaylistData = await chrome.storage.local.get(
					`mpv_folder_data_${lastUsedFolderId}`,
				);
				const initialPlaylist =
					initialPlaylistData[`mpv_folder_data_${lastUsedFolderId}`]
						?.playlist || [];
				const lastPlayedId =
					initialPlaylistData[`mpv_folder_data_${lastUsedFolderId}`]
						?.lastPlayedId;

				// Set initial mode optimistically based on prefs
				const showMiniView = prefs?.mode === "minimized";
				uiManager.setMode(showMiniView ? "mini" : "full");

				// Apply baseline UI instantly
				if (prefs) {
					optionsManager.updateAllPreferencesUI(prefs);
					if (btnMiniToggleStub) {
						const isStubEnabled = prefs.showMinimizedStub ?? true;
						btnMiniToggleStub.classList.toggle("active-toggle", isStubEnabled);
					}
					if (prefs.kbOpenPopup)
						popupKeybinds.openPopup = prefs.kbOpenPopup;
				}

				populateFolderDropdowns({ success: true, folderIds, lastUsedFolderId });

				// Seed the playback manager with the cache instantly
				MPV.playbackStateManager.update({
					folderId: playbackCache.folderId,
					isRunning: playbackCache.isRunning || !playbackCache.isIdle,
					isPaused: playbackCache.isPaused,
					isIdle: playbackCache.isIdle,
					lastPlayedId: playbackCache.lastPlayedId,
					sessionIds: playbackCache.sessionIds,
					needsAppend: playbackCache.needsAppend
				});

				if (uiManager.isMiniView()) {
					// Render playlist instantly from storage (Static state + Playback cache)
					const isFolderMatch = playbackCache.folderId && lastUsedFolderId && playbackCache.folderId.toLowerCase() === lastUsedFolderId.toLowerCase();
					const isFolderActive =
						isFolderMatch &&
						(playbackCache.isRunning || !playbackCache.isIdle);
					const isPaused = (playbackCache.isPaused || playbackCache.isIdle) || false;

					// Priority for lastPlayedId: Cache (real-time) > Storage (backup)
					const effectiveLastPlayedId =
						isFolderMatch &&
						playbackCache.lastPlayedId
							? playbackCache.lastPlayedId
							: lastPlayedId;

					// Determine if we need append based on session IDs in cache vs current playlist
					let needsAppend = false;
					if (playbackCache.sessionIds && initialPlaylist.length > 0) {
						const sessionIds = new Set(playbackCache.sessionIds);
						needsAppend = initialPlaylist.some(
							(item) => !sessionIds.has(item.id),
						);
					}

					renderPlaylist(
						initialPlaylist,
						effectiveLastPlayedId,
						isFolderActive,
						isPaused,
						needsAppend,
						null,
						true,
					);

					// Show loading state instantly if cache says we are launching
					if (
						playbackCache.isLaunching &&
						isFolderMatch
					) {
						MPV.playbackStateManager.setLoading(lastUsedFolderId);
					}

					if (miniAddBtn) miniAddBtn.focus({ preventScroll: true });
				} else {
					if (prefs?.autofocusNewFolder) newFolderNameInput.focus({ preventScroll: true });
				}

				// 2. DEEP SYNC: Now fetch live/contextual data (Can be slow)
				(async () => {
					try {
						// Update native host status (Async)
						updateNativeHostStatusUI();

						sendMessageAsync({ action: "get_auto_add_state" })
							.then((res) => {
								if (res?.success) updateAutoAddVisuals(res.active);
							})
							.catch((err) => {
								logger?.debug?.("[Popup] Failed to get auto-add state:", { data: err });
							});

						// Request deep sync from manager
						MPV.playbackStateManager.requestSync();
						const activeTab = await getActiveTab();
						const isHttp = activeTab?.url?.startsWith("http") ?? false;
						isCurrentTabHttp = isHttp;
						const tabId = activeTab?.id;

						// Attempt to 'steal' state from the on-page controller (Ultra Fast Sync)
						if (tabId && uiManager.isMiniView()) {
							try {
								const tabState = await new Promise((resolve) => {
									chrome.tabs.sendMessage(tabId, { action: "get_controller_state" }, (res) => {
										if (chrome.runtime.lastError) resolve(null);
										else resolve(res);
									});
								});

								if (tabState && tabState.success && tabState.folderId && lastUsedFolderId && tabState.folderId.toLowerCase() === lastUsedFolderId.toLowerCase()) {
									renderPlaylist(
										tabState.playlist,
										tabState.lastPlayedId,
										tabState.isFolderActive,
										false, // Pause state unknown
										false, // Append state unknown
									);
									if (tabState.isClosing) setPlaybackClosing(true);
									console.log("[Popup] Synced state from active tab controller.");
								}
							} catch (e) {
								logger?.debug?.("[Popup] Failed to sync state from active tab controller:", { data: e });
							}
						}

						// Sync Mode: Correct initial mode if tab-specific state differs
						let uiState = null;
						if (isHttp && tabId) {
							// PING CHECK: Detect if content script is blocked or dead
							const isContentScriptDead = await new Promise((resolve) => {
								chrome.tabs.sendMessage(tabId, { action: "ping" }, (res) => {
									if (chrome.runtime.lastError) resolve(true);
									else resolve(false);
								});
								// 200ms timeout for the ping to avoid hanging if the script is blocked
								setTimeout(() => resolve(true), 200);
							});

							const uiStateResponse = await sendMessageAsync({
								action: "get_ui_state_for_tab",
								tabId,
							});
							uiState = uiStateResponse?.state;
							uiManager.determineAndSetInitialMode(isHttp, uiState, cachedPrefs || prefs, isContentScriptDead);

							if (uiState?.preferences) {
								cachedPrefs = uiState.preferences;
								optionsManager.updateAllPreferencesUI(uiState.preferences);
								
								// Update quick toggles
								if (btnMiniToggleStub) {
									const isStubEnabled = uiState.preferences.showMinimizedStub ?? true;
									btnMiniToggleStub.classList.toggle("active-toggle", isStubEnabled);
								}
							}

							// Update on-page buttons visibility
							showOnPageControllerBtn.style.display = "block";
							hideOnPageControllerBtn.style.display = uiManager.isMiniView()
								? "none"
								: "block";
						}

						// Update Add button state based on detected URL
						if (activeTab && miniAddBtn) {
							const isYouTube = activeTab.url
								? activeTab.url.includes("youtube.com/watch")
								: false;
							const detectedUrl = uiState?.detectedUrl;
							if (detectedUrl) currentDetectedUrl = detectedUrl;

							const hasStream = !!detectedUrl || isYouTube;
							miniAddBtn.classList.toggle("stream-present", hasStream);
							miniAddBtn.disabled = !hasStream;
							miniAddBtn.title = !hasStream
								? "No stream detected"
								: isYouTube
									? "YouTube Video detected"
									: "Stream/video detected";
						}
					} catch (bgError) {
						console.warn("[Popup] Background sync failed:", bgError);
					}
				})();
			} catch (error) {
				console.error("[Popup] Initialization error:", error);
				uiManager.setMode("full");
				populateFolderDropdowns();
				updateRemoveButtonState();
				showStatus(`Error initializing popup: ${error.message}`, true);
			}
		}

		// --- Popup Lifecycle Port ---
		// This allows the background script to detect if the popup is open
		// and send a message to close it, enabling the "toggle" keybind.
		const lifecyclePort = chrome.runtime.connect({ name: "popup-lifecycle" });
		lifecyclePort.onMessage.addListener((msg) => {
			if (msg.action === "close_popup") {
				window.close();
			}
		});

		// Add a listener for log messages from the background script.
		// This will only receive messages while the popup is open.
		chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
			// Handle log messages for the status bar
			if (request.log) {
				showStatus(request.log.text, request.log.type === "error");
			}

			if (request.action === "update_playlist_item") {
				const currentFolderId = miniFolderSelect.value;
				if (currentFolderId && request.folderId && currentFolderId.toLowerCase() === request.folderId.toLowerCase()) {
					updateItemDelta(request.itemId, request.delta);
				}
			}

			// Consolidate playback and playlist updates
			if (request.action === "playback_state_changed" || request.action === "playlist_dirty") {
				const currentFolderId = miniFolderSelect.value;
				const state = request.state || request;
				const isFolderMatch = currentFolderId && state.folderId && currentFolderId.toLowerCase() === state.folderId.toLowerCase();
				
				if (isFolderMatch) {
					// 1. Update manager
					MPV.playbackStateManager.update(state);
					
					// 2. Trigger fresh fetch for playlist content if dirty
					if (request.action === "playlist_dirty") {
						refreshPlaylist(null, true);
					} else {
						// Lightweight re-render for status flags
						renderPlaylist(
							null,
							state.lastPlayedId,
							state.isRunning,
							state.isPaused,
							state.needsAppend,
							state.completedIds,
							true
						);
					}
				}
			}

			if (request.action === "auto_add_state_changed") {
				updateAutoAddVisuals(request.active);
			}

			if (request.action === "set_minimized_state") {
				uiManager.setMode(request.minimized ? "mini" : "full");
				if (request.minimized) refreshPlaylist(null, true);
			}

			// Handle live playlist updates to keep the item count and playlist view in sync
			if (request.action === "render_playlist") {
				const isMiniView = uiManager.isMiniView();
				const currentFolderId = miniFolderSelect.value;
				const activePbFolder = MPV.playbackStateManager.state.folderId;
				const isMatchingActiveFolder = activePbFolder && request.folderId && activePbFolder.toLowerCase() === request.folderId.toLowerCase();

				// 1. Update unified manager only if active or matches active session
				if (request.isFolderActive || isMatchingActiveFolder || !activePbFolder) {
					MPV.playbackStateManager.update({
						folderId: request.folderId,
						isRunning: request.isFolderActive,
						isPaused: request.isPaused,
						isIdle: request.isIdle,
						isClosing: request.isClosing,
						lastPlayedId: request.lastPlayedId,
						needsAppend: request.needsAppend,
						sessionIds: request.sessionIds,
					});
				}

				// 2. Heavy data sync (If looking at the right folder)
				if (currentFolderId && request.folderId && currentFolderId.toLowerCase() === request.folderId.toLowerCase()) {
					if (isMiniView) {
						renderPlaylist(
							request.playlist,
							request.lastPlayedId,
							request.isFolderActive,
							request.isPaused,
							request.needsAppend,
							request.completedIds,
							true,
						);
					}
				}
			}

			// Sync folder selection if it changed in another context (e.g. on page)
			if (request.action === "last_folder_changed") {
				if (miniFolderSelect.value && request.folderId && miniFolderSelect.value.toLowerCase() !== request.folderId.toLowerCase()) {
					miniFolderSelect.value = request.folderId;
					refreshPlaylist(null, true);
				}
				if (removeFolderSelect && request.folderId && removeFolderSelect.value.toLowerCase() !== request.folderId.toLowerCase()) {
					removeFolderSelect.value = request.folderId;
					updateRemoveButtonState();
				}
			}

			// Handle folder data changes (e.g. IDs assigned after playback starts)
			if (request.foldersChanged) {
				populateFolderDropdowns();
			}

			// Handle live changes to the detected URL to update the "Add" button's state
			if (request.action === "detected_url_changed") {
				getActiveTab()
					.then((activeTab) => {
						// The miniAddBtn is for the mini-controller view.
						// We check if the message is for the currently active tab.
						if (activeTab && activeTab.id === request.tabId && miniAddBtn) {
							currentDetectedUrl = request.url;

							const isYouTube = !!activeTab?.url?.includes("youtube.com/watch");
							const hasStream = !!request.url || isYouTube;

							miniAddBtn.classList.toggle("stream-present", hasStream);
							miniAddBtn.disabled = !hasStream;

							if (!hasStream) {
								miniAddBtn.title = "No stream detected";
							} else {
								miniAddBtn.title = isYouTube
									? "YouTube Video detected"
									: "Stream/video detected";
							}
						}
					})
					.catch((e) =>
						console.error("Failed to query tabs for detected_url_changed:", e),
					);
			}

			// If preferences changed in another context (e.g., dragging the anilist panel), update our UI.
			if (request.action === "preferences_changed") {
				const getPrefs = async () => {
					const activeTab = await getActiveTab();
					const tabId = activeTab?.id || null;
					return sendMessageAsync({ action: "get_ui_preferences", tabId });
				};

				getPrefs()
					.then((response) => {
						if (response?.success && response.preferences) {
							cachedPrefs = response.preferences;
							optionsManager.updateAllPreferencesUI(response.preferences);
						}
						if (btnMiniToggleStub && response?.preferences) {
							const isStubEnabled =
								response.preferences.showMinimizedStub ?? true;
							btnMiniToggleStub.classList.toggle("active-toggle", isStubEnabled);
						}
					})
					.catch((e) =>
						console.error(
							"Failed to get preferences for preferences_changed:",
							e,
						),
					);
			}

			if (request.action === "show_status_banner") {
				showStatus(request.message, !!request.isError);
				if (sendResponse) sendResponse({ success: true });
				return true;
			}

			// New: Handle confirmation requests from the background script
			if (request.action === "show_popup_confirmation") {
				// This is an async action, so we must return true.
				(async () => {
					try {
						const confirmed = await showPopupConfirmation(request.message);
						sendResponse({ confirmed });
					} catch (e) {
						logger?.warn?.("[Popup] show_popup_confirmation failed:", { data: e });
						sendResponse({ confirmed: false });
					}
				})();
				return true;
			}
		});

		// AniList Releases Logic
		const anilistReleasesSection = document.querySelector(
			".anilist-releases-section",
		);
		const anilistReleasesContent = document.getElementById(
			"anilist-releases-content",
		);
		const refreshAnilistBtn = document.getElementById("btn-refresh-anilist");
		const anilistNavControls = document.querySelector(".anilist-nav-controls");
		const btnAnilistPrev = document.getElementById("btn-anilist-prev");
		const btnAnilistNext = document.getElementById("btn-anilist-next");
		const btnAnilistToday = document.getElementById("btn-anilist-today");

		const aniListManager = createAniListManager({
			anilistReleasesSection,
			anilistReleasesContent,
			refreshAnilistBtn,
			anilistNavControls,
			btnAnilistPrev,
			btnAnilistNext,
			btnAnilistToday,
		});
		aniListManager.bindAniListListeners();

		// Start the initialization process
		optionsManager.initializeEventListeners();
		initializePopup();

		const youTubeToolsManager = createYouTubeToolsManager({
			showStatus,
			onHideMpvView: () => {
				uiManager.views.mini.style.display = "none";
				uiManager.views.full.style.display = "none";
			},
			onRestoreMpvView: () => {
				uiManager.setMode(uiManager.activeMode || "full");
			},
		});
		uiManager.isMpvViewHidden = () => youTubeToolsManager.getActiveExtTab() === "yt";
		youTubeToolsManager.initialize();

		// Periodic Sync: Now replaced by reactive storage listener for better performance.
		chrome.storage.onChanged.addListener((changes, areaName) => {
			if (areaName !== "local") return;
			
			if (changes.active_playback_state) {
				const newState = changes.active_playback_state.newValue;
				if (newState && miniFolderSelect?.value && newState.folderId?.toLowerCase() === miniFolderSelect.value.toLowerCase()) {
					console.log("[Popup] Reactive Storage Sync:", newState);
					
					// Update manager
					MPV.playbackStateManager.update(newState);
					
					// Re-render
					renderPlaylist(
						null,
						newState.lastPlayedId,
						newState.isRunning,
						newState.isPaused,
						newState.needsAppend,
						newState.completedIds,
						true
					);
				}
			}
		});
	} catch (e) {
		console.error("Error in DOMContentLoaded handler:", e);
		showStatus(`Critical error: ${e.message}`, true);
		reportBrowserError("Popup", `Critical DOMContentLoaded error: ${e.message}`, { stack: e.stack || "", data: e }).catch((logErr) => {
			logger?.warn?.(`[Popup] Failed to send critical error to logger: ${logErr.message}`);
		});
	}
});
