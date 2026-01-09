// background/handlers/import_export.js
import { storage } from '../storage_instance.js';
import { broadcastToTabs } from '../messaging.js';
import { debouncedSyncToNativeHostFile } from '../core_services.js';
import { callNativeHost } from '../../utils/nativeConnection.js';
import { updateContextMenus } from '../../utils/contextMenu.js';
import { sanitizeString } from '../../utils/commUtils.module.js';

export async function handleImportFromFile(request, sender) {
    const filename = request.filename;
    const options = request.options || { preserveTitle: true, preserveLastPlayed: true };
    
    if (!filename) return { success: false, error: 'No filename provided.' };

    const response = await callNativeHost({ action: 'import_from_file', filename });
    if (!response.success) return response;

    try {
        const baseFolderName = sanitizeString(filename.replace(/\.json$/i, ''), true);
        if (!baseFolderName) throw new Error("Invalid filename for folder creation.");

        const importedData = JSON.parse(response.data);

        // --- Helper: Item Processor ---
        const processPlaylist = (playlist) => {
            return playlist.map(item => {
                if (typeof item === 'string') {
                    return { url: sanitizeString(item), title: sanitizeString(item), id: crypto.randomUUID(), settings: {} };
                } else if (item && typeof item.url === 'string') {
                    const newItem = {
                        ...item,
                        url: sanitizeString(item.url),
                        title: options.preserveTitle ? sanitizeString(item.title || item.url) : sanitizeString(item.url),
                        id: item.id || crypto.randomUUID(), // PRESERVE ID IF EXISTS
                        settings: item.settings || {}
                    };
                    if (!options.preserveLastPlayed) delete newItem.resume_time;
                    return newItem;
                }
                return null;
            }).filter(i => i !== null);
        };

        if (importedData && importedData.type === 'mpv_playlist_organizer_settings') {
            const confirmResponse = await new Promise(resolve => {
                chrome.runtime.sendMessage({ 
                    action: 'show_popup_confirmation', 
                    message: `The file '${filename}' appears to be a settings backup. Restore your preferences?` 
                }, (res) => resolve(res && res.confirmed));
            });

            if (!confirmResponse) return { success: true, message: 'Settings restore cancelled.' };
            return await handleImportSettings(importedData, filename);
        }

        const foldersToImport = {};

        // --- Detection: Single Folder or Full Backup? ---
        if (Array.isArray(importedData)) {
            // Case 1: Just a list of URLs
            foldersToImport[baseFolderName] = { playlist: processPlaylist(importedData) };
        } else if (importedData && Array.isArray(importedData.playlist)) {
            // Case 2: A single folder object
            const folder = { playlist: processPlaylist(importedData.playlist) };
            if (options.preserveLastPlayed && importedData.last_played_id) {
                if (folder.playlist.some(i => i.id === importedData.last_played_id)) {
                    folder.last_played_id = importedData.last_played_id;
                }
            }
            foldersToImport[baseFolderName] = folder;
        } else if (typeof importedData === 'object' && importedData !== null) {
            // Case 3: Multiple folders (Full Backup)
            for (const key in importedData) {
                const folderContent = importedData[key];
                if (folderContent && Array.isArray(folderContent.playlist)) {
                    const folder = { playlist: processPlaylist(folderContent.playlist) };
                    if (options.preserveLastPlayed && folderContent.last_played_id) {
                        if (folder.playlist.some(i => i.id === folderContent.last_played_id)) {
                            folder.last_played_id = folderContent.last_played_id;
                        }
                    }
                    foldersToImport[key] = folder;
                }
            }
        }

        if (Object.keys(foldersToImport).length === 0) return { success: true, message: `Import file was empty or incompatible.` };

        const localData = await storage.get();
        let importedCount = 0;

        for (let [folderId, folderData] of Object.entries(foldersToImport)) {
            let finalId = folderId;
            let counter = 1;
            while (localData.folders[finalId]) {
                finalId = `${folderId} (${counter})`;
                counter++;
            }
            localData.folders[finalId] = folderData;
            localData.folderOrder.push(finalId);
            importedCount++;
        }

        await storage.set(localData);
        await updateContextMenus(storage);
        broadcastToTabs({ foldersChanged: true });
        debouncedSyncToNativeHostFile();
        
        return { success: true, message: `Successfully imported ${importedCount} folder(s).` };
    } catch (e) {
        return { success: false, error: `Import failed: ${e.message}` };
    }
}

async function handleImportSettings(importedData, filename) {
    try {
        const localData = await storage.get();
        const importedSettings = importedData.settings;
        const localDependencyStatus = localData.settings.ui_preferences?.global?.dependencyStatus;
        const excludeKeys = ['last_used_folder_id', 'anilist_cache'];
        
        let restoredCount = 0;
        for (const key in importedSettings) {
            if (!excludeKeys.includes(key)) {
                localData.settings[key] = importedSettings[key];
                restoredCount++;
            }
        }
        
        if (localDependencyStatus && localData.settings.ui_preferences?.global) {
            localData.settings.ui_preferences.global.dependencyStatus = localDependencyStatus;
        }
        
        await storage.set(localData);

        try {
            const nativeSyncKeys = [
                'mpv_path', 'mpv_decoder', 'enable_url_analysis', 'browser_for_url_analysis',
                'enable_youtube_analysis', 'user_agent_string', 'enable_smart_resume',
                'enable_active_item_highlight', 'disable_network_overrides', 'enable_cache',
                'http_persistence', 'demuxer_max_bytes', 'demuxer_max_back_bytes',
                'cache_secs', 'demuxer_readahead_secs', 'stream_buffer_size', 
                'ytdlp_concurrent_fragments', 'enable_reconnect', 'reconnect_delay', 
                'automatic_mpv_flags'
            ];
            const syncPrefs = {};
            const globalPrefs = localData.settings.ui_preferences?.global || {};
            nativeSyncKeys.forEach(key => {
                if (globalPrefs[key] !== undefined) syncPrefs[key] = globalPrefs[key];
            });
            if (Object.keys(syncPrefs).length > 0) {
                await callNativeHost({ action: 'set_ui_preferences', preferences: syncPrefs });
            }
        } catch (err) {}

        broadcastToTabs({ action: 'preferences_changed' });
        return { success: true, message: `Restored ${restoredCount} settings.` };
    } catch (e) {
        return { success: false, error: `Settings restore failed: ${e.message}` };
    }
}

export async function handleExportSettings(request) {
    const filename = request.filename || 'mpv_settings_backup';
    const data = await storage.get();
    const filteredSettings = JSON.parse(JSON.stringify(data.settings));
    
    if (filteredSettings.ui_preferences && filteredSettings.ui_preferences.global) {
        const global = filteredSettings.ui_preferences.global;
        const keysToRemove = ['minimized', 'position', 'anilistPanelVisible', 'anilistPanelPosition', 'anilistPanelSize', 'minimizedStubPosition', 'dependencyStatus'];
        keysToRemove.forEach(key => delete global[key]);
    }
    if (filteredSettings.ui_preferences) delete filteredSettings.ui_preferences.domains;

    const exportData = {
        type: 'mpv_playlist_organizer_settings',
        version: chrome.runtime.getManifest().version,
        timestamp: new Date().toISOString(),
        settings: filteredSettings
    };

    return callNativeHost({ action: 'export_playlists', data: exportData, filename, subfolder: 'settings' });
}

export async function handleExportAllPlaylistsSeparately(request) {
    const data = await storage.get();
    const options = request.options || { preserveTitle: true, preserveLastPlayed: true };
    const filteredFolders = JSON.parse(JSON.stringify(data.folders));
    
    for (const folderId in filteredFolders) {
        const folder = filteredFolders[folderId];
        if (!options.preserveLastPlayed) delete folder.last_played_id;
        folder.playlist = folder.playlist.map(item => {
            const newItem = { ...item };
            if (!options.preserveTitle) newItem.title = newItem.url;
            if (!options.preserveLastPlayed) delete newItem.resume_time;
            return newItem;
        });
    }

    return callNativeHost({ action: 'export_all_playlists_separately', data: filteredFolders, customNames: options.customNames || {} });
}

export async function handleExportFolderPlaylist(request) {
    if (!request.filename || !request.folderId) return { success: false, error: 'Missing filename or folderId.' };
    const data = await storage.get();
    const folder = data.folders[request.folderId];
    const options = request.options || { preserveTitle: true, preserveLastPlayed: true };
    
    if (!folder || !folder.playlist) return { success: false, error: `Folder empty.` };

    const folderToExport = JSON.parse(JSON.stringify(folder));
    if (!options.preserveLastPlayed) delete folderToExport.last_played_id;
    folderToExport.playlist = folderToExport.playlist.map(item => {
        const newItem = { ...item };
        if (!options.preserveTitle) newItem.title = newItem.url;
        if (!options.preserveLastPlayed) delete newItem.resume_time;
        return newItem;
    });

    return callNativeHost({ action: 'export_playlists', data: folderToExport, filename: request.filename });
}

export async function handleListImportFiles() {
    return callNativeHost({ action: 'list_import_files' });
}

export async function handleOpenExportFolder() {
    return callNativeHost({ action: 'open_export_folder' });
}