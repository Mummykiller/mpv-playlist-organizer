/**
 * Manages all playlist-related actions like adding, removing, clearing, and reordering.
 */
import { sanitizeString } from './commUtils.module.js';
import { normalizeYouTubeUrl, sendMessageAsync } from './commUtils.module.js';
import { storage } from '../background/storage_instance.js';
import { broadcastLog, broadcastToTabs } from '../background/messaging.js';
import { debouncedSyncToNativeHostFile } from '../background/core_services.js';
import { callNativeHost } from './nativeConnection.js';
import { isFolderActive, getMpvPlaylistCompletedExitCode } from '../background/handlers/playback.js';
import { findM3u8InUrl } from '../background/handlers/m3u8_scanner.js';

// A lock to prevent multiple scraping processes for the same URL at the same time.
const scrapingInProgress = new Set();

async function addUrlToFolder(folderId, url, title, originalTab = null, sender = null) {
    try {
        const sanitizedUrl = sanitizeString(url);
        const normalizedUrl = normalizeYouTubeUrl(sanitizedUrl);
        const sanitizedTitle = sanitizeString(title);

        let data = await storage.get();
        if (!data.folders[folderId]) {
            data.folders[folderId] = { playlist: [], last_played_id: null };
        }

        const playlist = data.folders[folderId].playlist;
        const duplicateBehavior = data.settings.ui_preferences.global.duplicate_url_behavior || 'ask';
        
        const isDuplicate = playlist.some(item => normalizeYouTubeUrl(item.url) === normalizedUrl);

        if (isDuplicate) {
            if (duplicateBehavior === 'never') {
                const logMessage = `[Background]: URL already in folder '${folderId}'. "Never Add" is on.`;
                broadcastLog({ text: logMessage, type: 'info' });
                return { success: true, message: logMessage };
            }
            if (duplicateBehavior === 'ask') {
                const isFromPopup = sender?.url?.startsWith('chrome-extension://');
                let confirmed = false;

                if (isFromPopup) {
                    try {
                        const response = await sendMessageAsync({
                            action: 'show_popup_confirmation',
                            message: `This URL is already in the playlist for "${folderId}". Add it again?`
                        });
                        confirmed = !!response?.confirmed;
                    } catch (e) {
                        console.warn("[PlaylistManager] Popup confirmation failed:", e);
                        confirmed = true;
                    }
                } else {
                    // Try to find target tab for confirmation
                    let targetTabId = originalTab?.id;
                    if (!targetTabId) {
                        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
                        targetTabId = activeTab?.id;
                    }

                    if (targetTabId) {
                        try {
                            const response = await chrome.tabs.sendMessage(targetTabId, {
                                action: 'show_confirmation',
                                message: `This URL is already in the playlist for "${folderId}". Add it again?`
                            });
                            confirmed = !!response?.confirmed;
                        } catch (e) {
                            broadcastLog({ text: `[Background]: Could not ask for confirmation on tab ${targetTabId}. Adding duplicate.`, type: 'info' });
                            confirmed = true;
                        }
                    } else {
                        confirmed = true;
                    }
                }

                if (!confirmed) {
                    const logMessage = `[Background]: Add action cancelled by user for folder '${folderId}'.`;
                    broadcastLog({ text: logMessage, type: 'info' });
                    return { success: true, message: logMessage };
                }

                // IMPORTANT: Re-fetch data after async confirmation to avoid race conditions
                data = await storage.get();
                if (!data.folders[folderId]) data.folders[folderId] = { playlist: [] };
            }
        }

        // Generate a robust unique ID
        const itemId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? 
            crypto.randomUUID() : 
            'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
                const r = Math.random() * 16 | 0;
                const v = c === 'x' ? r : (r & 0x3 | 0x8);
                return v.toString(16);
            });

        const newItem = { 
            url: normalizedUrl, 
            title: sanitizedTitle, 
            id: itemId,
            settings: {} 
        };

        // Add to the confirmed fresh data structure
        data.folders[folderId].playlist.push(newItem);
        
        // Persist to storage
        await storage.set(data);
        
        // Immediate sync to native host file
        debouncedSyncToNativeHostFile(folderId, true);

        // Notify all UIs to refresh
        broadcastToTabs({ 
            action: 'render_playlist', 
            folderId: folderId, 
            playlist: data.folders[folderId].playlist, 
            last_played_id: data.folders[folderId].last_played_id,
            isFolderActive: isFolderActive(folderId)
        });

        // Trigger live append if MPV is running
        const globalPrefs = data.settings.ui_preferences.global;
        if (globalPrefs.auto_append_on_add !== false) {
            callNativeHost({ 
                action: 'append', 
                url_item: newItem, 
                folderId: folderId 
            }).catch(() => {});
        }

        const logMessage = `[Background]: Added "${sanitizedTitle}" to folder '${folderId}'.`;
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
 */
async function _scrapeAndAddUrl(folderId, urlToAdd, tab, sender, skipYouTubeCheck = false) {
    const isYouTubeUrl = /youtube\.com\/(watch|playlist)/.test(urlToAdd);

    if (isYouTubeUrl && !skipYouTubeCheck) {
        broadcastLog({ text: `[Background]: YouTube URL detected. Scraping title via oEmbed...`, type: 'info' });
        try {
            const oEmbedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(urlToAdd)}&format=json`;
            const response = await fetch(oEmbedUrl);
            if (!response.ok) throw new Error(`oEmbed request failed: ${response.status}`);

            const videoDetails = await response.json();
            const isPlaylist = urlToAdd.includes('/playlist?list=');
            const itemTitle = videoDetails.title || (isPlaylist ? "YouTube Playlist" : "YouTube Video");
            const finalTitle = videoDetails.author_name ? `${videoDetails.author_name} - ${itemTitle}` : itemTitle;

            return await addUrlToFolder(folderId, urlToAdd, finalTitle, tab, sender);
        } catch (e) {
            broadcastLog({ text: `[Background]: YouTube oEmbed scrape failed: ${e.message}. Falling back to scanner.`, type: 'info' });
            return await _scrapeAndAddUrl(folderId, urlToAdd, tab, sender, true);
        }
    } else {
        broadcastLog({ text: `[Background]: Non-YouTube URL detected. Scanning for stream and title...`, type: 'info' });
        let scanResult;
        try {
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
            return await addUrlToFolder(folderId, urlToAdd, urlToAdd, tab, sender);
        } finally {
            if (scanResult?.scannerTab?.windowId) {
                chrome.windows.remove(scanResult.scannerTab.windowId).catch(() => {});
            }
        }
    }
}

export async function handleAdd(request, sender) {
    let tabId = request.tabId || sender.tab?.id;
    const folderId = request.folderId;
    let tab = request.tab || sender.tab; 

    if (!tab && tabId) {
        try { tab = await chrome.tabs.get(tabId); } catch (e) {}
    }
    if (!tab) {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        tab = activeTab;
        tabId = tab?.id;
    }

    const urlToProcess = request.data?.url || tab?.url;
    if (urlToProcess && scrapingInProgress.has(urlToProcess)) {
        return { success: true, message: 'Scraping already in progress.' };
    }

    if (!folderId) {
        return { success: false, error: 'Missing folderId for add action.' };
    }

    if (request.data?.url && request.data?.title) {
        scrapingInProgress.add(request.data.url);
        try {
            return await addUrlToFolder(folderId, request.data.url, request.data.title, tab, sender);
        } finally {
            scrapingInProgress.delete(request.data.url);
        }
    } else {
        const urlToScan = tab?.url;
        if (!urlToScan) {
            return { success: false, error: 'Cannot scrape this page. URL missing.' };
        }
        scrapingInProgress.add(urlToScan);
        try {
            return await _scrapeAndAddUrl(folderId, urlToScan, tab, sender);
        } finally {
            scrapingInProgress.delete(urlToScan);
        }
    }
}

export async function handleClear(request) {
    const data = await storage.get();
    const folderId = request.folderId;
    if (!data.folders[folderId]) return { success: false, error: "Folder not found." };

    data.folders[folderId].playlist = [];
    await storage.set(data);
    debouncedSyncToNativeHostFile(folderId, true);

    broadcastToTabs({ 
        action: 'render_playlist', 
        folderId: folderId, 
        playlist: [],
        isFolderActive: isFolderActive(folderId)
    });

    callNativeHost({ action: 'clear_live', folderId: folderId }).catch(() => {});
    return { success: true, message: `Playlist for '${folderId}' cleared.` };
}

export async function handleRemoveItem(request) {
    const data = await storage.get();
    const { folderId } = request;
    const indexToRemove = request.data?.index;
    
    if (data.folders[folderId] && typeof indexToRemove === 'number') {
        const playlist = data.folders[folderId].playlist;
        if (indexToRemove >= 0 && indexToRemove < playlist.length) {
            const itemToRemove = playlist[indexToRemove];
            playlist.splice(indexToRemove, 1);
            await storage.set(data);
            debouncedSyncToNativeHostFile(folderId, true);

            broadcastToTabs({ 
                action: 'render_playlist', 
                folderId: folderId, 
                playlist: playlist,
                last_played_id: data.folders[folderId].last_played_id,
                isFolderActive: isFolderActive(folderId)
            });

            if (data.settings.ui_preferences.global.live_removal !== false) {
                callNativeHost({ action: 'remove_item_live', folderId, item_id: itemToRemove.id }).catch(() => {});
            }
            return { success: true, message: 'Item removed.' };
        }
    }
    return { success: false, error: 'Invalid item index.' };
}

export async function handleSetPlaylistOrder(request) {
    const { folderId, data: { order } } = request;
    const storageData = await storage.get();
    if (!storageData.folders[folderId]) return { success: false };

    storageData.folders[folderId].playlist = order;
    await storage.set(storageData);
    debouncedSyncToNativeHostFile(folderId, true);

    broadcastToTabs({ 
        action: 'render_playlist', 
        folderId: folderId, 
        playlist: order,
        last_played_id: storageData.folders[folderId].last_played_id,
        isFolderActive: isFolderActive(folderId)
    });

    callNativeHost({ action: 'reorder_live', folderId, new_order: order }).catch(() => {});
    return { success: true };
}

export async function handleAddFromContextMenu(folderId, urlToAdd, title, tab) {
    if (scrapingInProgress.has(urlToAdd)) return { success: true };
    scrapingInProgress.add(urlToAdd);
    try {
        return await _scrapeAndAddUrl(folderId, urlToAdd, tab, null);
    } finally {
        scrapingInProgress.delete(urlToAdd);
    }
}

export async function handleGetPlaylist(request) {
    const data = await storage.get();
    const folder = data.folders[request.folderId] || { playlist: [], last_played_id: null };
    return { 
        success: true, 
        list: folder.playlist, 
        last_played_id: folder.last_played_id,
        isFolderActive: isFolderActive(request.folderId)
    };
}
