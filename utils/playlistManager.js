/**
 * Manages all playlist-related actions like adding, removing, clearing, and reordering.
 */
// --- Injected Dependencies ---
let storage;
let broadcastToTabs;
let broadcastLog;
let debouncedSyncToNativeHostFile;
let sendMessageAsync; // For asking confirmation from other contexts
let findM3u8InUrl; // For the stream scanner
let callNativeHost; // For oEmbed via native host
let MPV_PLAYLIST_COMPLETED_EXIT_CODE; // For context-menu driven playlist updates

// A lock to prevent multiple scraping processes for the same URL at the same time.
const scrapingInProgress = new Set();

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
    findM3u8InUrl = deps.findM3u8InUrl;
    callNativeHost = deps.callNativeHost;
    MPV_PLAYLIST_COMPLETED_EXIT_CODE = deps.MPV_PLAYLIST_COMPLETED_EXIT_CODE;
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

        // Generate a stable ID for the item immediately.
        // This ensures the browser and native host agree on the ID without race conditions.
        const newItem = { 
            url, 
            title, 
            id: crypto.randomUUID() 
        };

        data.folders[folderId].playlist.push(newItem);
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

/**
 * Centralized function to scrape details for a URL and add it to a folder.
 * This handles YouTube oEmbed, the generic stream scanner, and adding the final result.
 * @param {string} folderId The ID of the folder to add to.
 * @param {string} urlToAdd The initial URL (can be a page URL or direct video URL).
 * @param {chrome.tabs.Tab} tab The originating tab, used for confirmations and scanner focus.
 * @param {chrome.runtime.MessageSender} sender The sender of the message.
 * @param {boolean} [skipYouTubeCheck=false] - Internal flag to prevent oEmbed loops.
 */
async function _scrapeAndAddUrl(folderId, urlToAdd, tab, sender, skipYouTubeCheck = false) {
    const isYouTubeUrl = /youtube\.com\/(watch|playlist)/.test(urlToAdd);

    if (isYouTubeUrl && !skipYouTubeCheck) {
        broadcastLog({ text: `[Background]: YouTube URL detected. Scraping title via oEmbed...`, type: 'info' });
        try {
            // Use a simple fetch for oEmbed as it's more direct than going through the native host.
            const oEmbedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(urlToAdd)}&format=json`;
            const response = await fetch(oEmbedUrl);
            if (!response.ok) throw new Error(`oEmbed request failed: ${response.status}`);

            const videoDetails = await response.json();
            const isPlaylist = urlToAdd.includes('/playlist?list=');
            const itemTitle = videoDetails.title || (isPlaylist ? "YouTube Playlist" : "YouTube Video");
            const finalTitle = videoDetails.author_name ? `${videoDetails.author_name} - ${itemTitle}` : itemTitle;

            return await addUrlToFolder(folderId, urlToAdd, finalTitle, tab, sender);
        } catch (e) {
            broadcastLog({ text: `[Background]: YouTube oEmbed scrape failed: ${e.message}. Falling back to stream scanner.`, type: 'info' });
            // If oEmbed fails, don't just give up. Fall back to the robust stream scanner
            // which can use PageScraper.js as a final attempt to get a good title.
            return await _scrapeAndAddUrl(folderId, urlToAdd, tab, sender, true); // Recursive call with the flag set to true
        }
    } else {
        // For all other sites, use the robust stream scanner.
        broadcastLog({ text: `[Background]: Non-YouTube URL detected. Scanning for stream and title...`, type: 'info' });
        let scanResult;
        try {
            // The findM3u8InUrl function now handles everything: opening the scanner,
            // waiting for a stream, and scraping the title as a fallback.
            scanResult = await findM3u8InUrl(urlToAdd, tab);

            if (scanResult.url) {
                return await addUrlToFolder(folderId, scanResult.url, scanResult.title, tab, sender);
            } else {
                const message = `[Background]: Scanner did not detect a video stream on '${urlToAdd}'. Nothing added.`;
                broadcastLog({ text: message, type: 'info' });
                return { success: false, error: message };
            }
        } catch (error) {
            const message = `[Background]: Scanner failed for '${urlToAdd}'. Adding original URL as fallback. Error: ${error.message}`;
            broadcastLog({ text: message, type: 'info' });
            // Fallback: add the original page URL with a basic title.
            return await addUrlToFolder(folderId, urlToAdd, urlToAdd, tab, sender);
        } finally {
            // Ensure the scanner window is always closed.
            if (scanResult?.scannerTab?.windowId) {
                chrome.windows.remove(scanResult.scannerTab.windowId).catch(() => {});
            }
        }
    }
}

export async function handleAdd(request, sender) {
    const tabId = request.tabId || sender.tab?.id;
    const folderId = request.folderId;
    const tab = sender.tab; // Only trust the sender's tab object

    // --- Loop/Spam Prevention ---
    const urlToProcess = request.data?.url || tab?.url;
    if (scrapingInProgress.has(urlToProcess)) {
        broadcastLog({ text: `[Background]: A request to add "${urlToProcess}" is already in progress. Ignoring.`, type: 'info' });
        return { success: true, message: 'Scraping already in progress for this URL.' };
    }

    if (!tabId || !folderId) {
        return { success: false, error: 'Missing tabId or folderId for add action.' };
    }

    // If the title and URL are already provided (by the efficient on-page button),
    // add them directly without using the scanner.
    const isYouTubePlaylist = request.data?.url && request.data.url.includes('youtube.com/playlist');
    if (request.data?.url && request.data?.title && !isYouTubePlaylist) {
        scrapingInProgress.add(request.data.url);
        broadcastLog({ text: `[Background]: Received pre-scraped item. Adding directly.`, type: 'info' });
        try {
            return await addUrlToFolder(folderId, request.data.url, request.data.title, tab, sender);
        } finally {
            scrapingInProgress.delete(request.data.url);
        }
    } else {
        // Otherwise (e.g., from the popup), trigger the full scrape-and-add process
        // using the tab's main URL. This will use the scanner.
        scrapingInProgress.add(tab.url);
        const result = await _scrapeAndAddUrl(folderId, tab.url, tab, sender);
        scrapingInProgress.delete(tab.url);
        return result;
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
        const itemToRemove = playlist[indexToRemove];
        playlist.splice(indexToRemove, 1);
        await storage.set(data);
        broadcastToTabs({ action: 'render_playlist', folderId: request.folderId, playlist: playlist });
        debouncedSyncToNativeHostFile();

        // Attempt to remove from live MPV session if running
        callNativeHost({ 
            action: 'remove_item_live', 
            folderId: request.folderId, 
            item_id: itemToRemove.id 
        }).catch(() => {});

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

    // Attempt to reorder live MPV session
    callNativeHost({
        action: 'reorder_live',
        folderId: folderId,
        new_order: order
    }).catch(() => {});

    return { success: true, message: `Playlist order for '${folderId}' updated.` };
}

export async function handleAddFromContextMenu(folderId, urlToAdd, title, tab) {
    if (scrapingInProgress.has(urlToAdd)) {
        broadcastLog({ text: `[Background]: A request to add "${urlToAdd}" is already in progress. Ignoring.`, type: 'info' });
        return { success: true, message: 'Scraping already in progress for this URL.' };
    }
    scrapingInProgress.add(urlToAdd);
    const result = await _scrapeAndAddUrl(folderId, urlToAdd, tab, null);
    scrapingInProgress.delete(urlToAdd);
    return result;
}

export async function handleGetPlaylist(request) {
    const data = await storage.get();
    const folder = data.folders[request.folderId] || { playlist: [] };
    return { success: true, list: folder.playlist };
}