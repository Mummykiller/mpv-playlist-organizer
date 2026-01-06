// background/handlers/import_export.js
import { sanitizeString } from '../../utils/sanitization.js';

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

export async function handleImportFromFile(request, sender) {
    const filename = request.filename;
    // Default to true for all if options missing (which they will be now for import)
    const options = request.options || { preserveTitle: true, preserveLastPlayed: true };
    
    if (!filename) {
        return { success: false, error: 'No filename provided.' };
    }

    const response = await _callNativeHost({ action: 'import_from_file', filename });

    if (!response.success) {
        return response; // Forward the error from native host
    }

    try {
        // Derive folder name from filename, e.g., "my_backup.json" -> "my_backup"
        // And sanitize it for filesystem safety as it will become a folder ID.
        const baseFolderName = sanitizeString(filename.replace(/\.json$/i, ''), true);

        if (!baseFolderName) {
            throw new Error("Invalid filename for folder creation.");
        }

        // Parse content
        const importedData = JSON.parse(response.data);

        // CHECK: Is this a settings backup?
        if (importedData && importedData.type === 'mpv_playlist_organizer_settings') {
            // Ask for confirmation before restoring settings
            const confirmResponse = await new Promise(resolve => {
                chrome.runtime.sendMessage({ 
                    action: 'show_popup_confirmation', 
                    message: `The file '${filename}' appears to be a settings backup. Would you like to restore your preferences, keybinds, and custom MPV flags?` 
                }, (response) => {
                    resolve(response && response.confirmed);
                });
            });

            if (!confirmResponse) {
                return { success: true, message: 'Settings restore cancelled.' };
            }

            return await handleImportSettings(importedData, filename);
        }

        let combinedPlaylist = [];
        let importedLastPlayedId = null;

        if (Array.isArray(importedData)) {
            // Case 1: The file is a simple JSON array of URLs.
            combinedPlaylist = importedData
                .filter(item => typeof item === 'string')
                .map(url => ({ 
                    url: sanitizeString(url), 
                    title: sanitizeString(url),
                    id: crypto.randomUUID(),
                    settings: {}
                }));
        } else if (typeof importedData === 'object' && importedData !== null) {
            // Case 2: The file is an object of folders (like our export format).
            // We'll merge all playlists from within this file into one.
            for (const key in importedData) {
                const folderContent = importedData[key];
                if (folderContent && Array.isArray(folderContent.playlist)) {
                    // Try to capture last played ID if we don't have one yet
                    if (!importedLastPlayedId && folderContent.last_played_id) {
                        importedLastPlayedId = folderContent.last_played_id;
                    }

                    // Handle both old (string) and new (object) formats within the import file.
                    const items = folderContent.playlist.map(item => {
                        if (typeof item === 'string') {
                            return { 
                                url: sanitizeString(item), 
                                title: sanitizeString(item),
                                id: crypto.randomUUID(),
                                settings: {}
                            };
                        } else if (item && typeof item.url === 'string') {
                            const newItem = {
                                ...item,
                                url: sanitizeString(item.url),
                                title: options.preserveTitle ? sanitizeString(item.title || item.url) : sanitizeString(item.url),
                                id: item.id || crypto.randomUUID(),
                                settings: item.settings || {}
                            };
                            
                            if (!options.preserveLastPlayed) {
                                delete newItem.resume_time;
                            }
                            
                            return newItem;
                        }
                        return null;
                    });
                    combinedPlaylist.push(...items.filter(item => item !== null));
                }
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
        const newFolderData = { playlist: combinedPlaylist };
        if (options.preserveLastPlayed && importedLastPlayedId) {
            // Verify the ID actually exists in the imported playlist
            if (combinedPlaylist.some(item => item.id === importedLastPlayedId)) {
                newFolderData.last_played_id = importedLastPlayedId;
            }
        }

        localData.folders[newFolderId] = newFolderData;
        localData.folderOrder.push(newFolderId);
        await _storage.set(localData);

        // Update UI and sync data to the native host's file
        await _updateContextMenus(_storage);
        _broadcastToTabs({ foldersChanged: true });
        _debouncedSyncToNativeHostFile(true);
        return { success: true, message: `Imported '${filename}' as new folder '${newFolderId}' with ${combinedPlaylist.length} URL(s).` };
    } catch (e) {
        return { success: false, error: `Failed to parse or process import file: ${e.message}` };
    }
}

async function handleImportSettings(importedData, filename) {
    try {
        const localData = await _storage.get();
        const importedSettings = importedData.settings;
        
        // Preserve local dependency status as it is machine-specific
        const localDependencyStatus = localData.settings.ui_preferences?.global?.dependencyStatus;
        
        // Keys to exclude from restore (session-specific or persistent state)
        const excludeKeys = ['last_used_folder_id', 'anilist_cache'];
        
        let restoredCount = 0;
        for (const key in importedSettings) {
            if (!excludeKeys.includes(key)) {
                localData.settings[key] = importedSettings[key];
                restoredCount++;
            }
        }
        
        // Restore the local dependency status if it exists
        if (localDependencyStatus && localData.settings.ui_preferences?.global) {
            localData.settings.ui_preferences.global.dependencyStatus = localDependencyStatus;
        }
        
        await _storage.set(localData);

        // Sync relevant global settings to the native host's config.json
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
                await _callNativeHost({ action: 'set_ui_preferences', preferences: syncPrefs });
            }
        } catch (nativeSyncError) {
            console.warn("Failed to sync restored settings to native host:", nativeSyncError);
        }

        _broadcastToTabs({ action: 'preferences_changed' });
        
        return { 
            success: true, 
            message: `Successfully restored ${restoredCount} settings from '${filename}'.` 
        };
    } catch (e) {
        return { success: false, error: `Failed to restore settings: ${e.message}` };
    }
}

export async function handleExportSettings(request) {
    const filename = request.filename || 'mpv_settings_backup';
    const data = await _storage.get();
    
    // Create a deep copy of global settings to filter
    const filteredSettings = JSON.parse(JSON.stringify(data.settings));
    
    if (filteredSettings.ui_preferences && filteredSettings.ui_preferences.global) {
        const global = filteredSettings.ui_preferences.global;
        
        // Remove ephemeral/local-only state that shouldn't be in a portable backup
        const keysToRemove = [
            'minimized', 
            'position', 
            'anilistPanelVisible', 
            'anilistPanelPosition', 
            'anilistPanelSize', 
            'minimizedStubPosition',
            'dependencyStatus' // Already excluded in import, but good to keep export clean too
        ];
        
        keysToRemove.forEach(key => delete global[key]);
    }
    
    // Completely remove the 'domains' object to exclude per-website overrides from the backup
    if (filteredSettings.ui_preferences) {
        delete filteredSettings.ui_preferences.domains;
    }

    const exportData = {
        type: 'mpv_playlist_organizer_settings',
        version: chrome.runtime.getManifest().version,
        timestamp: new Date().toISOString(),
        settings: filteredSettings
    };

    return _callNativeHost({ 
        action: 'export_playlists', 
        data: exportData, 
        filename: filename,
        subfolder: 'settings'
    });
}

export async function handleExportAllPlaylistsSeparately(request) {
    const data = await _storage.get();
    const options = request.options || { preserveTitle: true, preserveLastPlayed: true, preserveResumeTime: true };
    
    // Create a copy of folders and strip metadata based on options
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

    return _callNativeHost({ 
        action: 'export_all_playlists_separately', 
        data: filteredFolders,
        customNames: options.customNames || {}
    });
}

export async function handleExportFolderPlaylist(request) {
    if (!request.filename || !request.folderId) return { success: false, error: 'Missing filename or folderId.' };
    const data = await _storage.get();
    const folder = data.folders[request.folderId];
    const options = request.options || { preserveTitle: true, preserveLastPlayed: true, preserveResumeTime: true };
    
    if (!folder || !folder.playlist || !folder.playlist.length) {
        return { success: false, error: `Folder '${request.folderId}' not found or is empty.` };
    }

    // Create a deep copy to avoid modifying live storage
    const folderToExport = JSON.parse(JSON.stringify(folder));

    // Strip metadata based on options
    if (!options.preserveLastPlayed) delete folderToExport.last_played_id;
    
    folderToExport.playlist = folderToExport.playlist.map(item => {
        const newItem = { ...item };
        if (!options.preserveTitle) newItem.title = newItem.url;
        if (!options.preserveLastPlayed) delete newItem.resume_time;
        return newItem;
    });

    return _callNativeHost({ action: 'export_playlists', data: folderToExport, filename: request.filename });
}

export async function handleListImportFiles() {
    return _callNativeHost({ action: 'list_import_files' });
}

export async function handleOpenExportFolder() {
    return _callNativeHost({ action: 'open_export_folder' });
}