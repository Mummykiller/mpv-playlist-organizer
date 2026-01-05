// background/handlers/folder_management.js
import { sanitizeString } from '../../utils/sanitization.js';

let _storage;
let _broadcastToTabs;
let _updateContextMenus;
let _debouncedSyncToNativeHostFile;

export function init(dependencies) {
    _storage = dependencies.storage;
    _broadcastToTabs = dependencies.broadcastToTabs;
    _updateContextMenus = dependencies.updateContextMenus;
    _debouncedSyncToNativeHostFile = dependencies.debouncedSyncToNativeHostFile;
}

function isValidFolderName(name) {
    if (!name || typeof name !== 'string') return false;
    // Strict whitelist: alphanumeric, underscores, hyphens, and spaces.
    // Disallow leading/trailing spaces and path traversal dots.
    const regex = /^[a-zA-Z0-9_\-\s]+$/;
    return regex.test(name) && name.trim() === name && !name.includes('..');
}

export async function handleCreateFolder(request) {
    const folderId = sanitizeString(request.folderId, true);
    if (!isValidFolderName(folderId)) {
        return { success: false, error: 'Invalid folder name. Only alphanumeric characters, spaces, hyphens, and underscores are allowed.' };
    }
    const data = await _storage.get();
    if (data.folders[folderId]) {
        return { success: false, error: 'A folder with that name already exists.' };
    }
    data.folderOrder.push(folderId);
    data.folders[folderId] = { playlist: [] };
    await _storage.set(data);
    await _updateContextMenus(_storage);
    _broadcastToTabs({ foldersChanged: true });
    _debouncedSyncToNativeHostFile(true);
    return { success: true, message: `Folder "${folderId}" created.` };
}

export async function handleGetAllFolderIds() {
    const data = await _storage.get();
    const folderIds = data.folderOrder || Object.keys(data.folders);
    const lastUsedFolderId = data.settings.last_used_folder_id;
    return { success: true, folderIds, lastUsedFolderId };
}

export async function handleRemoveFolder(request) {
    const folderIdToRemove = request.folderId;
    if (!folderIdToRemove) return { success: false, error: 'Invalid folder ID provided.' };

    const data = await _storage.get();
    if (data.folderOrder.length <= 1 && data.folders[folderIdToRemove]) {
        return { success: false, error: 'Cannot remove the last folder.' };
    }
    if (!data.folders[folderIdToRemove]) {
        return { success: false, error: 'Folder not found.' };
    }

    delete data.folders[folderIdToRemove];
    data.folderOrder = data.folderOrder.filter(id => id !== folderIdToRemove);

    if (data.settings.last_used_folder_id === folderIdToRemove) {
        data.settings.last_used_folder_id = Object.keys(data.folders)[0];
    }
    await _storage.set(data);

    await _updateContextMenus(_storage);
    _broadcastToTabs({ foldersChanged: true });
    _debouncedSyncToNativeHostFile(true);
    return { success: true, message: `Folder "${folderIdToRemove}" removed.` };
}

export async function handleRenameFolder(request) {
    const oldFolderId = request.oldFolderId;
    const newFolderId = sanitizeString(request.newFolderId, true);
    
    if (!oldFolderId || !isValidFolderName(newFolderId)) {
        return { success: false, error: 'Invalid folder names provided.' };
    }
    const data = await _storage.get();
    if (!data.folders[oldFolderId]) {
        return { success: false, error: `Folder "${oldFolderId}" not found.` };
    }
    if (data.folders[newFolderId]) {
        return { success: false, error: `A folder named "${newFolderId}" already exists.` };
    }

    data.folders[newFolderId] = data.folders[oldFolderId];
    delete data.folders[oldFolderId];

    const index = data.folderOrder.indexOf(oldFolderId);
    if (index !== -1) data.folderOrder[index] = newFolderId;

    if (data.settings.last_used_folder_id === oldFolderId) {
        data.settings.last_used_folder_id = newFolderId;
    }

    await _storage.set(data);
    await _updateContextMenus(_storage);
    _broadcastToTabs({ foldersChanged: true });
    _debouncedSyncToNativeHostFile(true);
    return { success: true, message: `Folder renamed to "${newFolderId}".` };
}

export async function handleSetFolderOrder(request) {
    const newOrder = request.order;
    if (!Array.isArray(newOrder)) {
        return { success: false, error: 'Invalid order data provided.' };
    }
    const data = await _storage.get();
    const currentKeys = new Set(Object.keys(data.folders));
    const newKeys = new Set(newOrder);
    if (currentKeys.size !== newKeys.size || ![...currentKeys].every(k => newKeys.has(k))) {
        return { success: false, error: 'New order does not match existing folders.' };
    }

    data.folderOrder = newOrder;
    await _storage.set(data);
    _debouncedSyncToNativeHostFile(true);
    return { success: true, message: 'Folder order updated.' };
}