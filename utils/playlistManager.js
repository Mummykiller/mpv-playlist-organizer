/**
 * Manages all playlist-related actions like adding, removing, clearing, and reordering.
 */

// --- Injected Dependencies ---
let storage;
let broadcastToTabs;
let broadcastLog;
let debouncedSyncToNativeHostFile;
let sendMessageAsync; // For asking confirmation from other contexts

/**
 * Injects dependencies from the main background script.
 * @param {object} deps - An object containing dependency functions and instances.
 */
export function injectDependencies(deps) {
    storage = deps.storage;
    broadcastToTabs = deps.broadcastToTabs;
    broadcastLog = deps.broadcastLog;
    debouncedSyncToNativeHostFile = deps.debouncedSyncToNativeHostFile;
    sendMessageAsync = deps.sendMessageAsync;
}

/**
 * Normalizes a YouTube URL by removing the 't' (timestamp) parameter.
 * This allows for more accurate duplicate detection.
 * @param {string} ytUrl The YouTube URL to normalize.
 * @returns {string} The normalized URL, or the original if not a YouTube video URL.
 */
function normalizeYouTubeUrlForCheck(ytUrl) {
    try {
        const urlObj = new URL(ytUrl);
        if (urlObj.hostname.includes('youtube.com') && urlObj.pathname === '/watch') {
            urlObj.searchParams.delete('t');
            return urlObj.toString();
        }
    } catch (e) {
        // Not a valid URL, return original
    }
    return ytUrl;
}

/**
 * Encapsulates the logic of adding an item to a folder's playlist.
 * @param {string} folderId The ID of the folder to add to.
 * @param {string} url The URL to add.
 * @param {string} title The scraped title for the entry.
 * @param {chrome.tabs.Tab} originalTab The tab where the context menu was clicked.
 * @param {chrome.runtime.MessageSender} sender The sender of the original message.
 */
async function addUrlToFolder(folderId, url, title, originalTab = null, sender = null) {
    try {
        const data = await storage.get();
        const playlist = data.folders[folderId]?.playlist || [];
        const duplicateBehavior = data.settings.ui_preferences.global.duplicate_url_behavior || 'ask';
        const normalizedUrl = normalizeYouTubeUrlForCheck(url);
        const isDuplicate = playlist.some(item => normalizeYouTubeUrlForCheck(item.url) === normalizedUrl);

        if (isDuplicate) {
            if (duplicateBehavior === 'never') {
                const logMessage = `[Background]: URL already in folder '${folderId}'. "Never Add" is on.`;
                broadcastLog({ text: logMessage, type: 'info' });
                return { success: true, message: logMessage }; // Stop here
            }
            if (duplicateBehavior === 'ask') {
                const isFromPopup = sender?.url?.startsWith('chrome-extension://');

                if (isFromPopup) {
                    const response = await sendMessageAsync({
                        action: 'show_popup_confirmation',
                        message: `This URL is already in the playlist for "${folderId}". Add it again?`
                    });
                    if (!response || !response.confirmed) {
                        const logMessage = `[Background]: Add action cancelled by user for folder '${folderId}'.`;
                        broadcastLog({ text: logMessage, type: 'info' });
                        return { success: true, message: logMessage };
                    }
                } else if (originalTab && originalTab.id) {
                    try {
                        const response = await chrome.tabs.sendMessage(originalTab.id, {
                            action: 'show_confirmation',
                            message: `This URL is already in the playlist for "${folderId}". Add it again?`
                        });

                        if (!response || !response.confirmed) {
                            const logMessage = `[Background]: Add action cancelled by user for folder '${folderId}'.`;
                            broadcastLog({ text: logMessage, type: 'info' });
                            return { success: true, message: logMessage };
                        }
                    } catch (e) {
                        const logMessage = `[Background]: Could not ask for confirmation on tab ${originalTab.id}. Adding duplicate URL to '${folderId}'. Reason: ${e.message}`;
                        broadcastLog({ text: logMessage, type: 'info' });
                    }
                } else {
                    const logMessage = `[Background]: Duplicate URL detected for folder '${folderId}'. Adding anyway as no UI is available to ask for confirmation.`;
                    broadcastLog({ text: logMessage, type: 'info' });
                }
            }
        }

        data.folders[folderId].playlist.push({ url, title });
        await storage.set(data);
        debouncedSyncToNativeHostFile();

        broadcastToTabs({ action: 'render_playlist', folderId: folderId, playlist: data.folders[folderId].playlist, fromContextMenu: true });

        const logMessage = `[Background]: Added "${title}" to folder '${folderId}'.`;
        broadcastLog({ text: logMessage, type: 'info' });
        return { success: true, message: logMessage };

    } catch (e) {
        const logMessage = `[Background]: Error adding to folder '${folderId}': ${e.message}`;
        broadcastLog({ text: logMessage, type: 'error' });
        return { success: false, error: logMessage };
    }
}

export async function handleAdd(request, sender) {
    const tabId = request.tabId || sender.tab?.id;
    const folderId = request.folderId;

    if (!tabId || !folderId) {
        return { success: false, error: 'Missing tabId or folderId for add action.' };
    }

    try {
        const scrapedDetails = await chrome.tabs.sendMessage(tabId, { action: 'scrape_and_get_details' });

        if (!scrapedDetails || !scrapedDetails.url) {
            return { success: false, error: 'No stream/video detected on the page to add.' };
        }

        return await addUrlToFolder(folderId, scrapedDetails.url, scrapedDetails.title, request.tab || sender.tab, sender);
    } catch (e) {
        return { success: false, error: `Could not communicate with content script: ${e.message}` };
    }
}

export async function handleClear(request) {
    const data = await storage.get();
    data.folders[request.folderId].playlist = [];
    await storage.set(data);
    try {
        await broadcastToTabs({ action: 'render_playlist', folderId: request.folderId, playlist: [] });
    } catch (e) { /* Suppress errors if no content scripts exist */ }
    debouncedSyncToNativeHostFile();
    return { success: true, message: `Playlist in folder ${request.folderId} cleared` };
}

export async function handleRemoveItem(request) {
    const data = await storage.get();
    const playlist = data.folders[request.folderId].playlist;
    const indexToRemove = request.data?.index;
    if (typeof indexToRemove === 'number' && indexToRemove >= 0 && indexToRemove < playlist.length) {
        playlist.splice(indexToRemove, 1);
        await storage.set(data);
        broadcastToTabs({ action: 'render_playlist', folderId: request.folderId, playlist: playlist });
        debouncedSyncToNativeHostFile();
        return { success: true, message: 'Item removed.' };
    }
    return { success: false, error: 'Invalid item index.' };
}

export async function handleSetPlaylistOrder(request) {
    const { folderId, data: { order } } = request;
    if (!folderId || !Array.isArray(order)) {
        return { success: false, error: 'Invalid data for setting playlist order.' };
    }

    const storageData = await storage.get();
    if (!storageData.folders[folderId]) {
        return { success: false, error: `Folder '${folderId}' not found.` };
    }

    storageData.folders[folderId].playlist = order;
    await storage.set(storageData);
    debouncedSyncToNativeHostFile();
    return { success: true, message: `Playlist order for '${folderId}' updated.` };
}

export async function handleAddFromContextMenu(folderId, urlToAdd, title, tab) {
    return addUrlToFolder(folderId, urlToAdd, title, tab);
}

export async function handleGetPlaylist(request) {
    const data = await storage.get();
    const folder = data.folders[request.folderId] || { playlist: [] };
    return { success: true, list: folder.playlist };
}