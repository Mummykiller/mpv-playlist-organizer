// background.js
// --- Core Module Imports ---
import { storage } from './background/storage_instance.js';
import { broadcastLog, broadcastToTabs } from './background/messaging.js';
import { debouncedSyncToNativeHostFile } from './background/core_services.js';
import { callNativeHost, addNativeListener } from './utils/nativeConnection.js';
import { updateContextMenus } from './utils/contextMenu.js';
import * as playlistManager from './utils/playlistManager.js';

// --- Handler Imports ---
import * as ui_state_handlers from './background/handlers/ui_state.js';
import * as m3u8_scanner_handlers from './background/handlers/m3u8_scanner.js';
import * as playback_handlers from './background/handlers/playback.js';
import * as folder_management_handlers from './background/handlers/folder_management.js';
import * as import_export_handlers from './background/handlers/import_export.js';
import * as dependency_anilist_handlers from './background/handlers/dependency_anilist.js';

// --- Shared State ---
let nativeHostStatus = { status: 'unknown', lastCheck: 0, info: null };

chrome.runtime.onConnect.addListener((port) => {
    if (port.name === "popup-lifecycle") {
        ui_state_handlers.setPopupPort(port);
        port.onDisconnect.addListener(() => {
            ui_state_handlers.setPopupPort(null);
        });
    }
});

// --- Main Message Listener ---
const actionHandlers = {
    // UI State
    'content_script_init': ui_state_handlers.handleContentScriptInit,
    'get_ui_state_for_tab': ui_state_handlers.handleGetUiStateForTab,
    'report_detected_url': ui_state_handlers.handleReportDetectedUrl,
    'set_last_folder_id': ui_state_handlers.handleSetLastFolderId,
    'switch_playlist': ui_state_handlers.handleSwitchPlaylist,
    'get_last_folder_id': async () => {
        const data = await storage.get();
        return { folderId: data.settings.last_used_folder_id || Object.keys(data.folders)[0] };
    },
    'set_ui_preferences': ui_state_handlers.handleSetUiPreferences,
    'get_ui_preferences': ui_state_handlers.handleGetUiPreferences,
    'get_default_automatic_flags': ui_state_handlers.handleGetDefaultAutomaticFlags,
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
    'play': playback_handlers.handlePlay, 
    'play_m3u': playback_handlers.handlePlayM3U, 
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

actionHandlers['session_restored'] = playback_handlers.handleSessionRestored;

async function performNativeHostHeartbeat() {
    try {
        const response = await callNativeHost({ action: 'ping' });
        if (response?.success) {
            nativeHostStatus = {
                status: 'online', lastCheck: Date.now(),
                info: { python: response.python_version, platform: response.platform }
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
    performNativeHostHeartbeat();
    chrome.alarms.create('native-host-heartbeat', { periodInMinutes: 5 });
}

startNativeHostHeartbeat();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.log && !request.action) return;
    const handler = actionHandlers[request.action];
    if (handler) {
        (async () => {
            try {
                const response = await handler(request, sender);
                if (response !== undefined) sendResponse(response);
            } catch (e) {
                console.error(`[BG] Error handling action '${request.action}':`, e);
                sendResponse({ success: false, error: e.message });
            }
        })();
        return true;
    }
    return false; 
});

chrome.runtime.onInstalled.addListener(async () => {
    await storage.initialize();
    await updateContextMenus(storage);
    chrome.alarms.create('periodic-storage-janitor', { periodInMinutes: 10080 });
    console.log("[BG] MPV Handler extension installed and initialized.");
});

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'periodic-storage-janitor') {
        storage.runJanitorTasks().catch(e => console.error("Janitor alarm failed:", e));
    } else if (alarm.name === 'native-host-heartbeat') {
        performNativeHostHeartbeat();
    } else if (alarm.name === 'sync-to-native-host') {
        import('./background/core_services.js').then(m => m._syncToNativeHostFile());
    }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    const { menuItemId, linkUrl, srcUrl, pageUrl } = info;
    const urlToAdd = linkUrl || srcUrl || pageUrl;
    if (!urlToAdd) return;

    const getFolderId = async () => {
        if (menuItemId.startsWith('add-to-folder-')) return menuItemId.substring('add-to-folder-'.length);
        if (menuItemId.startsWith('add-playlist-to-folder-')) return menuItemId.substring('add-playlist-to-folder-'.length);
        const data = await storage.get();
        return data.settings.last_used_folder_id;
    };

    const folderId = await getFolderId();
    if (folderId) {
        if (menuItemId.startsWith('add-playlist-to-folder-')) {
            playlistManager.handleAddFromContextMenu(folderId, urlToAdd, "YouTube Playlist", tab);
        } else {
            playlistManager.handleAddFromContextMenu(folderId, urlToAdd, tab.title || urlToAdd, tab);
        }
    }
});

async function reinjectContentScripts() {
    const manifest = chrome.runtime.getManifest();
    const jsFiles = manifest.content_scripts[0].js;
    try {
        const data = await storage.get();
        const restrictedDomains = data.settings.ui_preferences.global.restricted_domains || [];
        const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
        
        for (const tab of tabs) {
            if (tab.url.startsWith("chrome://") || tab.url.startsWith("about:") || tab.url.includes("chrome.google.com/webstore")) continue;
            try {
                const url = new URL(tab.url);
                if (restrictedDomains.some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain))) continue;
            } catch (e) { continue; }

            try {
                const isAlive = await chrome.tabs.sendMessage(tab.id, { action: 'ping' }).then(res => res?.success).catch(() => false);
                if (isAlive) continue;

                await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    func: () => {
                        ['m3u8-controller-host', 'm3u8-minimized-host', 'anilist-panel-host', 'mpv-organizer-host-styles'].forEach(id => document.getElementById(id)?.remove());
                        window.mpvControllerInitialized = false;
                    }
                }).catch(() => {});

                await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: jsFiles });
            } catch (tabErr) {}
        }
    } catch (err) {}
}

reinjectContentScripts();
