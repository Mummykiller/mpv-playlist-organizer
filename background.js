// --- Module Imports ---
import { debounce, sendMessageAsync } from './utils/commUtils.module.js';
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
let nativeHostStatus = { status: 'unknown', lastCheck: 0, info: null };
let popupPort = null; // Port for communication with the open popup

chrome.runtime.onConnect.addListener((port) => {
    if (port.name === "popup-lifecycle") {
        popupPort = port;
        port.onDisconnect.addListener(() => {
            popupPort = null;
        });
    }
});

// --- Messaging Helpers ---
/**
 * Broadcasts a message to all content scripts in open tabs.
 * @param {object} message - The message object to send.
 */
function broadcastToTabs(message) {
    // Send to other extension contexts (like the popup).
    chrome.runtime.sendMessage(message).catch(() => {});

    // Optimized: Only query tabs that we can actually script (http/https)
    // to reduce console noise and IPC overhead for restricted pages.
    chrome.tabs.query({ url: ["http://*/*", "https://*/*"] }, (tabs) => {
        for (const tab of tabs) {
            try {
                // Attempt to send the message, but ignore errors if the content script isn't injected.
                chrome.tabs.sendMessage(tab.id, message).catch(() => {});
            } catch (e) {
                // Silently ignore failures for inactive or restricted tabs.
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
 * Gathers folder data from chrome.storage.local and sends it to the
 * native host to be written to the folders.json file. This keeps the
 * CLI and the extension in sync.
 * @param {string} [folderId] - Optional: If provided, only sync this specific folder.
 */
const _syncToNativeHostFile = async (folderId = null) => {
    const data = await storage.get();
    try {
        const payload = {
            action: 'export_data',
        };

        if (folderId && data.folders[folderId]) {
            // Incremental sync: only send the changed folder
            payload.data = { [folderId]: data.folders[folderId] };
            payload.is_incremental = true;
        } else {
            // Full sync
            payload.data = data.folders;
            payload.is_incremental = false;
        }

        await callNativeHost(payload);
    } catch (e) {
        const errorMessage = `Failed to sync data to native host file: ${e.message}`;
        console.error(`[BG] ${errorMessage}`);
        broadcastLog({ text: `[Background]: ${errorMessage}`, type: 'error' });
    }
};

// Debounce the sync function to avoid rapid-fire writes to the native host.
// In MV3, we use chrome.alarms to ensure the sync happens even if the worker unloads.
const debouncedSyncToNativeHostFile = (folderId = null, immediate = false) => {
    if (immediate) {
        _syncToNativeHostFile(folderId);
        chrome.alarms.clear('sync-to-native-host');
    } else {
        // We still use a single alarm for simplicity, but we could 
        // queue folderIds if needed. For now, a full sync on alarm is fine.
        chrome.alarms.create('sync-to-native-host', { delayInMinutes: 1 });
    }
};

// --- Initialize all handlers with shared dependencies ---
// Dependencies injected here are defined above this point.

injectNativeConnectionDependencies({ 
    broadcastLog, 
    handleMpvExited: playback_handlers.handleMpvExited,
    handleUpdateLastPlayed: playback_handlers.handleUpdateLastPlayed,
    handleUpdateItemResumeTime: playback_handlers.handleUpdateItemResumeTime,
    handleSessionRestored: playback_handlers.handleSessionRestored
});

playlistManager.injectDependencies({
    storage,
    broadcastToTabs,
    broadcastLog,
    debouncedSyncToNativeHostFile,
    sendMessageAsync,
    findM3u8InUrl: m3u8_scanner_handlers.findM3u8InUrl,
    callNativeHost,
    isFolderActive: playback_handlers.isFolderActive,
    MPV_PLAYLIST_COMPLETED_EXIT_CODE: playback_handlers.getMpvPlaylistCompletedExitCode()
});

ui_state_handlers.init({
    storage,
    broadcastToTabs,
    broadcastLog,
    callNativeHost,
    updateContextMenus,
    tabUiState, // Pass the shared state
    m3u8_scanner_handlers, // Pass m3u8_scanner_handlers
    playback_handlers,
    getPopupPort: () => popupPort
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
    'switch_playlist': ui_state_handlers.handleSwitchPlaylist,
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
    'force_refresh_dependencies': ui_state_handlers.handleForceRefreshDependencies,
    'open_popup': ui_state_handlers.handleOpenPopup,
    'heartbeat': ui_state_handlers.handleHeartbeat,
    'get_native_host_status': () => ({ success: true, ...nativeHostStatus }),
    // Folder Management
    'create_folder': folder_management_handlers.handleCreateFolder,
    'get_all_folder_ids': folder_management_handlers.handleGetAllFolderIds,
    'remove_folder': folder_management_handlers.handleRemoveFolder,
    'rename_folder': folder_management_handlers.handleRenameFolder,
    'set_folder_order': folder_management_handlers.handleSetFolderOrder,
    // MPV and Playlist Actions
    'is_mpv_running': playback_handlers.handleIsMpvRunning,
    'update_item_resume_time': playback_handlers.handleUpdateItemResumeTime,
    'play': playback_handlers.handlePlay, // This now delegates to handlePlayM3U internally
    'play_m3u': playback_handlers.handlePlayM3U, // New action for direct M3U playback
    'append': playback_handlers.handleAppend,
    'confirm_clear_playlist': playback_handlers.handleClearPlaylistConfirmation,
    'close_mpv': playback_handlers.handleCloseMpv,
    'add': playlistManager.handleAdd,
    'get_playlist': playlistManager.handleGetPlaylist,
    'clear': playlistManager.handleClear,
    'remove_item': playlistManager.handleRemoveItem,
    'set_playlist_order': playlistManager.handleSetPlaylistOrder,
    // Import/Export
    'export_all_playlists_separately': import_export_handlers.handleExportAllPlaylistsSeparately,
    'export_folder_playlist': import_export_handlers.handleExportFolderPlaylist,
    'export_settings': import_export_handlers.handleExportSettings,
    'import_from_file': import_export_handlers.handleImportFromFile,
    'list_import_files': import_export_handlers.handleListImportFiles,
    'open_export_folder': import_export_handlers.handleOpenExportFolder,
    'get_anilist_releases': dependency_anilist_handlers.handleGetAnilistReleases,
    'ytdlp_update_check': dependency_anilist_handlers.handleYtdlpUpdateCheck,
    'user_confirmed_ytdlp_update': dependency_anilist_handlers.handleUserConfirmedYtdlpUpdate,
    'manual_ytdlp_update': dependency_anilist_handlers.handleManualYtdlpUpdate,
};

// New handler for the unsolicited 'session_restored' message from the native host
actionHandlers['session_restored'] = playback_handlers.handleSessionRestored;

/**
 * Periodically pings the native host to verify it's still alive and responding.
 */
async function performNativeHostHeartbeat() {
    try {
        const response = await callNativeHost({ action: 'ping' });
        if (response?.success) {
            nativeHostStatus = {
                status: 'online',
                lastCheck: Date.now(),
                info: {
                    python: response.python_version,
                    platform: response.platform
                }
            };
        } else {
            nativeHostStatus.status = 'error';
            nativeHostStatus.lastCheck = Date.now();
        }
    } catch (e) {
        nativeHostStatus.status = 'offline';
        nativeHostStatus.lastCheck = Date.now();
    }
}

function startNativeHostHeartbeat() {
    // Initial check
    performNativeHostHeartbeat();
    
    // Create an alarm for persistent checking (30 mins is standard for heartbeats in MV3)
    // We use a shorter interval (5 mins) as per the original intention
    chrome.alarms.create('native-host-heartbeat', {
        periodInMinutes: 5 
    });
}

startNativeHostHeartbeat();

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
                // Only send a response if one was returned.
                if (response !== undefined) {
                    sendResponse(response);
                }
            } catch (e) {
                console.error(`[BG] Error handling action '${request.action}':`, e);
                sendResponse({ success: false, error: e.message });
            }
        })();
        // Return true to indicate that the response will be sent asynchronously.
        return true;
    }

    // Do NOT send a response here. This allows other listeners (like the popup)
    // to potentially handle the message if it's not a background action.
    return false; 
});

// --- Initial Setup ---
// On install, ensure the default 'Default' folder exists and set up context menus.
chrome.runtime.onInstalled.addListener(async () => {
    // Initialize the storage which runs all necessary migrations.
    await storage.initialize();

    await updateContextMenus(storage);

    // Create a weekly alarm for storage janitor tasks
    chrome.alarms.create('periodic-storage-janitor', {
        periodInMinutes: 10080 // 7 days
    });

    console.log("[BG] MPV Handler extension installed and initialized.");
});

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'periodic-storage-janitor') {
        console.log("[BG] Running periodic storage janitor tasks...");
        storage.runJanitorTasks().catch(e => console.error("Janitor alarm failed:", e));
    } else if (alarm.name === 'native-host-heartbeat') {
        performNativeHostHeartbeat();
    } else if (alarm.name === 'sync-to-native-host') {
        _syncToNativeHostFile();
    }
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

// --- Auto-Reinjection Logic ---
/**
 * Re-injects content scripts into all open tabs.
 * This ensures the extension UI continues to work after an extension reload
 * without requiring the user to refresh their pages.
 */
async function reinjectContentScripts() {
    const manifest = chrome.runtime.getManifest();
    const jsFiles = manifest.content_scripts[0].js;
    let reinjectedCount = 0;

    try {
        const data = await storage.get();
        const restrictedDomains = data.settings.ui_preferences.global.restricted_domains || [];
        const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
        
        for (const tab of tabs) {
            // Skip restricted tabs (like chrome:// or extension pages)
            if (tab.url.startsWith("chrome://") || tab.url.startsWith("about:") || tab.url.includes("chrome.google.com/webstore")) continue;

            // --- NEW: User-defined restricted domains check ---
            try {
                const url = new URL(tab.url);
                const isRestricted = restrictedDomains.some(domain => 
                    url.hostname === domain || url.hostname.endsWith('.' + domain)
                );
                if (isRestricted) continue;
            } catch (e) { /* invalid url */ }

            try {
                // Check if the content script is already alive
                const isAlive = await chrome.tabs.sendMessage(tab.id, { action: 'ping' })
                    .then(res => res && res.success)
                    .catch(() => false);

                if (isAlive) continue;

                // Clean up any existing (dead) UI elements first
                await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    func: () => {
                        const ids = [
                            'm3u8-controller-host', 
                            'm3u8-minimized-host', 
                            'anilist-panel-host',
                            'mpv-organizer-host-styles'
                        ];
                        ids.forEach(id => document.getElementById(id)?.remove());
                        window.mpvControllerInitialized = false;
                    }
                }).catch(() => {});

                // Inject JS files sequentially
                await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    files: jsFiles
                });
                
                reinjectedCount++;
            } catch (tabErr) {
                // Ignore silent failures on restricted/unsupported pages
            }
        }
        
        if (reinjectedCount > 0) {
            console.log(`[Background]: Auto-reinjection complete for ${reinjectedCount} tabs.`);
        }
    } catch (err) {
        console.error("[Background]: Global error during auto-reinjection:", err);
    }
}


// Perform re-injection on startup/reload
reinjectContentScripts();