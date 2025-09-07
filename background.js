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

class StorageManager {
    constructor(storageKey) {
        this.STORAGE_KEY = storageKey;
        this.initPromise = null;
    }

    /**
     * Initializes the storage manager, running all necessary data migrations.
     * This must be called once at startup before other methods are used.
     * @returns {Promise<void>}
     */
    initialize() {
        if (this.initPromise) {
            return this.initPromise;
        }
        this.initPromise = (async () => {
            await this._migrateStorageToOneObject();
            await this._runDataMigrations();
        })();
        return this.initPromise;
    }

    _getDefaultData() {
        return {
            folders: { 'YT': { playlist: [] } },
            folderOrder: ['YT'],
            settings: {
                last_used_folder_id: 'YT',
                ui_preferences: {
                    global: {
                        minimized: false, mode: 'full', logVisible: true, pinned: false,
                        position: { top: '10px', left: 'auto', right: '10px', bottom: 'auto' },
                        launch_geometry: '', custom_geometry_width: '', custom_geometry_height: '',
                        custom_mpv_flags: '', show_play_new_button: false, duplicate_url_behavior: 'ask',
                        stream_scanner_timeout: 60, confirm_remove_folder: true, confirm_clear_playlist: true,
                        confirm_close_mpv: true, confirm_play_new: true, clear_on_completion: false,
                    },
                    domains: {}
                }
            }
        };
    }

    async get() {
        const data = await chrome.storage.local.get(this.STORAGE_KEY);
        return data[this.STORAGE_KEY] || this._getDefaultData();
    }

    async set(data) {
        await chrome.storage.local.set({ [this.STORAGE_KEY]: data });
    }

    async _runDataMigrations() {
        const data = await chrome.storage.local.get(this.STORAGE_KEY);
        let storedValue = data[this.STORAGE_KEY];
        let needsUpdate = false;

        if (!storedValue) {
            storedValue = this._getDefaultData();
            needsUpdate = true;
        } else {
            if (!storedValue.settings) {
                storedValue.settings = {};
                needsUpdate = true;
            }
            if (!storedValue.settings.ui_preferences) {
                storedValue.settings.ui_preferences = { global: {}, domains: {} };
                needsUpdate = true;
            }
            if (typeof storedValue.settings.ui_preferences.global === 'undefined') {
                needsUpdate = true;
                const oldPrefs = storedValue.settings.ui_preferences || {};
                storedValue.settings.ui_preferences = { global: oldPrefs, domains: {} };
            }

            const globalPrefs = storedValue.settings.ui_preferences.global;

            if (storedValue.settings.global_ui_state) {
                needsUpdate = true;
                globalPrefs.minimized = storedValue.settings.global_ui_state.minimized ?? false;
                delete storedValue.settings.global_ui_state;
            }

            if (typeof globalPrefs.confirm_destructive_actions !== 'undefined') {
                needsUpdate = true;
                const oldVal = globalPrefs.confirm_destructive_actions;
                globalPrefs.confirm_remove_folder = globalPrefs.confirm_remove_folder ?? oldVal;
                globalPrefs.confirm_clear_playlist = globalPrefs.confirm_clear_playlist ?? oldVal;
                globalPrefs.confirm_close_mpv = globalPrefs.confirm_close_mpv ?? oldVal;
                delete globalPrefs.confirm_destructive_actions;
            }

            const defaultGlobalPrefs = this._getDefaultData().settings.ui_preferences.global;
            const originalGlobalPrefsJSON = JSON.stringify(globalPrefs);
            const newGlobalPrefs = { ...defaultGlobalPrefs, ...globalPrefs };

            if (JSON.stringify(newGlobalPrefs) !== originalGlobalPrefsJSON) {
                needsUpdate = true;
                storedValue.settings.ui_preferences.global = newGlobalPrefs;
            }
        }

        if (needsUpdate) {
            await this.set(storedValue);
            broadcastLog({ text: `[Background]: Data structure updated to latest version.`, type: 'info' });
        }
    }

    async _migrateStorageToOneObject() {
        const oldFolderIdsResult = await chrome.storage.local.get('folder_ids');
        if (oldFolderIdsResult.folder_ids) {
            console.log("Old storage format detected. Migrating to unified object...");
            const newData = this._getDefaultData(); // Start with a default structure
            newData.folders = {}; // Clear default folder
            newData.folderOrder = [];
            const keysToRemove = ['folder_ids'];

            for (const folderId of oldFolderIdsResult.folder_ids) {
                const folderKey = `folder_${folderId}`;
                const folderDataResult = await chrome.storage.local.get(folderKey);
                const storedValue = folderDataResult[folderKey];
                const playlist = Array.isArray(storedValue) ? storedValue : (storedValue?.playlist || storedValue?.urls || []);
                newData.folders[folderId] = { playlist };
                newData.folderOrder.push(folderId);
                keysToRemove.push(folderKey);
            }

            const lastFolder = await chrome.storage.local.get('last_used_folder_id');
            newData.settings.last_used_folder_id = lastFolder.last_used_folder_id || 'YT';
            keysToRemove.push('last_used_folder_id');

            await this.set(newData);
            await chrome.storage.local.remove(keysToRemove);
            console.log("Storage migration complete. Old keys removed.");
        }
    }
}

const storage = new StorageManager('mpv_organizer_data');

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
    broadcastToTabs(message);
    // Send to other extension contexts (like the popup).
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
            } else if (responseData.action === 'mpv_exited') {
                // Handle unsolicited messages from the native host
                handleMpvExited(responseData);
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

async function handleMpvExited(data) {
    const { folderId, returnCode } = data;
    if (!folderId) return;
    
    broadcastLog({ text: `[Background]: MPV session for folder '${folderId}' has ended with exit code ${returnCode}.`, type: 'info' });

    const storageData = await storage.get();
    const shouldClear = storageData.settings.ui_preferences.global.clear_on_completion ?? false;

    if (shouldClear) {
        // The custom exit code from our on_completion.lua script is 99.
        // This is the only case where we should auto-clear the playlist.
        if (returnCode === 99) {
            broadcastLog({ text: `[Background]: Playlist finished. Auto-clearing playlist for folder '${folderId}' as per settings.`, type: 'info' });
            await handleClear({ folderId: folderId });
        } else {
            broadcastLog({ text: `[Background]: MPV exited without finishing the playlist (code: ${returnCode}). Playlist for '${folderId}' will not be cleared.`, type: 'info' });
        }
    }
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
    const data = await storage.get();
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
    const data = await storage.get();
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

async function handleContentScriptInit(request, sender) {
    const tabId = sender.tab?.id;
    const origin = sender.origin;

    if (tabId && origin) {
        if (!tabUiState[tabId]) tabUiState[tabId] = {};
        try {
            tabUiState[tabId].uiDomain = new URL(origin).hostname;
        } catch (e) { /* ignore invalid origins */ }
        
        const data = await storage.get();
        const globalPrefs = data.settings.ui_preferences.global;

        let domain = null;
        if (origin.startsWith('http:') || origin.startsWith('https:')) {
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

        if (!isMinimized) {
            chrome.tabs.sendMessage(tabId, { action: 'show_ui' }).catch(() => {});
        }
    }
}

async function handleGetUiStateForTab(request) {
    const tabId = request.tabId;
    const tab = await chrome.tabs.get(tabId);
    const data = await storage.get();
    const globalPrefs = data.settings.ui_preferences.global;
    const tabState = tabUiState[tabId] || {};

    let domain = tabState.uiDomain;
    if (!domain && tab.url && (tab.url.startsWith('http:') || tab.url.startsWith('https:'))) {
        try {
            domain = new URL(tab.url).hostname;
        } catch (e) { /* ignore */ }
    }

    const domainPrefs = domain ? data.settings.ui_preferences.domains[domain] || {} : {};

    let isMinimized;
    if (typeof domainPrefs.minimized === 'boolean') {
        isMinimized = domainPrefs.minimized;
    } else {
        isMinimized = (globalPrefs.mode === 'minimized');
    }

    return { success: true, state: { minimized: isMinimized, detectedUrl: tabState.detectedUrl } };
}

async function handleReportDetectedUrl(request, sender) {
    const tabId = sender.tab?.id;
    if (tabId) {
        if (!tabUiState[tabId]) tabUiState[tabId] = {};
        tabUiState[tabId].detectedUrl = request.url;
        chrome.runtime.sendMessage({ action: 'detected_url_changed', tabId: tabId, url: request.url });
    }
}

async function handleSetLastFolderId(request) {
    if (request.folderId) {
        const data = await storage.get();
        data.settings.last_used_folder_id = request.folderId;
        await storage.set(data);
        broadcastToTabs({ action: 'last_folder_changed', folderId: request.folderId });
        return { success: true };
    }
    return { success: false, error: 'No folderId provided.' };
}

async function handleGetLastFolderId() {
    const data = await storage.get();
    const folderId = data.settings.last_used_folder_id || Object.keys(data.folders)[0];
    return { success: true, folderId };
}

async function handleGetUiPreferences(request, sender) {
    const data = await storage.get();
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

async function handleSetUiPreferences(request, sender) {
    const data = await storage.get();
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

    await storage.set(data);
    broadcastToTabs({ action: 'preferences_changed' });
    return { success: true };
}

async function handleCreateFolder(request) {
    if (!request.folderId || !request.folderId.trim()) {
        return { success: false, error: 'Folder name cannot be empty.' };
    }
    const data = await storage.get();
    if (data.folders[request.folderId]) {
        return { success: false, error: 'A folder with that name already exists.' };
    }
    data.folderOrder.push(request.folderId);
    data.folders[request.folderId] = { playlist: [] };
    await storage.set(data);
    updateContextMenus();
    broadcastToTabs({ foldersChanged: true });
    debouncedSyncToNativeHostFile();
    return { success: true, message: `Folder "${request.folderId}" created.` };
}

async function handleGetAllFolderIds() {
    const data = await storage.get();
    const folderIds = data.folderOrder || Object.keys(data.folders);
    const lastUsedFolderId = data.settings.last_used_folder_id;
    return { success: true, folderIds, lastUsedFolderId };
}

async function handleRemoveFolder(request) {
    const folderIdToRemove = request.folderId;
    if (!folderIdToRemove) return { success: false, error: 'Invalid folder ID provided.' };

    const data = await storage.get();
    if (data.folderOrder.length <= 1 && data.folders[folderIdToRemove]) {
        return { success: false, error: 'Cannot remove the last folder.' };
    }
    if (!data.folders[folderIdToRemove]) {
        return { success: false, error: 'Folder not found.' };
    }

    delete data.folders[folderIdToRemove];
    data.folderOrder = data.folderOrder.filter(id => id !== folderIdToRemove);

    if (data.settings.last_used_folder_id === folderIdToRemove) {
        data.settings.last_used_folder_id = Object.keys(data.folders)[0];
    }
    await storage.set(data);

    updateContextMenus();
    broadcastToTabs({ foldersChanged: true });
    debouncedSyncToNativeHostFile();
    return { success: true, message: `Folder "${folderIdToRemove}" removed.` };
}

async function handleRenameFolder(request) {
    const { oldFolderId, newFolderId } = request;
    if (!oldFolderId || !newFolderId || !newFolderId.trim()) {
        return { success: false, error: 'Invalid folder names provided.' };
    }
    const data = await storage.get();
    if (!data.folders[oldFolderId]) {
        return { success: false, error: `Folder "${oldFolderId}" not found.` };
    }
    if (data.folders[newFolderId]) {
        return { success: false, error: `A folder named "${newFolderId}" already exists.` };
    }

    data.folders[newFolderId] = data.folders[oldFolderId];
    delete data.folders[oldFolderId];

    const index = data.folderOrder.indexOf(oldFolderId);
    if (index !== -1) data.folderOrder[index] = newFolderId;

    if (data.settings.last_used_folder_id === oldFolderId) {
        data.settings.last_used_folder_id = newFolderId;
    }

    await storage.set(data);
    updateContextMenus();
    broadcastToTabs({ foldersChanged: true });
    debouncedSyncToNativeHostFile();
    return { success: true, message: `Folder renamed to "${newFolderId}".` };
}

async function handleSetFolderOrder(request) {
    const newOrder = request.order;
    if (!Array.isArray(newOrder)) {
        return { success: false, error: 'Invalid order data provided.' };
    }
    const data = await storage.get();
    const currentKeys = new Set(Object.keys(data.folders));
    const newKeys = new Set(newOrder);
    if (currentKeys.size !== newKeys.size || ![...currentKeys].every(k => newKeys.has(k))) {
        return { success: false, error: 'New order does not match existing folders.' };
    }

    data.folderOrder = newOrder;
    await storage.set(data);
    debouncedSyncToNativeHostFile();
    return { success: true, message: 'Folder order updated.' };
}

async function handleImportFromFile(request) {
    const filename = request.filename;
    if (!filename) {
        return { success: false, error: 'No filename provided.' };
    }

    const response = await callNativeHost({ action: 'import_from_file', filename });

    if (!response.success) {
        return response; // Forward the error from native host
    }

    try {
        // Derive folder name from filename, e.g., "my_backup.json" -> "my_backup"
        const baseFolderName = filename.replace(/\.json$/i, '');

        // Parse content and build a single combined playlist
        const importedData = JSON.parse(response.data);
        let combinedPlaylist = [];

        if (Array.isArray(importedData)) {
            // Case 1: The file is a simple JSON array of URLs.
            combinedPlaylist = importedData.filter(url => typeof url === 'string');
        } else if (typeof importedData === 'object' && importedData !== null) {
            // Case 2: The file is an object of folders (like our export format).
            // We'll merge all playlists from within this file into one.
            for (const key in importedData) {
                const folderContent = importedData[key];
                if (folderContent && Array.isArray(folderContent.playlist)) {
                    combinedPlaylist.push(...folderContent.playlist.filter(url => typeof url === 'string'));
                }
            }
        } else {
            throw new Error("Unsupported import file format. Must be a JSON array of URLs or an object of folders.");
        }

        if (combinedPlaylist.length === 0) {
            return { success: true, message: `Import file '${filename}' was empty or contained no valid URLs. No folder created.` };
        }

        // Get local data and handle name collision for the new folder.
        const localData = await storage.get();
        let newFolderId = baseFolderName;
        let counter = 1;
        while (localData.folders[newFolderId]) {
            newFolderId = `${baseFolderName} (${counter})`;
            counter++;
        }

        // Create the new folder with the combined playlist.
        localData.folders[newFolderId] = { playlist: combinedPlaylist };
        localData.folderOrder.push(newFolderId);
        await storage.set(localData);

        // Update UI and sync data to the native host's file
        updateContextMenus();
        broadcastToTabs({ foldersChanged: true });
        debouncedSyncToNativeHostFile();
        return { success: true, message: `Imported '${filename}' as new folder '${newFolderId}' with ${combinedPlaylist.length} URL(s).` };
    } catch (e) {
        return { success: false, error: `Failed to parse or process import file: ${e.message}` };
    }
}

async function handleIsMpvRunning(request) {
    return callNativeHost({ action: 'is_mpv_running' });
}

async function handlePlay(request) {
    const data = await storage.get();
    const globalPrefs = data.settings.ui_preferences.global;
    const playlist = data.folders[request.folderId]?.playlist;
    if (!playlist || playlist.length === 0) {
        const message = `Playlist in folder '${request.folderId}' is empty. Nothing to play.`;
        broadcastLog({ text: `[Background]: ${message}`, type: 'error' });
        return { success: false, error: message };
    }
    return callNativeHost({
        action: 'play',
        folderId: request.folderId,
        playlist: playlist,
        geometry: globalPrefs.launch_geometry === 'custom' ? null : globalPrefs.launch_geometry,
        custom_width: globalPrefs.launch_geometry === 'custom' ? globalPrefs.custom_geometry_width : null,
        custom_height: globalPrefs.launch_geometry === 'custom' ? globalPrefs.custom_geometry_height : null,
        custom_mpv_flags: globalPrefs.custom_mpv_flags || ''
    });
}

async function handlePlayNewInstance(request) {
    const data = await storage.get();
    const globalPrefs = data.settings.ui_preferences.global;
    const playlist = data.folders[request.folderId]?.playlist;
    if (!playlist || playlist.length === 0) {
        const message = `Playlist in folder '${request.folderId}' is empty. Nothing to play.`;
        broadcastLog({ text: `[Background]: ${message}`, type: 'error' });
        return { success: false, error: message };
    }
    // This calls a new action on the native host
    return callNativeHost({
        action: 'play_new_instance',
        playlist: playlist,
        geometry: globalPrefs.launch_geometry === 'custom' ? null : globalPrefs.launch_geometry,
        custom_width: globalPrefs.launch_geometry === 'custom' ? globalPrefs.custom_geometry_width : null,
        custom_height: globalPrefs.launch_geometry === 'custom' ? globalPrefs.custom_geometry_height : null,
        custom_mpv_flags: globalPrefs.custom_mpv_flags || ''
    });
}

async function handleCloseMpv(request) {
    return callNativeHost({ action: 'close_mpv' });
}

async function handleAdd(request, sender) {
    const tabId = request.tabId || sender.tab?.id;
    const urlToAdd = tabId ? tabUiState[tabId]?.detectedUrl : null;
    if (!urlToAdd) return { success: false, error: 'No URL detected on the page to add.' };

    const data = await storage.get();
    data.folders[request.folderId].playlist.push(urlToAdd);
    await storage.set(data);
    broadcastToTabs({ action: 'render_playlist', folderId: request.folderId, playlist: data.folders[request.folderId].playlist });
    debouncedSyncToNativeHostFile();
    return { success: true, message: `Added to playlist in folder: ${request.folderId}` };
}

async function handleGetPlaylist(request) {
    const data = await storage.get();
    const folder = data.folders[request.folderId] || { playlist: [] };
    return { success: true, list: folder.playlist };
}

async function handleClear(request) {
    const data = await storage.get();
    data.folders[request.folderId].playlist = [];
    await storage.set(data);
    broadcastToTabs({ action: 'render_playlist', folderId: request.folderId, playlist: [] });
    debouncedSyncToNativeHostFile();
    return { success: true, message: `Playlist in folder ${request.folderId} cleared` };
}

async function handleRemoveItem(request) {
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

async function handleExportFolderPlaylist(request) {
    if (!request.filename || !request.folderId) return { success: false, error: 'Missing filename or folderId.' };
    const data = await storage.get();
    const folder = data.folders[request.folderId];
    if (!folder || !folder.playlist) return { success: false, error: `Folder '${request.folderId}' not found or is empty.` };
    return callNativeHost({ action: 'export_playlists', data: folder.playlist, filename: request.filename });
}

// --- Action Handler Map ---
// This map centralizes all message actions to their corresponding handler functions.
const actionHandlers = {
    // UI State
    'content_script_init': handleContentScriptInit,
    'get_ui_state_for_tab': handleGetUiStateForTab,
    'report_detected_url': handleReportDetectedUrl,
    'set_last_folder_id': handleSetLastFolderId,
    'get_last_folder_id': handleGetLastFolderId,
    'get_ui_preferences': handleGetUiPreferences,
    'set_ui_preferences': handleSetUiPreferences,
    // Folder Management
    'create_folder': handleCreateFolder,
    'get_all_folder_ids': handleGetAllFolderIds,
    'remove_folder': handleRemoveFolder,
    'rename_folder': handleRenameFolder,
    'set_folder_order': handleSetFolderOrder,
    // MPV and Playlist Actions
    'is_mpv_running': handleIsMpvRunning,
    'play': handlePlay,
    'play_new_instance': handlePlayNewInstance,
    'close_mpv': handleCloseMpv,
    'add': handleAdd,
    'get_playlist': handleGetPlaylist,
    'clear': handleClear,
    'remove_item': handleRemoveItem,
    // Import/Export
    'export_all_playlists_separately': async () => {
        const data = await storage.get();
        return callNativeHost({ action: 'export_all_playlists_separately', data: data.folders });
    },
    'export_folder_playlist': handleExportFolderPlaylist,
    'import_from_file': handleImportFromFile,
    'list_import_files': () => callNativeHost({ action: 'list_import_files' }),
    'open_export_folder': () => callNativeHost({ action: 'open_export_folder' }),
    'get_anilist_releases': () => callNativeHost({ action: 'get_anilist_releases' }),
    // Special case from scanner
    'log_from_scanner': (request) => {
        broadcastLog(request.log);
        // This action doesn't need to send a response back to the scanner.
    },
};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // Filter out broadcasted log messages that aren't commands.
    if (request.log && !request.action) {
        return;
    }

    const handler = actionHandlers[request.action];

    if (handler) {
        // Use an async IIFE to handle the promise-based handler and send the response.
        (async () => {
            try {
                const response = await handler(request, sender);
                // Some handlers might not return a value (e.g., log_from_scanner).
                // Only send a response if one was returned.
                if (response !== undefined) {
                    sendResponse(response);
                }
            } catch (e) {
                console.error(`Error handling action '${request.action}':`, e);
                sendResponse({ success: false, error: e.message });
            }
        })();
        // Return true to indicate that the response will be sent asynchronously.
        return true;
    }

    // If no handler is found, send a generic error response.
    sendResponse({ success: false, error: `Unknown action: '${request.action}'` });
    return false; // No async response will be sent.
});

// --- Initial Setup ---
// On install, ensure the default 'YT' folder exists and set up context menus.
chrome.runtime.onInstalled.addListener(async () => {
    // Initialize the storage which runs all necessary migrations.
    // This must complete before we try to update menus or sync data.
    await storage.initialize();

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

        if (!urlToAdd) return;

        const isYouTube = urlToAdd.includes('youtube.com/') || urlToAdd.includes('youtu.be/');

        if (isYouTube) {
            // If it's a YouTube link, add it directly.
            await addUrlToFolder(folderId, urlToAdd);
        } else {
            // For other links, try to find an M3U8 stream.
            broadcastLog({ text: `[Background]: Non-YouTube URL detected. Scanning for M3U8 stream in a hidden tab...`, type: 'info' });
            try {
                const m3u8Url = await findM3u8InUrl(urlToAdd, tab);
                // Pass both the found URL and the original for a better log message.
                await addUrlToFolder(folderId, m3u8Url, urlToAdd);
            } catch (error) {
                const errorMessage = `[Background]: Failed to find an M3U8 stream for '${urlToAdd}'. Error: ${error.message}`;
                broadcastLog({ text: errorMessage, type: 'error' });
            }
        }
    }
});

// --- M3U8 Stream Detection ---

// A simple in-memory cache to avoid sending the same URL repeatedly to a tab.
// The key is the tabId, and the value is the last detected URL.
const lastDetectedUrls = {};
// A map to hold promises for M3U8 detection in temporary tabs.
// The key is the tabId, and the value is { resolve, reject }.
let m3u8DetectionPromises = {};

/**
 * A helper function to encapsulate the logic of adding a URL to a folder's playlist.
 * @param {string} folderId The ID of the folder to add to.
 * @param {string} url The URL to add.
 * @param {string} originalUrl The original URL from the context menu, for logging.
 */
async function addUrlToFolder(folderId, url, originalUrl = null) {
    try {
        const data = await storage.get();
        data.folders[folderId].playlist.push(url);
        await storage.set(data);
        debouncedSyncToNativeHostFile();

        // Notify content scripts to re-render their lists
        broadcastToTabs({ action: 'render_playlist', folderId: folderId, playlist: data.folders[folderId].playlist });

        const logMessage = originalUrl ?
            `[Background]: Found stream for '${originalUrl}' and added it to folder '${folderId}'.` :
            `[Background]: Added URL to folder '${folderId}' via context menu.`;
        broadcastLog({ text: logMessage, type: 'info' });
    } catch (e) {
        const logMessage = `[Background]: Error adding to folder '${folderId}': ${e.message}`;
        broadcastLog({ text: logMessage, type: 'error' });
    }
}

/**
 * Creates a new popup window for the user to interact with to trigger stream detection.
 * @param {string} url The URL to open in the new window.
 * @returns {Promise<chrome.tabs.Tab>} A promise that resolves with the tab object of the new window.
 */
async function _createScannerWindow(url) {
    const newWindow = await chrome.windows.create({
        url: url,
        type: 'popup',
        width: 1024,
        height: 768,
    });

    if (!newWindow?.tabs?.length) {
        throw new Error("Failed to create scanner window.");
    }

    broadcastLog({
        text: `[Scanner]: A scanner window has been opened. Please manually start the video in that window to capture the stream.`,
        type: 'info'
    });

    return newWindow.tabs[0];
}

/**
 * Waits for the webRequest listener to detect an M3U8 stream in a specific tab.
 * @param {number} tabId The ID of the tab to listen on.
 * @param {number} timeoutInSeconds The number of seconds to wait before timing out.
 * @returns {Promise<string>} A promise that resolves with the detected M3U8 URL.
 */
async function _waitForM3u8Detection(tabId, timeoutInSeconds) {
    return new Promise((resolve, reject) => {
        const timeoutDuration = timeoutInSeconds * 1000;

        const timeout = setTimeout(() => {
            // The promise might have already been resolved/rejected.
            // If the entry still exists, it means we timed out.
            if (m3u8DetectionPromises[tabId]) {
                delete m3u8DetectionPromises[tabId];
                reject(new Error(`M3U8 detection timed out after ${timeoutInSeconds} seconds.`));
            }
        }, timeoutDuration);

        // Store the promise's handlers so the webRequest listener can use them.
        // The handlers are responsible for cleaning up the timeout and the promise map entry.
        m3u8DetectionPromises[tabId] = {
            resolve: (url) => {
                clearTimeout(timeout);
                resolve(url);
                delete m3u8DetectionPromises[tabId];
            },
            reject: (err) => {
                clearTimeout(timeout);
                reject(err);
                delete m3u8DetectionPromises[tabId];
            }
        };
    });
}

/**
 * Switches focus back to the user's original tab and window after scanning is complete.
 * @param {chrome.tabs.Tab} originalTab The tab object to return focus to.
 */
async function _focusOriginalTab(originalTab) {
    if (!originalTab) return;
    if (originalTab.windowId) {
        await chrome.windows.update(originalTab.windowId, { focused: true }).catch(() => {});
    }
    if (originalTab.id) {
        await chrome.tabs.update(originalTab.id, { active: true }).catch(() => {});
    }
}

/**
 * Opens a URL in a hidden tab to find an M3U8 stream URL.
 * @param {string} url The page URL to scan.
 * @returns {Promise<string>} A promise that resolves with the detected M3U8 URL.
 */
async function findM3u8InUrl(url, originalTab) {
    let newWindow;
    let scannerTab; // The tab inside the new window

    try {
        const data = await storage.get();
        const timeoutInSeconds = data.settings.ui_preferences.global.stream_scanner_timeout || 60;

        scannerTab = await _createScannerWindow(url);
        const detectedUrl = await _waitForM3u8Detection(scannerTab.id, timeoutInSeconds);
        return detectedUrl;

    } finally {
        // This block ensures we always clean up by closing the scanner window
        // and switching focus back to the original tab.
        if (scannerTab && scannerTab.windowId) {
            chrome.windows.remove(scannerTab.windowId).catch(() => {});
        }
        await _focusOriginalTab(originalTab);
    }
}

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

            // NEW: Check if there's a promise waiting for an M3U8 from this tab.
            if (m3u8DetectionPromises[details.tabId]) {
                m3u8DetectionPromises[details.tabId].resolve(details.url);
                return; // The promise handler will clean up. Stop further processing.
            }

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
    // If a tab with a pending detection is closed, reject the promise.
    if (m3u8DetectionPromises[tabId]) {
        m3u8DetectionPromises[tabId].reject(new Error('Tab was closed before M3U8 detection completed.'));
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
