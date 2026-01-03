// background/handlers/ui_state.js

let _storage;
let _broadcastToTabs;
let _broadcastLog;
let _callNativeHost;
let _updateContextMenus;
let _tabUiState; // Shared state from background.js
let _m3u8_scanner_handlers;
let _playback_handlers;

export function init(dependencies) {
    _storage = dependencies.storage;
    _broadcastToTabs = dependencies.broadcastToTabs;
    _broadcastLog = dependencies.broadcastLog;
    _callNativeHost = dependencies.callNativeHost;
    _updateContextMenus = dependencies.updateContextMenus;
    _tabUiState = dependencies.tabUiState;
    _m3u8_scanner_handlers = dependencies.m3u8_scanner_handlers;
    _playback_handlers = dependencies.playback_handlers;
}


export async function handleContentScriptInit(request, sender) {
    const tabId = sender.tab?.id; // Ensure tab exists
    const origin = sender.origin;

    if (tabId && origin && sender.tab) {
        if (!_tabUiState[tabId]) _tabUiState[tabId] = {};
        try {
            _tabUiState[tabId].uiDomain = new URL(origin).hostname;
        } catch (e) { /* ignore invalid origins */ }
        
        const data = await _storage.get();
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

        // --- NEW: Prioritize Live Session Data ---
        // If a folder is currently playing, we should default to that folder
        // and its active item, rather than just the last used folder from settings.
        let folderId = _playback_handlers.playbackQueueInstance?.currentPlayingItem?.folderId;
        let isFolderActive = !!folderId;
        let lastPlayedId = null;

        if (!folderId) {
            folderId = data.settings.last_used_folder_id || Object.keys(data.folders)[0];
        }

        const folder = data.folders[folderId];
        lastPlayedId = folder?.last_played_id;

        // Send a single message with the determined state.
        await chrome.tabs.sendMessage(tabId, { 
            action: 'init_ui_state', 
            shouldBeMinimized: isMinimized,
            folderId: folderId,
            lastPlayedId: lastPlayedId,
            isFolderActive: isFolderActive
        }).catch(() => {});

        // Proactively trigger a folder and playlist refresh.
        chrome.tabs.sendMessage(tabId, { 
            action: 'render_playlist', 
            folderId: folderId, 
            playlist: folder?.playlist || [],
            last_played_id: lastPlayedId,
            isFolderActive: isFolderActive
        }).catch(() => {});
    }
}





export async function handleGetUiStateForTab(request) {
    const tabId = request.tabId;
    const tab = await chrome.tabs.get(tabId);
    const data = await _storage.get();
    const globalPrefs = data.settings.ui_preferences.global;
    const tabState = _tabUiState[tabId] || {};

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
            detectedUrl: _m3u8_scanner_handlers.handleGetDetectedUrlForTab(tabId)
        }
    };
}

export async function handleReportDetectedUrl(request, sender) {
    const tabId = sender.tab?.id;
    if (tabId) {
        if (!_tabUiState[tabId]) _tabUiState[tabId] = {};
        _tabUiState[tabId].detectedUrl = request.url;
        // Broadcast to all contexts (popup and content scripts)
        // The popup can check if the tabId matches the active tab.
        _broadcastToTabs({ action: 'detected_url_changed', tabId: tabId, url: request.url });
    }
}

export async function handleSetLastFolderId(request) {
    if (request.folderId) {
        const data = await _storage.get();
        data.settings.last_used_folder_id = request.folderId;
        await _storage.set(data);
        _broadcastToTabs({ action: 'last_folder_changed', folderId: request.folderId });
        await _updateContextMenus(_storage); // Rebuild context menus to reflect the new "current" folder.
        return { success: true };
    }
    return { success: false, error: 'No folderId provided.' };
}

export async function handleGetUiPreferences(request, sender) {
    const data = await _storage.get();
    let globalPrefs = { ...data.settings.ui_preferences.global };

    // --- NEW: Sync Hardware Decoder from Native Host ---
    // If the setting is 'auto', we ask the native host what the OS recommendation is.
    if (globalPrefs.mpv_decoder === 'auto' || !globalPrefs.mpv_decoder) {
        try {
            const status = await _callNativeHost({ action: 'check_dependencies' });
            if (status?.success) {
                // If native host has a specific decoder in its config, use it.
                // This allows the installer's automatic pick to show up in the UI.
                const nativeSettings = await _callNativeHost({ action: 'get_all_folders' }); // Just to get settings context if needed, but check_dependencies is better
                // Actually, let's add a specific 'get_settings' call or use dependency check
                const settingsResponse = await _callNativeHost({ action: 'get_default_automatic_flags' }); // This usually returns settings
                
                // Let's use a simpler approach: get the actual settings from the native host
                const actualSettings = await _callNativeHost({ action: 'get_ui_preferences' }); // The native host has its own version
                if (actualSettings?.preferences?.mpv_decoder) {
                    globalPrefs.mpv_decoder = actualSettings.preferences.mpv_decoder;
                }
            }
        } catch (e) {
            console.warn("Could not sync native decoder settings:", e);
        }
    }

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

export async function handleSetUiPreferences(request, sender) {
    const data = await _storage.get();
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

    await _storage.set(data);

    // --- NEW: Sync Global Preferences to Native Host config.json ---
    if (!domain) {
        try {
            // Only sync keys that the native host actually cares about to avoid bloat
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
            nativeSyncKeys.forEach(key => {
                if (newPreferences[key] !== undefined) syncPrefs[key] = newPreferences[key];
            });

            if (Object.keys(syncPrefs).length > 0) {
                await _callNativeHost({ action: 'set_ui_preferences', preferences: syncPrefs });
            }
        } catch (e) {
            console.warn("Failed to sync preferences to native host:", e);
        }
    }

    // Broadcast the change, but also include the domain it applies to.
    // This allows other tabs to ignore UI changes that aren't for them.
    _broadcastToTabs({
        action: 'preferences_changed', preferences: newPreferences, domain: domain
    });
    return { success: true };
}

export async function handleGetDefaultAutomaticFlags() {
    try {
        const response = await _callNativeHost({ action: 'get_default_automatic_flags' });
        if (response.success && response.flags) {
            return { success: true, flags: response.flags };
        }
    } catch (e) {
        _broadcastLog({ text: `[Background]: Failed to fetch default flags from native host: ${e.message}`, type: 'error' });
    }
    
    // Fallback to local defaults if native host is unavailable
    const defaultData = _storage._getDefaultData();
    return { success: true, flags: defaultData.settings.ui_preferences.global.automatic_mpv_flags };
}

export async function handleSetMinimizedState(request) {
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
}

export function handleHeartbeat() {
    return { success: true };
}

export function handleForceReloadSettings() {
    _broadcastToTabs({ action: 'preferences_changed', preferences: {} });
    return { success: true };
}

export async function handleOpenPopup(request, sender) {
    _broadcastLog({ text: `[Background]: Attempting to open popup...`, type: 'info' });
    if (chrome.action && chrome.action.openPopup) {
        // Fire and forget (but log errors) to avoid blocking the message response
        // or timing out the message channel if the popup takes time to init.
        chrome.action.openPopup({ windowId: sender.tab.windowId }).catch(e => {
            console.error("Popup open failed:", e);
            _broadcastLog({ text: `[Background]: Popup open failed: ${e.message}`, type: 'error' });
        });
        return { success: true };
    }
    return { success: false, error: 'chrome.action.openPopup is not supported in this browser version.' };
}
