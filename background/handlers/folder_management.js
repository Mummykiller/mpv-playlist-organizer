// background/handlers/folder_management.js

import { sanitizeString } from "../../utils/commUtils.module.js";
import { storage } from "../storage_instance.js";
import { createHandler } from "../handler_factory.js";
import { broadcastPlaylistState } from "../ui_broadcaster.js";

export const handleCreateFolder = createHandler(async ({ request, data }) => {
	let { folderId } = request;
	if (!folderId) return { success: false, error: "No folder name provided." };

	folderId = sanitizeString(folderId, true);
	if (!folderId)
		return { success: false, error: "Invalid folder name after sanitization." };

	if (data.folders[folderId])
		return { success: false, error: "Folder already exists." };

	data.folders[folderId] = { playlist: [] };
	if (!data.folderOrder) data.folderOrder = Object.keys(data.folders);
	if (!data.folderOrder.includes(folderId)) data.folderOrder.push(folderId);

	// Ensure the UI stays on the newly created folder
	data.settings.lastUsedFolderId = folderId;

	return { success: true, folderId };
}, {
	broadcastFolders: true,
	updateMenus: true,
	syncToNative: true
});

export const handleGetAllFolderIds = createHandler(async ({ data }) => {
	return {
		success: true,
		folderIds: data.folderOrder || Object.keys(data.folders),
		lastUsedFolderId: data.settings.lastUsedFolderId,
	};
});

export const handleRemoveFolder = createHandler(async ({ request, data }) => {
	const { folderId } = request;
	if (!folderId) return { success: false, error: "No folder ID provided." };

	if (!data.folders[folderId])
		return { success: false, error: "Folder not found." };

	const wasActive = data.settings.lastUsedFolderId === folderId;

	delete data.folders[folderId];
	if (data.folderOrder) {
		data.folderOrder = data.folderOrder.filter((id) => id !== folderId);
	}

	// Ensure at least one folder exists
	if (Object.keys(data.folders).length === 0) {
		const defaultId = "Playlist 1";
		data.folders[defaultId] = { playlist: [] };
		data.folderOrder = [defaultId];
		data.settings.lastUsedFolderId = defaultId;
	} else if (wasActive) {
		data.settings.lastUsedFolderId = data.folderOrder && data.folderOrder.length > 0
			? data.folderOrder[0]
			: Object.keys(data.folders)[0];
	}

	return { success: true, folderChanged: wasActive, newFolderId: data.settings.lastUsedFolderId };
}, {
	broadcastFolders: true,
	updateMenus: true,
	syncToNative: true,
	onSuccess: async (result) => {
		if (result.folderChanged) {
			await broadcastPlaylistState(result.newFolderId, null, "last_folder_changed");
		}
	}
});

export const handleRenameFolder = createHandler(async ({ request, data }) => {
	let { oldFolderId, newFolderId } = request;
	let oldId = oldFolderId || request.oldId;
	let newId = newFolderId || request.newId;

	if (!oldId || !newId) return { success: false, error: "Missing folder IDs." };

	newId = sanitizeString(newId, true);
	if (!newId) return { success: false, error: "Invalid new folder name." };

	if (!data.folders[oldId])
		return { success: false, error: "Folder not found." };
	if (data.folders[newId])
		return { success: false, error: "New folder name already exists." };

	data.folders[newId] = data.folders[oldId];
	delete data.folders[oldId];

	if (data.folderOrder) {
		const index = data.folderOrder.indexOf(oldId);
		if (index !== -1) data.folderOrder[index] = newId;
	}

	if (data.settings.lastUsedFolderId === oldId) {
		data.settings.lastUsedFolderId = newId;
	}

	return { success: true, folderId: newId };
}, {
	broadcastFolders: true,
	updateMenus: true,
	syncToNative: true
});

export const handleSetFolderOrder = createHandler(async ({ request, data }) => {
	const { order } = request;
	if (!order) return { success: false, error: "No order provided." };

	data.folderOrder = order;
	return { success: true };
}, {
	broadcastFolders: true,
	updateMenus: true,
	syncToNative: true
});
