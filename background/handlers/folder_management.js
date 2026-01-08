// background/handlers/folder_management.js
import { storage } from '../storage_instance.js';
import { broadcastToTabs } from '../messaging.js';
import { debouncedSyncToNativeHostFile } from '../core_services.js';
import { updateContextMenus } from '../../utils/contextMenu.js';
import { sanitizeString } from '../../utils/sanitization.js';

export async function handleCreateFolder(request) {
    let { folderId } = request;
    if (!folderId) return { success: false, error: 'No folder name provided.' };

    folderId = sanitizeString(folderId, true);
    if (!folderId) return { success: false, error: 'Invalid folder name after sanitization.' };

    const data = await storage.get();
    if (data.folders[folderId]) return { success: false, error: 'Folder already exists.' };

    data.folders[folderId] = { playlist: [] };
    if (!data.folderOrder) data.folderOrder = Object.keys(data.folders);
    if (!data.folderOrder.includes(folderId)) data.folderOrder.push(folderId);

    await storage.set(data);
    broadcastToTabs({ action: 'foldersChanged', folderId: folderId });
    await updateContextMenus(storage);
    debouncedSyncToNativeHostFile(folderId);

    return { success: true, folderId };
}

export async function handleGetAllFolderIds() {
    const data = await storage.get();
    return {
        success: true,
        folderIds: data.folderOrder || Object.keys(data.folders),
        lastUsedFolderId: data.settings.last_used_folder_id
    };
}

export async function handleRemoveFolder(request) {
    const { folderId } = request;
    if (!folderId) return { success: false, error: 'No folder ID provided.' };

    const data = await storage.get();
    if (!data.folders[folderId]) return { success: false, error: 'Folder not found.' };

    delete data.folders[folderId];
    if (data.folderOrder) data.folderOrder = data.folderOrder.filter(id => id !== folderId);

    if (data.settings.last_used_folder_id === folderId) {
        data.settings.last_used_folder_id = data.folderOrder ? data.folderOrder[0] : Object.keys(data.folders)[0];
    }

    await storage.set(data);
    broadcastToTabs({ action: 'foldersChanged' });
    await updateContextMenus(storage);
    
    // For removal, we trigger a full sync to ensure the host is aware of the deletion
    debouncedSyncToNativeHostFile();

    return { success: true };
}

export async function handleRenameFolder(request) {
    let { oldId, newId } = request;
    if (!oldId || !newId) return { success: false, error: 'Missing folder IDs.' };

    newId = sanitizeString(newId, true);
    if (!newId) return { success: false, error: 'Invalid new folder name.' };

    const data = await storage.get();
    if (!data.folders[oldId]) return { success: false, error: 'Folder not found.' };
    if (data.folders[newId]) return { success: false, error: 'New folder name already exists.' };

    data.folders[newId] = data.folders[oldId];
    delete data.folders[oldId];

    if (data.folderOrder) {
        const index = data.folderOrder.indexOf(oldId);
        if (index !== -1) data.folderOrder[index] = newId;
    }

    if (data.settings.last_used_folder_id === oldId) {
        data.settings.last_used_folder_id = newId;
    }

    await storage.set(data);
    broadcastToTabs({ action: 'foldersChanged', folderId: newId });
    await updateContextMenus(storage);
    debouncedSyncToNativeHostFile();

    return { success: true, folderId: newId };
}

export async function handleSetFolderOrder(request) {
    const { order } = request;
    if (!order) return { success: false, error: 'No order provided.' };

    const data = await storage.get();
    data.folderOrder = order;

    await storage.set(data);
    broadcastToTabs({ action: 'foldersChanged' });
    await updateContextMenus(storage);
    debouncedSyncToNativeHostFile();

    return { success: true };
}