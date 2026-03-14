import { domUtils } from "./utils/domUtils.module.js";
import { AniListRenderer } from "./utils/anilist_renderer.module.js";
import {
	debounce,
	getYoutubeId,
	isYouTubeUrl,
	normalizeYouTubeUrl,
	sendMessageAsync,
} from "./utils/commUtils.module.js";
import { OptionsManager } from "./utils/settings.js";
import { MpvInterface } from "./utils/MpvInterface.module.js";
import { PlaylistRenderer } from "./utils/PlaylistRenderer.js";

document.addEventListener("DOMContentLoaded", async () => {
	try {
		// This line is intentionally kept for the diff

		// IMPORTANT: You must include settings.js in your popup.html before this script, like so:
		// <script src="settings.js"></script>

		// --- Element Definitions ---
		const sharedAnilistSection = document.getElementById(
			"shared-anilist-section",
		);

		// This needs to be defined before UIModeManager which uses it.
		const statusMessageElement = document.getElementById("status-message");

		/**
		 * SHOW STATUS (LOG BAR)
		 * This function handles the text that appears in the fixed bottom bar.
		 * 
		 * @param {string} text - The message to display.
		 * @param {boolean} isError - If true, styles the message as an error (red).
		 */
		function showStatus(text, isError = false) {
			statusMessageElement.textContent = text;
			
			// Colors are defined in popup.css via variables
			statusMessageElement.style.color = isError
				? "var(--accent-danger)"
				: "var(--accent-success)";
		}

		// --- UI Mode Manager ---
		// This class centralizes the logic for handling the two different UI views (mini and full).
		class UIModeManager {
			constructor() {
				this.views = {
					mini: document.getElementById("mini-controller-view"),
					full: document.getElementById("folder-management-view"),
				};
				this.activeMode = null;

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

				this.activeMode = mode;
				this.views.mini.style.display = mode === "mini" ? "flex" : "none";
				this.views.full.style.display = mode === "full" ? "block" : "none";

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
			 */
			determineAndSetInitialMode(isHttp, uiState, prefs) {
				let showMiniView = false;
				if (isHttp) {
					showMiniView = uiState?.minimized ?? prefs?.mode === "minimized";
				} else {
					// On restricted pages (like brave://), use the global preference.
					// This allows users to access playback controls via the mini-popup
					// even when the on-page controller cannot be injected.
					showMiniView = prefs?.mode === "minimized";
				}
				this.setMode(showMiniView ? "mini" : "full");
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

		// Views
		const miniControllerView = document.getElementById("mini-controller-view");
		const folderManagementView = document.getElementById(
			"folder-management-view",
		);

		// Folder Management View Elements
		const newFolderNameInput = document.getElementById("new-folder-name");
		const createFolderBtn = document.getElementById("btn-create-folder");
		const removeFolderSelect = document.getElementById("remove-folder-select");
		const renameFolderBtn = document.getElementById("btn-rename-folder");
		const removeFolderBtn = document.getElementById("btn-remove-folder");
		const customGeometryContainer = document.getElementById(
			"custom-geometry-container",
		);
		const customWidthInput = document.getElementById("custom-width");

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

		let folderToRename = null;
		let currentDetectedUrl = null;
		let isPlaybackLoading = false;
		let isPlaybackClosing = false;
		let cachedPrefs = null;
		let loadingTimeout = null;

		// Persistent state for UI consistency
		const popupState = {
			isFolderActive: false,
			lastPlayedId: null,
			isPaused: false,
			needsAppend: false,
			currentPlaylist: [],
		};

		// Unified Playback State Subscription
		const MPV = window.MPV_INTERNAL;
		const playbackUnsubscribe = MPV.playbackStateManager.subscribe((pbState) => {
			// Update local persistent state
			popupState.isFolderActive = pbState.status !== "stopped";
			popupState.lastPlayedId = pbState.lastPlayedId;
			popupState.isPaused = pbState.status === "paused";
			popupState.needsAppend = pbState.needsAppend;

			// Only update UI if we are looking at the relevant folder
			const currentFolderId = miniFolderSelect?.value;
			if (pbState.folderId === currentFolderId) {
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
			}
		});

		// Selection Mode State
		let isSelectionModeActive = false;

		// Reorder Elements
		const reorderContainer = document.getElementById("reorder-container");
		const miniReorderContainer = document.getElementById(
			"mini-reorder-container",
		);
		const toggleReorderBtn = document.getElementById("btn-toggle-reorder");
		const miniToggleReorderBtn = document.getElementById(
			"btn-mini-toggle-reorder",
		);

		// Reorder State
		let isReorderModeActive = false;
		let draggedItem = null;
		const statusMessage = statusMessageElement;

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

		/**
		 * Populates all folder dropdowns in the popup.
		 * @param {object} data Optional pre-fetched folder data.
		 */
		function populateFolderDropdowns(data = null) {
			const processResponse = (response) => {
				if (!response?.success) return;

				// Clear existing options
				removeFolderSelect.innerHTML =
					'<option value="">Select folder to remove...</option>';
				miniFolderSelect.innerHTML = "";

				response.folderIds.forEach((id, index) => {
					const option = document.createElement("option");
					option.value = id;
					option.textContent = `${index + 1}. ${id}`;
					removeFolderSelect.appendChild(option.cloneNode(true));
					miniFolderSelect.appendChild(option);
				});

				if (
					response.lastUsedFolderId &&
					response.folderIds.includes(response.lastUsedFolderId)
				) {
					miniFolderSelect.value = response.lastUsedFolderId;
					removeFolderSelect.value = response.lastUsedFolderId;
				}

				updateRemoveButtonState();
			};

			if (data) {
				processResponse(data);
			} else {
				sendMessageAsync({ action: "get_all_folder_ids" })
					.then(processResponse)
					.then(() => {
						if (uiManager.isMiniView()) refreshPlaylist();
					})
					.catch((e) => {
						console.error("Failed to populate folder dropdowns:", e);
						showStatus("Connection to background script lost.", true);
					});
			}
		}

		/**
		 * Handles the logic for creating a new folder.
		 */
		function handleCreateFolder() {
			const inputElement = uiManager.newFolderNameInput;
			const newName = inputElement.value.trim();
			if (!newName) {
				showStatus("Folder name cannot be empty.", true);
				return;
			}

			if (newName.length > 64) {
				showStatus("Folder name is too long (max 64 characters).", true);
				return;
			}

			// Add validation for folder name characters by disallowing invalid filename chars.
			const invalidCharsRegex = /[\\/:*?"<>|$;&`]/;
			if (invalidCharsRegex.test(newName)) {
				showStatus('Folder name cannot contain /  : * ? " < > | $ ; & `', true);
				return;
			}

			sendMessageAsync({ action: "create_folder", folderId: newName })
				.then((response) => {
					if (response.success) {
						showStatus(`Folder "${newName}" created!`);
						inputElement.value = "";
						populateFolderDropdowns();
					} else {
						showStatus(response.error || "An unknown error occurred.", true);
					}
				})
				.catch((e) => {
					showStatus("Failed to create folder: " + e.message, true);
				});
		}

		/**
		 * Handles the logic for removing a folder after confirmation.
		 * @param {string} folderId The ID of the folder to remove.
		 */
		async function handleRemoveFolder(folderId) {
			if (!folderId) {
				return showStatus("No folder selected to remove.", true);
			}

			try {
				const prefsResponse = await sendMessageAsync({
					action: "get_ui_preferences",
				});
				const prefs = prefsResponse?.preferences;
				if (prefs?.confirmRemoveFolder ?? true) {
					const confirmed = await showPopupConfirmation(
						`Are you sure you want to remove the folder "${folderId}"? This action cannot be undone.`,
					);
					if (!confirmed) return;
				}

				const response = await sendMessageAsync({
					action: "remove_folder",
					folderId: folderId,
				});
				if (response.success) {
					showStatus(`Folder "${folderId}" removed.`);
					populateFolderDropdowns();
				} else {
					showStatus(response.error || "An unknown error occurred.", true);
				}
			} catch (e) {
				showStatus("Failed to remove folder: " + e.message, true);
			}
		}

		function handleRenameFolder() {
			const selectedFolder = uiManager.folderSelect.value;

			if (!selectedFolder) {
				return showStatus("No folder selected to rename.", true);
			}

			folderToRename = selectedFolder;
			renameFolderInput.value = selectedFolder;
			renameFolderModal.style.display = "flex";
			renameFolderInput.focus({ preventScroll: true });
			renameFolderInput.select();
		}

		async function saveRename() {
			const oldFolderId = folderToRename;
			const newFolderId = renameFolderInput.value.trim();

			if (!newFolderId) {
				return showStatus("New folder name cannot be empty.", true);
			}

			if (newFolderId.length > 64) {
				showStatus("New folder name is too long (max 64 characters).", true);
				return;
			}
			if (oldFolderId === newFolderId) {
				renameFolderModal.style.display = "none";
				return; // No change
			}

			// Add validation for folder name characters by disallowing invalid filename chars.
			const invalidCharsRegex = /[\\/:*?"<>|$;&`]/;
			if (invalidCharsRegex.test(newFolderId)) {
				showStatus(
					'New folder name cannot contain /  : * ? " < > | $ ; & `',
					true,
				);
				return;
			}

			try {
				const response = await sendMessageAsync({
					action: "rename_folder",
					oldFolderId,
					newFolderId,
				});

				if (response.success) {
					showStatus(response.message);
					populateFolderDropdowns();
				} else {
					showStatus(response.error || "Failed to rename folder.", true);
				}
			} catch (e) {
				showStatus("Failed to rename folder: " + e.message, true);
			}

			renameFolderModal.style.display = "none";
			folderToRename = null;
		}

		/**
		 * Enables or disables the remove button based on selection.
		 */
		function updateRemoveButtonState() {
			const hasSelection = !!removeFolderSelect.value;
			removeFolderBtn.disabled = !hasSelection;
			renameFolderBtn.disabled = !hasSelection;
		}

		/**
		 * Fetches the playlist for a given folder and renders it.
		 * @param {object} data Optional pre-fetched playlist data.
		 */
		async function refreshPlaylist(data = null, preventScroll = false) {
			const processResponse = (response) => {
				if (response?.success) {
					// 1. Update unified manager first
					MPV.playbackStateManager.update({
						folderId: miniFolderSelect.value,
						isRunning: response.isRunning,
						isPaused: response.isPaused,
						isIdle: response.isIdle,
						lastPlayedId: response.lastPlayedId,
						needsAppend: response.needsAppend
					});

					// 2. Heavy data sync
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

		function setPlaybackLoading(isLoading) {
			isPlaybackLoading = isLoading;
			if (!miniPlayBtn) return;
			
			miniPlayBtn.classList.toggle("btn-loading", isLoading);
			if (isLoading) {
				miniPlayBtn.classList.remove("btn-playing");
				// Safety Timeout: Prevent infinite loading
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

		/**
		 * Renders the items of the currently selected folder into the playlist container.
		 * @param {Array} playlist - The array of URL items to render.
		 * @param {string} lastPlayedId - The ID of the item that was last played in this folder.
		 * @param {boolean} isFolderActive - Whether this folder is currently being played in MPV.
		 * @param {boolean} isPaused - Whether the active playback is paused.
		 * @param {boolean} needsAppend - Whether there are items to append to the active session.
		 */
		function renderPlaylist(
			playlist,
			lastPlayedId,
			isFolderActive = null,
			isPaused = null,
			needsAppend = null,
			completedIds = null,
			preventScroll = false,
		) {
			// Update persistent state with whatever was provided
			if (playlist) popupState.currentPlaylist = playlist;
			if (lastPlayedId) popupState.lastPlayedId = lastPlayedId;
			if (typeof isFolderActive === "boolean") popupState.isFolderActive = isFolderActive;
			if (typeof isPaused === "boolean") popupState.isPaused = isPaused;
			if (typeof needsAppend === "boolean") popupState.needsAppend = needsAppend;
			if (completedIds) popupState.completedIds = completedIds;

			// Use fallbacks from persistent state
			const effectivePlaylist = playlist || popupState.currentPlaylist || [];
			const effectiveLastPlayedId = lastPlayedId || popupState.lastPlayedId;
			const effectiveIsFolderActive =
				typeof isFolderActive === "boolean" ? isFolderActive : popupState.isFolderActive;
			const effectiveIsPaused = 
				typeof isPaused === "boolean" ? isPaused : (popupState.isPaused || false);
			const effectiveNeedsAppend = 
				typeof needsAppend === "boolean" ? needsAppend : (popupState.needsAppend || false);
			const effectiveCompletedIds = completedIds || popupState.completedIds || [];

			// Guard: If we are in the closing state, do not update UI button icons
			// or state as 'isPlaybackClosing' has higher visual priority.
			if (isPlaybackClosing) return;

			// 1. Let the shared renderer handle the list
			playlistRenderer.updatePrefs(cachedPrefs || {});
			playlistRenderer.render({
				playlist: effectivePlaylist,
				lastPlayedId: effectiveLastPlayedId,
				isActive: effectiveIsFolderActive,
				isPaused: effectiveIsPaused,
				needsAppend: effectiveNeedsAppend,
				completedIds: effectiveCompletedIds,
				preventScroll: preventScroll
			});

			// 2. Update the play button based on current playback state
			if (miniPlayBtn) {
				const effectiveIsActive = !!effectiveIsFolderActive;
				const showingNeedsAppend = effectiveIsActive && !!effectiveNeedsAppend;

				miniPlayBtn.classList.toggle(
					"btn-playing",
					effectiveIsActive || showingNeedsAppend,
				);
				
				// Clear loading state if we have a definitive render, 
				// unless we are currently awaiting a 'play' command response.
				if (!isPlaybackLoading || effectiveIsActive || showingNeedsAppend) {
					setPlaybackLoading(false);
				}

				if (showingNeedsAppend) {
					miniPlayBtn.title = "Queue to Playlist";
					miniPlayBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`;
				} else if (effectiveIsActive) {
					miniPlayBtn.title = "Play/Pause Playlist";
					miniPlayBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`;
				} else {
					miniPlayBtn.title = "Play Playlist";
					miniPlayBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;
				}
			}
		}

		function updateItemDelta(itemId, delta) {
			playlistRenderer.updateItemDelta(itemId, delta);
		}
						// Quick Action Bar Listeners
				

		showOnPageControllerBtn.addEventListener("click", () => {
			// Send a message to the background script to update the minimized state for the current tab.
			// The background script will then relay this to the correct content script.
			sendMessageAsync({
				action: "set_minimized_state",
				minimized: false,
			}).then((response) => {
				if (response?.success) {
					window.close(); // Close the popup on success
				} else {
					// Show an error if the background script couldn't find the tab or another error occurred.
					showStatus(response?.error || "Could not show controller.", true);
				}
			});
		});

		hideOnPageControllerBtn.addEventListener("click", () => {
			// Send a message to the background script to update the minimized state for the current tab.
			// The background script will then relay this to the correct content script.
			sendMessageAsync({
				action: "set_minimized_state",
				minimized: true,
			}).then((response) => {
				if (response?.success) {
					window.close(); // Close the popup on success
				} else {
					// Show an error if the background script couldn't find the tab or another error occurred.
					showStatus(response?.error || "Could not hide controller.", true);
				}
			});
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
		if (btnMiniToggleStub) {
			btnMiniToggleStub.addEventListener("click", async () => {
				const currentVal = cachedPrefs?.showMinimizedStub ?? true;
				const newVal = !currentVal;
				
				// Optimistic local update
				if (cachedPrefs) cachedPrefs.showMinimizedStub = newVal;
				btnMiniToggleStub.classList.toggle("active-toggle", newVal);

				await sendMessageAsync({
					action: "set_ui_preferences",
					preferences: { showMinimizedStub: newVal },
				});
			});
		}

		// --- Reorder Logic ---

		function getActiveReorderControls() {
			if (uiManager.isMiniView()) {
				return {
					elementsToHide: [
						document.getElementById("mini-folder-select"),
						document.getElementById("btn-mini-manage-folders"),
						document.getElementById("mini-item-count-container"),
					],
				};
			}
			// Full view
			return {
				elementsToHide: [
					document.getElementById("remove-folder-select"),
					document.getElementById("rename-remove-controls"),
				],
			};
		}

		async function toggleReorderMode() {
			isReorderModeActive = !isReorderModeActive;
			const { elementsToHide } = getActiveReorderControls();
			const toggleBtn = uiManager.reorderToggleBtn;
			const container = uiManager.reorderContainer;

			toggleBtn.classList.toggle("active", isReorderModeActive);

			if (isReorderModeActive) {
				if (toggleBtn === toggleReorderBtn) {
					// Main view only
					toggleBtn.textContent = "Save Order";
				}

				elementsToHide.forEach((el) => (el.style.display = "none"));
				container.style.display = "block";
				try {
					const response = await sendMessageAsync({
						action: "get_all_folder_ids",
					});
					if (response.success) {
						renderReorderList(container, response.folderIds);
					}
				} catch (e) {
					showStatus("Failed to load folders for reordering.", true);
				}
			} else {
				const list = container.querySelector(".reorder-list");
				if (list) {
					const newOrder = [...list.children].map(
						(item) => item.dataset.folderId,
					);
					try {
						await sendMessageAsync({
							action: "set_folder_order",
							order: newOrder,
						});
						showStatus("Folder order saved.");
					} catch (e) {
						showStatus("Failed to save folder order.", true);
					}
				}

				if (toggleBtn === toggleReorderBtn) {
					// Main view only
					toggleBtn.textContent = "Reorder";
				}

				container.innerHTML = "";
				container.style.display = "none";
				elementsToHide.forEach((el) => (el.style.display = ""));
				populateFolderDropdowns(); // Refresh dropdowns with new order
			}
		}

		function renderReorderList(container, folderIds) {
			container.innerHTML = ""; // Clear previous list
			const list = document.createElement("ul");
			list.className = "reorder-list";

			folderIds.forEach((id) => {
				const item = document.createElement("li");
				item.className = "reorder-item";
				item.draggable = true;
				item.dataset.folderId = id;

				const handle = document.createElement("span");
				handle.className = "drag-handle";
				handle.innerHTML = "&#9776;"; // Hamburger icon

				const text = document.createTextNode(id);

				item.appendChild(handle);
				item.appendChild(text);
				list.appendChild(item);
			});

			addDragDropListeners(list);
			container.appendChild(list);
		}

		function addDragDropListeners(list) {
			list.addEventListener("dragstart", (e) => {
				draggedItem = e.target;
				setTimeout(() => e.target.classList.add("dragging"), 0);
			});

			list.addEventListener("dragend", () => {
				if (!draggedItem) return;
				draggedItem.classList.remove("dragging");
				draggedItem = null;
			});

			list.addEventListener("dragover", (e) => {
				e.preventDefault();

				const afterElement = domUtils.getDragAfterElement(list, e.clientY, ".reorder-item:not(.dragging), .list-item:not(.dragging)");
				const existingIndicator = list.querySelector(".drag-over");

				if (afterElement) {
					if (existingIndicator && existingIndicator !== afterElement) {
						existingIndicator.classList.remove("drag-over");
					}
					afterElement.classList.add("drag-over");
				} else {
					if (existingIndicator) {
						existingIndicator.classList.remove("drag-over");
					}
				}
			});

			list.addEventListener("drop", (e) => {
				e.preventDefault();
				const dropTarget = list.querySelector(".drag-over");
				if (dropTarget) {
					dropTarget.classList.remove("drag-over");
				}
				if (draggedItem && draggedItem.parentElement === list) {
					list.insertBefore(draggedItem, dropTarget);
				}
			});
		}

		// --- Export/Import Logic ---

		function handleExport() {
			const folderId = uiManager.folderSelect.value;

			if (!folderId) {
				return showStatus("Please select a folder to export.", true);
			}

			// Suggest a default filename with a timestamp, without the extension.
			const date = new Date();
			const year = date.getFullYear();
			const month = String(date.getMonth() + 1).padStart(2, "0");
			const day = String(date.getDate()).padStart(2, "0");
			const hours = String(date.getHours()).padStart(2, "0");
			const minutes = String(date.getMinutes()).padStart(2, "0");
			const seconds = String(date.getSeconds()).padStart(2, "0");
			const safeFolderId = folderId.replace(/[^a-zA-Z0-9_-]/g, "_");
			const suggestedFilename = `mpv_playlist_${safeFolderId}_${year}${month}${day}_${hours}${minutes}${seconds}`;

			exportFilenameInput.value = suggestedFilename;
			exportFilenameModal.style.display = "flex";
			exportFilenameInput.focus({ preventScroll: true });
			exportFilenameInput.select();
		}

		exportCancelBtn.addEventListener("click", () => {
			exportFilenameModal.style.display = "none";
		});

		const handleSaveExport = async () => {
			const filename = exportFilenameInput.value.trim();
			if (!filename) {
				return showStatus("Filename cannot be empty.", true);
			}

			// Basic validation: allow letters, numbers, hyphens, underscores.
			if (!/^[a-zA-Z0-9_.-]+$/.test(filename)) {
				return showStatus(
					"Filename can only contain letters, numbers, hyphens, and underscores.",
					true,
				);
			}

			const folderId = uiManager.folderSelect.value;

			if (!folderId) {
				return showStatus("Please select a folder to export.", true);
			}

			const options = {
				preserveTitle: document.getElementById("export-opt-title").checked,
				preserveLastPlayed: document.getElementById("export-opt-lastplayed")
					.checked,
			};

			try {
				const response = await sendMessageAsync({
					action: "export_folder_playlist",
					filename: filename,
					folderId: folderId,
					options: options,
				});
				if (response?.success) {
					showStatus(response.message);
				} else {
					showStatus(response?.error || "Export failed.", true);
				}
			} catch (e) {
				showStatus("Export failed: " + e.message, true);
			}
			exportFilenameModal.style.display = "none";
		};

		function handleImport() {
			sendMessageAsync({ action: "list_import_files" })
				.then((response) => {
					if (response?.success) {
						importFileSelect.innerHTML = ""; // Clear old options
						if (response.files.length === 0) {
							importFileSelect.innerHTML =
								"<option disabled>No backup files found.</option>";
							importConfirmBtn.disabled = true;
						} else {
							response.files.forEach((file) => {
								const option = document.createElement("option");
								option.value = file;
								option.textContent = file;
								importFileSelect.appendChild(option);
							});
							importConfirmBtn.disabled = false;
						}
						importSelectionModal.style.display = "flex";
					} else {
						showStatus(response?.error || "Could not list import files.", true);
					}
				})
				.catch((e) => {
					showStatus("Failed to list import files: " + e.message, true);
				});
		}

		async function handleExportAll() {
			const modal = document.getElementById("export-all-modal");
			const confirmBtn = document.getElementById("export-all-confirm-btn");
			const cancelBtn = document.getElementById("export-all-cancel-btn");
			const folderListContainer = document.getElementById(
				"export-all-folder-list",
			);

			// Reset container and show modal
			folderListContainer.innerHTML =
				'<p style="margin: 0 0 4px 0; font-size: 14px; color: var(--text-secondary); font-weight: 500;">Custom Filenames (Optional):</p>';
			modal.style.display = "flex";

			try {
				const response = await sendMessageAsync({
					action: "get_all_folder_ids",
				});
				if (response.success && response.folderIds) {
					response.folderIds.forEach((id) => {
						const row = document.createElement("div");
						row.style.display = "flex";
						row.style.alignItems = "center";
						row.style.gap = "8px";

						const label = document.createElement("span");
						label.textContent = id + ":";
						label.style.fontSize = "16px";
						label.style.fontWeight = "500";
						label.style.flexShrink = "0";
						label.style.width = "120px";
						label.style.overflow = "hidden";
						label.style.textOverflow = "ellipsis";
						label.title = id;

						const input = document.createElement("input");
						input.type = "text";
						input.className = "export-all-name-input";
						input.placeholder = id;
						input.dataset.folderId = id;
						input.style.padding = "4px 8px";
						input.style.fontSize = "16px";
						input.style.flexGrow = "1";

						row.append(label, input);
						folderListContainer.appendChild(row);
					});
				}
			} catch (e) {
				console.error("Failed to load folders for Export All:", e);
			}

			confirmBtn.onclick = () => {
				const customNames = {};
				folderListContainer
					.querySelectorAll(".export-all-name-input")
					.forEach((input) => {
						const val = input.value.trim();
						if (val) customNames[input.dataset.folderId] = val;
					});

				const options = {
					preserveTitle: document.getElementById("export-all-opt-title")
						.checked,
					preserveLastPlayed: document.getElementById(
						"export-all-opt-lastplayed",
					).checked,
					customNames: customNames,
				};

				showStatus("Exporting all playlists...");
				chrome.runtime.sendMessage(
					{ action: "export_all_playlists_separately", options },
					(response) => {
						if (response?.success) {
							showStatus(response.message);
						} else {
							showStatus(response?.error || "Export all failed.", true);
						}
					},
				);
				modal.style.display = "none";
			};

			cancelBtn.onclick = () => {
				modal.style.display = "none";
			};
		}

		function handleOpenExportFolder() {
			showStatus("Requesting to open folder...");
			chrome.runtime.sendMessage(
				{ action: "open_export_folder" },
				(response) => {
					if (response?.success) {
						// The native host handles opening the folder. We can close the popup
						// for a seamless experience.
						window.close();
					} else {
						showStatus(response?.error || "Could not open folder.", true);
					}
				},
			);
		}

		async function handleExportSettings() {
			const date = new Date();
			const year = date.getFullYear();
			const month = String(date.getMonth() + 1).padStart(2, "0");
			const day = String(date.getDate()).padStart(2, "0");
			const suggestedFilename = `mpv_settings_backup_${year}${month}${day}`;

			try {
				const response = await sendMessageAsync({
					action: "export_settings",
					filename: suggestedFilename,
				});
				if (response?.success) {
					showStatus(response.message);
				} else {
					showStatus(response?.error || "Export failed.", true);
				}
			} catch (e) {
				showStatus("Export failed: " + e.message, true);
			}
		}

		// Consolidate event listeners for similar actions
		[exportDataBtn, miniExportDataBtn].forEach((btn) =>
			btn.addEventListener("click", handleExport),
		);
		[exportAllDataBtn, miniExportAllDataBtn].forEach((btn) =>
			btn.addEventListener("click", handleExportAll),
		);
		[
			openExportFolderBtn,
			miniOpenExportFolderBtn,
			openExportFolderBtnAlt,
		].forEach((btn) => btn.addEventListener("click", handleOpenExportFolder));
		[importDataBtn, miniImportDataBtn, importSettingsBtn].forEach((btn) =>
			btn.addEventListener("click", handleImport),
		);
		if (exportSettingsBtn)
			exportSettingsBtn.addEventListener("click", handleExportSettings);

		// Modal specific listeners
		exportSaveBtn.addEventListener("click", handleSaveExport);
		exportFilenameInput.addEventListener(
			"keydown",
			(e) => e.key === "Enter" && exportSaveBtn.click(),
		);
		renameCancelBtn.addEventListener("click", () => {
			renameFolderModal.style.display = "none";
			folderToRename = null;
		});
		renameSaveBtn.addEventListener("click", saveRename);
		renameFolderInput.addEventListener(
			"keydown",
			(e) => e.key === "Enter" && saveRename(),
		);
		importCancelBtn.addEventListener("click", () => {
			importSelectionModal.style.display = "none";
		});

		// Reorder listeners
		[toggleReorderBtn, miniToggleReorderBtn].forEach((btn) =>
			btn.addEventListener("click", toggleReorderMode),
		);

		importCancelBtn.addEventListener("click", () => {
			importSelectionModal.style.display = "none";
		});

		const optionsManager = new OptionsManager({
			sendMessageAsync,
			showStatus,
			fetchAniListReleases,
		});

		const playlistRenderer = new PlaylistRenderer(playlistContainer, {
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

		importConfirmBtn.addEventListener("click", () => {
			const filename = importFileSelect.value;
			if (
				!filename ||
				importFileSelect.options[importFileSelect.selectedIndex].disabled
			)
				return;

			const options = {
				preserveTitle: document.getElementById("import-opt-title").checked,
				preserveLastPlayed: document.getElementById("import-opt-lastplayed")
					.checked,
			};

			chrome.runtime.sendMessage(
				{ action: "import_from_file", filename, options },
				(response) => {
					if (response?.success) {
						showStatus(response.message);
						populateFolderDropdowns(); // Refresh folder list to show new/updated folders
					} else {
						showStatus(response?.error || "Import failed.", true);
					}
				},
			);
			importSelectionModal.style.display = "none";
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

		// Helper to scrape page details directly from popup
		const getPageDetails = (tabId) =>
			new Promise((resolve) => {
				chrome.tabs.sendMessage(
					tabId,
					{ action: "scrape_and_get_details" },
					(response) => {
						if (chrome.runtime.lastError) return resolve(null);
						resolve(response);
					},
				);
			});

		/**
		 * Fetches the native host status from the background script and updates the UI.
		 */
		async function updateNativeHostStatusUI() {
			const diagEl = document.querySelector(
				"#diag-native-host-status .dependency-value",
			);
			if (!diagEl) return;

			try {
				const response = await sendMessageAsync({
					action: "get_native_host_status",
				});
				if (response?.success) {
					const status = response.status || "unknown";
					diagEl.textContent = status.charAt(0).toUpperCase() + status.slice(1);

					if (status === "online") {
						diagEl.style.color = "var(--accent-positive)";
						if (response.info?.python) {
							diagEl.title = `Python: ${response.info.python}\nPlatform: ${response.info.platform}`;
						}
					} else if (status === "offline") {
						diagEl.style.color = "var(--accent-danger)";
						diagEl.title = "Native host is not running or not installed.";
					} else {
						diagEl.style.color = "var(--text-secondary)";
					}
				}
			} catch (e) {
				diagEl.textContent = "Error";
				diagEl.style.color = "var(--accent-danger)";
			}
		}

		// --- Mini Controller Logic (Refactored for Clarity) ---

		async function handleMiniAdd() {
			const folderId = miniFolderSelect.value;
			if (!folderId) return showStatus("Please select a folder.", true);

			const miniAddBtn = document.getElementById("btn-mini-add");
			if (!miniAddBtn) return;

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

				// 1. Try to get details from the on-page controller
				const details = await getPageDetails(tabId);

				// Check if we actually have a detected stream URL or if it's YouTube
				const isYouTube = activeTab.url.includes("youtube.com/watch");
				const streamUrl =
					details?.url ||
					currentDetectedUrl ||
					(isYouTube ? activeTab.url : null);

				if (!streamUrl) {
					console.log(
						"[Popup] No stream detected. Add action ignored to match OSC behavior.",
					);
					showStatus("No stream detected on this page.", true);
					return;
				}

				// Set loading state
				miniAddBtn.disabled = true;
				const originalIcon = miniAddBtn.innerHTML;
				miniAddBtn.innerHTML = `<svg class="spin-animation" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>`;

				let title = details?.title || activeTab.title || streamUrl;
				if (title && title.length > 255) {
					title = title.substring(0, 252) + "...";
				}

				const addResponse = await MpvInterface.add(folderId, {
					url: streamUrl,
					title: title,
				}, { tabId, tab: activeTab });

				if (addResponse.success) {
					if (addResponse.message) showStatus(addResponse.message);

					// Success feedback
					miniAddBtn.classList.add("url-in-playlist");
					miniAddBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;

					setTimeout(() => refreshPlaylist(), 50);

					setTimeout(() => {
						miniAddBtn.innerHTML = originalIcon;
						miniAddBtn.disabled = false;
					}, 2000);
				} else {
					showStatus(addResponse.error || "Failed to add URL.", true);
					miniAddBtn.innerHTML = originalIcon;
					miniAddBtn.disabled = false;
				}
			} catch (error) {
				console.error("[Popup] MiniAdd Error:", error);
				if (error.message !== "No active tab") {
					showStatus(`An error occurred: ${error.message}`, true);
				}
				if (miniAddBtn) {
					miniAddBtn.disabled = false;
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

				const response = await MpvInterface.closeMpv();
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
				const response = await (action === "clear" ? MpvInterface.clear(folderId) : sendMessageAsync({ action, folderId }));
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

			// Get current 'needsAppend' state from the button
			const needsAppend =
				miniPlayBtn?.title.includes("Queue") ||
				miniPlayBtn?.innerHTML.includes("<line");

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

		// --- Playlist Event Binding ---
		playlistContainer.addEventListener("click", (e) => {
			const listItem = e.target.closest(".list-item");
			if (!listItem) return;

			const removeBtn = e.target.closest(".btn-remove-item");
			const copyBtn = e.target.closest(".btn-copy-item");
			const watchedCheckbox = e.target.closest(".item-watched-checkbox");

			// Handle Button A selection mode (Pick Start Item)
			if (isPickStartModeActive && !removeBtn && !copyBtn && !watchedCheckbox) {
				const id = listItem.dataset.id;
				const fullItem = popupState.currentPlaylist.find(i => i.id === id);

				if (fullItem) {
					MpvInterface.play(miniFolderSelect.value, {
						urlItem: fullItem,
						playlistStartId: fullItem.id
					});
					isPickStartModeActive = false;
					refreshQuickActionsBar();
				}
				return;
			}

			// Handle Selection Mode (Disconnected Launch)
			if (isSelectionModeActive && !removeBtn && !copyBtn && !watchedCheckbox) {
				const id = listItem.dataset.id;
				const fullItem = popupState.currentPlaylist.find(i => i.id === id);

				if (fullItem) {
					sendMessageAsync({
						action: "play_new_instance",
						urlItem: fullItem,
						playNewInstance: true,
						folderId: miniFolderSelect.value
					});
					
					isSelectionModeActive = false;
					playlistContainer.classList.remove("selection-mode-active");
					document.querySelectorAll(".quick-action-btn.selection-mode-active").forEach(el => el.classList.remove("selection-mode-active"));
					document.getElementById("quick-actions-bar")?.classList.remove("selection-mode-active");
				}
				return;
			}
		});
		addDragDropListeners(playlistContainer);
		playlistContainer.addEventListener("drop", (e) => {
			e.preventDefault();
			const dropTarget = playlistContainer.querySelector(".drag-over");
			if (dropTarget) {
				dropTarget.classList.remove("drag-over");
			}
			if (draggedItem && draggedItem.parentElement === playlistContainer) {
				const folderId = miniFolderSelect.value;
				if (!folderId) return;

				const newOrder = [
					...playlistContainer.querySelectorAll(".list-item"),
				].map((item) => ({
					url: item.dataset.url,
					title: item.dataset.title,
					id: item.dataset.id,
				}));
				
				MpvInterface.setPlaylistOrder(folderId, newOrder).catch((err) => {
					showStatus("Failed to save playlist order: " + err.message, true);
				});
			}
		});

		miniAddBtn.addEventListener("click", handleMiniAdd);
		miniAddBtn.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			sendMessageAsync({ action: "toggle_auto_add" }).then(res => {
				if (res?.success) updateAutoAddVisuals(res.active);
			});
		});

		miniPlayBtn.addEventListener("click", () =>
			handlePlaySelectedPlaylist(miniFolderSelect.value),
		);

		miniClearBtn.addEventListener("click", () =>
			handleMiniSimpleCommand("clear"),
		);
		miniCloseMpvBtn.addEventListener("click", handleMiniCloseMpv);

		// Quick Action Bar Listeners
		const quickActionButtons = document.querySelectorAll(".quick-action-btn");
		
		const refreshQuickActionsBar = () => {
			const bar = document.getElementById("quick-actions-bar");
			if (!bar) return;

			bar.classList.toggle("selection-mode-active", isSelectionModeActive);
			bar.classList.toggle("pick-start-mode-active", isPickStartModeActive);
			playlistContainer.classList.toggle("selection-mode-active", isSelectionModeActive);
			playlistContainer.classList.toggle("pick-start-mode-active", isPickStartModeActive);

			quickActionButtons.forEach(btn => {
				if (btn.id === "btn-quick-a") {
					btn.classList.toggle("active", isPickStartModeActive);
				} else if (btn.classList.contains("btn-disconnected-toggle")) {
					btn.classList.toggle("active", isSelectionModeActive);
				}
			});
		};

		// Track pick start mode globally in popup scope
		let isPickStartModeActive = false;

			quickActionButtons.forEach((btn, index) => {
				const isA = btn.id === "btn-quick-a" || index === 0;
				const isLast = btn.classList.contains("btn-disconnected-toggle") || index === quickActionButtons.length - 1;

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
							sendMessageAsync({
								action: "play",
								folderId: miniFolderSelect.value,
								urlItem: firstItem,
								playlistStartId: firstItem.id
							});
						} else {
							showStatus("Cannot play from start - Playlist is empty.", true);
						}
					};

					btn.oncontextmenu = (e) => {
						e.preventDefault();
						e.stopPropagation();
						isSelectionModeActive = false;
						isPickStartModeActive = !isPickStartModeActive;
						refreshQuickActionsBar();
					};
				} else if (isLast) {
					btn.textContent = "⚡";
					btn.title = "Toggle Disconnected Launch (Selection Mode)";
					btn.classList.add("btn-disconnected-toggle");

					btn.onclick = (e) => {
						e.stopPropagation();
						isPickStartModeActive = false;
						isSelectionModeActive = !isSelectionModeActive;
						refreshQuickActionsBar();
					};
				} else {
				btn.addEventListener("click", () => {
					console.log(`Quick Action ${btn.textContent} clicked`);
				});
			}
		});

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
					lastPlayedId: playbackCache.lastPlayedId
				});

				if (uiManager.isMiniView()) {
					// Render playlist instantly from storage (Static state + Playback cache)
					const isFolderActive =
						playbackCache.folderId === lastUsedFolderId &&
						(playbackCache.isRunning || !playbackCache.isIdle);
					const isPaused = (playbackCache.isPaused || playbackCache.isIdle) || false;

					// Priority for lastPlayedId: Cache (real-time) > Storage (backup)
					const effectiveLastPlayedId =
						playbackCache.folderId === lastUsedFolderId &&
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
						playbackCache.folderId === lastUsedFolderId
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

						sendMessageAsync({ action: "get_auto_add_state" }).then(res => {
							if (res?.success) updateAutoAddVisuals(res.active);
						});

						// Request deep sync from manager
						MPV.playbackStateManager.requestSync();
						const tabs = await chrome.tabs
							.query({ active: true, currentWindow: true })
							.catch(() => []);
						const activeTab = tabs && tabs.length > 0 ? tabs[0] : null;
						const isHttp = activeTab?.url?.startsWith("http") ?? false;
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

								if (tabState && tabState.success && tabState.folderId === lastUsedFolderId) {
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
							} catch (e) {}
						}

						// Sync Mode: Correct initial mode if tab-specific state differs
						let uiState = null;
						if (isHttp && tabId) {
							const uiStateResponse = await sendMessageAsync({
								action: "get_ui_state_for_tab",
								tabId,
							});
							uiState = uiStateResponse?.state;
							uiManager.determineAndSetInitialMode(isHttp, uiState, prefs);

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

		// Close the popup whenever it loses focus. This handles both clicking away
		// within the browser and switching to another application, which is the
		// standard and expected behavior for extension popups.
		window.addEventListener("blur", () => {
			window.close();
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
				if (currentFolderId === request.folderId) {
					updateItemDelta(request.itemId, request.delta);
				}
			}

			if (request.action === "auto_add_state_changed") {
				updateAutoAddVisuals(request.active);
			}

			// Handle live playlist updates to keep the item count and playlist view in sync
			if (request.action === "render_playlist") {
				const isMiniView = uiManager.isMiniView();
				const currentFolderId = miniFolderSelect.value;

				// 1. Update unified manager first
				MPV.playbackStateManager.update({
					folderId: request.folderId,
					isRunning: request.isFolderActive,
					isPaused: request.isPaused,
					isIdle: request.isIdle,
					isClosing: request.isClosing,
					lastPlayedId: request.lastPlayedId,
					needsAppend: request.needsAppend
				});

				// 2. Heavy data sync (If looking at the right folder)
				if (currentFolderId === request.folderId) {
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
				if (miniFolderSelect.value !== request.folderId) {
					miniFolderSelect.value = request.folderId;
					refreshPlaylist(null, true);
				}
			}

			// Handle folder data changes (e.g. IDs assigned after playback starts)
			if (request.foldersChanged) {
				populateFolderDropdowns();
			}

			// Handle live changes to the detected URL to update the "Add" button's state
			if (request.action === "detected_url_changed") {
				chrome.tabs
					.query({ active: true, currentWindow: true })
					.then(([activeTab]) => {
						// The miniAddBtn is for the mini-controller view.
						// We check if the message is for the currently active tab.
						if (activeTab && activeTab.id === request.tabId && miniAddBtn) {
							currentDetectedUrl = request.url;

							const isYouTube = activeTab.url.includes("youtube.com/watch");
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
					const tabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
					const tabId = tabs && tabs.length > 0 ? tabs[0].id : null;
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

			// New: Handle confirmation requests from the background script
			if (request.action === "show_popup_confirmation") {
				// This is an async action, so we must return true.
				(async () => {
					try {
						const confirmed = await showPopupConfirmation(request.message);
						sendResponse({ confirmed });
					} catch (e) {
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

		let currentAnilistOffset = 0;

		async function fetchAniListReleases(forceRefresh = false, offset = 0) {
			// Show nav controls if they were hidden
			if (anilistNavControls) anilistNavControls.style.display = "flex";

			// Remove existing list but keep nav controls
			const existingList = anilistReleasesContent.querySelector(
				".anilist-releases-list, .anilist-empty-message, .anilist-error",
			);
			if (existingList) existingList.remove();

			// Add spinner after nav controls
			let spinner = anilistReleasesContent.querySelector(".loading-spinner");
			if (!spinner) {
				spinner = document.createElement("div");
				spinner.className = "loading-spinner";
				anilistReleasesContent.appendChild(spinner);
			}
			spinner.style.display = "block";

			// Update nav buttons state
			if (btnAnilistPrev) btnAnilistPrev.disabled = offset <= -6;
			if (btnAnilistNext) btnAnilistNext.disabled = offset >= 6;
			if (btnAnilistToday) {
				btnAnilistToday.style.opacity = offset === 0 ? "0.5" : "1";
				btnAnilistToday.style.cursor = offset === 0 ? "default" : "pointer";

				// Show date on today button if not zero
				if (offset !== 0) {
					const targetDate = new Date();
					targetDate.setDate(targetDate.getDate() + offset);
					btnAnilistToday.textContent = targetDate.toLocaleDateString(
						undefined,
						{ month: "short", day: "numeric" },
					);
				} else {
					btnAnilistToday.textContent = "Today";
				}
			}

			try {
				const releases = await AniListRenderer.fetchReleases(
					forceRefresh,
					offset,
				);
				spinner.style.display = "none";
				AniListRenderer.render(anilistReleasesContent, releases, offset);

				if (anilistReleasesSection.open) {
					setTimeout(() => {
						const container = document.getElementById("scrollable-content");
						if (container) domUtils.smoothScrollTo(document.getElementById("scrollable-content"), container.scrollHeight, 400);
					}, 50);
				}
			} catch (error) {
				spinner.style.display = "none";
				const errorElement = document.createElement("div");
				errorElement.className = "anilist-error";
				errorElement.textContent = `Error: ${error.message}`;
				anilistReleasesContent.appendChild(errorElement);
			}
		}

		if (btnAnilistPrev) {
			btnAnilistPrev.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				if (currentAnilistOffset > -6) {
					currentAnilistOffset--;
					fetchAniListReleases(false, currentAnilistOffset);
				}
			});
		}

		if (btnAnilistNext) {
			btnAnilistNext.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				if (currentAnilistOffset < 6) {
					currentAnilistOffset++;
					fetchAniListReleases(false, currentAnilistOffset);
				}
			});
		}

		if (btnAnilistToday) {
			btnAnilistToday.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				if (currentAnilistOffset !== 0) {
					currentAnilistOffset = 0;
					fetchAniListReleases(false, 0);
				}
			});
		}

		refreshAnilistBtn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			fetchAniListReleases(true, currentAnilistOffset);
		});

		anilistReleasesSection.addEventListener("toggle", (event) => {
			if (event.target.open) {
				// Ensure the note is present and correct when the section is opened.
				let noteElement = anilistReleasesSection.querySelector(
					".anilist-release-delay-info",
				);
				if (!noteElement) {
					noteElement = document.createElement("p");
					noteElement.className = "anilist-release-delay-info";
					// Insert it after the summary, before the content div.
					anilistReleasesContent.insertAdjacentElement(
						"beforebegin",
						noteElement,
					);
				}
				noteElement.textContent =
					"Note: There may be a 30 minute to 3 hour delay on release times.";

				fetchAniListReleases();

				// After a short delay to allow the content to render and the popup to resize,
				// scroll the internal content container to the bottom.
				setTimeout(() => {
					const container = document.getElementById("scrollable-content");
					if (container) domUtils.smoothScrollTo(document.getElementById("scrollable-content"), container.scrollHeight, 400);
				}, 50);
			}
		});

		// Force Reload Settings Button
		const forceReloadSettingsBtn = document.getElementById(
			"btn-force-reload-settings",
		);
		if (forceReloadSettingsBtn) {
			forceReloadSettingsBtn.addEventListener("click", () => {
				sendMessageAsync({ action: "force_reload_settings" }).then(() => {
					showStatus("Settings reloaded on all tabs.");
				});
			});
		}

		// Start the initialization process
		optionsManager.initializeEventListeners();
		initializePopup();

		// Periodic Sync: Ensure the popup stays in sync with background state while open.
		// This recovers from missed broadcasts and handles Service Worker wakeup lag.
		setInterval(() => {
			if (uiManager.isMiniView()) {
				refreshPlaylist(null, true);
			}
		}, 5000);
	} catch (e) {
		console.error("Error in DOMContentLoaded handler:", e);
		showStatus(`Critical error: ${e.message}`, true);
	}
});
