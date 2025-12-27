// background/handlers/import_export.js

let _storage;
let _broadcastToTabs;
let _callNativeHost;
let _updateContextMenus;
let _debouncedSyncToNativeHostFile;

export function init(dependencies) {
    _storage = dependencies.storage;
    _broadcastToTabs = dependencies.broadcastToTabs;
    _callNativeHost = dependencies.callNativeHost;
    _updateContextMenus = dependencies.updateContextMenus;
    _debouncedSyncToNativeHostFile = dependencies.debouncedSyncToNativeHostFile;
}

export async function handleImportFromFile(request) {
    const filename = request.filename;
    if (!filename) {
        return { success: false, error: 'No filename provided.' };
    }

    const response = await _callNativeHost({ action: 'import_from_file', filename });

    if (!response.success) {
        return response; // Forward the error from native host
    }

    try {
        // Derive folder name from filename, e.g., "my_backup.json" -> "my_backup"
        const baseFolderName = filename.replace(/\.json$/i, '');

        // Parse content and build a single combined playlist
        const importedData = JSON.parse(response.data);
        let combinedPlaylist = [];

        if (Array.isArray(importedData)) {
            // Case 1: The file is a simple JSON array of URLs.
            combinedPlaylist = importedData
                .filter(item => typeof item === 'string')
                .map(url => ({ url: url, title: url }));
        } else if (typeof importedData === 'object' && importedData !== null) {
            // Case 2: The file is an object of folders (like our export format).
            // We'll merge all playlists from within this file into one.
            for (const key in importedData) {
                const folderContent = importedData[key];
                if (folderContent && Array.isArray(folderContent.playlist)) {
                    // Handle both old (string) and new (object) formats within the import file.
                    const items = folderContent.playlist.map(item => 
                        typeof item === 'string' ? { url: item, title: item } : item
                    );
                    combinedPlaylist.push(...items.filter(item => item && typeof item.url === 'string'));
                }
            }
        } else {
            // New: Handle single playlist export (just an array of URLs)
            if (Array.isArray(importedData)) {
                 combinedPlaylist = importedData.filter(url => typeof url === 'string').map(url => ({ url, title: url }));
            } else {
                throw new Error("Unsupported import file format. Must be a JSON array of URLs or an object of folders.");
            }
        }

        if (combinedPlaylist.length === 0) {
            return { success: true, message: `Import file '${filename}' was empty or contained no valid URLs. No folder created.` };
        }

        // Get local data and handle name collision for the new folder.
        const localData = await _storage.get();
        let newFolderId = baseFolderName;
        let counter = 1;
        while (localData.folders[newFolderId]) {
            newFolderId = `${baseFolderName} (${counter})`;
            counter++;
        }

        // Create the new folder with the combined playlist.
        localData.folders[newFolderId] = { playlist: combinedPlaylist };
        localData.folderOrder.push(newFolderId);
        await _storage.set(localData);

        // Update UI and sync data to the native host's file
        await _updateContextMenus(_storage);
        _broadcastToTabs({ foldersChanged: true });
        _debouncedSyncToNativeHostFile();
        return { success: true, message: `Imported '${filename}' as new folder '${newFolderId}' with ${combinedPlaylist.length} URL(s).` };
    } catch (e) {
        return { success: false, error: `Failed to parse or process import file: ${e.message}` };
    }
}

export async function handleExportAllPlaylistsSeparately() {
    const data = await _storage.get();
    return _callNativeHost({ action: 'export_all_playlists_separately', data: data.folders });
}

export async function handleExportFolderPlaylist(request) {
    if (!request.filename || !request.folderId) return { success: false, error: 'Missing filename or folderId.' };
    const data = await _storage.get();
    const folder = data.folders[request.folderId];
    // Extract just the URLs for the export file.
    const urlPlaylist = folder?.playlist?.map(item => item.url) || [];
    if (!folder || !urlPlaylist.length) return { success: false, error: `Folder '${request.folderId}' not found or is empty.` };
    return _callNativeHost({ action: 'export_playlists', data: urlPlaylist, filename: request.filename });
}

export async function handleListImportFiles() {
    return _callNativeHost({ action: 'list_import_files' });
}

export async function handleOpenExportFolder() {
    return _callNativeHost({ action: 'open_export_folder' });
}