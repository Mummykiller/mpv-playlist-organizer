/**
 * Manages all data persistence and migration logic for the extension.
 * It uses a single unified object in chrome.storage.local.
 */
export class StorageManager {
    constructor(storageKey, broadcastLog) {
        this.STORAGE_KEY = storageKey;
        this.initPromise = null;
        this.broadcastLog = broadcastLog; // Dependency for logging during migrations
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
                        custom_mpv_flags: '',
                        automatic_mpv_flags: [
                            { flag: '--force-window=yes', description: 'Create a video output window even if there is no video.', enabled: true },
                            { flag: '--save-position-on-quit', description: 'Always save the current playback position on quit.', enabled: true }
                        ],
                        show_play_new_button: false, duplicate_url_behavior: 'ask', one_click_add: false,
                        auto_append_on_add: true,
                        live_removal: true,
                        stream_scanner_timeout: 60, confirm_remove_folder: true, confirm_clear_playlist: true,
                        confirm_close_mpv: true, confirm_play_new: true, confirm_folder_switch: true, clear_on_completion: false,
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
                        // Keybindings
                        kb_add_playlist: 'Shift+A',
                        kb_play_playlist: 'Shift+P',
                        kb_toggle_controller: 'Shift+S',
                        kb_open_popup: 'Alt+P',
                        dependencyStatus: {
                            mpv: { found: null, path: null, error: null },
                            ytdlp: { found: null, path: null, version: null, error: null }
                        },
                        // Define default bypass scripts. The native host will handle execution.
                        // These scripts will be used automatically if detected and matched.
                        bypassScripts: {
                            "animepahe_bypass": {

                                "match_patterns": ["*://animepahe.com/*"],
                                "script_path": "play_with_bypass.sh", // Path relative to native_host.py
                                "description": "Bypass security for AnimePahe.com streams."
                            }
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

            if (!storedValue.settings.ui_preferences.global.dependencyStatus) {
                storedValue.settings.ui_preferences.global.dependencyStatus = this._getDefaultData().settings.ui_preferences.global.dependencyStatus;
                needsUpdate = true;
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