// background/handlers/dependency_anilist.js

let _storage;
let _broadcastLog;
let _broadcastToTabs;
let _callNativeHost;

export function init(dependencies) {
    _storage = dependencies.storage;
    _broadcastLog = dependencies.broadcastLog;
    _broadcastToTabs = dependencies.broadcastToTabs;
    _callNativeHost = dependencies.callNativeHost;
}

/**
 * Checks MPV and yt-dlp dependencies via the native host and stores the results.
 * Also broadcasts a message to update UI components.
 */
async function _checkDependenciesAndStore() {
    _broadcastLog({ text: `[Background]: Checking MPV and yt-dlp dependencies...`, type: 'info' });
    const response = await _callNativeHost({ action: 'check_dependencies' });

    if (response.success) {
        const data = await _storage.get();
        data.settings.ui_preferences.global.dependencyStatus = {
            mpv: response.mpv,
            ytdlp: response.ytdlp
        };
        await _storage.set(data);
        _broadcastLog({ text: `[Background]: Dependency check completed.`, type: 'info' });
        _broadcastToTabs({ action: 'dependencies_status_changed', status: data.settings.ui_preferences.global.dependencyStatus });
    } else {
        _broadcastLog({ text: `[Background]: Dependency check failed: ${response.error}`, type: 'error' });
    }
}

export async function handleGetAnilistReleases(request) {
    // All caching logic is now handled by the native host.
    const forceRefresh = request.force ?? false;

    // Check preferences to see if the user has disabled the cache.
    // Fetch preferences directly from storage instead of sending a message to itself.
    const data = await _storage.get();
    const isCacheDisabled = data.settings.ui_preferences.global.disable_anilist_cache ?? false;

    // If the cache is disabled, we instruct the native host to delete the cache file.
    // This ensures no stale data is ever used when this setting is on.
    const deleteCache = isCacheDisabled;

    const nativeResponse = await _callNativeHost({
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

export async function handleYtdlpUpdateCheck(request) {
    // This is triggered by the native host when it detects a playback failure.
    // First, log the message it sent.
    if (request.log) {
        _broadcastLog(request.log);
    }

    // Find the tab that originated the MPV command to show the confirmation there.
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = activeTab?.id;

    const data = await _storage.get();
    const updateBehavior = data.settings.ui_preferences.global.ytdlp_update_behavior || 'manual';

    if (updateBehavior === 'manual') {
        _broadcastLog({ text: `[Background]: yt-dlp update behavior is set to 'manual'. No action taken.`, type: 'info' });
        return { success: true, message: 'Manual update mode. No action taken.' };
    }

    if (updateBehavior === 'ask') {
        if (!tabId) {
            return { success: false, error: 'Could not find an active tab to show confirmation.' };
        }
        // Ask the content script to show a confirmation. The content script will then send a message back.
        // We use a page-level confirmation that doesn't depend on the controller UI.
        chrome.tabs.sendMessage(tabId, { action: 'ytdlp_update_confirm' })
            .catch(err => _broadcastLog({ text: `[Background]: Could not send update confirmation to tab ${tabId}. Error: ${err.message}`, type: 'error' }));
        return { success: true, message: 'Confirmation requested from user.' };
    }
    if (updateBehavior === 'auto') {
        // If the setting is enabled, tell the native host to proceed with the update.
        return _callNativeHost({ action: 'run_ytdlp_update' });
    }
}

export async function handleUserConfirmedYtdlpUpdate() {
    _broadcastLog({ text: `[Background]: User confirmed. Starting yt-dlp update...`, type: 'info' });
    return _callNativeHost({ action: 'run_ytdlp_update' });
}

export async function handleManualYtdlpUpdate() {
    _broadcastLog({ text: `[Background]: Manual yt-dlp update triggered from settings.`, type: 'info' });
    return _callNativeHost({ action: 'run_ytdlp_update' });
}

export async function handleGetDependencyStatus() {
    await _checkDependenciesAndStore(); // Ensure dependencies are checked before returning status
    const data = await _storage.get();
    return { success: true, status: data.settings.ui_preferences.global.dependencyStatus };
}