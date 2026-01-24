// background/handlers/import_export.js

import { sanitizeString } from "../../utils/commUtils.module.js";
import { nativeLink } from "../../utils/nativeLink.js";
import { createHandler } from "../handler_factory.js";
import { processPlaylist } from "../../utils/item_processor.js";

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
		const confirmResponse = await new Promise((resolve) => {
			chrome.runtime.sendMessage(
				{
					action: "show_popup_confirmation",
					message: `The file '${filename}' appears to be a settings backup. Restore your preferences?`,
				},
				(res) => {
					if (chrome.runtime.lastError) {
						resolve(true); 
					} else {
						resolve(res && res.confirmed);
					}
				},
			);
		});

		if (!confirmResponse) return { success: true, message: "Settings restore cancelled." };
		return await _importSettingsLogic(importedData, data);
	}

	const foldersToImport = {};
	const processorOptions = {
		preserveTitle: options.preserveTitle,
		preserveResumeTime: options.preserveLastPlayed
	};

	// --- Detection: Single Folder or Full Backup? ---
	if (Array.isArray(importedData)) {
		foldersToImport[baseFolderName] = {
			playlist: processPlaylist(importedData, processorOptions),
		};
	} else if (importedData && Array.isArray(importedData.playlist)) {
		const folder = { playlist: processPlaylist(importedData.playlist, processorOptions) };
		if (options.preserveLastPlayed && importedData.last_played_id) {
			if (folder.playlist.some((i) => i.id === importedData.last_played_id)) {
				folder.last_played_id = importedData.last_played_id;
			}
		}
		foldersToImport[baseFolderName] = folder;
	} else if (typeof importedData === "object" && importedData !== null) {
		const source = importedData.folders || importedData;
		for (const key in source) {
			const folderContent = source[key];
			if (folderContent && Array.isArray(folderContent.playlist)) {
				const folder = { playlist: processPlaylist(folderContent.playlist, processorOptions) };
				if (options.preserveLastPlayed && folderContent.last_played_id) {
					if (folder.playlist.some((i) => i.id === folderContent.last_played_id)) {
						folder.last_played_id = folderContent.last_played_id;
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
	const excludeKeys = ["last_used_folder_id", "anilist_cache"];

	let restoredCount = 0;
	for (const key in importedSettings) {
		if (excludeKeys.includes(key)) continue;

		if (key === "ui_preferences") {
			// Deep merge for ui_preferences to preserve domains and positions if they were missing in backup
			const importedPrefs = importedSettings[key];
			const localPrefs = localData.settings[key] || { global: {}, domains: {} };

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
			
			localData.settings[key] = localPrefs;
			restoredCount++;
		} else {
			localData.settings[key] = importedSettings[key];
			restoredCount++;
		}
	}

	// Sync to native host
	try {
		const nativeSyncKeys = [
			"mpv_path", "mpv_decoder", "enable_url_analysis", "browser_for_url_analysis",
			"enable_youtube_analysis", "user_agent_string", "enable_smart_resume",
			"enable_active_item_highlight", "disable_network_overrides", "enable_cache",
			"http_persistence", "demuxer_max_bytes", "demuxer_max_back_bytes",
			"cache_secs", "demuxer_readahead_secs", "stream_buffer_size",
			"ytdlp_concurrent_fragments", "enable_reconnect", "reconnect_delay",
			"automatic_mpv_flags",
		];
		const syncPrefs = {};
		const globalPrefs = localData.settings.ui_preferences?.global || {};
		nativeSyncKeys.forEach((key) => {
			if (globalPrefs[key] !== undefined) syncPrefs[key] = globalPrefs[key];
		});
		if (Object.keys(syncPrefs).length > 0) {
			await nativeLink.setUiPreferences(syncPrefs);
		}
	} catch (err) {}

	return { 
		success: true, 
		message: `Restored ${restoredCount} settings groups.`
	};
}

export const handleExportSettings = createHandler(async ({ data, request }) => {
	const filename = request.filename || "mpv_settings_backup";
	const filteredSettings = JSON.parse(JSON.stringify(data.settings));

	if (filteredSettings.ui_preferences?.global) {
		const global = filteredSettings.ui_preferences.global;
		// We only remove dynamic status info, but keep positions and modes for a better restore experience
		[
			"dependencyStatus",
		].forEach((key) => delete global[key]);
	}
	
	// Keep domains in export so they aren't lost on restore
	// delete filteredSettings.ui_preferences.domains; 

	const exportData = {
		type: "mpv_playlist_organizer_settings",
		version: chrome.runtime.getManifest().version,
		timestamp: new Date().toISOString(),
		settings: filteredSettings,
	};

	return nativeLink.fileSystem.call("export_playlists", {
		data: exportData,
		filename,
		subfolder: "settings",
	});
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
		if (!options.preserveLastPlayed) delete folder.last_played_id;
	}

	return nativeLink.fileSystem.call("export_all_playlists_separately", {
		data: filteredFolders,
		customNames: options.customNames || {},
	});
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
	if (!options.preserveLastPlayed) delete folderToExport.last_played_id;

	return nativeLink.fileSystem.call("export_playlists", {
		data: folderToExport,
		filename: filename,
	});
});

export async function handleListImportFiles() {
	return nativeLink.fileSystem.listFiles();
}

export async function handleOpenExportFolder() {
	return nativeLink.fileSystem.openExportFolder();
}