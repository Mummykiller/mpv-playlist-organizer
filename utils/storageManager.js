/**
 * Manages all data persistence and migration logic for the extension.
 * Uses a granular 'Bucket' system to improve performance and memory usage.
 * Storage Keys:
 * - 'mpv_storage_version': Integer version
 * - 'mpv_settings': Global preferences object
 * - 'mpv_folder_index': Array of folder names in order
 * - 'mpv_folder_data_[ID]': Individual playlist data for each folder
 */
export class StorageManager {
    constructor(storageKey, broadcastLog) {
        this.STORAGE_KEY = storageKey; // Legacy key for migration
        this.initPromise = null;
        this.broadcastLog = broadcastLog;
        this.writeQueue = Promise.resolve();
    }

    async initialize() {
        if (this.initPromise) return this.initPromise;
        
        this.initPromise = (async () => {
            const versionData = await chrome.storage.local.get('mpv_storage_version');
            const version = versionData.mpv_storage_version || 1;

            if (version < 2) {
                await this._migrateToGranularStorage();
            }

            await this._runDataMigrations();
            await this.runJanitorTasks();
        })();
        return this.initPromise;
    }

    /**
     * Migrates from the monolithic 'mpv_organizer_data' key to granular keys.
     */
    async _migrateToGranularStorage() {
        console.log("[Storage] Migrating to Granular Storage (v2)...");
        const legacyData = await chrome.storage.local.get(this.STORAGE_KEY);
        const data = legacyData[this.STORAGE_KEY];

        if (!data) {
            // New installation, just set the version
            await chrome.storage.local.set({ 'mpv_storage_version': 2 });
            return;
        }

        const newStorage = {
            'mpv_storage_version': 2,
            'mpv_settings': data.settings,
            'mpv_folder_index': data.folderOrder || Object.keys(data.folders)
        };

        // Split folders into individual keys
        for (const [folderId, folderData] of Object.entries(data.folders)) {
            newStorage[`mpv_folder_data_${folderId}`] = folderData;
        }

        await chrome.storage.local.set(newStorage);
        // We keep the legacy key for one session just in case, but usually we'd remove it.
        // await chrome.storage.local.remove(this.STORAGE_KEY); 
        console.log("[Storage] Migration to Granular Storage complete.");
    }

    /**
     * Gets the full aggregate data object. 
     * Note: This is kept for backward compatibility with existing handlers.
     */
    async get() {
        try {
            const keys = await chrome.storage.local.get(['mpv_settings', 'mpv_folder_index']);
            
            // If new system isn't initialized, fall back to legacy or defaults
            if (!keys.mpv_settings) {
                const legacy = await chrome.storage.local.get(this.STORAGE_KEY);
                return legacy[this.STORAGE_KEY] || this._getDefaultData();
            }

            const settings = keys.mpv_settings;
            const folderOrder = keys.mpv_folder_index;
            
            // Aggressively fetch all folder data keys
            const folderKeys = folderOrder.map(id => `mpv_folder_data_${id}`);
            const foldersData = await chrome.storage.local.get(folderKeys);

            const folders = {};
            folderOrder.forEach(id => {
                folders[id] = foldersData[`mpv_folder_data_${id}`] || { playlist: [] };
            });

            return {
                settings,
                folderOrder,
                folders
            };
        } catch (e) {
            console.error("Storage get failed:", e);
            return this._getDefaultData();
        }
    }

    /**
     * Sets the data by splitting it back into granular keys.
     */
    async set(data) {
        this.writeQueue = this.writeQueue.then(async () => {
            try {
                const update = {
                    'mpv_settings': data.settings,
                    'mpv_folder_index': data.folderOrder || Object.keys(data.folders)
                };

                // Add each folder to the update batch
                for (const [folderId, folderData] of Object.entries(data.folders)) {
                    update[`mpv_folder_data_${folderId}`] = folderData;
                }

                await chrome.storage.local.set(update);
            } catch (e) {
                console.error("Storage set failed:", e);
                if (this.broadcastLog) {
                    this.broadcastLog({ text: `[Background]: Storage write failed: ${e.message}`, type: 'error' });
                }
            }
        });
        return this.writeQueue;
    }

    async runJanitorTasks() {
        const data = await this.get();
        let modified = false;

        // 1. Sync folders and folderOrder
        const folderIds = Object.keys(data.folders);
        const orderedIds = data.folderOrder || [];

        // Remove from folderOrder if folder no longer exists
        const validOrder = orderedIds.filter(id => data.folders[id]);
        if (validOrder.length !== orderedIds.length) {
            data.folderOrder = validOrder;
            modified = true;
        }

        // Add to folderOrder if folder exists but is not ordered
        folderIds.forEach(id => {
            if (!data.folderOrder.includes(id)) {
                data.folderOrder.push(id);
                modified = true;
            }
        });

        // 2. Prune domain preferences (optional: only if they are empty)
        if (data.settings.ui_preferences.domains) {
            for (const domain in data.settings.ui_preferences.domains) {
                if (Object.keys(data.settings.ui_preferences.domains[domain]).length === 0) {
                    delete data.settings.ui_preferences.domains[domain];
                    modified = true;
                }
            }
        }

        // 3. NEW: Physical cleanup of deleted folder keys in storage
        const allStorage = await chrome.storage.local.get(null);
        const physicalFolderKeys = Object.keys(allStorage).filter(k => k.startsWith('mpv_folder_data_'));
        const activeFolderKeys = folderIds.map(id => `mpv_folder_data_${id}`);
        
        const keysToRemove = physicalFolderKeys.filter(k => !activeFolderKeys.includes(k));
        if (keysToRemove.length > 0) {
            await chrome.storage.local.remove(keysToRemove);
            console.log(`[Storage Janitor] Removed ${keysToRemove.length} orphaned folder keys from storage.`);
        }

        if (modified) {
            await this.set(data);
            console.log("Storage Janitor: Cleaned up orphaned/inconsistent metadata.");
        }
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
                        custom_mpv_flags: '',
                        mpv_decoder: 'auto',
                        automatic_mpv_flags: [
                            { flag: '--force-window=yes', description: 'Create a video output window even if there is no video.', enabled: true },
                            { flag: '--save-position-on-quit', description: 'Always save the current playback position on quit.', enabled: true }
                        ],
                        show_play_new_button: false, duplicate_url_behavior: 'ask', one_click_add: false,
                        auto_append_on_add: true,
                        live_removal: true,
                        stream_scanner_timeout: 60, confirm_remove_folder: true, confirm_clear_playlist: true,
                        confirm_close_mpv: true, confirm_play_new: true, confirm_folder_switch: true, clear_on_completion: 'no',
                        autofocus_new_folder: false,
                        anilistPanelVisible: false,
                        enable_dblclick_copy: false,
                        anilistPanelPosition: null,
                        anilistPanelSize: null,                        
                        anilist_image_height: 126,
                        lockAnilistPanel: false,
                        forcePanelAttached: false,
                        anilistAttachOnOpen: true,
                        popup_width: 600,
                        popup_width_locked: false,
                        yt_use_cookies: true,
                        yt_mark_watched: true,
                        yt_ignore_config: true,
                        other_sites_use_cookies: true,
                        minimizedStubPosition: { top: '15px', left: '15px', right: 'auto', bottom: 'auto' },                        
                        show_minimized_stub: true,
                        enable_smart_resume: true,
                        enable_precise_resume: false,
                        enable_active_item_highlight: true,
                        // Networking & Buffering Defaults
                        disable_network_overrides: false,
                        enable_cache: true,
                        http_persistence: 'auto',
                        demuxer_max_bytes: '1G',
                        demuxer_max_back_bytes: '500M',
                        cache_secs: 500,
                        demuxer_readahead_secs: 500,
                        stream_buffer_size: '10M',
                        ytdlp_concurrent_fragments: 4,
                        enable_reconnect: true,
                        reconnect_delay: 4,
                        performance_profile: 'default',
                        ffmpeg_path: '',
                        node_path: '',
                        restricted_domains: [],
                        // Keybindings
                        kb_add_playlist: 'Shift+A',
                        kb_play_playlist: 'Shift+P',
                        kb_toggle_controller: 'Shift+S',
                        kb_switch_playlist: 'Shift+Tab',
                        kb_open_popup: 'Alt+P',
                        dependencyStatus: {
                            mpv: { found: null, path: null, error: null },
                            ytdlp: { found: null, path: null, version: null, error: null },
                            ffmpeg: { found: null, path: null, version: null, error: null },
                            node: { found: null, path: null, version: null, error: null }
                        }
                    },
                    domains: {}
                }
            }
        };
    }

    async get() {
        try {
            const data = await chrome.storage.local.get(this.STORAGE_KEY);
            return data[this.STORAGE_KEY] || this._getDefaultData();
        } catch (e) {
            console.error("Storage get failed:", e);
            // Return default data on error to prevent app crash, 
            // though this might mask persistence issues.
            return this._getDefaultData();
        }
    }

    async set(data) {
        // Use a promise chain to ensure sequential execution of write operations.
        this.writeQueue = this.writeQueue.then(async () => {
            try {
                await chrome.storage.local.set({ [this.STORAGE_KEY]: data });
            } catch (e) {
                console.error("Storage set failed:", e);
                if (this.broadcastLog) {
                    this.broadcastLog({ text: `[Background]: Storage write failed: ${e.message}`, type: 'error' });
                }
            }
        });
        return this.writeQueue;
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

            if (typeof globalPrefs.clear_on_completion === 'boolean') {
                needsUpdate = true;
                globalPrefs.clear_on_completion = globalPrefs.clear_on_completion ? 'yes' : 'no';
            }

            const defaultGlobalPrefs = this._getDefaultData().settings.ui_preferences.global;
            storedValue.settings.ui_preferences.global = { ...defaultGlobalPrefs, ...globalPrefs };

            // Ensure dependencyStatus has all required keys
            if (!storedValue.settings.ui_preferences.global.dependencyStatus) {
                storedValue.settings.ui_preferences.global.dependencyStatus = defaultGlobalPrefs.dependencyStatus;
                needsUpdate = true;
            } else {
                const currentStatus = storedValue.settings.ui_preferences.global.dependencyStatus;
                const defaultStatus = defaultGlobalPrefs.dependencyStatus;
                let statusModified = false;
                
                for (const key in defaultStatus) {
                    if (!currentStatus[key]) {
                        currentStatus[key] = defaultStatus[key];
                        statusModified = true;
                    }
                }
                
                if (statusModified) {
                    storedValue.settings.ui_preferences.global.dependencyStatus = currentStatus;
                    needsUpdate = true;
                }
            }

            // Migration: Ensure all playlist items have a 'settings' object and a unique 'id'.
            for (const folderId in storedValue.folders) {
                const folder = storedValue.folders[folderId];
                if (folder.playlist && Array.isArray(folder.playlist)) {
                    folder.playlist = folder.playlist.map(item => {
                        let modified = false;
                        let newItem = { ...item };
                        
                        if (typeof item === 'object' && item !== null) {
                            if (!item.settings) {
                                newItem.settings = {};
                                modified = true;
                            }
                            if (!item.id) {
                                newItem.id = crypto.randomUUID();
                                modified = true;
                            }
                        }
                        
                        if (modified) {
                            needsUpdate = true;
                            return newItem;
                        }
                        return item;
                    });
                }
            }
        }
    
        if (storedValue.folders) {
            for (const folderId in storedValue.folders) {
                const folder = storedValue.folders[folderId];
                if (folder.playlist && folder.playlist.length > 0 && typeof folder.playlist[0] === 'string') {
                    this.broadcastLog({ text: `[Background]: Migrating playlist for folder '${folderId}' to new format.`, type: 'info' });
                    folder.playlist = folder.playlist.map(url => ({ url: url, title: url }));
                    needsUpdate = true;
                }
            }
        }

        if (needsUpdate) {
            await this.set(storedValue);
            this.broadcastLog({ text: `[Background]: Data structure updated to latest version.`, type: 'info' });
        }
    }

    async _migrateStorageToOneObject() {
        const oldFolderIdsResult = await chrome.storage.local.get('folder_ids');
        if (oldFolderIdsResult.folder_ids) {
            console.log("Old storage format detected. Migrating to unified object...");
            const newData = this._getDefaultData();
            newData.folders = {};
            newData.folderOrder = [];
            const keysToRemove = ['folder_ids'];

            for (const folderId of oldFolderIdsResult.folder_ids) {
                const folderKey = `folder_${folderId}`;
                const folderDataResult = await chrome.storage.local.get(folderKey);
                const storedValue = folderDataResult[folderKey];
                let playlist = Array.isArray(storedValue) ? storedValue : (storedValue?.playlist || storedValue?.urls || []);
                if (playlist.length > 0 && typeof playlist[0] === 'string') {
                    playlist = playlist.map(url => ({ url: url, title: url, settings: {} }));
                } else {
                    // Ensure existing objects also have settings
                    playlist = playlist.map(item => ({ ...item, settings: item.settings || {} }));
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