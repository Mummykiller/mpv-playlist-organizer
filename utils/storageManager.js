/**
 * Manages all data persistence and migration logic for the extension.
 * Uses a granular 'Bucket' system to improve performance and memory usage.
 */
export class StorageManager {
    constructor(storageKey, broadcastLog) {
        this.STORAGE_KEY = storageKey;
        this.initPromise = null;
        this.broadcastLog = broadcastLog;
        this.writeQueue = Promise.resolve();
        this._cache = null;
    }

    async initialize() {
        if (this.initPromise) return this.initPromise;
        this.initPromise = (async () => {
            const versionData = await chrome.storage.local.get('mpv_storage_version');
            const version = versionData.mpv_storage_version || 1;
            if (version < 2) await this._migrateToGranularStorage();
            await this._runDataMigrations();
            await this.runJanitorTasks();
        })();
        return this.initPromise;
    }

    async _migrateToGranularStorage() {
        console.log("[Storage] Migrating to Granular Storage (v2)...");
        const legacyData = await chrome.storage.local.get(this.STORAGE_KEY);
        const data = legacyData[this.STORAGE_KEY];
        if (!data) {
            await chrome.storage.local.set({ 'mpv_storage_version': 2 });
            return;
        }
        const update = {
            'mpv_storage_version': 2,
            'mpv_settings': data.settings,
            'mpv_folder_index': data.folderOrder || Object.keys(data.folders)
        };
        for (const [folderId, folderData] of Object.entries(data.folders)) {
            update[`mpv_folder_data_${folderId}`] = folderData;
        }
        await chrome.storage.local.set(update);
        console.log("[Storage] Migration complete.");
    }

    async get(force = false) {
        if (this._cache && !force) return this._cache;
        
        try {
            const keys = await chrome.storage.local.get(['mpv_settings', 'mpv_folder_index']);
            if (!keys.mpv_settings) {
                const legacy = await chrome.storage.local.get(this.STORAGE_KEY);
                this._cache = legacy[this.STORAGE_KEY] || this._getDefaultData();
                return this._cache;
            }

            const settings = keys.mpv_settings;
            const folderOrder = keys.mpv_folder_index || ['Default'];
            
            const folderKeys = folderOrder.map(id => `mpv_folder_data_${id}`);
            const foldersData = await chrome.storage.local.get(folderKeys);

            const folders = {};
            folderOrder.forEach(id => {
                folders[id] = foldersData[`mpv_folder_data_${id}`] || { playlist: [], last_played_id: null };
            });

            this._cache = { settings, folderOrder, folders };
            return this._cache;
        } catch (e) {
            console.error("Storage get failed:", e);
            return this._getDefaultData();
        }
    }

    async set(data, folderId = null) {
        // Update cache immediately to ensure subsequent 'get' calls see the change
        this._cache = data;

        this.writeQueue = this.writeQueue.then(async () => {
            try {
                this._validateData(data);
                if (!data || !data.folders) throw new Error("Invalid data structure");

                // Sync folderOrder with actual folders keys
                const actualKeys = Object.keys(data.folders);
                const folderOrder = data.folderOrder || actualKeys;
                
                // Ensure all existing folders are in the index
                actualKeys.forEach(k => { if (!folderOrder.includes(k)) folderOrder.push(k); });

                const update = {
                    'mpv_storage_version': 2,
                    'mpv_settings': data.settings,
                    'mpv_folder_index': folderOrder
                };

                if (folderId) {
                    // PARTIAL UPDATE: Only write the changed folder
                    if (data.folders[folderId]) {
                        update[`mpv_folder_data_${folderId}`] = data.folders[folderId];
                    }
                } else {
                    // FULL UPDATE: Write all folders
                    for (const fid of folderOrder) {
                        if (data.folders[fid]) {
                            update[`mpv_folder_data_${fid}`] = data.folders[fid];
                        }
                    }
                }

                await chrome.storage.local.set(update);
            } catch (e) {
                console.error("Storage set failed:", e);
                if (this.broadcastLog) this.broadcastLog({ text: `[Storage]: Write failed: ${e.message}`, type: 'error' });
            }
        });
        return this.writeQueue;
    }

    async runJanitorTasks() {
        const data = await this.get();
        let modified = false;
        const folderIds = Object.keys(data.folders);
        const orderedIds = data.folderOrder || [];

        const validOrder = orderedIds.filter(id => data.folders[id]);
        if (validOrder.length !== orderedIds.length) { data.folderOrder = validOrder; modified = true; }

        folderIds.forEach(id => { if (!data.folderOrder.includes(id)) { data.folderOrder.push(id); modified = true; } });

        if (modified) await this.set(data);
    }

    _getDefaultData() {
        return {
            folders: { 'Default': { playlist: [], last_played_id: null } },
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
                            { flag: '--force-window=yes', enabled: true },
                            { flag: '--save-position-on-quit', enabled: true }
                        ],
                        show_play_new_button: false, duplicate_url_behavior: 'ask', auto_append_on_add: true,
                        live_removal: true, confirm_remove_folder: true, confirm_clear_playlist: true,
                        confirm_close_mpv: true, confirm_play_new: true, confirm_folder_switch: true,
                        clear_on_completion: 'no', clear_scope: 'session', anilistPanelVisible: false, enable_dblclick_copy: false,
                        anilist_image_height: 126, lockAnilistPanel: false, forcePanelAttached: false,
                        anilistAttachOnOpen: true, popup_width: 600, yt_use_cookies: true,
                        yt_mark_watched: true, yt_ignore_config: true, other_sites_use_cookies: true,
                        show_watched_status_gui: true,
                        minimizedStubPosition: { top: '15px', left: '15px' }, show_minimized_stub: true,
                        enable_smart_resume: true, enable_active_item_highlight: true,
                        disable_network_overrides: false, enable_cache: true, http_persistence: 'auto',
                        demuxer_max_bytes: '1G', demuxer_max_back_bytes: '500M', cache_secs: 500,
                        demuxer_readahead_secs: 500, stream_buffer_size: '10M', ytdlp_concurrent_fragments: 4,
                        enable_reconnect: true, reconnect_delay: 4, performance_profile: 'default',
                        restricted_domains: [], kb_add_playlist: 'Shift+A', kb_play_playlist: 'Shift+P',
                        kb_toggle_controller: 'Shift+S', kb_switch_playlist: 'Shift+Tab', kb_open_popup: 'Alt+P',
                        dependencyStatus: {
                            mpv: { found: null, path: null }, ytdlp: { found: null, path: null },
                            ffmpeg: { found: null, path: null }, node: { found: null, path: null }
                        }
                    },
                    domains: {}
                }
            }
        };
    }

    _validateData(data) {
        if (!data || typeof data !== 'object') throw new Error("Data must be an object");
        
        // Prototype Pollution Protection
        const isPoisoned = (obj) => {
            if (!obj || typeof obj !== 'object') return false;
            if (Object.keys(obj).some(k => k === '__proto__' || k === 'constructor' || k === 'prototype')) return true;
            return Object.values(obj).some(v => typeof v === 'object' && isPoisoned(v));
        };
        if (isPoisoned(data)) throw new Error("Malicious data detected (Prototype Pollution)");

        if (!data.folders || typeof data.folders !== 'object') throw new Error("Data must contain a 'folders' object");
        if (!data.settings || typeof data.settings !== 'object') throw new Error("Data must contain a 'settings' object");

        // Validate folders
        for (const [id, folder] of Object.entries(data.folders)) {
            if (id.length > 64) throw new Error(`Folder ID '${id}' exceeds 64 characters`);
            if (!folder.playlist || !Array.isArray(folder.playlist)) throw new Error(`Folder '${id}' must have a playlist array`);
            
            folder.playlist.forEach((item, index) => {
                if (!item.url) throw new Error(`Item at index ${index} in '${id}' missing URL`);
                if (!item.id) item.id = crypto.randomUUID(); // Auto-fix missing IDs
            });
        }
    }

    async _runDataMigrations() {
        const data = await this.get();
        let needsUpdate = false;
        
        // Ensure all items have unique IDs and settings
        for (const folderId in data.folders) {
            const folder = data.folders[folderId];
            if (folder.playlist) {
                folder.playlist = folder.playlist.map(item => {
                    if (typeof item === 'object' && item !== null) {
                        if (!item.id || !item.settings) {
                            needsUpdate = true;
                            return { ...item, id: item.id || crypto.randomUUID(), settings: item.settings || {} };
                        }
                    }
                    return item;
                });
            }
        }
        if (needsUpdate) await this.set(data);
    }
}
