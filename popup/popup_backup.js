// popup/popup_backup.js
// Export/Import playlists and settings backup modals for popup.js.

import { sendMessageAsync } from "../utils/commUtils.module.js";

export function createBackupManager(ctx) {
	const {
		uiManager,
		showStatus,
		populateFolderDropdowns,
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
	} = ctx;

	function handleExport() {
		const folderId = uiManager.folderSelect.value;

		if (!folderId) {
			return showStatus("Please select a folder to export.", true);
		}

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

	async function handleSaveExport() {
		const filename = exportFilenameInput.value.trim();
		if (!filename) {
			return showStatus("Filename cannot be empty.", true);
		}

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
				filename,
				folderId,
				options,
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
	}

	function handleImport() {
		sendMessageAsync({ action: "list_import_files" })
			.then((response) => {
				if (response?.success) {
					importFileSelect.innerHTML = "";
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
				preserveTitle: document.getElementById("export-all-opt-title").checked,
				preserveLastPlayed: document.getElementById(
					"export-all-opt-lastplayed",
				).checked,
				customNames,
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

	function bindBackupListeners() {
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
		if (exportSettingsBtn) {
			exportSettingsBtn.addEventListener("click", handleExportSettings);
		}

		exportCancelBtn.addEventListener("click", () => {
			exportFilenameModal.style.display = "none";
		});
		exportSaveBtn.addEventListener("click", handleSaveExport);
		exportFilenameInput.addEventListener(
			"keydown",
			(e) => e.key === "Enter" && exportSaveBtn.click(),
		);
		importCancelBtn.addEventListener("click", () => {
			importSelectionModal.style.display = "none";
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
						populateFolderDropdowns();
					} else {
						showStatus(response?.error || "Import failed.", true);
					}
				},
			);
			importSelectionModal.style.display = "none";
		});
	}

	return {
		bindBackupListeners,
	};
}
