// --- Constants ---
const NATIVE_HOST_NAME = 'com.mpv_playlist_organizer.handler'; // IMPORTANT: This must match the name in your native host manifest JSON.

// --- Debounce Utility ---
/**
 * Creates a debounced function that delays invoking `func` until after `wait`
 * milliseconds have elapsed since the last time the debounced function was
 * invoked.
 * @param {Function} func The function to debounce.
 * @param {number} wait The number of milliseconds to delay.
 * @returns {Function} Returns the new debounced function.
 */
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func.apply(this, args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// --- Storage Helpers ---

/**
 * Retrieves all folder IDs from storage.
 * @returns {Promise<string[]>} A promise that resolves to an array of folder IDs.
 */
async function getAllFolderIds() {
    const data = await chrome.storage.local.get('folder_ids');
    // Ensure 'YT' folder always exists as a default.
    if (!data.folder_ids || !data.folder_ids.includes('YT')) {
        const existingIds = data.folder_ids || [];
        const newIds = ['YT', ...existingIds];
        await chrome.storage.local.set({ folder_ids: newIds });
        return newIds;
    }
    return data.folder_ids;
}

/**
 * Retrieves a specific folder's data object from storage.
 * @param {string} folderId - The ID of the folder to retrieve.
 * @returns {Promise<{playlist: string[], last_played_pos: number}>} A promise that resolves to the folder data object.
 */
async function getFolderData(folderId) {
    const key = `folder_${folderId}`;
    const data = await chrome.storage.local.get(key);
    const storedValue = data[key];

    // Case 1: Nothing stored for this key. Return default structure.
    if (!storedValue) {
        return { playlist: [], last_played_pos: 0 };
    }

    // Case 2: Already in the new format. Return as is.
    if (Array.isArray(storedValue.playlist)) {
        // Ensure last_played_pos exists to be safe
        return {
            playlist: storedValue.playlist,
            last_played_pos: storedValue.last_played_pos || 0
        };
    }

    // Case 3: Legacy format (either a raw array of URLs, or an object with a `urls` property).
    // We need to convert it to the new format.
    const playlist = Array.isArray(storedValue) ? storedValue : storedValue.urls || [];
    const last_played_pos = storedValue.last_played_pos || 0;

    return { playlist, last_played_pos };
}

/**
 * Saves a specific folder's data object to storage.
 * @param {string} folderId - The ID of the folder to save.
 * @param {{playlist: string[], last_played_pos: number}} folderData - The folder data object to save.
 */
async function saveFolderData(folderId, folderData) {
    const key = `folder_${folderId}`;
    await chrome.storage.local.set({ [key]: folderData });
}

/**
 * Wraps chrome.runtime.sendNativeMessage in a Promise for async/await.
 * @param {string} hostName - The name of the native messaging host.
 * @param {object} message - The message to send to the native host.
 * @returns {Promise<object>} A promise that resolves with the native host's response.
 */
function sendNativeMessagePromise(hostName, message) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendNativeMessage(hostName, message, (response) => {
            if (chrome.runtime.lastError) {
                return reject(chrome.runtime.lastError);
            }
            resolve(response);
        });
    });
}
// --- Messaging Helper ---

/**
 * Broadcasts a message to all content scripts in open tabs.
 * @param {object} message - The message object to send.
 */
function broadcastToTabs(message) {
    chrome.tabs.query({}, (tabs) => {
        for (const tab of tabs) {
            // Attempt to send the message, but ignore errors if the content script isn't injected.
            chrome.tabs.sendMessage(tab.id, message).catch(() => {});
        }
    });
}

/**
 * A wrapper for sending a message to the native host that includes
 * centralized error handling and logging.
 * @param {object} message - The message to send to the native host.
 * @returns {Promise<object>} A promise that resolves with the native host's response.
 */
async function callNativeHost(message) {
    try {
        const response = await sendNativeMessagePromise(NATIVE_HOST_NAME, message);
        const logType = response.success ? 'info' : 'error';
        const logMessage = response.message || response.error || 'Received response from native host.';
        broadcastToTabs({ log: { text: `[Native Host]: ${logMessage}`, type: logType } });
        return response;
    } catch (error) {
        const errorMessage = `Could not connect to native host. Ensure it's installed correctly. Error: ${error.message}`;
        console.error(errorMessage);
        broadcastToTabs({ log: { text: `[Background]: ${errorMessage}`, type: 'error' } });
        return { success: false, error: errorMessage };
    }
}

/**
 * Gathers all folder data from chrome.storage.local and sends it to the
 * native host to be written to the folders.json file. This keeps the
 * CLI and the extension in sync.
 */
async function syncDataToNativeHostFile() {
    try {
        const allFolderIds = await getAllFolderIds();
        const allFoldersData = {};

        for (const id of allFolderIds) {
            allFoldersData[id] = await getFolderData(id);
        }

        await callNativeHost({
            action: 'export_data',
            data: allFoldersData
        });
    } catch (e) {
        const errorMessage = `Failed to sync data to native host file: ${e.message}`;
        console.error(errorMessage);
        broadcastToTabs({ log: { text: `[Background]: ${errorMessage}`, type: 'error' } });
    }
}

// Debounce the sync function to avoid rapid-fire writes to the native host.
// A 1-second delay is reasonable. If multiple changes happen in quick succession,
// it will only sync once after the user is done.
const debouncedSyncToNativeHostFile = debounce(syncDataToNativeHostFile, 1000);

// --- Context Menu Management ---

/**
 * Creates or updates the context menus for adding URLs to folders.
 */
async function updateContextMenus() {
    // Use a promise-based wrapper for the callback API for cleaner async/await syntax.
    await new Promise(resolve => chrome.contextMenus.removeAll(resolve));
    
    const folderIds = await getAllFolderIds();

    // Create a parent menu item.
    chrome.contextMenus.create({
        id: 'add-to-mpv-parent',
        title: 'Add to MPV Folder',
        contexts: ['link', 'video', 'audio', 'page']
    });

    if (folderIds.length > 0) {
        // Create a submenu for each folder.
        folderIds.forEach(id => {
            chrome.contextMenus.create({
                id: `add-to-folder-${id}`,
                parentId: 'add-to-mpv-parent',
                title: `Add to folder: "${id}"`,
                contexts: ['link', 'video', 'audio', 'page']
            });
        });
    } else {
        // If there are no queues, show a disabled placeholder item.
        chrome.contextMenus.create({
            id: 'no-queues',
            parentId: 'add-to-mpv-parent',
            title: 'No folders available. Create one first.',
            enabled: false,
            contexts: ['link', 'video', 'audio', 'page']
        });
    }
}
// --- Main Message Listener ---

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // Use an async IIFE to handle promises and send responses correctly.
    (async () => {
        try {
            switch (request.action) {
                // --- Folder Management Actions (from popup.js) ---
                case 'create_folder': {
                    if (!request.folderId || !request.folderId.trim()) {
                        sendResponse({ success: false, error: 'Folder name cannot be empty.' });
                        return;
                    }
                    const allIds = await getAllFolderIds();
                    if (allIds.includes(request.folderId)) {
                        sendResponse({ success: false, error: 'A folder with that name already exists.' });
                        return;
                    }
                    allIds.push(request.folderId);
                    await chrome.storage.local.set({ folder_ids: allIds });
                    await saveFolderData(request.folderId, { playlist: [], last_played_pos: 0 });
                    updateContextMenus(); // Update context menus with the new folder
                    broadcastToTabs({ foldersChanged: true });
                    debouncedSyncToNativeHostFile();
                    sendResponse({ success: true, message: `Folder "${request.folderId}" created.` });
                    break;
                }

                case 'get_all_folder_ids': {
                    const folderIds = await getAllFolderIds();
                    sendResponse({ success: true, folderIds });
                    break;
                }

                case 'remove_folder': {
                    const folderIdToRemove = request.folderId;
                    if (!folderIdToRemove) {
                        sendResponse({ success: false, error: 'Invalid folder ID provided.' });
                        return;
                    }

                    const allIdsBeforeRemove = await getAllFolderIds();
                    if (allIdsBeforeRemove.length <= 1 && allIdsBeforeRemove.includes(folderIdToRemove)) {
                        sendResponse({ success: false, error: 'Cannot remove the last folder.' });
                        return;
                    }
                    
                    if (!allIdsBeforeRemove.includes(folderIdToRemove)) {
                        sendResponse({ success: false, error: 'Folder not found.' });
                        return;
                    }

                    // Remove the folder ID
                    const allIds = allIdsBeforeRemove.filter(id => id !== folderIdToRemove);
                    await chrome.storage.local.set({ folder_ids: allIds });

                    // Remove the playlist data
                    await chrome.storage.local.remove(`folder_${folderIdToRemove}`);

                    updateContextMenus(); // Update context menus to remove the folder
                    broadcastToTabs({ foldersChanged: true });
                    debouncedSyncToNativeHostFile();
                    sendResponse({ success: true, message: `Folder "${folderIdToRemove}" removed.` });
                    break;
                }

                // --- Playlist Item Actions (from content.js) ---
                case 'add': {
                    const folderData = await getFolderData(request.folderId);
                    folderData.playlist.push(request.url);
                    await saveFolderData(request.folderId, folderData);
                    // Broadcast the updated list to all tabs
                    broadcastToTabs({ action: 'render_playlist', folderId: request.folderId, playlist: folderData.playlist });
                    debouncedSyncToNativeHostFile();
                    sendResponse({ success: true, message: `Added to playlist in folder: ${request.folderId}` });
                    break;
                }

                case 'get_playlist': {
                    const { playlist } = await getFolderData(request.folderId);
                    sendResponse({ success: true, list: playlist });
                    break;
                }

                case 'clear': {
                    // Reset the playlist and the last played position.
                    await saveFolderData(request.folderId, { playlist: [], last_played_pos: 0 });
                    broadcastToTabs({ action: 'render_playlist', folderId: request.folderId, playlist: [] });
                    debouncedSyncToNativeHostFile();
                    sendResponse({ success: true, message: `Playlist in folder ${request.folderId} cleared` });
                    break;
                }

                case 'remove_item': {
                    const folderData = await getFolderData(request.folderId);
                    const indexToRemove = request.data?.index;
                    if (typeof indexToRemove === 'number' && indexToRemove >= 0 && indexToRemove < folderData.playlist.length) {
                        folderData.playlist.splice(indexToRemove, 1);
                        // If we remove an item before the last played position, we need to adjust the position.
                        if (folderData.last_played_pos > 0 && indexToRemove < folderData.last_played_pos) {
                            folderData.last_played_pos--;
                        } else if (indexToRemove === folderData.last_played_pos && folderData.last_played_pos >= folderData.playlist.length) {
                            // If we removed the last item which was also the last played, reset to 0.
                            folderData.last_played_pos = 0;
                        }
                        await saveFolderData(request.folderId, folderData);
                        broadcastToTabs({ action: 'render_playlist', folderId: request.folderId, playlist: folderData.playlist });
                        debouncedSyncToNativeHostFile();
                        sendResponse({ success: true, message: 'Item removed.' });
                    } else {
                        sendResponse({ success: false, error: 'Invalid item index.' });
                    }
                    break;
                }

                // --- MPV Actions (from content.js) ---
                case 'play': {
                    const folderData = await getFolderData(request.folderId);
                    const { playlist, last_played_pos } = folderData;

                    if (!playlist || playlist.length === 0) {
                        const message = `Playlist in folder '${request.folderId}' is empty. Nothing to play.`;
                        broadcastToTabs({ log: { text: `[Background]: ${message}`, type: 'error' } });
                        sendResponse({ success: false, error: message });
                        return;
                    }

                    const response = await callNativeHost({
                        action: 'play',
                        playlist: playlist,
                        start_index: last_played_pos || 0
                    });
                    sendResponse(response);
                    break;
                }
                case 'stop': {
                    const response = await callNativeHost({ action: 'stop' });

                    // After stopping, save the last played position if available.
                    if (response.success && typeof response.playlist_pos === 'number' && response.playlist_pos >= 0) {
                        const folderData = await getFolderData(request.folderId);
                        const playlistLength = folderData.playlist.length;
                        let new_pos = response.playlist_pos;

                        // If mpv reports a position equal to length, it means it finished the last track.
                        // Reset to 0 so next play starts from the beginning.
                        if (playlistLength > 0 && new_pos >= playlistLength) {
                            new_pos = 0;
                        }
                        if (folderData.last_played_pos !== new_pos) {
                            folderData.last_played_pos = new_pos;
                            await saveFolderData(request.folderId, folderData);
                            const logMessage = `[Background]: Saved position ${new_pos} for folder '${request.folderId}'.`;
                            broadcastToTabs({ log: { text: logMessage, type: 'info' } });
                        }
                    }
                    sendResponse(response);
                    break;
                }
                default:
                    sendResponse({ success: false, error: 'Unknown action.' });
                    break;
            }
        } catch (e) {
            console.error(`Error handling action '${request.action}':`, e);
            sendResponse({ success: false, error: e.message });
        }
    })();

    return true; // Required for async sendResponse.
});

// --- Initial Setup ---
// On install, ensure the default 'YT' folder exists and set up context menus.
chrome.runtime.onInstalled.addListener(async (details) => {
    // Create context menu for the action icon (toolbar button)
    // This allows the user to bring back the UI if it has been minimized.
    chrome.contextMenus.create({
        id: 'show-controller-action',
        title: 'Show Controller UI',
        contexts: ['action']
    });

    await getAllFolderIds(); // This ensures 'YT' exists.
    await updateContextMenus(); // Create the context menus for pages.
    await syncDataToNativeHostFile(); // Sync data on first install/update.
    console.log("MPV Handler extension installed and initialized.");
});

// --- Context Menu Click Handler ---
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    const { menuItemId } = info;

    // Handle showing the controller UI from the action's context menu
    if (menuItemId === 'show-controller-action') {
        if (tab && tab.id) {
            chrome.tabs.sendMessage(tab.id, { action: 'show_ui' })
                .catch(error => {
                    // This error is expected if the content script isn't injected on the page
                    // (e.g., chrome:// pages, or the store page).
                    if (!error.message.includes('Receiving end does not exist')) {
                        console.error(`[Background]: Error sending show_ui message to tab ${tab.id}:`, error);
                    }
                });
        }
        return; // Stop processing
    }

    if (typeof menuItemId === 'string' && menuItemId.startsWith('add-to-folder-')) {
        const folderId = menuItemId.substring('add-to-folder-'.length);
        
        // Determine the URL from the context info, preferring the most specific source.
        const urlToAdd = info.linkUrl || info.srcUrl || info.pageUrl;

        if (urlToAdd) {
            try {
                const folderData = await getFolderData(folderId);
                folderData.playlist.push(urlToAdd);
                await saveFolderData(folderId, folderData);
                debouncedSyncToNativeHostFile();

                // Notify content scripts to re-render their lists
                broadcastToTabs({ action: 'render_playlist', folderId: folderId, playlist: folderData.playlist });
                
                // Also provide some feedback in the log
                const logMessage = `[Background]: Added URL to folder '${folderId}' via context menu.`;
                broadcastToTabs({ log: { text: logMessage, type: 'info' } });
            } catch (e) {
                const logMessage = `[Background]: Error adding to folder '${folderId}' via context menu: ${e.message}`;
                broadcastToTabs({ log: { text: logMessage, type: 'error' } });
            }
        }
    }
});

// --- M3U8 Stream Detection ---

// A simple in-memory cache to avoid sending the same URL repeatedly to a tab.
// The key is the tabId, and the value is the last detected URL.
const lastDetectedUrls = {};

chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
        // We need response headers for this listener.
        if (!details.responseHeaders) {
            return;
        }

        // Check 1: Look for a specific M3U8 Content-Type header. This is the most reliable method.
        const contentTypeHeader = details.responseHeaders.find(
            (header) => header.name.toLowerCase() === 'content-type'
        );

        const isM3U8ContentType = contentTypeHeader && (
            contentTypeHeader.value.includes('application/vnd.apple.mpegurl') ||
            contentTypeHeader.value.includes('application/x-mpegURL') ||
            contentTypeHeader.value.includes('audio/mpegurl') ||
            contentTypeHeader.value.includes('audio/x-mpegurl')
        );

        // Check 2: As a fallback, check if the URL path ends with .m3u8.
        // This handles misconfigured servers that don't send the correct Content-Type.
        // We parse the URL to ignore query parameters (e.g., .m3u8?token=...).
        let isM3U8Url = false;
        try {
            const url = new URL(details.url);
            isM3U8Url = url.pathname.endsWith('.m3u8');
        } catch (e) {
            // Invalid URL, ignore.
        }

        if (isM3U8ContentType || isM3U8Url) {
            // Avoid sending the same URL repeatedly for the same tab.
            if (lastDetectedUrls[details.tabId] === details.url) {
                return; // We've already sent this one.
            }
            lastDetectedUrls[details.tabId] = details.url;

            // Log to the service worker console for debugging.
            console.log(`[Background]: Detected M3U8 stream: ${details.url} in tab ${details.tabId}`);

            // Send the detected URL to the content script of the tab where the request originated.
            chrome.tabs.sendMessage(details.tabId, { m3u8: details.url })
                .catch(error => {
                    // This error is expected if the content script isn't injected on the page.
                    if (!error.message.includes('Receiving end does not exist')) {
                        console.error(`[Background]: Error sending M3U8 URL to tab ${details.tabId}:`, error);
                    }
                });
        }
    },
    {
        urls: ["<all_urls>"],
        // 'xmlhttprequest' and 'other' are common types for HLS manifests.
        types: ["xmlhttprequest", "other", "media"]
    },
    // We need 'responseHeaders' to check the Content-Type.
    ["responseHeaders"]
);

// Clean up the cache when a tab is closed to prevent memory leaks.
chrome.tabs.onRemoved.addListener((tabId) => {
    if (lastDetectedUrls[tabId]) {
        delete lastDetectedUrls[tabId];
    }
});

// When a tab is reloaded or navigates to a new page, clear its cached M3U8 URL.
// This ensures that if the same stream is present on the new page, it will be detected again.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading' && lastDetectedUrls[tabId]) {
        delete lastDetectedUrls[tabId];
    }
});