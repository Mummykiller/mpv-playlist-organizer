// background/handlers/ui_state.js
import { storage } from '../storage_instance.js';
import { broadcastLog, broadcastToTabs } from '../messaging.js';
import { callNativeHost } from '../../utils/nativeConnection.js';
import { updateContextMenus } from '../../utils/contextMenu.js';
import { isYouTubeUrl, normalizeYouTubeUrl } from '../../utils/commUtils.module.js';
import * as m3u8_scanner_handlers from './m3u8_scanner.js';
import * as playback_handlers from './playback.js';

// Cache for native host info to speed up UI preference retrieval
let _nativeInfoCache = {
    decoder: null,
    timestamp: 0
};
const CACHE_TTL_MS = 600000; // 10 minutes

// Helper to get current popup port (assigned by background.js)
let popupPort = null;
export function setPopupPort(port) { popupPort = port; }

export async function handleContentScriptInit(request, sender) {
    const tabId = sender.tab?.id; // Ensure tab exists
    const origin = sender.origin;

    if (tabId && origin && sender.tab) {
        // ... (remaining logic using storage, broadcastLog, etc directly)
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

        const mpvStatus = await playback_handlers.handleIsMpvRunning().catch(() => ({ is_running: false }));
        let folderId = mpvStatus?.is_running ? mpvStatus.folderId : null;
        let isFolderActive = !!folderId;
        let lastPlayedId = null;

        if (!folderId) {
            folderId = data.settings.last_used_folder_id || Object.keys(data.folders)[0];
        }

        const folder = data.folders[folderId];
        lastPlayedId = folder?.last_played_id;

        const detectedUrl = m3u8_scanner_handlers.handleGetDetectedUrlForTab(tabId);

        await chrome.tabs.sendMessage(tabId, { 
            action: 'init_ui_state', 
            tabId: tabId,
            shouldBeMinimized: isMinimized,
            folderId: folderId,
            lastPlayedId: lastPlayedId,
            isFolderActive: isFolderActive,
            playlist: folder?.playlist || [],
            detectedUrl: detectedUrl
        }).catch(() => {});
    }
}

export async function handleGetUiStateForTab(request) {
    const tabId = request.tabId;
    const tab = await chrome.tabs.get(tabId);
    const data = await storage.get();
    const globalPrefs = data.settings.ui_preferences.global;
    
    // We'll need to handle tabUiState differently or just query it from background.js
    // For now, let's assume we can get it or ignore it if not critical.
    
    let domain = null;
    if (tab.url && (tab.url.startsWith('http:') || tab.url.startsWith('https:'))) {
        try {
            domain = new URL(tab.url).hostname;
        } catch (e) { /* ignore */ }
    }

    const domainPrefs = domain ? data.settings.ui_preferences.domains[domain] || {} : {};
    const finalPrefs = { ...globalPrefs, ...domainPrefs };

    return {
        success: true,
        state: {
            minimized: finalPrefs.minimized ?? (finalPrefs.mode === 'minimized'),
            detectedUrl: m3u8_scanner_handlers.handleGetDetectedUrlForTab(tabId)
        }
    };
}

export async function handleReportPageUrl(request, sender) {
    const tabId = sender.tab?.id;
    if (!tabId || !request.url) return;

    let urlToReport = request.url;
    
    // Centralized Smart Logic: Deciding what counts as a "detectable" video URL
    if (isYouTubeUrl(urlToReport)) {
        const isWatchPage = urlToReport.includes('/watch') || urlToReport.includes('youtu.be/');
        const isPlaylistPage = urlToReport.includes('/playlist');
        
        if (isWatchPage || isPlaylistPage) {
            urlToReport = normalizeYouTubeUrl(urlToReport);
            
            const currentState = m3u8_scanner_handlers.handleGetDetectedUrlForTab(tabId);
            
            // Only update if it changed or wasn't already set by the scanner (M3U8 takes priority over YouTube page URL)
            if (currentState !== urlToReport && (!currentState || isYouTubeUrl(currentState))) {
                m3u8_scanner_handlers.handleUpdateDetectedUrlForTab(tabId, urlToReport);
                broadcastToTabs({ action: 'detected_url_changed', tabId: tabId, url: urlToReport });
            }
        }
    }
}

export async function handleSetLastFolderId(request) {
    if (request.folderId) {
        const data = await storage.get();
        data.settings.last_used_folder_id = request.folderId;
        await storage.set(data);
        broadcastToTabs({ action: 'last_folder_changed', folderId: request.folderId });
        await updateContextMenus(storage);
        return { success: true };
    }
    return { success: false, error: 'No folderId provided.' };
}

export async function handleSwitchPlaylist() {
    const data = await storage.get();
    const folderOrder = data.folderOrder || Object.keys(data.folders);
    
    if (folderOrder.length <= 1) return { success: true };

    const currentFolderId = data.settings.last_used_folder_id || folderOrder[0];
    let currentIndex = folderOrder.indexOf(currentFolderId);
    
    const nextIndex = (currentIndex + 1) % folderOrder.length;
    const nextFolderId = folderOrder[nextIndex];

    data.settings.last_used_folder_id = nextFolderId;
    await storage.set(data);

    const folder = data.folders[nextFolderId] || { playlist: [] };
    const mpvStatus = await playback_handlers.handleIsMpvRunning().catch(() => ({ is_running: false }));
    const isFolderActive = !!(mpvStatus?.is_running && (mpvStatus.folderId === nextFolderId || playback_handlers.isFolderActive(nextFolderId)));

    broadcastToTabs({ 
        action: 'last_folder_changed', 
        folderId: nextFolderId,
        playlist: folder.playlist,
        lastPlayedId: folder.last_played_id,
        isFolderActive: isFolderActive
    });
    
    updateContextMenus(storage).catch(e => console.error("Failed to update context menus:", e));

    return { success: true, folderId: nextFolderId };
}

export async function handleGetUiPreferences(request, sender) {
    const data = await storage.get();
    let globalPrefs = { ...data.settings.ui_preferences.global };

    const now = Date.now();
    if (_nativeInfoCache.timestamp && (now - _nativeInfoCache.timestamp < CACHE_TTL_MS)) {
        if (_nativeInfoCache.decoder) globalPrefs.mpv_decoder = _nativeInfoCache.decoder;
        if (_nativeInfoCache.ffmpeg_path && !globalPrefs.ffmpeg_path) globalPrefs.ffmpeg_path = _nativeInfoCache.ffmpeg_path;
        if (_nativeInfoCache.node_path && !globalPrefs.node_path) globalPrefs.node_path = _nativeInfoCache.node_path;
    } else {
        try {
            const nativeSettings = await callNativeHost({ action: 'get_ui_preferences' });
            if (nativeSettings?.success && nativeSettings.preferences) {
                const np = nativeSettings.preferences;
                if (np.mpv_decoder) {
                    globalPrefs.mpv_decoder = np.mpv_decoder;
                    _nativeInfoCache.decoder = np.mpv_decoder;
                }
                if (np.ffmpeg_path) {
                    if (!globalPrefs.ffmpeg_path) globalPrefs.ffmpeg_path = np.ffmpeg_path;
                    _nativeInfoCache.ffmpeg_path = np.ffmpeg_path;
                }
                if (np.node_path) {
                    if (!globalPrefs.node_path) globalPrefs.node_path = np.node_path;
                    _nativeInfoCache.node_path = np.node_path;
                }
                _nativeInfoCache.timestamp = now;
            }
        } catch (e) {
            console.warn("Could not sync native settings:", e);
        }
    }

    let domain = null;
    if (sender.origin && (sender.origin.startsWith('http:') || sender.origin.startsWith('https:'))) {
        try {
            domain = new URL(sender.origin).hostname;
        } catch (e) { /* ignore */ }
    }

    if (domain) {
        const domainPrefs = data.settings.ui_preferences.domains[domain] || {};
        return { success: true, preferences: { ...globalPrefs, ...domainPrefs } };
    }
    return { success: true, preferences: globalPrefs };
}

export async function handleSetUiPreferences(request, sender) {
    const data = await storage.get();
    const newPreferences = request.preferences;

    let domain = null;
    if (sender.origin && (sender.origin.startsWith('http:') || sender.origin.startsWith('https:'))) {
        try {
            domain = new URL(sender.origin).hostname;
        } catch (e) { /* ignore */ }
    }

    if (domain) {
        const existingDomainPrefs = data.settings.ui_preferences.domains[domain] || {};
        data.settings.ui_preferences.domains[domain] = { ...existingDomainPrefs, ...newPreferences };
    } else {
        data.settings.ui_preferences.global = { ...data.settings.ui_preferences.global, ...newPreferences };
    }

    await storage.set(data);

    if (!domain) {
        _nativeInfoCache.decoder = null;
        _nativeInfoCache.timestamp = 0;

        try {
            const nativeSyncKeys = [
                'mpv_path', 'mpv_decoder', 'enable_url_analysis', 'browser_for_url_analysis',
                'enable_youtube_analysis', 'user_agent_string', 'enable_smart_resume',
                'enable_active_item_highlight', 'disable_network_overrides', 'enable_cache',
                'http_persistence', 'demuxer_max_bytes', 'demuxer_max_back_bytes',
                'cache_secs', 'demuxer_readahead_secs', 'stream_buffer_size', 
                'ytdlp_concurrent_fragments', 'enable_reconnect', 'reconnect_delay', 
                'performance_profile', 'ffmpeg_path', 'node_path', 'automatic_mpv_flags'
            ];
            
            const syncPrefs = {};
            nativeSyncKeys.forEach(key => {
                if (newPreferences[key] !== undefined) syncPrefs[key] = newPreferences[key];
            });

            if (Object.keys(syncPrefs).length > 0) {
                await callNativeHost({ action: 'set_ui_preferences', preferences: syncPrefs });
            }
        } catch (e) {
            console.warn("Failed to sync preferences to native host:", e);
        }
    }

    broadcastToTabs({
        action: 'preferences_changed', preferences: newPreferences, domain: domain
    });
    return { success: true };
}

export async function handleGetDefaultAutomaticFlags() {
    try {
        const response = await callNativeHost({ action: 'get_default_automatic_flags' });
        if (response.success && response.flags) {
            return { success: true, flags: response.flags };
        }
    } catch (e) {
        broadcastLog({ text: `[Background]: Failed to fetch default flags: ${e.message}`, type: 'error' });
    }
    
    const defaultData = storage._getDefaultData();
    return { success: true, flags: defaultData.settings.ui_preferences.global.automatic_mpv_flags };
}

export async function handleSetMinimizedState(request) {
    const { minimized } = request;
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
}

export function handleHeartbeat() { return { success: true }; }

export function handleForceReloadSettings() {
    broadcastToTabs({ action: 'preferences_changed', preferences: {} });
    return { success: true };
}

export async function handleForceRefreshDependencies() {
    _nativeInfoCache.decoder = null;
    _nativeInfoCache.timestamp = 0;
    const response = await callNativeHost({ action: 'check_dependencies', force_refresh: true });
    
    if (response.success) {
        const data = await storage.get();
        data.settings.ui_preferences.global.dependencyStatus = {
            mpv: response.mpv, ytdlp: response.ytdlp, ffmpeg: response.ffmpeg, node: response.node
        };
        await storage.set(data);
        broadcastToTabs({ 
            action: 'preferences_changed', 
            preferences: { dependencyStatus: data.settings.ui_preferences.global.dependencyStatus } 
        });
        broadcastLog({ text: "[Background]: Dependency status refreshed successfully.", type: "info" });
    }
    return response;
}

export async function handleOpenPopup(request, sender) {
    if (popupPort) {
        try {
            popupPort.postMessage({ action: 'close_popup' });
        } catch (e) {}
        return { success: true };
    }

    if (chrome.action && chrome.action.openPopup) {
        chrome.action.openPopup({ windowId: sender.tab.windowId }).catch(() => {});
        return { success: true };
    }
    return { success: false, error: 'openPopup not supported.' };
}
