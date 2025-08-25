// --- Constants ---
const NATIVE_HOST_NAME = 'com.mpv_playlist_organizer.handler';

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

// --- Unified Storage Model ---

const STORAGE_KEY = 'mpv_organizer_data';

/**
 * Retrieves the single, unified data object from storage.
 * @returns {Promise<object>} A promise that resolves to the entire data object.
 */
async function getStorageData() {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    const storedValue = data[STORAGE_KEY];

    // Default structure if nothing is stored yet.
    if (!storedValue) {
        return {
            folders: { 'YT': { playlist: [] } },
            settings: {
                last_used_folder_id: 'YT',
                global_ui_state: { minimized: false },
                ui_preferences: {
                    mode: 'full',
                    logVisible: true,
                    pinned: false,
                    position: { top: '10px', left: 'auto', right: '10px', bottom: 'auto' },
                    launch_geometry: '', // Default: no geometry flag (e.g., '640x360', 'custom')
                    custom_geometry_width: '', // Custom width if launch_geometry is 'custom'
                    custom_geometry_height: '' // Custom height if launch_geometry is 'custom'
                }
            }
        };
    }
    // Ensure ui_preferences exists for users migrating from older versions
    if (!storedValue.settings.ui_preferences) {
        storedValue.settings.ui_preferences = {
            mode: 'full',
            logVisible: true,
            pinned: false,
            position: { top: '10px', left: 'auto', right: '10px', bottom: 'auto' },
            launch_geometry: '',
            custom_geometry_width: '',
            custom_geometry_height: ''
        };
    }
    // Ensure new geometry fields exist for older installations
    if (typeof storedValue.settings.ui_preferences.custom_geometry_width === 'undefined') {
        storedValue.settings.ui_preferences.custom_geometry_width = '';
        storedValue.settings.ui_preferences.custom_geometry_height = '';
    }
    return storedValue;
}

/**
 * Saves the single, unified data object to storage.
 * @param {object} data - The entire data object to save.
 */
async function setStorageData(data) {
    await chrome.storage.local.set({ [STORAGE_KEY]: data });
}

/**
 * Migrates data from the old multi-key format to the new single-object format.
 * This is non-destructive and only runs if old data is found.
 */
async function migrateStorageToOneObject() {
    const oldFolderIdsResult = await chrome.storage.local.get('folder_ids');
    // If 'folder_ids' key exists, we need to migrate.
    if (oldFolderIdsResult.folder_ids) {
        console.log("Old storage format detected. Migrating to unified object...");
        const newData = { folders: {}, settings: {} };
        const keysToRemove = ['folder_ids'];

        for (const folderId of oldFolderIdsResult.folder_ids) {
            const folderKey = `folder_${folderId}`;
            const folderDataResult = await chrome.storage.local.get(folderKey);
            const storedValue = folderDataResult[folderKey];
            // Handle legacy formats during migration
            const playlist = Array.isArray(storedValue) ? storedValue : (storedValue?.playlist || storedValue?.urls || []);
            newData.folders[folderId] = { playlist };
            keysToRemove.push(folderKey);
        }

        const lastFolder = await chrome.storage.local.get('last_used_folder_id');
        newData.settings.last_used_folder_id = lastFolder.last_used_folder_id || 'YT';
        keysToRemove.push('last_used_folder_id');

        await setStorageData(newData);
        await chrome.storage.local.remove(keysToRemove);
        console.log("Storage migration complete. Old keys removed.");
    }
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
 * Broadcasts a log message to all content scripts and the popup.
 * @param {object} logObject - The log object to send (e.g., {text: '...', type: 'info'}).
 */
function broadcastLog(logObject) {
    const message = { log: logObject };
    // Send to all tabs
    chrome.tabs.query({}, (tabs) => {
        for (const tab of tabs) {
            chrome.tabs.sendMessage(tab.id, message).catch(() => {});
        }
    });
    // Send to other extension contexts (like the popup).
    // This is safe because listeners should ignore messages they aren't meant to process.
    chrome.runtime.sendMessage(message).catch(() => {});
}

// --- Native Host Communication (using a persistent connection) ---

const ConnectionStatus = {
    DISCONNECTED: 'DISCONNECTED',
    CONNECTING: 'CONNECTING',
    CONNECTED: 'CONNECTED',
};

let tabUiState = {}; // Tracks the minimized state of the UI for each tab
let nativePort = null;
let connectionStatus = ConnectionStatus.DISCONNECTED;
let requestPromises = {}; // Stores { resolve, reject } for ongoing requests
let requestIdCounter = 0; // Simple counter for unique request IDs
let connectionPromise = null; // A promise that resolves when connection is established

/**
 * Establishes a persistent connection to the native host.
 * This function is designed to be called only once while a connection is being attempted.
 * @returns {Promise<void>} A promise that resolves when the connection is successful or rejects if it fails.
 */
function connectToNativeHost() {
    if (connectionStatus !== ConnectionStatus.DISCONNECTED) {
        return connectionPromise;
    }

    connectionStatus = ConnectionStatus.CONNECTING;
    broadcastLog({ text: `[Background]: Connecting to native host...`, type: 'info' });

    connectionPromise = new Promise((resolve, reject) => {
        nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);

        const onDisconnect = () => {
            const errorMessage = chrome.runtime.lastError ? chrome.runtime.lastError.message : "Native host disconnected.";
            console.error("Native host disconnected:", errorMessage);
            broadcastLog({ text: `[Background]: Native host disconnected. It may need to be re-installed. Error: ${errorMessage}`, type: 'error' });

            // Reject all pending promises
            for (const id in requestPromises) {
                requestPromises[id].reject(new Error(`Native host disconnected: ${errorMessage}`));
            }

            nativePort = null;
            connectionStatus = ConnectionStatus.DISCONNECTED;
            requestPromises = {};
            reject(new Error(errorMessage)); // Reject the connection promise itself
        };

        nativePort.onDisconnect.addListener(onDisconnect);

        nativePort.onMessage.addListener((response) => {
            const { request_id, ...responseData } = response;
            if (request_id && requestPromises[request_id]) {
                requestPromises[request_id].resolve(responseData);
                delete requestPromises[request_id];
            } else {
                console.warn("Received message from native host without a matching request ID:", response);
            }
        });

        // If we reach here without onDisconnect being called immediately, the connection is likely established.
        connectionStatus = ConnectionStatus.CONNECTED;
        broadcastLog({ text: `[Background]: Successfully connected to native host.`, type: 'info' });
        resolve();
    });

    return connectionPromise;
}

/**
 * Sends a message to the native host, handling connection logic automatically.
 * @param {object} message - The message to send to the native host.
 * @returns {Promise<object>} A promise that resolves with the native host's response.
 */
async function callNativeHost(message) {
    return new Promise((resolve, reject) => {
        // This function ensures the connection is ready before proceeding.
        const ensureConnectedAndSend = async () => {
            if (connectionStatus !== ConnectionStatus.CONNECTED) {
                // Wait for the connection to be established or fail.
                await connectToNativeHost();
            }

            const requestId = `req_${requestIdCounter++}`;
            requestPromises[requestId] = { resolve, reject };
            const messageToSend = { ...message, request_id: requestId };

            try {
                nativePort.postMessage(messageToSend);
            } catch (e) {
                const errorMessage = `Failed to send message to native host. It may have disconnected. Error: ${e.message}`;
                reject(new Error(errorMessage));
                delete requestPromises[requestId];
                // The onDisconnect listener will handle resetting the state.
            }
        };

        // Execute the logic and catch any errors from connection or sending.
        ensureConnectedAndSend().catch(reject);
    }).then(response => {
        // This part runs after the promise from the native host resolves. Log the outcome.
        const logType = response.success ? 'info' : 'error';
        const logMessage = response.message || response.error || 'Received response from native host.';
        broadcastLog({ text: `[Native Host]: ${logMessage}`, type: logType });
        return response;
    }).catch(error => {
        // This part runs if the promise was rejected (e.g., disconnect, postMessage error).
        const errorMessage = `Could not communicate with native host. Error: ${error.message}`;
        console.error(errorMessage);
        broadcastLog({ text: `[Background]: ${errorMessage}`, type: 'error' });
        return { success: false, error: errorMessage };
    });
}

/**
 * Gathers all folder data from chrome.storage.local and sends it to the
 * native host to be written to the folders.json file. This keeps the
 * CLI and the extension in sync.
 */
async function syncDataToNativeHostFile() {
    const data = await getStorageData();
    try {
        await callNativeHost({
            action: 'export_data',
            data: data.folders // Only send the folders object
        });
    } catch (e) {
        const errorMessage = `Failed to sync data to native host file: ${e.message}`;
        console.error(errorMessage);
        broadcastLog({ text: `[Background]: ${errorMessage}`, type: 'error' });
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
    const data = await getStorageData();
    const folderIds = Object.keys(data.folders);

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
    // If this is a log message being broadcast, the background script should ignore it
    // to prevent an infinite loop or trying to process it as a command.
    if (request.log) {
        return; // Not a command for the background script.
    }

    // Use an async IIFE to handle promises and send responses correctly,
    // now that the log messages are filtered out.
    (async () => {
        try {
            switch (request.action) {
                // --- UI State Management ---
                case 'content_script_init': { // From content.js on load
                    const tabId = sender.tab?.id;
                    if (tabId) {
                        const data = await getStorageData();
                        if (!data.settings.global_ui_state.minimized) {
                            // If UI is not globally minimized, tell it to show itself.
                            chrome.tabs.sendMessage(tabId, { action: 'show_ui' }).catch(() => {});
                        }
                    }
                    break; // No response needed
                }
                case 'set_ui_minimized_state': { // From content.js on minimize/show
                    // This is now a global state, not per-tab, and is persisted.
                    const data = await getStorageData();
                    data.settings.global_ui_state.minimized = request.minimized;
                    await setStorageData(data);
                    // Broadcast the change to all tabs so they can sync their visibility.
                    broadcastToTabs({ action: 'apply_minimize_state', minimized: request.minimized });
                    sendResponse({ success: true });
                    break;
                }
                case 'get_ui_state_for_tab': { // From popup.js on open
                    const tabId = request.tabId;
                    const data = await getStorageData();
                    const tabState = tabUiState[tabId] || {}; // Get tab-specific data like detectedUrl
                    const combinedState = {
                        minimized: data.settings.global_ui_state.minimized,
                        detectedUrl: tabState.detectedUrl,
                    };
                    sendResponse({ success: true, state: combinedState });
                    break;
                }
                case 'is_mpv_running': { // New action to check MPV status
                    const response = await callNativeHost({ action: 'is_mpv_running' });
                    sendResponse(response);
                    break;
                }
                case 'report_detected_url': { // From content.js
                    const tabId = sender.tab?.id;
                    if (tabId) {
                        if (!tabUiState[tabId]) tabUiState[tabId] = {};
                        tabUiState[tabId].detectedUrl = request.url;
                    }
                    // No response needed, and no re-broadcast.
                    break;
                }
                case 'set_last_folder_id': { // From content.js when user changes folder
                    if (request.folderId) {
                        const data = await getStorageData();
                        data.settings.last_used_folder_id = request.folderId;
                        await setStorageData(data);
                        sendResponse({ success: true });
                    } else {
                        sendResponse({ success: false, error: 'No folderId provided.' });
                    }
                    break;
                }
                case 'get_last_folder_id': { // From content.js on init
                    const data = await getStorageData();
                    const folderId = data.settings.last_used_folder_id || Object.keys(data.folders)[0];
                    sendResponse({ success: true, folderId });
                    break;
                }
                // --- UI Preferences (from content.js) ---
                case 'get_ui_preferences': {
                    const data = await getStorageData();
                    sendResponse({ success: true, preferences: data.settings.ui_preferences });
                    break;
                }
                case 'set_ui_preferences': {
                    const data = await getStorageData();
                    // Merge the new preferences with the existing ones
                    data.settings.ui_preferences = { ...data.settings.ui_preferences, ...request.preferences };
                    await setStorageData(data);
                    // Broadcast the change to all other tabs so they can sync their UI.
                    broadcastToTabs({ action: 'apply_ui_preferences', preferences: data.settings.ui_preferences });
                    sendResponse({ success: true }); // No need to send data back
                    break;
                }
                // --- Folder Management Actions (from popup.js) ---
                case 'create_folder': {
                    if (!request.folderId || !request.folderId.trim()) {
                        sendResponse({ success: false, error: 'Folder name cannot be empty.' });
                        return;
                    }
                    const data = await getStorageData();
                    if (data.folders[request.folderId]) {
                        sendResponse({ success: false, error: 'A folder with that name already exists.' });
                        return;
                    }
                    data.folders[request.folderId] = { playlist: [] };
                    await setStorageData(data);
                    updateContextMenus(); // Update context menus with the new folder
                    broadcastToTabs({ foldersChanged: true });
                    debouncedSyncToNativeHostFile();
                    sendResponse({ success: true, message: `Folder "${request.folderId}" created.` });
                    break;
                }
                case 'get_all_folder_ids': {
                    const data = await getStorageData();
                    const folderIds = Object.keys(data.folders);
                    sendResponse({ success: true, folderIds });
                    break;
                }

                case 'remove_folder': {
                    const folderIdToRemove = request.folderId;
                    if (!folderIdToRemove) {
                        sendResponse({ success: false, error: 'Invalid folder ID provided.' });
                        return;
                    }

                    const data = await getStorageData();
                    const folderIds = Object.keys(data.folders);

                    if (folderIds.length <= 1 && data.folders[folderIdToRemove]) {
                        sendResponse({ success: false, error: 'Cannot remove the last folder.' });
                        return;
                    }
                    if (!data.folders[folderIdToRemove]) {
                        sendResponse({ success: false, error: 'Folder not found.' });
                        return;
                    }

                    delete data.folders[folderIdToRemove];

                    // If the removed folder was the last one used, update the setting
                    // to point to the first available folder to prevent errors.
                    if (data.settings.last_used_folder_id === folderIdToRemove) {
                        data.settings.last_used_folder_id = Object.keys(data.folders)[0];
                    }
                    await setStorageData(data);

                    updateContextMenus(); // Update context menus to remove the folder
                    broadcastToTabs({ foldersChanged: true });
                    debouncedSyncToNativeHostFile();
                    sendResponse({ success: true, message: `Folder "${folderIdToRemove}" removed.` });
                    break;
                }

                // --- Playlist Item Actions (from content.js) ---
                case 'add': {
                    // The tabId now comes from the popup's payload for mini-controller actions,
                    // or from the sender for on-page controller actions.
                    const tabId = request.tabId || sender.tab?.id;
                    const urlToAdd = tabId ? tabUiState[tabId]?.detectedUrl : null;

                    if (!urlToAdd) {
                        sendResponse({ success: false, error: 'No URL detected on the page to add.' });
                        return;
                    }

                    const data = await getStorageData();
                    data.folders[request.folderId].playlist.push(urlToAdd);
                    await setStorageData(data);

                    broadcastToTabs({ action: 'render_playlist', folderId: request.folderId, playlist: data.folders[request.folderId].playlist });
                    debouncedSyncToNativeHostFile();
                    sendResponse({ success: true, message: `Added to playlist in folder: ${request.folderId}` });
                    break;
                }

                case 'get_playlist': {
                    const data = await getStorageData();
                    const folder = data.folders[request.folderId] || { playlist: [] };
                    sendResponse({ success: true, list: folder.playlist });
                    break;
                }

                case 'clear': {
                    const data = await getStorageData();
                    data.folders[request.folderId].playlist = [];
                    await setStorageData(data);
                    broadcastToTabs({ action: 'render_playlist', folderId: request.folderId, playlist: [] });
                    debouncedSyncToNativeHostFile();
                    sendResponse({ success: true, message: `Playlist in folder ${request.folderId} cleared` });
                    break;
                }

                case 'remove_item': {
                    const data = await getStorageData();
                    const playlist = data.folders[request.folderId].playlist;
                    const indexToRemove = request.data?.index;
                    if (typeof indexToRemove === 'number' && indexToRemove >= 0 && indexToRemove < playlist.length) {
                        playlist.splice(indexToRemove, 1);
                        await setStorageData(data);
                        broadcastToTabs({ action: 'render_playlist', folderId: request.folderId, playlist: playlist });
                        debouncedSyncToNativeHostFile();
                        sendResponse({ success: true, message: 'Item removed.' });
                    } else {
                        sendResponse({ success: false, error: 'Invalid item index.' });
                    }
                    break;
                }

                // --- MPV Actions (from content.js) ---
                case 'play': {
                    const data = await getStorageData();
                    const playlist = data.folders[request.folderId]?.playlist;
                    let geometry = data.settings.ui_preferences.launch_geometry;
                    const customWidth = data.settings.ui_preferences.custom_geometry_width;
                    const customHeight = data.settings.ui_preferences.custom_geometry_height;

                    if (!playlist || playlist.length === 0) {
                        const message = `Playlist in folder '${request.folderId}' is empty. Nothing to play.`;
                        broadcastLog({ text: `[Background]: ${message}`, type: 'error' });
                        sendResponse({ success: false, error: message });
                        return;
                    }

                    const response = await callNativeHost({
                        action: 'play',
                        folderId: request.folderId, // Pass the folder ID
                        playlist: playlist, // Pass the playlist
                        // Pass custom dimensions if 'custom' is selected, otherwise pass the predefined geometry string
                        geometry: geometry === 'custom' ? null : geometry,
                        custom_width: geometry === 'custom' ? customWidth : null,
                        custom_height: geometry === 'custom' ? customHeight : null
                    });
                    sendResponse(response);
                    break;
                }

                case 'close_mpv': {
                    const response = await callNativeHost({ action: 'close_mpv' });
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
    // On first install or update, run the storage migration to ensure data is in the new format.
    if (details.reason === 'install' || details.reason === 'update') {
        await migrateStorageToOneObject();
    }

    // Create context menu for the action icon (toolbar button)
    // This allows the user to bring back the UI if it has been minimized.
    chrome.contextMenus.create({
        id: 'show-controller-action',
        title: 'Show Controller UI',
        contexts: ['action']
    });

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
                const data = await getStorageData();
                data.folders[folderId].playlist.push(urlToAdd);
                await setStorageData(data);
                debouncedSyncToNativeHostFile();

                // Notify content scripts to re-render their lists
                broadcastToTabs({ action: 'render_playlist', folderId: folderId, playlist: data.folders[folderId].playlist });
                
                // Also provide some feedback in the log
                const logMessage = `[Background]: Added URL to folder '${folderId}' via context menu.`;
                broadcastLog({ text: logMessage, type: 'info' });
            } catch (e) {
                const logMessage = `[Background]: Error adding to folder '${folderId}' via context menu: ${e.message}`;
                broadcastLog({ text: logMessage, type: 'error' });
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
    if (tabUiState[tabId]) {
        delete tabUiState[tabId];
    }
    if (lastDetectedUrls[tabId]) {
        delete lastDetectedUrls[tabId];
    }
});

// When a tab is reloaded or navigates to a new page, clear its cached M3U8 URL.
// This ensures that if the same stream is present on the new page, it will be detected again.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'loading') {
        // A new page is loading, so reset the stream detection caches for this tab.
        // The minimized state is intentionally NOT cleared to make it persistent.
        if (lastDetectedUrls[tabId]) delete lastDetectedUrls[tabId];
        if (tabUiState[tabId]) tabUiState[tabId].detectedUrl = null;
    }
});
