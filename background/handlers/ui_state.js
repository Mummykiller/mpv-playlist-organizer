// background/handlers/ui_state.js

let _storage;
let _broadcastToTabs;
let _broadcastLog;
let _callNativeHost;
let _updateContextMenus;
let _tabUiState; // Shared state from background.js
let _m3u8_scanner_handlers;

export function init(dependencies) {
    _storage = dependencies.storage;
    _broadcastToTabs = dependencies.broadcastToTabs;
    _broadcastLog = dependencies.broadcastLog;
    _callNativeHost = dependencies.callNativeHost;
    _updateContextMenus = dependencies.updateContextMenus;
    _tabUiState = dependencies.tabUiState;
    _m3u8_scanner_handlers = dependencies.m3u8_scanner_handlers;
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

        // Send a single message with the determined state. The content script will handle showing/hiding.
        chrome.tabs.sendMessage(tabId, { action: 'init_ui_state', shouldBeMinimized: isMinimized }).catch(() => {});
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
    // Broadcast the change, but also include the domain it applies to.
    // This allows other tabs to ignore UI changes that aren't for them.
    _broadcastToTabs({
        action: 'preferences_changed', preferences: newPreferences, domain: domain
    });
    return { success: true };
}

export async function handleGetDefaultAutomaticFlags() {
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
        try {
            await chrome.action.openPopup({ windowId: sender.tab.windowId });
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }
    return { success: false, error: 'chrome.action.openPopup is not supported in this browser version.' };
}
