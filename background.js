// --- Module Imports ---
import { StorageManager } from './utils/storageManager.js';
import { callNativeHost, injectDependencies as injectNativeConnectionDependencies } from './utils/nativeConnection.js';
import { updateContextMenus } from './utils/contextMenu.js';
import * as playlistManager from './utils/playlistManager.js';

// --- Constants ---
const MPV_PLAYLIST_COMPLETED_EXIT_CODE = 99;

// --- Debounce Utility ---
/**
 * Creates a debounced function that delays invoking `func` until after `wait`
 * milliseconds have elapsed since the last time the debounced function was
 * invoked.
 * @param {Function} func The function to debounce.
 * @param {number} wait The number of milliseconds to delay.
 * @returns {Function} Returns the new debounced function.
 */
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func.apply(this, args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// --- Unified Storage Model ---

/**
 * A promise-based wrapper for chrome.runtime.sendMessage.
 * @param {object} payload The message to send.
 * @returns {Promise<any>} A promise that resolves with the response.
 */
const sendMessageAsync = (payload) => new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve(response);
    });
});

const storage = new StorageManager('mpv_organizer_data', broadcastLog);

// --- Messaging Helper ---

/**
 * Broadcasts a message to all content scripts in open tabs.
 * @param {object} message - The message object to send.
 */
function broadcastToTabs(message) {
    // Send to other extension contexts (like the popup).
    chrome.runtime.sendMessage(message).catch(() => {});

    chrome.tabs.query({}, (tabs) => {
        for (const tab of tabs) {
            try {
                // Attempt to send the message, but ignore errors if the content script isn't injected.
                chrome.tabs.sendMessage(tab.id, message).catch(() => {});
            } catch (e) {
                // This can happen if the tab is on a restricted page (e.g., chrome://)
            }
        }
    });
}

/**
 * Broadcasts a log message to all content scripts and the popup.
 * @param {object} logObject - The log object to send (e.g., {text: '...', type: 'info'}).
 */
function broadcastLog(logObject) {
    const message = { log: logObject };
    broadcastToTabs(message);
}

// --- Native Host Communication (using a persistent connection) ---

let tabUiState = {}; // Tracks the minimized state of the UI for each tab

/**
 * Gathers all folder data from chrome.storage.local and sends it to the
 * native host to be written to the folders.json file. This keeps the
 * CLI and the extension in sync.
 */
async function syncDataToNativeHostFile() {
    const data = await storage.get();
    try {
        await callNativeHost({
            action: 'export_data',
            data: data.folders // Only send the folders object
        });
    } catch (e) {
        const errorMessage = `Failed to sync data to native host file: ${e.message}`;
        console.error(errorMessage);
        broadcastLog({ text: `[Background]: ${errorMessage}`, type: 'error' });
    }
}

// Debounce the sync function to avoid rapid-fire writes to the native host.
// A 1-second delay is reasonable. If multiple changes happen in quick succession,
// it will only sync once after the user is done.
const debouncedSyncToNativeHostFile = debounce(syncDataToNativeHostFile, 1000);

async function handleMpvExited(data) {
    const { folderId, returnCode } = data;
    if (!folderId) return;
    
    broadcastLog({ text: `[Background]: MPV session for folder '${folderId}' has ended with exit code ${returnCode}.`, type: 'info' });

    const storageData = await storage.get();
    const shouldClear = storageData.settings.ui_preferences.global.clear_on_completion ?? false;

    broadcastLog({ text: `[Background]: 'Clear on Completion' setting is ${shouldClear ? 'ENABLED' : 'DISABLED'}.`, type: 'info' });

    if (shouldClear) {
        // MPV_PLAYLIST_COMPLETED_EXIT_CODE (99) indicates natural playlist completion.
        // We only clear the playlist if it completes naturally, not if the user closes MPV manually (which gives exit code 0).
        if (returnCode === MPV_PLAYLIST_COMPLETED_EXIT_CODE) {
            const completionType = 'naturally completed';
            broadcastLog({ text: `[Background]: MPV session for folder '${folderId}' ${completionType}. Auto-clearing playlist as per settings.`, type: 'info' });
            await playlistManager.handleClear({ folderId: folderId });
        } else {
            broadcastLog({ text: `[Background]: MPV exited with unexpected code ${returnCode}. Playlist for '${folderId}' will not be cleared.`, type: 'error' });
            // Only suggest script loading issue if it's not a normal exit (0) or natural completion (99)
            if (returnCode !== 0 && returnCode !== MPV_PLAYLIST_COMPLETED_EXIT_CODE) {
                broadcastLog({ text: `[Background]: This may indicate an issue with the 'on_completion.lua' script or an MPV crash.`, type: 'error' });
            }
        }
    } else {
        broadcastLog({ text: `[Background]: Playlist for '${folderId}' will not be cleared because the setting is disabled.`, type: 'info' });
    }
}

injectNativeConnectionDependencies({ broadcastLog, handleMpvExited });
playlistManager.injectDependencies({ storage, broadcastToTabs, broadcastLog, debouncedSyncToNativeHostFile, sendMessageAsync, findM3u8InUrl, callNativeHost });

/**
 * Checks MPV and yt-dlp dependencies via the native host and stores the results.
 * Also broadcasts a message to update UI components.
 */
async function _checkDependenciesAndStore() {
    broadcastLog({ text: `[Background]: Checking MPV and yt-dlp dependencies...`, type: 'info' });
    const response = await callNativeHost({ action: 'check_dependencies' });

    if (response.success) {
        const data = await storage.get();
        data.settings.ui_preferences.global.dependencyStatus = {
            mpv: response.mpv,
            ytdlp: response.ytdlp
        };
        await storage.set(data);
        broadcastLog({ text: `[Background]: Dependency check completed.`, type: 'info' });
        broadcastToTabs({ action: 'dependencies_status_changed', status: data.settings.ui_preferences.global.dependencyStatus });
    } else {
        broadcastLog({ text: `[Background]: Dependency check failed: ${response.error}`, type: 'error' });
    }
}


// --- Context Menu Management ---

// --- Main Message Listener ---

async function handleContentScriptInit(request, sender) {
    const tabId = sender.tab?.id; // Ensure tab exists
    const origin = sender.origin;

    if (tabId && origin && sender.tab) {
        if (!tabUiState[tabId]) tabUiState[tabId] = {};
        try {
            tabUiState[tabId].uiDomain = new URL(origin).hostname;
        } catch (e) { /* ignore invalid origins */ }
        
        const data = await storage.get();
        const globalPrefs = data.settings.ui_preferences.global;

        let domain = null;
        if (origin && (origin.startsWith('http:') || origin.startsWith('https:'))) {
            try {
                domain = new URL(origin).hostname;
            } catch (e) { /* ignore */ }
        }

        const domainPrefs = domain ? data.settings.ui_preferences.domains[domain] || {} : {};

        let isMinimized;
        if (typeof domainPrefs.minimized === 'boolean') {
            isMinimized = domainPrefs.minimized;
        } else {
            isMinimized = (globalPrefs.mode === 'minimized');
        }

        // Send a single message with the determined state. The content script will handle showing/hiding.
        chrome.tabs.sendMessage(tabId, { action: 'init_ui_state', shouldBeMinimized: isMinimized }).catch(() => {});
    }
}

async function handleGetUiStateForTab(request) {
    const tabId = request.tabId;
    const tab = await chrome.tabs.get(tabId);
    const data = await storage.get();
    const globalPrefs = data.settings.ui_preferences.global;
    const tabState = tabUiState[tabId] || {};

    let domain = tabState.uiDomain;
    if (!domain && tab.url && (tab.url.startsWith('http:') || tab.url.startsWith('https:'))) {
        try {
            domain = new URL(tab.url).hostname;
        } catch (e) { /* ignore */ }
    }

    const domainPrefs = domain ? data.settings.ui_preferences.domains[domain] || {} : {};

    // Combine global and domain preferences to get the final state for the tab.
    const finalPrefs = { ...globalPrefs, ...domainPrefs };

    return {
        success: true,
        state: {
            minimized: finalPrefs.minimized ?? (finalPrefs.mode === 'minimized'),
            detectedUrl: tabState.detectedUrl
        }
    };
}

async function handleReportDetectedUrl(request, sender) {
    const tabId = sender.tab?.id;
    if (tabId) {
        if (!tabUiState[tabId]) tabUiState[tabId] = {};
        tabUiState[tabId].detectedUrl = request.url;
        // Broadcast to all contexts (popup and content scripts)
        // The popup can check if the tabId matches the active tab.
        broadcastToTabs({ action: 'detected_url_changed', tabId: tabId, url: request.url });
    }
}

async function handleSetLastFolderId(request) {
    if (request.folderId) {
        const data = await storage.get();
        data.settings.last_used_folder_id = request.folderId;
        await storage.set(data);
        broadcastToTabs({ action: 'last_folder_changed', folderId: request.folderId });
        await updateContextMenus(storage); // Rebuild context menus to reflect the new "current" folder.
        return { success: true };
    }
    return { success: false, error: 'No folderId provided.' };
}

async function handleGetUiPreferences(request, sender) {
    const data = await storage.get();
    const globalPrefs = data.settings.ui_preferences.global;

    let domain = null;
    if (sender.origin && (sender.origin.startsWith('http:') || sender.origin.startsWith('https:'))) {
        try {
            domain = new URL(sender.origin).hostname;
        } catch (e) { /* Invalid origin, ignore. */ }
    }

    if (domain) {
        const domainPrefs = data.settings.ui_preferences.domains[domain] || {};
        return { success: true, preferences: { ...globalPrefs, ...domainPrefs } };
    }
    return { success: true, preferences: globalPrefs };
}

async function handleSetUiPreferences(request, sender) {
    const data = await storage.get();
    const newPreferences = request.preferences;

    let domain = null;
    if (sender.origin && (sender.origin.startsWith('http:') || sender.origin.startsWith('https:'))) {
        try {
            domain = new URL(sender.origin).hostname;
        } catch (e) { /* Invalid origin, ignore. */ }
    }

    if (domain) {
        const existingDomainPrefs = data.settings.ui_preferences.domains[domain] || {};
        data.settings.ui_preferences.domains[domain] = { ...existingDomainPrefs, ...newPreferences };
    } else {
        data.settings.ui_preferences.global = { ...data.settings.ui_preferences.global, ...newPreferences };
    }

    await storage.set(data);
    // Broadcast the change, but also include the domain it applies to.
    // This allows other tabs to ignore UI changes that aren't for them.
    broadcastToTabs({
        action: 'preferences_changed', preferences: newPreferences, domain: domain
    });
    return { success: true };
}

async function handleCreateFolder(request) {
    if (!request.folderId || !request.folderId.trim()) {
        return { success: false, error: 'Folder name cannot be empty.' };
    }
    const data = await storage.get();
    if (data.folders[request.folderId]) {
        return { success: false, error: 'A folder with that name already exists.' };
    }
    data.folderOrder.push(request.folderId);
    data.folders[request.folderId] = { playlist: [] };
    await storage.set(data);
    await updateContextMenus(storage);
    broadcastToTabs({ foldersChanged: true });
    debouncedSyncToNativeHostFile();
    return { success: true, message: `Folder "${request.folderId}" created.` };
}

async function handleGetAllFolderIds() {
    const data = await storage.get();
    const folderIds = data.folderOrder || Object.keys(data.folders);
    const lastUsedFolderId = data.settings.last_used_folder_id;
    return { success: true, folderIds, lastUsedFolderId };
}

async function handleRemoveFolder(request) {
    const folderIdToRemove = request.folderId;
    if (!folderIdToRemove) return { success: false, error: 'Invalid folder ID provided.' };

    const data = await storage.get();
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
    await storage.set(data);

    await updateContextMenus(storage);
    broadcastToTabs({ foldersChanged: true });
    debouncedSyncToNativeHostFile();
    return { success: true, message: `Folder "${folderIdToRemove}" removed.` };
}

async function handleRenameFolder(request) {
    const { oldFolderId, newFolderId } = request;
    if (!oldFolderId || !newFolderId || !newFolderId.trim()) {
        return { success: false, error: 'Invalid folder names provided.' };
    }
    const data = await storage.get();
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

    await storage.set(data);
    await updateContextMenus(storage);
    broadcastToTabs({ foldersChanged: true });
    debouncedSyncToNativeHostFile();
    return { success: true, message: `Folder renamed to "${newFolderId}".` };
}

async function handleSetFolderOrder(request) {
    const newOrder = request.order;
    if (!Array.isArray(newOrder)) {
        return { success: false, error: 'Invalid order data provided.' };
    }
    const data = await storage.get();
    const currentKeys = new Set(Object.keys(data.folders));
    const newKeys = new Set(newOrder);
    if (currentKeys.size !== newKeys.size || ![...currentKeys].every(k => newKeys.has(k))) {
        return { success: false, error: 'New order does not match existing folders.' };
    }

    data.folderOrder = newOrder;
    await storage.set(data);
    debouncedSyncToNativeHostFile();
    return { success: true, message: 'Folder order updated.' };
}

async function handleImportFromFile(request) {
    const filename = request.filename;
    if (!filename) {
        return { success: false, error: 'No filename provided.' };
    }

    const response = await callNativeHost({ action: 'import_from_file', filename });

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
        const localData = await storage.get();
        let newFolderId = baseFolderName;
        let counter = 1;
        while (localData.folders[newFolderId]) {
            newFolderId = `${baseFolderName} (${counter})`;
            counter++;
        }

        // Create the new folder with the combined playlist.
        localData.folders[newFolderId] = { playlist: combinedPlaylist };
        localData.folderOrder.push(newFolderId);
        await storage.set(localData);

        // Update UI and sync data to the native host's file
        await updateContextMenus(storage);
        broadcastToTabs({ foldersChanged: true });
        debouncedSyncToNativeHostFile();
        return { success: true, message: `Imported '${filename}' as new folder '${newFolderId}' with ${combinedPlaylist.length} URL(s).` };
    } catch (e) {
        return { success: false, error: `Failed to parse or process import file: ${e.message}` };
    }
}

async function handleIsMpvRunning(request) {
    return callNativeHost({ action: 'is_mpv_running' });
}

async function handleExportFolderPlaylist(request) {
    if (!request.filename || !request.folderId) return { success: false, error: 'Missing filename or folderId.' };
    const data = await storage.get();
    const folder = data.folders[request.folderId];
    // Extract just the URLs for the export file.
    const urlPlaylist = folder?.playlist?.map(item => item.url) || [];
    if (!folder || !urlPlaylist.length) return { success: false, error: `Folder '${request.folderId}' not found or is empty.` };
    return callNativeHost({ action: 'export_playlists', data: urlPlaylist, filename: request.filename });
}

async function handleGetAnilistReleases(request) {
    // All caching logic is now handled by the native host.
    const forceRefresh = request.force ?? false;

    // Check preferences to see if the user has disabled the cache.
    // Fetch preferences directly from storage instead of sending a message to itself.
    const data = await storage.get();
    const isCacheDisabled = data.settings.ui_preferences.global.disable_anilist_cache ?? false;

    // If the cache is disabled, we instruct the native host to delete the cache file.
    // This ensures no stale data is ever used when this setting is on.
    const deleteCache = isCacheDisabled;

    const nativeResponse = await callNativeHost({
        action: 'get_anilist_releases',
        force: forceRefresh || isCacheDisabled, // Also force a refresh if cache is disabled.
        delete_cache: deleteCache,
        is_cache_disabled: isCacheDisabled // New flag to prevent writing to cache
    });

    if (nativeResponse.success && nativeResponse.output) {
        try {
            // The native host now returns a JSON string, so we parse it here before sending to the UI.
            const data = JSON.parse(nativeResponse.output);
            return { success: true, output: data };
        } catch (e) {
            return { success: false, error: `Failed to parse JSON response from native host: ${e.message}` };
        }
    }
    // Forward any errors from the native host.
    return nativeResponse;
}

async function handleYtdlpUpdateCheck(request) {
    // This is triggered by the native host when it detects a playback failure.
    // First, log the message it sent.
    if (request.log) {
        broadcastLog(request.log);
    }

    // Find the tab that originated the MPV command to show the confirmation there.
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = activeTab?.id;

    const data = await storage.get();
    const updateBehavior = data.settings.ui_preferences.global.ytdlp_update_behavior || 'manual';

    if (updateBehavior === 'manual') {
        broadcastLog({ text: `[Background]: yt-dlp update behavior is set to 'manual'. No action taken.`, type: 'info' });
        return { success: true, message: 'Manual update mode. No action taken.' };
    }

    if (updateBehavior === 'ask') {
        if (!tabId) {
            return { success: false, error: 'Could not find an active tab to show confirmation.' };
        }
        // Ask the content script to show a confirmation. The content script will then send a message back.
        // We use a page-level confirmation that doesn't depend on the controller UI.
        chrome.tabs.sendMessage(tabId, { action: 'ytdlp_update_confirm' })
            .catch(err => broadcastLog({ text: `[Background]: Could not send update confirmation to tab ${tabId}. Error: ${err.message}`, type: 'error' }));
        return { success: true, message: 'Confirmation requested from user.' };
    }
    if (updateBehavior === 'auto') {
        // If the setting is enabled, tell the native host to proceed with the update.
        return callNativeHost({ action: 'run_ytdlp_update' });
    }
}

async function handleGetDependencyStatus() {
    const data = await storage.get();
    return { success: true, status: data.settings.ui_preferences.global.dependencyStatus };
}

// --- Action Handler Map ---
// This map centralizes all message actions to their corresponding handler functions.
const actionHandlers = {
    // UI State
    'content_script_init': handleContentScriptInit,
    'get_ui_state_for_tab': handleGetUiStateForTab,
    'report_detected_url': handleReportDetectedUrl,
    'set_last_folder_id': handleSetLastFolderId,
    'get_last_folder_id': async () => {
        const data = await storage.get();
        const folderId = data.settings.last_used_folder_id || Object.keys(data.folders)[0];
        return { success: true, folderId };
    },
    'get_default_automatic_flags': async () => {
        const defaultData = storage._getDefaultData();
        return { success: true, flags: defaultData.settings.ui_preferences.global.automatic_mpv_flags };
    },
    'get_ui_preferences': handleGetUiPreferences,
    'set_ui_preferences': handleSetUiPreferences,
    'set_minimized_state': async (request) => {
        const { minimized } = request;
        if (typeof minimized !== 'boolean') {
            return { success: false, error: 'Invalid minimized state provided.' };
        }
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!activeTab || !activeTab.id) {
            return { success: false, error: 'Could not find an active tab.' };
        }
        try {
            await chrome.tabs.sendMessage(activeTab.id, { action: 'set_minimized_state', minimized });
            return { success: true };
        } catch (error) {
            return { success: false, error: 'Controller not available on this page.' };
        }
    },
    // Folder Management
    'create_folder': handleCreateFolder,
    'get_all_folder_ids': handleGetAllFolderIds,
    'remove_folder': handleRemoveFolder,
    'rename_folder': handleRenameFolder,
    'set_folder_order': handleSetFolderOrder,
    // MPV and Playlist Actions
    'is_mpv_running': () => callNativeHost({ action: 'is_mpv_running' }),
    'play': async (request) => {
        const data = await storage.get();
        const globalPrefs = data.settings.ui_preferences.global;
        const playlist = data.folders[request.folderId]?.playlist;
        const urlPlaylist = playlist?.map(item => item.url) || [];
        if (!urlPlaylist.length) {
            return { success: false, error: `Playlist in folder '${request.folderId}' is empty.` };
        }
        return callNativeHost({
            action: 'play', folderId: request.folderId, playlist: urlPlaylist,
            geometry: globalPrefs.launch_geometry === 'custom' ? null : globalPrefs.launch_geometry,
            custom_width: globalPrefs.launch_geometry === 'custom' ? globalPrefs.custom_geometry_width : null,
            custom_height: globalPrefs.launch_geometry === 'custom' ? globalPrefs.custom_geometry_height : null,
            custom_mpv_flags: globalPrefs.custom_mpv_flags || '',
            automatic_mpv_flags: globalPrefs.automatic_mpv_flags || [],
            clear_on_completion: globalPrefs.clear_on_completion ?? false
        });
    },
    'play_new_instance': async (request) => {
        const data = await storage.get();
        const globalPrefs = data.settings.ui_preferences.global;
        const playlist = data.folders[request.folderId]?.playlist;
        const urlPlaylist = playlist?.map(item => item.url) || [];
        if (!urlPlaylist.length) {
            return { success: false, error: `Playlist in folder '${request.folderId}' is empty.` };
        }
        return callNativeHost({
            action: 'play_new_instance', playlist: urlPlaylist,
            geometry: globalPrefs.launch_geometry === 'custom' ? null : globalPrefs.launch_geometry,
            custom_width: globalPrefs.launch_geometry === 'custom' ? globalPrefs.custom_geometry_width : null,
            custom_height: globalPrefs.launch_geometry === 'custom' ? globalPrefs.custom_geometry_height : null,
            automatic_mpv_flags: globalPrefs.automatic_mpv_flags || [],
            custom_mpv_flags: globalPrefs.custom_mpv_flags || ''
        });
    },
    'close_mpv': () => callNativeHost({ action: 'close_mpv' }),
    'add': playlistManager.handleAdd,
    'get_playlist': playlistManager.handleGetPlaylist,
    'clear': playlistManager.handleClear,
    'remove_item': playlistManager.handleRemoveItem,
    'set_playlist_order': playlistManager.handleSetPlaylistOrder,
    // Import/Export
    'export_all_playlists_separately': async () => {
        const data = await storage.get();
        return callNativeHost({ action: 'export_all_playlists_separately', data: data.folders });
    },
    'export_folder_playlist': handleExportFolderPlaylist,
    'import_from_file': handleImportFromFile,
    'list_import_files': () => callNativeHost({ action: 'list_import_files' }),
    'open_export_folder': () => callNativeHost({ action: 'open_export_folder' }),
    'get_anilist_releases': handleGetAnilistReleases,
    // Special case from scanner
    'ytdlp_update_check': handleYtdlpUpdateCheck,
    'user_confirmed_ytdlp_update': () => {
        broadcastLog({ text: `[Background]: User confirmed. Starting yt-dlp update...`, type: 'info' });
        return callNativeHost({ action: 'run_ytdlp_update' });
    },
    'manual_ytdlp_update': () => {
        broadcastLog({ text: `[Background]: Manual yt-dlp update triggered from settings.`, type: 'info' });
        return callNativeHost({ action: 'run_ytdlp_update' });
    },
    'get_dependency_status': handleGetDependencyStatus,

    'log_from_scanner': (request) => {
        broadcastLog(request.log);
        // This action doesn't need to send a response back to the scanner.
    },
    'force_reload_settings': () => {
        // Broadcast an empty preferences object. This triggers the 'else' block in content.js
        // which calls applyInitialState(), effectively reloading all settings from storage.
        broadcastToTabs({ action: 'preferences_changed', preferences: {} });
        return { success: true };
    },
    'open_popup': async (request, sender) => {
        broadcastLog({ text: `[Background]: Attempting to open popup...`, type: 'info' });
        if (chrome.action && chrome.action.openPopup) {
            try {
                await chrome.action.openPopup({ windowId: sender.tab.windowId });
                return { success: true };
            } catch (e) {
                return { success: false, error: e.message };
            }
        }
        return { success: false, error: 'chrome.action.openPopup is not supported in this browser version.' };
    }
};

// Add a simple heartbeat handler that does nothing but respond.
// This allows content scripts to check if the background script is alive.
actionHandlers['heartbeat'] = () => ({ success: true });

// New handler for the unsolicited 'session_restored' message from the native host
actionHandlers['session_restored'] = (request) => {
    if (request.result?.was_stale) {
        broadcastLog({ text: `[Background]: Detected stale MPV session for folder '${request.result.folderId}'.`, type: 'info' });
        // Trigger the same cleanup logic as when MPV exits.
        handleMpvExited(request.result);
    }
};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // Filter out broadcasted log messages that aren't commands.
    if (request.log && !request.action) {
        return;
    }

    const handler = actionHandlers[request.action];

    if (handler) {
        // Use an async IIFE to handle the promise-based handler and send the response.
        (async () => {
            try {
                const response = await handler(request, sender);
                // Some handlers might not return a value (e.g., log_from_scanner).
                // Only send a response if one was returned.
                if (response !== undefined) {
                    sendResponse(response);
                }
            } catch (e) {
                console.error(`Error handling action '${request.action}':`, e);
                sendResponse({ success: false, error: e.message });
            }
        })();
        // Return true to indicate that the response will be sent asynchronously.
        return true;
    }

    // If no handler is found, send a generic error response.
    sendResponse({ success: false, error: `Unknown action: '${request.action}'` });
    return false; // No async response will be sent.
});

// --- Initial Setup ---
// On install, ensure the default 'Default' folder exists and set up context menus.
chrome.runtime.onInstalled.addListener(async () => {
    // Initialize the storage which runs all necessary migrations.
    await storage.initialize();

    await updateContextMenus(storage);
    await syncDataToNativeHostFile();
    await _checkDependenciesAndStore();
    console.log("MPV Handler extension installed and initialized.");
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    const { menuItemId, linkUrl, srcUrl, pageUrl } = info;
    const urlToAdd = linkUrl || srcUrl || pageUrl;
    if (!urlToAdd) return;

    const getFolderId = async () => {
        if (menuItemId.startsWith('add-to-folder-')) return menuItemId.substring('add-to-folder-'.length);
        if (menuItemId.startsWith('add-playlist-to-folder-')) return menuItemId.substring('add-playlist-to-folder-'.length);
        if (menuItemId === 'add-to-last-used-folder') {
            const data = await storage.get();
            return data.settings.last_used_folder_id;
        }
        if (menuItemId === 'one-click-add-to-last-used-folder') return (await storage.get()).settings.last_used_folder_id;
        return null;
    };

    const folderId = await getFolderId();
    if (!folderId) return;

    // The context menu now uses the exact same centralized handler as the on-page button.
    playlistManager.handleAddFromContextMenu(folderId, urlToAdd, null, tab);
});

// --- M3U8 Stream Detection ---

// A simple in-memory cache to avoid sending the same URL repeatedly to a tab.
// The key is the tabId, and the value is the last detected URL.
const lastDetectedUrls = {};
// A map to hold promises for M3U8 detection in temporary tabs.
// The key is the tabId, and the value is { resolve, reject }.
let m3u8DetectionPromises = {};

/**
 * Creates a new popup window for the user to interact with to trigger stream detection.
 * @param {string} url The URL to open in the new window.
 * @returns {Promise<chrome.tabs.Tab>} A promise that resolves with the tab object of the new window.
 */
async function _createScannerWindow(url) {
    let finalUrl = url;
    try {
        // Add a parameter to the URL to identify it as a scanner window.
        // This prevents the content script from injecting the UI into it.
        const scannerUrl = new URL(url);
        scannerUrl.searchParams.set('mpv_playlist_scanner', 'true');
        finalUrl = scannerUrl.toString();
    } catch (e) {
        // If URL parsing fails, use the original URL. This is a fallback.
        console.warn(`Could not parse URL to add scanner parameter: ${url}`);
    }

    const newWindow = await chrome.windows.create({
        url: finalUrl,
        type: 'popup',
        width: 1024,
        height: 768,
    });

    if (!newWindow?.tabs?.length) {
        throw new Error("Failed to create scanner window.");
    }

    broadcastLog({
        text: `[Scanner]: A scanner window has been opened. Please manually start the video in that window to capture the stream.`,
        type: 'info'
    });

    return newWindow.tabs[0];
}

/**
 * Waits for the webRequest listener to detect an M3U8 stream in a specific tab.
 * @param {number} tabId The ID of the tab to listen on.
 * @param {number} timeoutInSeconds The number of seconds to wait before timing out.
 * @returns {Promise<string>} A promise that resolves with the detected M3U8 URL.
 */
async function _waitForM3u8Detection(tabId, timeoutInSeconds) {
    return new Promise((resolve, reject) => {
        const timeoutDuration = timeoutInSeconds * 1000;

        const timeoutId = setTimeout(() => {
            if (m3u8DetectionPromises[tabId]) {
                delete m3u8DetectionPromises[tabId];
                reject(new Error(`M3U8 detection timed out. User did not initiate video playback within ${timeoutInSeconds} seconds.`));
            }
        }, timeoutDuration);

        // Store the promise's handlers so the webRequest listener can use them.
        m3u8DetectionPromises[tabId] = {
            resolve: (url) => {
                clearTimeout(timeoutId);
                delete m3u8DetectionPromises[tabId];
                resolve(url);
            },
            reject: (err) => {
                clearTimeout(timeoutId);
                delete m3u8DetectionPromises[tabId];
                reject(err);
            },
            timeoutId: timeoutId // Store the initial timeout ID
        };
    });
}

/**
 * Switches focus back to the user's original tab and window after scanning is complete.
 * @param {chrome.tabs.Tab} originalTab The tab object to return focus to.
 */
async function _focusOriginalTab(originalTab) {
    if (!originalTab) return;
    if (originalTab.windowId) {
        await chrome.windows.update(originalTab.windowId, { focused: true }).catch(() => {});
    }
    if (originalTab.id) {
        await chrome.tabs.update(originalTab.id, { active: true }).catch(() => {});
    }
}

/**
 * Opens a URL in a hidden tab to find an M3U8 stream URL.
 * @param {string} url The page URL to scan.
 * @returns {Promise<{url: string, title: string, scannerTab: chrome.tabs.Tab}>} A promise that resolves with the detected URL, title, and the scanner tab.
 */
async function findM3u8InUrl(url, originalTab) {
    let newWindow;
    let scannerTab; // The tab inside the new window

    try {
        const data = await storage.get();
        const timeoutInSeconds = data.settings.ui_preferences.global.stream_scanner_timeout || 60;

        scannerTab = await _createScannerWindow(url);

        await new Promise((resolve) => {
            const listener = (tabId, changeInfo) => {
                if (tabId === scannerTab.id && changeInfo.status === 'complete') {
                    chrome.tabs.onUpdated.removeListener(listener);
                    resolve();
                }
            };
            chrome.tabs.onUpdated.addListener(listener);
        });

        const streamPromise = _waitForM3u8Detection(scannerTab.id, timeoutInSeconds);
        const titlePromise = chrome.tabs.sendMessage(scannerTab.id, { action: 'scrape_and_get_details' })
            .catch(() => ({ title: url, url: url }));

        // Wait for both promises. If the stream detection fails (e.g., timeout or window closed),
        // the streamPromise will reject, and we'll catch it, setting detectedStreamUrl to null.
        let detectedStreamUrl = null;
        let scrapedDetails = { title: url, url: url };
        try {
            [detectedStreamUrl, scrapedDetails] = await Promise.all([streamPromise, titlePromise]);
        } catch (error) {
            // This block will be entered if the stream detection times out or the tab is closed.
            // We only need the title, so we'll still wait for that promise to resolve.
            scrapedDetails = await titlePromise;
        }

        const finalUrl = detectedStreamUrl; // This is the critical change. Only use the detected stream.
        const finalTitle = scrapedDetails.title;

        return { url: finalUrl, title: finalTitle, scannerTab: scannerTab, originalUrl: url };

    } finally {
        await _focusOriginalTab(originalTab);
    }
}

chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
        // --- NEW: Inactivity timeout logic for scanner windows ---
        const promiseInfo = m3u8DetectionPromises[details.tabId];
        if (promiseInfo) {
            const INACTIVITY_TIMEOUT_MS = 15000; // 15 seconds of inactivity
            clearTimeout(promiseInfo.timeoutId); // Clear the previous timeout

            // Set a new inactivity timeout
            promiseInfo.timeoutId = setTimeout(() => {
                // Check if the promise is still pending before rejecting
                if (m3u8DetectionPromises[details.tabId]) {
                    // Use the reject function from the promise which will also clean up the map entry
                    m3u8DetectionPromises[details.tabId].reject(new Error(`M3U8 detection timed out after ${INACTIVITY_TIMEOUT_MS / 1000} seconds of network inactivity.`));
                }
            }, INACTIVITY_TIMEOUT_MS);
        }
        // --- END of new logic ---

        // Optimization: Ignore requests originating from our own extension to prevent loops.
        if (details.initiator && details.initiator.startsWith(`chrome-extension://${chrome.runtime.id}`)) {
            return;
        }

        // Check if the URL's path ends with .m3u8.
        try {
            const url = new URL(details.url);
            if (!url.pathname.endsWith('.m3u8')) return;
        } catch (e) {
            return; // Invalid URL, ignore.
        }

        // Avoid sending the same URL repeatedly for the same tab.
        if (lastDetectedUrls[details.tabId] === details.url) {
            return;
        }
        lastDetectedUrls[details.tabId] = details.url;

        // NEW: Update state immediately and notify popup
        if (!tabUiState[details.tabId]) tabUiState[details.tabId] = {};
        tabUiState[details.tabId].detectedUrl = details.url;
        chrome.runtime.sendMessage({ action: 'detected_url_changed', tabId: details.tabId, url: details.url }).catch(() => {});

        // Check if a scanner window is waiting for this URL.
        // Re-use promiseInfo from the inactivity check
        if (promiseInfo) {
            promiseInfo.resolve(details.url);
            return;
        }

        // Send the detected URL to the content script of the tab where the request originated.
        chrome.tabs.sendMessage(details.tabId, { m3u8: details.url })
            .catch(error => {
                if (!error.message.includes('Receiving end does not exist')) {
                    console.error(`[Background]: Error sending M3U8 URL to tab ${details.tabId}:`, error);
                }
            });
    },
    {
        urls: ["<all_urls>"],
        types: ["xmlhttprequest", "other", "media", "main_frame"] // Listen on more types for broader compatibility
    }
);

// Clean up the cache when a tab is closed to prevent memory leaks.
chrome.tabs.onRemoved.addListener((tabId) => {
    if (tabUiState[tabId]) {
        delete tabUiState[tabId];
    }
    // If a tab with a pending detection is closed, reject the promise.
    if (m3u8DetectionPromises[tabId]) {
        m3u8DetectionPromises[tabId].reject(new Error('Tab was closed before M3U8 detection completed.'));
    }
    if (lastDetectedUrls[tabId]) {
        delete lastDetectedUrls[tabId];
    }
});

// When a tab is reloaded or navigates to a new page, clear its cached M3U8 URL.
// This ensures that if the same stream is present on the new page, it will be detected again.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'loading') {
        // A new page is loading, so reset the stream detection caches for this tab.
        // The minimized state is intentionally NOT cleared to make it persistent.
        if (lastDetectedUrls[tabId]) delete lastDetectedUrls[tabId];
        if (tabUiState[tabId]) tabUiState[tabId].detectedUrl = null;
    }
});
