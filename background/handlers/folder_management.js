// background/handlers/folder_management.js

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

export async function handleCreateFolder(request) {
    if (!request.folderId || !request.folderId.trim()) {
        return { success: false, error: 'Folder name cannot be empty.' };
    }
    const data = await _storage.get();
    if (data.folders[request.folderId]) {
        return { success: false, error: 'A folder with that name already exists.' };
    }
    data.folderOrder.push(request.folderId);
    data.folders[request.folderId] = { playlist: [] };
    await _storage.set(data);
    await _updateContextMenus(_storage);
    _broadcastToTabs({ foldersChanged: true });
    _debouncedSyncToNativeHostFile();
    return { success: true, message: `Folder "${request.folderId}" created.` };
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
    _debouncedSyncToNativeHostFile();
    return { success: true, message: `Folder "${folderIdToRemove}" removed.` };
}

export async function handleRenameFolder(request) {
    const { oldFolderId, newFolderId } = request;
    if (!oldFolderId || !newFolderId || !newFolderId.trim()) {
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
    _debouncedSyncToNativeHostFile();
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
    _debouncedSyncToNativeHostFile();
    return { success: true, message: 'Folder order updated.' };
}