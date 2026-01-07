// background/handlers/dependency_anilist.js
import { storage } from '../storage_instance.js';
import { broadcastLog } from '../messaging.js';
import { callNativeHost } from '../../utils/nativeConnection.js';

// In-flight request tracker to prevent redundant calls to the native host
let _inFlightReleasesRequest = null;

export async function handleGetAnilistReleases(request) {
    const forceRefresh = request.force ?? false;
    const data = await storage.get();
    const isCacheDisabled = data.settings.ui_preferences.global.disable_anilist_cache ?? false;

    if (_inFlightReleasesRequest && !forceRefresh && !isCacheDisabled) return _inFlightReleasesRequest;

    _inFlightReleasesRequest = (async () => {
        try {
            const deleteCache = isCacheDisabled;
            const nativeResponse = await callNativeHost({
                action: 'get_anilist_releases',
                force: forceRefresh || isCacheDisabled,
                delete_cache: deleteCache,
                is_cache_disabled: isCacheDisabled
            });

            if (nativeResponse.success && nativeResponse.output) {
                try {
                    const data = JSON.parse(nativeResponse.output);
                    return { success: true, output: data };
                } catch (e) {
                    return { success: false, error: `JSON Parse failed: ${e.message}` };
                }
            }
            return nativeResponse;
        } finally {
            _inFlightReleasesRequest = null;
        }
    })();

    return _inFlightReleasesRequest;
}

export async function handleYtdlpUpdateCheck(request) {
    if (request.log) broadcastLog(request.log);

    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = activeTab?.id;

    const data = await storage.get();
    const updateBehavior = data.settings.ui_preferences.global.ytdlp_update_behavior || 'manual';

    if (updateBehavior === 'manual') return { success: true, message: 'Manual mode.' };

    if (updateBehavior === 'ask') {
        if (!tabId) return { success: false, error: 'No active tab.' };
        chrome.tabs.sendMessage(tabId, { action: 'ytdlp_update_confirm' }).catch(() => {});
        return { success: true, message: 'Confirmation requested.' };
    }
    if (updateBehavior === 'auto') return callNativeHost({ action: 'run_ytdlp_update' });
}

export async function handleUserConfirmedYtdlpUpdate() {
    broadcastLog({ text: `[Background]: Starting yt-dlp update...`, type: 'info' });
    return callNativeHost({ action: 'run_ytdlp_update' });
}

export async function handleManualYtdlpUpdate() {
    broadcastLog({ text: `[Background]: Manual yt-dlp update triggered.`, type: 'info' });
    return callNativeHost({ action: 'run_ytdlp_update' });
}