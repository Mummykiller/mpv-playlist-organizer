// --- Module Imports ---
import { StorageManager } from './utils/storageManager.js';
import { callNativeHost, injectDependencies as injectNativeConnectionDependencies } from './utils/nativeConnection.js';
import { updateContextMenus } from './utils/contextMenu.js';
import * as playlistManager from './utils/playlistManager.js';

import * as ui_state_handlers from './background/handlers/ui_state.js';
import * as m3u8_scanner_handlers from './background/handlers/m3u8_scanner.js';
import * as playback_handlers from './background/handlers/playback.js';
import * as folder_management_handlers from './background/handlers/folder_management.js';
import * as import_export_handlers from './background/handlers/import_export.js';
import * as dependency_anilist_handlers from './background/handlers/dependency_anilist.js';

// --- Shared State ---
let tabUiState = {}; // Tracks the UI state for each tab (e.g., minimized status, detected URL for content script)

// --- Utility Functions ---
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

// --- Messaging Helpers ---
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

// --- Unified Storage Model ---
const storage = new StorageManager('mpv_organizer_data', broadcastLog);

// --- Native Host Communication Helpers ---
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

/**
 * Resyncs the browser extension's storage from the native host's folders.json file.
 * This is crucial when the native host has modified folders.json directly.
 */
async function resyncDataFromNativeHostFile() {
    try {
        broadcastLog({ text: `[Background]: Requesting folders data from native host...`, type: 'info' });
        const response = await callNativeHost({ action: 'get_all_folders' });
        if (response.success) {
            const data = await storage.get(); // Get current browser storage
            const oldFolders = JSON.stringify(data.folders); // Stringify for comparison
            data.folders = response.folders; // Update folders with data from native host
            await storage.set(data); // Persist updated data to browser storage
            broadcastLog({ text: `[Background]: Successfully resynced folders from native host.`, type: 'info' });
            
            // Only broadcast 'foldersChanged' if actual folder data has changed to prevent unnecessary UI refreshes.
            if (oldFolders !== JSON.stringify(data.folders)) {
                broadcastToTabs({ foldersChanged: true }); // Notify UI to refresh
            }
        } else {
            const errorMessage = `Failed to resync folders from native host: ${response.error || 'Unknown error'}`;
            console.error(errorMessage);
            broadcastLog({ text: `[Background]: ${errorMessage}`, type: 'error' });
        }
    } catch (e) {
        const errorMessage = `Error during resync from native host: ${e.message}`;
        console.error(errorMessage);
        broadcastLog({ text: `[Background]: ${errorMessage}`, type: 'error' });
    }
}

// --- Initialize all handlers with shared dependencies ---
// Dependencies injected here are defined above this point.

injectNativeConnectionDependencies({ broadcastLog, handleMpvExited: playback_handlers.handleMpvExited });

playlistManager.injectDependencies({
    storage,
    broadcastToTabs,
    broadcastLog,
    debouncedSyncToNativeHostFile,
    sendMessageAsync,
    findM3u8InUrl: m3u8_scanner_handlers.findM3u8InUrl,
    callNativeHost,
    MPV_PLAYLIST_COMPLETED_EXIT_CODE: playback_handlers.getMpvPlaylistCompletedExitCode()
});

ui_state_handlers.init({
    storage,
    broadcastToTabs,
    broadcastLog,
    callNativeHost,
    updateContextMenus,
    tabUiState, // Pass the shared state
    m3u8_scanner_handlers // Pass m3u8_scanner_handlers
});

m3u8_scanner_handlers.init({
    storage,
    broadcastLog,
    broadcastToTabs,
});

playback_handlers.init({
    storage,
    broadcastLog,
    broadcastToTabs,
    callNativeHost,
    resyncDataFromNativeHostFile,
    debouncedSyncToNativeHostFile,
});

folder_management_handlers.init({
    storage,
    broadcastToTabs,
    updateContextMenus,
    debouncedSyncToNativeHostFile,
});

import_export_handlers.init({
    storage,
    broadcastToTabs,
    callNativeHost,
    updateContextMenus,
    debouncedSyncToNativeHostFile,
});

dependency_anilist_handlers.init({
    storage,
    broadcastLog,
    broadcastToTabs,
    callNativeHost,
});


// --- Main Message Listener ---
// This map centralizes all message actions to their corresponding handler functions.
const actionHandlers = {
    // UI State
    'content_script_init': ui_state_handlers.handleContentScriptInit,
    'get_ui_state_for_tab': ui_state_handlers.handleGetUiStateForTab,
    'report_detected_url': ui_state_handlers.handleReportDetectedUrl,
    'set_last_folder_id': ui_state_handlers.handleSetLastFolderId,
    'get_last_folder_id': async () => {
        const data = await storage.get();
        const folderId = data.settings.last_used_folder_id || Object.keys(data.folders)[0];
        return { success: true, folderId };
    },
    'get_default_automatic_flags': ui_state_handlers.handleGetDefaultAutomaticFlags,
    'get_ui_preferences': ui_state_handlers.handleGetUiPreferences,
    'set_ui_preferences': ui_state_handlers.handleSetUiPreferences,
    'set_minimized_state': ui_state_handlers.handleSetMinimizedState,
    'force_reload_settings': ui_state_handlers.handleForceReloadSettings,
    'open_popup': ui_state_handlers.handleOpenPopup,
    'heartbeat': ui_state_handlers.handleHeartbeat,
    // Folder Management
    'create_folder': folder_management_handlers.handleCreateFolder,
    'get_all_folder_ids': folder_management_handlers.handleGetAllFolderIds,
    'remove_folder': folder_management_handlers.handleRemoveFolder,
    'rename_folder': folder_management_handlers.handleRenameFolder,
    'set_folder_order': folder_management_handlers.handleSetFolderOrder,
    // MPV and Playlist Actions
    'is_mpv_running': playback_handlers.handleIsMpvRunning,
    'play': playback_handlers.handlePlay, // This now delegates to handlePlayM3U internally
    'play_m3u': playback_handlers.handlePlayM3U, // New action for direct M3U playback
    'append': playback_handlers.handleAppend,
    'close_mpv': playback_handlers.handleCloseMpv,
    'add': playlistManager.handleAdd,
    'get_playlist': playlistManager.handleGetPlaylist,
    'clear': playlistManager.handleClear,
    'remove_item': playlistManager.handleRemoveItem,
    'set_playlist_order': playlistManager.handleSetPlaylistOrder,
    // Import/Export
    'export_all_playlists_separately': import_export_handlers.handleExportAllPlaylistsSeparately,
    'export_folder_playlist': import_export_handlers.handleExportFolderPlaylist,
    'import_from_file': import_export_handlers.handleImportFromFile,
    'list_import_files': import_export_handlers.handleListImportFiles,
    'open_export_folder': import_export_handlers.handleOpenExportFolder,
    'get_anilist_releases': dependency_anilist_handlers.handleGetAnilistReleases,
    'ytdlp_update_check': dependency_anilist_handlers.handleYtdlpUpdateCheck,
    'user_confirmed_ytdlp_update': dependency_anilist_handlers.handleUserConfirmedYtdlpUpdate,
    'manual_ytdlp_update': dependency_anilist_handlers.handleManualYtdlpUpdate,
    'get_dependency_status': dependency_anilist_handlers.handleGetDependencyStatus,

    'log_from_scanner': m3u8_scanner_handlers.handleLogFromScanner,
};

// New handler for the unsolicited 'session_restored' message from the native host
actionHandlers['session_restored'] = playback_handlers.handleSessionRestored;

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