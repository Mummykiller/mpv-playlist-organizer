// --- Constants ---
const NATIVE_HOST_NAME = 'com.mpv_playlist_organizer.handler';
const MPV_PLAYLIST_COMPLETED_EXIT_CODE = 99;

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

/**
 * A promise-based wrapper for chrome.runtime.sendMessage.
 * @param {object} payload The message to send.
 * @returns {Promise<any>} A promise that resolves with the response.
 */
const sendMessageAsync = (payload) => new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve(response);
    });
});

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
            folders: { 'Default': { playlist: [] } },
            folderOrder: ['Default'],
            settings: {
                last_used_folder_id: 'Default',
                ui_preferences: {
                    global: {
                        minimized: false, mode: 'full', logVisible: true, pinned: false,
                        position: { top: '10px', left: 'auto', right: '10px', bottom: 'auto' },
                        launch_geometry: '', custom_geometry_width: '', custom_geometry_height: '',
                        custom_mpv_flags: '', show_play_new_button: false, duplicate_url_behavior: 'ask', one_click_add: false,
                        stream_scanner_timeout: 60, confirm_remove_folder: true, confirm_clear_playlist: true,
                        confirm_close_mpv: true, confirm_play_new: true, clear_on_completion: false,
                        autofocus_new_folder: false, // Added in a previous step
                        anilistPanelVisible: false,
                        enable_dblclick_copy: false, // New preference, disabled by default
                        anilistPanelPosition: null,
                        anilistPanelSize: null, // { width: '388px', height: '500px' }
                        anilist_cache: null,
                        autoReattachAnilistPanel: true,
                        anilist_image_height: 126, // New: Default cover image height
                        lockAnilistPanel: false, // New setting for the hard lock
                        minimizedStubPosition: { top: '15px', left: '15px', right: 'auto', bottom: 'auto' }, // Default to top-left corner
                        show_anilist_releases: true,
                        show_minimized_stub: true,
                        // New: Dependency Status for MPV and yt-dlp
                        dependencyStatus: {
                            mpv: { found: null, path: null, error: null },
                            ytdlp: { found: null, path: null, version: null, error: null }
                        }
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
            storedValue.settings.ui_preferences.global = { ...defaultGlobalPrefs, ...globalPrefs };

            // New Migration: Ensure dependencyStatus is initialized
            if (!storedValue.settings.ui_preferences.global.dependencyStatus) {
                storedValue.settings.ui_preferences.global.dependencyStatus = this._getDefaultData().settings.ui_preferences.global.dependencyStatus;
                needsUpdate = true;
            }
        }
    
        // New Migration: Convert string playlists to object playlists {url, title}
        if (storedValue.folders) {
            for (const folderId in storedValue.folders) {
                const folder = storedValue.folders[folderId];
                if (folder.playlist && folder.playlist.length > 0 && typeof folder.playlist[0] === 'string') {
                    broadcastLog({ text: `[Background]: Migrating playlist for folder '${folderId}' to new format.`, type: 'info' });
                    folder.playlist = folder.playlist.map(url => ({
                        url: url,
                        // Use the URL as a fallback title for old entries.
                        title: url 
                    }));
                    needsUpdate = true;
                }
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
                let playlist = Array.isArray(storedValue) ? storedValue : (storedValue?.playlist || storedValue?.urls || []);
                // Also migrate during this step if we find old string-based playlists
                if (playlist.length > 0 && typeof playlist[0] === 'string') {
                    playlist = playlist.map(url => ({ url: url, title: url }));
                }
                newData.folders[folderId] = { playlist };
                newData.folderOrder.push(folderId);
                keysToRemove.push(folderKey);
            }

            const lastFolder = await chrome.storage.local.get('last_used_folder_id');
            newData.settings.last_used_folder_id = lastFolder.last_used_folder_id || 'Default';
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
            try {
                // Attempt to send the message, but ignore errors if the content script isn't injected.
                chrome.tabs.sendMessage(tab.id, message).catch(() => {});
            } catch (e) {
                // This can happen if the tab is on a restricted page (e.g., chrome://)
            }
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
    if (connectionPromise) {
        return connectionPromise;
    }

    connectionStatus = ConnectionStatus.CONNECTING;
    broadcastLog({ text: `[Background]: Establishing connection to native host...`, type: 'info' });

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
            connectionPromise = null; // Allow for a new connection attempt
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
            } else if (responseData.log) {
                // Handle unsolicited log messages from the native host
                broadcastLog(responseData.log);
            } else {
            // New: Handle session restoration status on connect
            if (responseData.action === 'session_restored' && responseData.result) {
                if (responseData.result.was_stale) {
                    handleMpvExited(responseData.result);
                }
                return; // This is not a response to a request, so we're done.
            }
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
        if (returnCode === MPV_PLAYLIST_COMPLETED_EXIT_CODE) {
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
        const ensureConnectedAndSend = async () => {
            await connectToNativeHost();

            const requestId = `req_${requestIdCounter++}`;
            requestPromises[requestId] = { resolve, reject };
            const messageToSend = { ...message, request_id: requestId };

            try {
                nativePort.postMessage(messageToSend);
            } catch (e) {
                const errorMessage = `Failed to send message to native host. It may have disconnected. Error: ${e.message}`;
                reject(new Error(errorMessage));
                delete requestPromises[requestId];
            }
        };

        ensureConnectedAndSend().catch(reject);
    }).then(response => {
        // This part runs after the promise from the native host resolves. Log the outcome.
        const logType = response.success ? 'info' : 'error';
        const logMessage = response.message || response.error || 'Received response from native host.';
        broadcastLog({ text: `[Native Host]: ${logMessage}`, type: logType });
        return response;
    }).catch(error => {
        const errorMessage = `Could not communicate with native host. It might be disconnected or not installed. Error: ${error.message}`;
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

/**
 * Checks MPV and yt-dlp dependencies via the native host and stores the results.
 * Also broadcasts a message to update UI components.
 */
async function _checkDependenciesAndStore() {
    broadcastLog({ text: `[Background]: Checking MPV and yt-dlp dependencies...`, type: 'info' });
    const response = await callNativeHost({ action: 'check_dependencies' });

    if (response.success) {
        const data = await storage.get();
        data.settings.ui_preferences.global.dependencyStatus = {
            mpv: response.mpv,
            ytdlp: response.ytdlp
        };
        await storage.set(data);
        broadcastLog({ text: `[Background]: Dependency check completed.`, type: 'info' });
        broadcastToTabs({ action: 'dependencies_status_changed', status: data.settings.ui_preferences.global.dependencyStatus });
    } else {
        broadcastLog({ text: `[Background]: Dependency check failed: ${response.error}`, type: 'error' });
    }
}


// --- Context Menu Management ---

/**
 * Creates or updates the context menus for adding URLs to folders.
 */
async function updateContextMenus() {
  await new Promise((resolve) => chrome.contextMenus.removeAll(resolve));
  const data = await storage.get();
  const folderIds = data.folderOrder || Object.keys(data.folders);
  const oneClickAdd = data.settings.ui_preferences.global.one_click_add ?? false;
  const contexts = ["link", "video", "audio", "page"];

  if (folderIds.length === 0) {
    chrome.contextMenus.create({
      id: "no-queues",
      title: "No MPV folders available",
      enabled: false,
      contexts: contexts,
    });
    return;
  }

  const lastUsedFolderId = data.settings.last_used_folder_id;

  // --- Create a single parent menu item ---
  const parentId = "add-to-mpv-parent";
  chrome.contextMenus.create({
    id: parentId,
    title: "Add to MPV Folder",
    contexts: contexts,
  });

  // --- Reorder folders to place the last used one at the top ---
  // This replaces the explicit "Add to current" option.
  let orderedFolderIds = [...folderIds]; // Create a mutable copy
  if (lastUsedFolderId && orderedFolderIds.includes(lastUsedFolderId)) {
      // Remove the last used folder from its current position
      orderedFolderIds = orderedFolderIds.filter(id => id !== lastUsedFolderId);
      // Add it to the beginning of the array
      orderedFolderIds.unshift(lastUsedFolderId);
  }
  // --- Create a separate parent for YouTube playlists ---
    chrome.contextMenus.create({
        id: 'add-youtube-playlist-parent',
        title: 'Add Playlist to MPV Folder',
        contexts: ['link'],
        targetUrlPatterns: ["*://*.youtube.com/playlist?list=*"]
    });

  // --- Add all folders as sub-items ---
  orderedFolderIds.forEach((id) => {
    // Add to the main "Add to MPV Folder" menu
    chrome.contextMenus.create({
      id: `add-to-folder-${id}`,
      parentId: parentId,
      title: id,
      contexts: contexts,
    });
    // Add to the "Add Playlist to MPV Folder" menu
    chrome.contextMenus.create({
      id: `add-playlist-to-folder-${id}`,
      parentId: "add-youtube-playlist-parent",
      title: id,
      contexts: ["link"],
    });
  });
}
// --- Main Message Listener ---

async function handleContentScriptInit(request, sender) {
    const tabId = sender.tab?.id; // Ensure tab exists
    const origin = sender.origin;

    if (tabId && origin && sender.tab) {
        if (!tabUiState[tabId]) tabUiState[tabId] = {};
        try {
            tabUiState[tabId].uiDomain = new URL(origin).hostname;
        } catch (e) { /* ignore invalid origins */ }
        
        const data = await storage.get();
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

    const isMinimized = domainPrefs.minimized ?? (globalPrefs.mode === 'minimized');

    return { success: true, state: { minimized: isMinimized, detectedUrl: tabState.detectedUrl } };
}

async function handleReportDetectedUrl(request, sender) {
    const tabId = sender.tab?.id;
    if (tabId) {
        if (!tabUiState[tabId]) tabUiState[tabId] = {};
        tabUiState[tabId].detectedUrl = request.url;
        // Broadcast to all contexts (popup and content scripts)
        // The popup can check if the tabId matches the active tab.
        broadcastToTabs({ action: 'detected_url_changed', tabId: tabId, url: request.url });
    }
}

async function handleSetLastFolderId(request) {
    if (request.folderId) {
        const data = await storage.get();
        data.settings.last_used_folder_id = request.folderId;
        await storage.set(data);
        broadcastToTabs({ action: 'last_folder_changed', folderId: request.folderId });
        updateContextMenus(); // Rebuild context menus to reflect the new "current" folder.
        return { success: true };
    }
    return { success: false, error: 'No folderId provided.' };
}

async function handleGetLastFolderId() {
    const data = await storage.get();
    const folderId = data.settings.last_used_folder_id || Object.keys(data.folders)[0];
    return { success: true, folderId };
}

async function handleSetMinimizedState(request, sender) {
    const { minimized } = request;
    if (typeof minimized !== 'boolean') {
        return { success: false, error: 'Invalid minimized state provided.' };
    }

    // Find the currently active tab to apply the state to.
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab || !activeTab.id) {
        return { success: false, error: 'Could not find an active tab.' };
    }

    try {
        // Send a message directly to the content script of the active tab.
        await chrome.tabs.sendMessage(activeTab.id, { action: 'set_minimized_state', minimized });
        return { success: true };
    } catch (error) {
        // This error is expected if the content script isn't on the page.
        return { success: false, error: 'Controller not available on this page.' };
    }
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
    broadcastToTabs({ action: 'preferences_changed', preferences: newPreferences }); // Send the actual preferences that changed
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
            combinedPlaylist = importedData
                .filter(item => typeof item === 'string')
                .map(url => ({ url: url, title: url }));
        } else if (typeof importedData === 'object' && importedData !== null) {
            // Case 2: The file is an object of folders (like our export format).
            // We'll merge all playlists from within this file into one.
            for (const key in importedData) {
                const folderContent = importedData[key];
                if (folderContent && Array.isArray(folderContent.playlist)) {
                    // Handle both old (string) and new (object) formats within the import file.
                    const items = folderContent.playlist.map(item => 
                        typeof item === 'string' ? { url: item, title: item } : item
                    );
                    combinedPlaylist.push(...items.filter(item => item && typeof item.url === 'string'));
                }
            }
        } else {
            // New: Handle single playlist export (just an array of URLs)
            if (Array.isArray(importedData)) {
                 combinedPlaylist = importedData.filter(url => typeof url === 'string').map(url => ({ url, title: url }));
            } else {
                throw new Error("Unsupported import file format. Must be a JSON array of URLs or an object of folders.");
            }
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
    // Extract just the URLs for MPV
    const urlPlaylist = playlist?.map(item => item.url) || [];

    if (!playlist || playlist.length === 0) {
        const message = `Playlist in folder '${request.folderId}' is empty. Nothing to play.`;
        broadcastLog({ text: `[Background]: ${message}`, type: 'error' });
        return { success: false, error: message };
    }
    return callNativeHost({
        action: 'play',
        folderId: request.folderId,
        playlist: urlPlaylist,
        geometry: globalPrefs.launch_geometry === 'custom' ? null : globalPrefs.launch_geometry,
        custom_width: globalPrefs.launch_geometry === 'custom' ? globalPrefs.custom_geometry_width : null,
        custom_height: globalPrefs.launch_geometry === 'custom' ? globalPrefs.custom_geometry_height : null,
        custom_mpv_flags: globalPrefs.custom_mpv_flags || '',
        clear_on_completion: globalPrefs.clear_on_completion ?? false
    });
}

async function handlePlayNewInstance(request) {
    const data = await storage.get();
    const globalPrefs = data.settings.ui_preferences.global;
    const playlist = data.folders[request.folderId]?.playlist;
    // Extract just the URLs for MPV
    const urlPlaylist = playlist?.map(item => item.url) || [];

    if (!playlist || playlist.length === 0) {
        const message = `Playlist in folder '${request.folderId}' is empty. Nothing to play.`;
        broadcastLog({ text: `[Background]: ${message}`, type: 'error' });
        return { success: false, error: message };
    }
    // This calls a new action on the native host
    return callNativeHost({
        action: 'play_new_instance',
        playlist: urlPlaylist,
        geometry: globalPrefs.launch_geometry === 'custom' ? null : globalPrefs.launch_geometry,
        custom_width: globalPrefs.launch_geometry === 'custom' ? globalPrefs.custom_geometry_width : null,
        custom_height: globalPrefs.launch_geometry === 'custom' ? globalPrefs.custom_geometry_height : null,
        custom_mpv_flags: globalPrefs.custom_mpv_flags || '',
        clear_on_completion: globalPrefs.clear_on_completion ?? false
    });
}

async function handleCloseMpv(request) {
    return callNativeHost({ action: 'close_mpv' });
}

async function handleAdd(request, sender) {
    // The 'add' action now triggers the scraping process.
    // It expects a tabId from the sender (popup or context menu).
    const tabId = request.tabId || sender.tab?.id;
    const folderId = request.folderId;

    if (!tabId || !folderId) {
        return { success: false, error: 'Missing tabId or folderId for add action.' };
    }

    try {
        // Ask the content script to scrape the page details.
        const scrapedDetails = await chrome.tabs.sendMessage(tabId, { action: 'scrape_and_get_details' });

        if (!scrapedDetails || !scrapedDetails.url) {
            return { success: false, error: 'No stream/video detected on the page to add.' };
        }

        // Use the dedicated 'addUrlToFolder' function to handle adding the new item.
        // The 'originalTab' can come from the request object (from the popup) or the sender (from the content script).
        return await addUrlToFolder(folderId, scrapedDetails.url, scrapedDetails.title, request.tab || sender.tab, sender); // Pass the sender to identify the source
    } catch (e) {
        return { success: false, error: `Could not communicate with content script: ${e.message}` };
    }
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
    // It's possible for this to be called when no content scripts are available
    // (e.g., after an extension reload). We wrap this in a try/catch to
    // prevent "Receiving end does not exist" errors from being uncaught.
    try {
        await broadcastToTabs({ action: 'render_playlist', folderId: request.folderId, playlist: [] });
    } catch (e) { /* Suppress errors, as UI update is not critical here */ }
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

async function handleSetPlaylistOrder(request) {
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
    debouncedSyncToNativeHostFile(); // Persist the change to folders.json
    return { success: true, message: `Playlist order for '${folderId}' updated.` };
}

async function handleExportFolderPlaylist(request) {
    if (!request.filename || !request.folderId) return { success: false, error: 'Missing filename or folderId.' };
    const data = await storage.get();
    const folder = data.folders[request.folderId];
    // Extract just the URLs for the export file.
    const urlPlaylist = folder?.playlist?.map(item => item.url) || [];
    if (!folder || !urlPlaylist.length) return { success: false, error: `Folder '${request.folderId}' not found or is empty.` };
    return callNativeHost({ action: 'export_playlists', data: urlPlaylist, filename: request.filename });
}

async function handleGetAnilistReleases(request) {
    // All caching logic is now handled by the native host.
    const forceRefresh = request.force ?? false;

    // Check preferences to see if the user has disabled the cache.
    // Fetch preferences directly from storage instead of sending a message to itself.
    const data = await storage.get();
    const isCacheDisabled = data.settings.ui_preferences.global.disable_anilist_cache ?? false;

    // If the cache is disabled, we instruct the native host to delete the cache file.
    // This ensures no stale data is ever used when this setting is on.
    const deleteCache = isCacheDisabled;

    const nativeResponse = await callNativeHost({
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

async function handleYtdlpUpdateCheck(request) {
    // This is triggered by the native host when it detects a playback failure.
    // First, log the message it sent.
    if (request.log) {
        broadcastLog(request.log);
    }

    // Find the tab that originated the MPV command to show the confirmation there.
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = activeTab?.id;

    const data = await storage.get();
    const updateBehavior = data.settings.ui_preferences.global.ytdlp_update_behavior || 'manual';

    if (updateBehavior === 'manual') {
        broadcastLog({ text: `[Background]: yt-dlp update behavior is set to 'manual'. No action taken.`, type: 'info' });
        return { success: true, message: 'Manual update mode. No action taken.' };
    }

    if (updateBehavior === 'ask') {
        if (!tabId) {
            return { success: false, error: 'Could not find an active tab to show confirmation.' };
        }
        // Ask the content script to show a confirmation. The content script will then send a message back.
        // We use a page-level confirmation that doesn't depend on the controller UI.
        chrome.tabs.sendMessage(tabId, { action: 'ytdlp_update_confirm' })
            .catch(err => broadcastLog({ text: `[Background]: Could not send update confirmation to tab ${tabId}. Error: ${err.message}`, type: 'error' }));
        return { success: true, message: 'Confirmation requested from user.' };
    }
    if (updateBehavior === 'auto') {
        // If the setting is enabled, tell the native host to proceed with the update.
        return callNativeHost({ action: 'run_ytdlp_update' });
    }
}

async function handleGetDependencyStatus() {
    const data = await storage.get();
    return { success: true, status: data.settings.ui_preferences.global.dependencyStatus };
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
    'set_minimized_state': handleSetMinimizedState,
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
    'set_playlist_order': handleSetPlaylistOrder,
    // Import/Export
    'export_all_playlists_separately': async () => {
        const data = await storage.get();
        return callNativeHost({ action: 'export_all_playlists_separately', data: data.folders });
    },
    'export_folder_playlist': handleExportFolderPlaylist,
    'import_from_file': handleImportFromFile,
    'list_import_files': () => callNativeHost({ action: 'list_import_files' }),
    'open_export_folder': () => callNativeHost({ action: 'open_export_folder' }),
    'get_anilist_releases': handleGetAnilistReleases,
    // Special case from scanner
    'ytdlp_update_check': handleYtdlpUpdateCheck,
    'user_confirmed_ytdlp_update': () => {
        broadcastLog({ text: `[Background]: User confirmed. Starting yt-dlp update...`, type: 'info' });
        return callNativeHost({ action: 'run_ytdlp_update' });
    },
    'manual_ytdlp_update': () => {
        broadcastLog({ text: `[Background]: Manual yt-dlp update triggered from settings.`, type: 'info' });
        return callNativeHost({ action: 'run_ytdlp_update' });
    },
    'get_dependency_status': handleGetDependencyStatus,

    'log_from_scanner': (request) => {
        broadcastLog(request.log);
        // This action doesn't need to send a response back to the scanner.
    }
};

// Add a simple heartbeat handler that does nothing but respond.
// This allows content scripts to check if the background script is alive.
actionHandlers['heartbeat'] = () => ({ success: true });

// New handler for the unsolicited 'session_restored' message from the native host
actionHandlers['session_restored'] = (request) => {
    if (request.result?.was_stale) {
        broadcastLog({ text: `[Background]: Detected stale MPV session for folder '${request.result.folderId}'.`, type: 'info' });
        // Trigger the same cleanup logic as when MPV exits.
        handleMpvExited(request.result);
    }
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
// On install, ensure the default 'Default' folder exists and set up context menus.
chrome.runtime.onInstalled.addListener(async () => {
    // Initialize the storage which runs all necessary migrations.
    // This must complete before we try to update menus or sync data.
    await storage.initialize();

    await updateContextMenus(); // Create the context menus for pages.
    await syncDataToNativeHostFile(); // Sync data on first install/update.
    await _checkDependenciesAndStore(); // Perform initial dependency check
    console.log("MPV Handler extension installed and initialized.");
});

// --- Rate Limiting for oEmbed ---
let lastOEmbedRequestTime = 0;

// --- Context Menu Click Handler ---
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    const { menuItemId } = info;

    let folderId = null;
    // Determine the folderId based on which context menu item was clicked.
    if (typeof menuItemId === 'string' && menuItemId.startsWith('add-to-folder-')) {
        folderId = menuItemId.substring('add-to-folder-'.length);
    // New: Handle the new playlist context menu item.
    } else if (typeof menuItemId === 'string' && menuItemId.startsWith('add-playlist-to-folder-')) {
        folderId = menuItemId.substring('add-playlist-to-folder-'.length);
    } else if (menuItemId === 'add-to-last-used-folder') {
        // If the one-click-add item was clicked, get the last used folder from storage.
        const data = await storage.get();
        folderId = data.settings.last_used_folder_id;
    }

    // If we successfully determined a folderId, proceed to add the URL.
    if (folderId) {
        // This block is now common for both types of context menu clicks.
        
        // Determine the URL from the context info, preferring the most specific source.
        const urlToAdd = info.linkUrl || info.srcUrl || info.pageUrl;
        if (!urlToAdd) return;

        const isYouTubeVideoUrl = /^https?:\/\/((www|music)\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]+)/.test(urlToAdd);
        const isYouTubePlaylistUrl = /^https?:\/\/((www|music)\.)?youtube\.com\/playlist\?list=([a-zA-Z0-9_-]+)/.test(urlToAdd);

        if (isYouTubeVideoUrl || isYouTubePlaylistUrl) {
            // --- Rate Limiting Logic ---
            const now = Date.now();
            const minInterval = 1000; // 1 request per second
            const elapsed = now - lastOEmbedRequestTime;
            const delay = Math.max(0, minInterval - elapsed);

            // Set the time for the *next* allowed request.
            lastOEmbedRequestTime = now + delay;

            setTimeout(async () => {
                broadcastLog({ text: `[Background]: YouTube URL detected. Scraping title via oEmbed...`, type: 'info' });
                try {
                    // Use YouTube's oEmbed endpoint for a reliable and lightweight way to get video details.
                    const oEmbedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(urlToAdd)}&format=json`;
                    const response = await fetch(oEmbedUrl);
                    if (!response.ok) {
                        throw new Error(`YouTube oEmbed request failed with status: ${response.status} ${response.statusText}`);
                    }
                    const videoDetails = await response.json();
                    
                    const itemTitle = videoDetails.title || (isYouTubePlaylistUrl ? "YouTube Playlist" : "YouTube Video");
                    const channelName = videoDetails.author_name || null;
                    const finalTitle = channelName ? `${channelName} - ${itemTitle}` : itemTitle;

                    await addUrlToFolder(folderId, urlToAdd, finalTitle, tab);
                } catch (e) {
                    broadcastLog({ text: `[Background]: YouTube oEmbed scrape failed: ${e.message}. Adding with basic title.`, type: 'error' });
                    // Fallback to adding with a very basic title if the scrape fails.
                    await addUrlToFolder(folderId, urlToAdd, isYouTubePlaylistUrl ? "YouTube Playlist" : "YouTube Video", tab);
                }
            }, delay);
        } else {
            // --- Default Behavior for Other Sites ---
            // Use the scanner window to find streams and get the title.
            broadcastLog({ text: `[Background]: URL detected from context menu. Scanning for stream and title...`, type: 'info' });
            try {
                const scanResult = await findM3u8InUrl(urlToAdd, tab);
                const { url: streamUrl, title, scannerTab } = scanResult;

                if (streamUrl) {
                    await addUrlToFolder(folderId, streamUrl, title, tab);
                } else {
                    broadcastLog({ text: `[Background]: Scanner did not detect a video stream. Add action cancelled.`, type: 'info' });
                }
                if (scannerTab && scannerTab.windowId) {
                    chrome.windows.remove(scannerTab.windowId).catch(() => {});
                }
            } catch (error) {
                const errorMessage = `[Background]: Scanner failed for '${urlToAdd}'. Adding original URL as fallback. Error: ${error.message}`;
                broadcastLog({ text: errorMessage, type: 'info' });
                await addUrlToFolder(folderId, urlToAdd, urlToAdd, tab); // Fallback to adding the URL as its own title
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
 * A helper function to encapsulate the logic of adding an item to a folder's playlist.
 * @param {string} folderId The ID of the folder to add to.
 * @param {string} url The URL to add.
 * @param {string} title The scraped title for the entry.
 * @param {chrome.tabs.Tab} originalTab The tab where the context menu was clicked.
 * @param {chrome.runtime.MessageSender} sender The sender of the original message.
 */
async function addUrlToFolder(folderId, url, title, originalTab = null, sender = null) {
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
                // We need to ask the user. We can't do it from the background script directly.
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
                        // If confirmed, proceed to add.
                    } catch (e) {
                        // This might happen if the content script isn't injected or the tab was closed.
                        // In this case, we can't ask, so we'll log and add it as a fallback.
                        const logMessage = `[Background]: Could not ask for confirmation on tab ${originalTab.id}. Adding duplicate URL to '${folderId}'. Reason: ${e.message}`;
                        broadcastLog({ text: logMessage, type: 'info' });
                    }
                } else {
                    // No original tab to ask, so just add it.
                    const logMessage = `[Background]: Duplicate URL detected for folder '${folderId}'. Adding anyway as no UI is available to ask for confirmation.`;
                    broadcastLog({ text: logMessage, type: 'info' });
                }
            }
        }

        data.folders[folderId].playlist.push({ url, title });
        await storage.set(data);
        debouncedSyncToNativeHostFile();

        // Notify content scripts to re-render their lists
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
 * Creates a new popup window for the user to interact with to trigger stream detection.
 * @param {string} url The URL to open in the new window.
 * @returns {Promise<chrome.tabs.Tab>} A promise that resolves with the tab object of the new window.
 */
async function _createScannerWindow(url) {
    let finalUrl = url;
    try {
        // Add a parameter to the URL to identify it as a scanner window.
        // This prevents the content script from injecting the UI into it.
        const scannerUrl = new URL(url);
        scannerUrl.searchParams.set('mpv_playlist_scanner', 'true');
        finalUrl = scannerUrl.toString();
    } catch (e) {
        // If URL parsing fails, use the original URL. This is a fallback.
        console.warn(`Could not parse URL to add scanner parameter: ${url}`);
    }

    const newWindow = await chrome.windows.create({
        url: finalUrl,
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
 * @returns {Promise<{url: string, title: string, scannerTab: chrome.tabs.Tab}>} A promise that resolves with the detected URL, title, and the scanner tab.
 */
async function findM3u8InUrl(url, originalTab) {
    let newWindow;
    let scannerTab; // The tab inside the new window

    try {
        const data = await storage.get();
        const timeoutInSeconds = data.settings.ui_preferences.global.stream_scanner_timeout || 60;

        scannerTab = await _createScannerWindow(url);

        await new Promise((resolve) => {
            const listener = (tabId, changeInfo) => {
                if (tabId === scannerTab.id && changeInfo.status === 'complete') {
                    chrome.tabs.onUpdated.removeListener(listener);
                    resolve();
                }
            };
            chrome.tabs.onUpdated.addListener(listener);
        });

        const streamPromise = _waitForM3u8Detection(scannerTab.id, timeoutInSeconds).catch(() => null);
        const titlePromise = chrome.tabs.sendMessage(scannerTab.id, { action: 'scrape_and_get_details' })
            .catch(() => ({ title: url, url: url }));

        const [detectedStreamUrl, scrapedDetails] = await Promise.all([streamPromise, titlePromise]);

        const finalUrl = detectedStreamUrl || scrapedDetails.url;
        const finalTitle = scrapedDetails.title;

        return { url: finalUrl, title: finalTitle, scannerTab: scannerTab };

    } finally {
        await _focusOriginalTab(originalTab);
    }
}

chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
        // Optimization: Quick string check before more expensive operations.
        if (!details.url.includes('.m3u8')) {
            return;
        }

        // Optimization: Ignore requests originating from our own extension to prevent loops.
        if (details.initiator && details.initiator.startsWith(`chrome-extension://${chrome.runtime.id}`)) {
            return;
        }

        // At the onBeforeRequest stage, we only have the URL.
        // We check if the URL's path ends with .m3u8.
        // This is much faster than waiting for response headers.
        try {
            const url = new URL(details.url);
            if (!url.pathname.endsWith('.m3u8')) return;
        } catch (e) {
            return; // Invalid URL, ignore.
        }
            // Avoid sending the same URL repeatedly for the same tab.
            if (lastDetectedUrls[details.tabId] === details.url) {
                return;
            }
            lastDetectedUrls[details.tabId] = details.url;

            // Check if a scanner window is waiting for this URL.
            if (m3u8DetectionPromises[details.tabId]) {
                m3u8DetectionPromises[details.tabId].resolve(details.url);
                return;
            }

            console.log(`[Background]: Detected M3U8 stream: ${details.url} in tab ${details.tabId}`);

            // Send the detected URL to the content script of the tab where the request originated.
            chrome.tabs.sendMessage(details.tabId, { m3u8: details.url })
                .catch(error => {
                    // This error is expected if the content script isn't on the page.
                    if (!error.message.includes('Receiving end does not exist')) {
                        console.error(`[Background]: Error sending M3U8 URL to tab ${details.tabId}:`, error);
                    }
                });
    },
    {
        urls: ["<all_urls>"],
        types: ["xmlhttprequest", "other", "media", "main_frame"] // Listen on more types for broader compatibility
    }
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
