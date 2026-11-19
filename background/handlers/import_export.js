// background/handlers/import_export.js

import { sanitizeString, promptUserConfirmation, normalizeKeys } from "../../utils/commUtils.module.js";
import { nativeLink } from "../../utils/nativeLink.js";
import { createHandler } from "../handler_factory.js";
import { processPlaylist } from "../../utils/item_processor.js";
import { UI_ONLY_KEYS } from "./ui_state.js";
import { setYtToolsEnabled } from "../yt_tools_service.js";

export const handleImportFromFile = createHandler(async ({ request, data }) => {
	const filename = request.filename;
	const options = request.options || {
		preserveTitle: true,
		preserveLastPlayed: true,
	};

	if (!filename) return { success: false, error: "No filename provided." };

	const response = await nativeLink.fileSystem.call("import_from_file", {
		filename,
	});
	
	if (!response.success) return response;
	
	// Support both 'data' and 'result' keys from native host
	const rawFileData = response.data !== undefined ? response.data : response.result;
	
	if (rawFileData === undefined || rawFileData === null || rawFileData === "") {
		return { success: false, error: "Imported file data is empty or missing." };
	}

	const baseFolderName = sanitizeString(filename.replace(/\.json$/i, ""), true);
	if (!baseFolderName) return { success: false, error: "Invalid filename." };

	let importedData;
	try {
		importedData = typeof rawFileData === "string" ? JSON.parse(rawFileData) : rawFileData;
	} catch (e) {
		return { success: false, error: `Failed to parse import file: ${e.message}` };
	}

	if (!importedData) return { success: false, error: "Imported data is null or invalid." };

	// --- Settings Restoration Check ---
	if (importedData && importedData.type === "mpv_playlist_organizer_settings") {
		const message = `The file '${filename}' appears to be a settings backup. Restore your preferences?`;
		const confirmed = await promptUserConfirmation(message);
		if (!confirmed) return { success: true, message: "Settings restore cancelled." };
		return await _importSettingsLogic(importedData, data);
	}

	const foldersToImport = {};
	const processorOptions = {
		preserveTitle: options.preserveTitle,
		preserveResumeTime: options.preserveLastPlayed
	};

	// --- Detection: Single Folder or Full Backup? ---
	if (Array.isArray(importedData)) {
		const normalizedItems = normalizeKeys(importedData);
		foldersToImport[baseFolderName] = {
			playlist: processPlaylist(normalizedItems, processorOptions),
		};
	} else if (importedData && Array.isArray(importedData.playlist)) {
		const normalizedFolder = normalizeKeys(importedData);
		const folder = { playlist: processPlaylist(normalizedFolder.playlist, processorOptions) };
		if (options.preserveLastPlayed && normalizedFolder.lastPlayedId) {
			if (folder.playlist.some((i) => i.id === normalizedFolder.lastPlayedId)) {
				folder.lastPlayedId = normalizedFolder.lastPlayedId;
			}
		}
		foldersToImport[baseFolderName] = folder;
	} else if (typeof importedData === "object" && importedData !== null) {
		const source =
			importedData.folders && typeof importedData.folders === "object" && !Array.isArray(importedData.folders)
				? importedData.folders
				: importedData;
		for (const key in source) {
			if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
			const rawFolderContent = source[key];
			if (rawFolderContent && Array.isArray(rawFolderContent.playlist)) {
				const folderContent = normalizeKeys(rawFolderContent);
				const folder = { playlist: processPlaylist(folderContent.playlist, processorOptions) };
				if (options.preserveLastPlayed && folderContent.lastPlayedId) {
					if (folder.playlist.some((i) => i.id === folderContent.lastPlayedId)) {
						folder.lastPlayedId = folderContent.lastPlayedId;
					}
				}
				foldersToImport[key] = folder;
			}
		}
	}

	if (Object.keys(foldersToImport).length === 0) {
		return { success: true, message: `Import file was empty or incompatible.` };
	}

	if (!data.folderOrder) data.folderOrder = Object.keys(data.folders);

	let importedCount = 0;
	for (const [folderId, folderData] of Object.entries(foldersToImport)) {
		let finalId = folderId;
		let counter = 1;
		while (data.folders[finalId]) {
			finalId = `${folderId} (${counter})`;
			counter++;
		}
		data.folders[finalId] = folderData;
		data.folderOrder.push(finalId);
		importedCount++;
	}

	return {
		success: true,
		message: `Successfully imported ${importedCount} folder(s).`,
	};
}, {
	syncToNative: true,
	broadcastFolders: true,
	broadcastPreferences: true,
	updateMenus: true
});

async function _importSettingsLogic(importedData, localData) {
	const importedSettings = importedData.settings;
	const excludeKeys = ["lastUsedFolderId", "anilist_cache", "anilistCache"];

	let restoredCount = 0;
	for (const key in importedSettings) {
		if (excludeKeys.includes(key)) continue;

		if (key === "ui_preferences" || key === "uiPreferences") {
			// Deep merge for uiPreferences to preserve domains and positions if they were missing in backup
			const importedPrefs = importedSettings[key];
			const localPrefs = localData.settings.uiPreferences || { global: {}, domains: {} };

			// Restore global prefs but preserve existing keys if not present in backup
			localPrefs.global = {
				...localPrefs.global,
				...(importedPrefs.global || {})
			};

			// Restore domains - merge them instead of overwriting
			if (importedPrefs.domains) {
				localPrefs.domains = {
					...localPrefs.domains,
					...importedPrefs.domains
				};
			}
			
			localData.settings.uiPreferences = localPrefs;
			restoredCount++;
		} else {
			localData.settings[key] = importedSettings[key];
			restoredCount++;
		}
	}

	// Restore YouTube Tools backup if included
	const ytBackup = importedData.youtubeTools || importedData.youtube_tools;
	if (ytBackup && typeof ytBackup === "object" && typeof chrome !== "undefined" && chrome?.storage?.local) {
		try {
			const existingYt = await chrome.storage.local.get(["shinkuExtensionSettings", "shinkuLibrary"]);
			const toWrite = {};
			if (ytBackup.settings && typeof ytBackup.settings === "object" && !Array.isArray(ytBackup.settings)) {
				const prevSettings =
					existingYt.shinkuExtensionSettings && typeof existingYt.shinkuExtensionSettings === "object"
						? existingYt.shinkuExtensionSettings
						: {};
				const mergedSettings = { ...prevSettings };
				for (const [cat, vals] of Object.entries(ytBackup.settings)) {
					if (vals && typeof vals === "object" && !Array.isArray(vals)) {
						mergedSettings[cat] = { ...(prevSettings[cat] || {}), ...vals };
					}
				}
				toWrite.shinkuExtensionSettings = mergedSettings;
			}
			if (ytBackup.library && typeof ytBackup.library === "object" && !Array.isArray(ytBackup.library)) {
				const prevLib =
					existingYt.shinkuLibrary && typeof existingYt.shinkuLibrary === "object" && !Array.isArray(existingYt.shinkuLibrary)
						? existingYt.shinkuLibrary
						: {};
				const mergedLib = { ...prevLib };
				for (const [vid, entry] of Object.entries(ytBackup.library)) {
					if (vid !== "__proto__" && vid !== "constructor" && vid !== "prototype" && entry && typeof entry === "object") {
						mergedLib[vid] = entry;
					}
				}
				toWrite.shinkuLibrary = mergedLib;
			}
			if (Object.keys(toWrite).length > 0) {
				await chrome.storage.local.set(toWrite);
				restoredCount++;
			}
			if (typeof ytBackup.enabled === "boolean") {
				await setYtToolsEnabled(ytBackup.enabled);
			}
		} catch (ytErr) {
			console.debug("[ImportExport] Failed to restore YouTube Tools data:", ytErr?.message || ytErr);
		}
	}

	// Sync to native host
	try {
		const syncPrefs = {};
		const globalPrefs = localData.settings.uiPreferences?.global || {};
		for (const key in globalPrefs) {
			if (!UI_ONLY_KEYS.includes(key) && globalPrefs[key] !== undefined) {
				syncPrefs[key] = globalPrefs[key];
			}
		}
		if (Object.keys(syncPrefs).length > 0) {
			await nativeLink.setUiPreferences(syncPrefs);
		}
	} catch (err) {
		console.debug("[ImportExport] Failed to sync UI prefs to native host:", err);
	}

	return { 
		success: true, 
		message: `Restored ${restoredCount} settings groups.`
	};
}

export const handleExportSettings = createHandler(async ({ data, request }) => {
	const filename = request.filename || "mpv_settings_backup";
	const filteredSettings = JSON.parse(JSON.stringify(data.settings));

	if (filteredSettings.uiPreferences?.global) {
		const global = filteredSettings.uiPreferences.global;
		// We only remove dynamic status info, but keep positions and modes for a better restore experience
		[
			"dependencyStatus",
		].forEach((key) => delete global[key]);
	}
	
	// Keep domains in export so they aren't lost on restore
	// delete filteredSettings.ui_preferences.domains; 

	let youtubeTools = null;
	if (typeof chrome !== "undefined" && chrome?.storage?.local?.get) {
		try {
			const ytStored = await chrome.storage.local.get([
				"shinkuYtToolsEnabled",
				"shinkuExtensionSettings",
				"shinkuLibrary",
			]);
			youtubeTools = {
				enabled: Boolean(ytStored.shinkuYtToolsEnabled),
				settings: ytStored.shinkuExtensionSettings || {},
				library: ytStored.shinkuLibrary || {},
			};
		} catch (ytErr) {
			console.debug("[ImportExport] Failed to read YT Tools data for export:", ytErr?.message || ytErr);
		}
	}

	const exportData = {
		type: "mpv_playlist_organizer_settings",
		version: chrome.runtime.getManifest().version,
		timestamp: new Date().toISOString(),
		settings: filteredSettings,
		...(youtubeTools ? { youtubeTools } : {}),
	};

	return nativeLink.fileSystem.call("export_playlists", {
		data: exportData,
		filename,
		subfolder: "settings",
	});
}, {
	manualPersistence: true,
});

export const handleExportAllPlaylistsSeparately = createHandler(async ({ data, request }) => {
	const options = request.options || { preserveTitle: true, preserveLastPlayed: true };
	const filteredFolders = JSON.parse(JSON.stringify(data.folders));

	for (const folderId in filteredFolders) {
		const folder = filteredFolders[folderId];
		folder.playlist = processPlaylist(folder.playlist, {
			preserveTitle: options.preserveTitle,
			preserveResumeTime: options.preserveLastPlayed
		});
		if (!options.preserveLastPlayed) delete folder.lastPlayedId;
	}

	return nativeLink.fileSystem.call("export_all_playlists_separately", {
		data: filteredFolders,
		customNames: options.customNames || {},
	});
}, {
	manualPersistence: true,
});

export const handleExportFolderPlaylist = createHandler(async ({ data, request }) => {
	const { filename, folderId } = request;
	if (!filename || !folderId) return { success: false, error: "Missing filename or folderId." };

	const folder = data.folders[folderId];
	if (!folder || !folder.playlist) return { success: false, error: `Folder empty.` };

	const options = request.options || { preserveTitle: true, preserveLastPlayed: true };
	const folderToExport = {
		...JSON.parse(JSON.stringify(folder)),
		playlist: processPlaylist(folder.playlist, {
			preserveTitle: options.preserveTitle,
			preserveResumeTime: options.preserveLastPlayed
		})
	};
	if (!options.preserveLastPlayed) delete folderToExport.lastPlayedId;

	return nativeLink.fileSystem.call("export_playlists", {
		data: folderToExport,
		filename: filename,
	});
}, {
	manualPersistence: true,
});

export async function handleListImportFiles() {
	return nativeLink.fileSystem.listFiles();
}

export async function handleOpenExportFolder() {
	return nativeLink.fileSystem.openExportFolder();
}