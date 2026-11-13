// popup/popup_folders.js
// Folder CRUD, dropdown population, and folder reorder mode for popup.js.

import { domUtils } from "../utils/domUtils.module.js";
import { sendMessageAsync } from "../utils/commUtils.module.js";

export function createFolderManager(ctx) {
	let folderToRename = null;
	let isReorderModeActive = false;
	let reorderActiveMode = null;
	let draggedItem = null;

	const {
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
		getRefreshPlaylist,
	} = ctx;

	function updateRemoveButtonState() {
		const hasSelection = !!removeFolderSelect.value;
		removeFolderBtn.disabled = !hasSelection;
		renameFolderBtn.disabled = !hasSelection;
	}

	function populateFolderDropdowns(data = null) {
		const processResponse = (response) => {
			if (!response?.success) return;

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

			const currentVal = miniFolderSelect.value;
			const targetFolderId =
				currentVal && response.folderIds.includes(currentVal)
					? currentVal
					: response.lastUsedFolderId &&
						  response.folderIds.includes(response.lastUsedFolderId)
						? response.lastUsedFolderId
						: response.folderIds[0];

			if (targetFolderId) {
				miniFolderSelect.value = targetFolderId;
				removeFolderSelect.value = targetFolderId;
			}

			updateRemoveButtonState();
		};

		if (data) {
			processResponse(data);
		} else {
			sendMessageAsync({ action: "get_all_folder_ids" })
				.then(processResponse)
				.then(() => {
					if (uiManager.isMiniView()) getRefreshPlaylist()();
				})
				.catch((e) => {
					console.error("Failed to populate folder dropdowns:", e);
					showStatus("Connection to background script lost.", true);
				});
		}
	}

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
			return;
		}

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

	function getActiveReorderControls(mode = uiManager.activeMode) {
		if (mode === "mini") {
			return {
				toggleBtn: miniToggleReorderBtn,
				container: miniReorderContainer,
				elementsToHide: [
					document.getElementById("mini-folder-select"),
					document.getElementById("btn-mini-manage-folders"),
					document.getElementById("mini-item-count-container"),
				],
			};
		}
		return {
			toggleBtn: toggleReorderBtn,
			container: reorderContainer,
			elementsToHide: [
				document.getElementById("remove-folder-select"),
				document.getElementById("rename-remove-controls"),
			],
		};
	}

	function cancelReorderMode() {
		if (!isReorderModeActive) return;
		const modeToRestore =
			reorderActiveMode || (uiManager.isMiniView() ? "mini" : "full");
		const { toggleBtn, container, elementsToHide } =
			getActiveReorderControls(modeToRestore);
		isReorderModeActive = false;
		reorderActiveMode = null;
		if (toggleBtn) {
			toggleBtn.classList.remove("active");
			if (toggleBtn === toggleReorderBtn) {
				toggleBtn.textContent = "Reorder";
			}
		}
		if (container) {
			container.innerHTML = "";
			container.style.display = "none";
		}
		elementsToHide.forEach((el) => {
			if (el) el.style.display = "";
		});
	}

	function addDragDropListeners(list) {
		list.addEventListener("dragstart", (e) => {
			draggedItem = e.target;
			setTimeout(() => e.target.classList.add("dragging"), 0);

			const url = e.target.dataset.url;
			if (url && e.dataTransfer) {
				e.dataTransfer.setData("text/plain", url);
			}
		});

		list.addEventListener("dragend", () => {
			if (!draggedItem) return;
			draggedItem.classList.remove("dragging");
			draggedItem = null;
		});

		list.addEventListener("dragover", (e) => {
			if (!draggedItem) return;
			e.preventDefault();

			const afterElement = domUtils.getDragAfterElement(
				list,
				e.clientY,
				".reorder-item:not(.dragging), .list-item:not(.dragging)",
			);
			const existingIndicator = list.querySelector(".drag-over");

			if (afterElement) {
				if (existingIndicator && existingIndicator !== afterElement) {
					existingIndicator.classList.remove("drag-over");
				}
				afterElement.classList.add("drag-over");
			} else if (existingIndicator) {
				existingIndicator.classList.remove("drag-over");
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
				if (list.id === "playlist-container") {
					[...list.querySelectorAll(".list-item")].forEach((item, idx) => {
						item.dataset.index = idx;
						const indexSpan = item.querySelector(".url-index");
						if (indexSpan) indexSpan.textContent = `${idx + 1}.`;
						const removeBtn = item.querySelector(".btn-remove-item");
						if (removeBtn) removeBtn.dataset.index = idx;
					});
				}
			}
		});
	}

	function renderReorderList(container, folderIds) {
		container.innerHTML = "";
		const list = document.createElement("ul");
		list.className = "reorder-list";

		folderIds.forEach((id) => {
			const item = document.createElement("li");
			item.className = "reorder-item";
			item.draggable = true;
			item.dataset.folderId = id;

			const handle = document.createElement("span");
			handle.className = "drag-handle";
			handle.innerHTML = "&#9776;";

			const text = document.createTextNode(id);

			item.appendChild(handle);
			item.appendChild(text);
			list.appendChild(item);
		});

		addDragDropListeners(list);
		container.appendChild(list);
	}

	async function toggleReorderMode() {
		isReorderModeActive = !isReorderModeActive;
		if (isReorderModeActive) {
			reorderActiveMode = uiManager.isMiniView() ? "mini" : "full";
		}
		const targetMode =
			reorderActiveMode || (uiManager.isMiniView() ? "mini" : "full");
		const { toggleBtn, container, elementsToHide } =
			getActiveReorderControls(targetMode);

		toggleBtn.classList.toggle("active", isReorderModeActive);

		if (isReorderModeActive) {
			if (toggleBtn === toggleReorderBtn) {
				toggleBtn.textContent = "Save Order";
			}

			elementsToHide.forEach((el) => {
				if (el) el.style.display = "none";
			});
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
				const newOrder = [...list.children]
					.map((item) => item.dataset.folderId)
					.filter(Boolean);
				if (newOrder.length > 0) {
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
			}

			if (toggleBtn === toggleReorderBtn) {
				toggleBtn.textContent = "Reorder";
			}

			container.innerHTML = "";
			container.style.display = "none";
			elementsToHide.forEach((el) => {
				if (el) el.style.display = "";
			});
			reorderActiveMode = null;
			populateFolderDropdowns();
		}
	}

	function bindFolderListeners() {
		renameCancelBtn.addEventListener("click", () => {
			renameFolderModal.style.display = "none";
			folderToRename = null;
		});
		renameSaveBtn.addEventListener("click", saveRename);
		renameFolderInput.addEventListener(
			"keydown",
			(e) => e.key === "Enter" && saveRename(),
		);
		[toggleReorderBtn, miniToggleReorderBtn].forEach((btn) =>
			btn.addEventListener("click", toggleReorderMode),
		);
	}

	return {
		updateRemoveButtonState,
		populateFolderDropdowns,
		handleCreateFolder,
		handleRemoveFolder,
		handleRenameFolder,
		saveRename,
		cancelReorderMode,
		toggleReorderMode,
		addDragDropListeners,
		bindFolderListeners,
		getFolderToRename: () => folderToRename,
		setFolderToRename: (val) => {
			folderToRename = val;
		},
		isReorderModeActive: () => isReorderModeActive,
		getDraggedItem: () => draggedItem,
	};
}
