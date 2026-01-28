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
			const versionData = await chrome.storage.local.get("mpv_storage_version");
			const version = versionData.mpv_storage_version || 1;
			if (version < 2) await this._migrateToGranularStorage();
			await this._migrateToCamelCaseSettings();
			await this._runDataMigrations();
			await this.runJanitorTasks();
		})();
		return this.initPromise;
	}

	async _migrateToCamelCaseSettings() {
		const keys = await chrome.storage.local.get(["mpv_settings", "mpv_camel_migrated"]);
		if (!keys.mpv_settings || keys.mpv_camel_migrated) return;

		console.log("[Storage] Migrating settings to camelCase...");
		const settings = keys.mpv_settings;
		
		const snakeToCamel = (str) => str.replace(/([-_][a-z])/g, group => group.toUpperCase().replace("-", "").replace("_", ""));

		const migrateObject = (obj) => {
			if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
			const newObj = {};
			for (const key in obj) {
				const newKey = snakeToCamel(key);
				newObj[newKey] = migrateObject(obj[key]);
			}
			return newObj;
		};

		if (settings.ui_preferences) {
			settings.uiPreferences = migrateObject(settings.ui_preferences);
			delete settings.ui_preferences;
		}
		
		if (settings.lastUsedFolderId === undefined && settings.last_used_folder_id !== undefined) {
			settings.lastUsedFolderId = settings.last_used_folder_id;
			delete settings.last_used_folder_id;
		}

		await chrome.storage.local.set({ 
			mpv_settings: settings,
			mpv_camel_migrated: true 
		});
		console.log("[Storage] camelCase migration complete.");
	}

	async _migrateToGranularStorage() {
		console.log("[Storage] Migrating to Granular Storage (v2)...");
		const legacyData = await chrome.storage.local.get(this.STORAGE_KEY);
		const data = legacyData[this.STORAGE_KEY];
		if (!data) {
			await chrome.storage.local.set({ mpv_storage_version: 2 });
			return;
		}
		const update = {
			mpv_storage_version: 2,
			mpv_settings: data.settings,
			mpv_folder_index: data.folderOrder || Object.keys(data.folders),
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
			// Optimization: Only get the core keys first.
			// We don't necessarily need all folders at once for the main UI.
			const keys = await chrome.storage.local.get([
				"mpv_settings",
				"mpv_folder_index",
			]);
			if (!keys.mpv_settings) {
				const legacy = await chrome.storage.local.get(this.STORAGE_KEY);
				this._cache = legacy[this.STORAGE_KEY] || this._getDefaultData();
				return this._cache;
			}

			const settings = keys.mpv_settings;
			const folderOrder = keys.mpv_folder_index || ["Default"];

			// To maintain compatibility with the current 'get()' signature (which returns everything),
			// we still fetch all folders, but we use a more efficient multi-key get.
			const folderKeys = folderOrder.map((id) => `mpv_folder_data_${id}`);
			const foldersData = await chrome.storage.local.get(folderKeys);

			const folders = {};
			folderOrder.forEach((id) => {
				folders[id] = foldersData[`mpv_folder_data_${id}`] || {
					playlist: [],
					lastPlayedId: null,
				};
			});

			this._cache = { settings, folderOrder, folders };
			return this._cache;
		} catch (e) {
			console.error("Storage get failed:", e);
			return this._getDefaultData();
		}
	}

	/**
	 * Optimized method to get data for a single folder without loading the entire library.
	 */
	async getFolder(folderId) {
		const folderKey = `mpv_folder_data_${folderId}`;
		const result = await chrome.storage.local.get([folderKey, "mpv_settings"]);
		return {
			folder: result[folderKey] || { playlist: [], lastPlayedId: null },
			settings: result.mpv_settings,
		};
	}

	async set(data, folderId = null) {
		// Update cache immediately
		this._cache = data;

		this.writeQueue = this.writeQueue.then(async () => {
			try {
				// If folderId is provided, we only validate and save that specific folder
				// instead of validating the entire library structure.
				if (folderId && data.folders[folderId]) {
					this._validateFolder(folderId, data.folders[folderId]);

					const update = {
						[`mpv_folder_data_${folderId}`]: data.folders[folderId],
						mpv_settings: data.settings,
					};

					// Also ensure folder is in index
					const currentOrder = data.folderOrder || [];
					if (!currentOrder.includes(folderId)) {
						currentOrder.push(folderId);
						update["mpv_folder_index"] = currentOrder;
					}

					await chrome.storage.local.set(update);
				} else {
					// Fallback to full validation and save if no specific folder targeted
					this._validateData(data);
					const update = {
						mpv_storage_version: 2,
						mpv_settings: data.settings,
						mpv_folder_index: data.folderOrder || Object.keys(data.folders),
					};
					for (const [fid, fData] of Object.entries(data.folders)) {
						update[`mpv_folder_data_${fid}`] = fData;
					}
					await chrome.storage.local.set(update);
				}
			} catch (e) {
				console.error("Storage set failed:", e);
				if (this.broadcastLog)
					this.broadcastLog({
						text: `[Storage]: Write failed: ${e.message}`,
						type: "error",
					});
			}
		});
		return this.writeQueue;
	}

	_validateFolder(id, folder) {
		if (id.length > 64)
			throw new Error(`Folder ID '${id}' exceeds 64 characters`);
		if (!folder || !folder.playlist || !Array.isArray(folder.playlist))
			throw new Error(`Folder '${id}' must have a playlist array`);

		// Use a standard for loop for performance on large playlists
		for (let i = 0; i < folder.playlist.length; i++) {
			const item = folder.playlist[i];
			if (!item.url)
				throw new Error(`Item at index ${i} in '${id}' missing URL`);
			if (!item.id)
				item.id =
					typeof crypto !== "undefined" && crypto.randomUUID
						? crypto.randomUUID()
						: Math.random().toString(36).slice(2);
		}
	}

	async runJanitorTasks() {
		const data = await this.get();
		let modified = false;
		const folderIds = Object.keys(data.folders);
		const orderedIds = data.folderOrder || [];

		const validOrder = orderedIds.filter((id) => data.folders[id]);
		if (validOrder.length !== orderedIds.length) {
			data.folderOrder = validOrder;
			modified = true;
		}

		folderIds.forEach((id) => {
			if (!data.folderOrder.includes(id)) {
				data.folderOrder.push(id);
				modified = true;
			}
		});

		if (modified) await this.set(data);
	}

	_getDefaultData() {
		return {
			folders: { Default: { playlist: [], lastPlayedId: null } },
			folderOrder: ["Default"],
			settings: {
				lastUsedFolderId: "Default",
				uiPreferences: {
					global: {
						minimized: false,
						mode: "full",
						logVisible: true,
						pinned: false,
						position: {
							top: "10px",
							left: "auto",
							right: "10px",
							bottom: "auto",
						},
						launchGeometry: "",
						customGeometryWidth: "",
						customGeometryHeight: "",
						customMpvFlags: "",
						mpvDecoder: "auto",
						automaticMpvFlags: [
							{ flag: "--force-window=yes", enabled: true },
							{ flag: "--save-position-on-quit", enabled: true },
						],
						showPlayNewButton: false,
						duplicateUrlBehavior: "ask",
						syncGlobalRemovals: false,
						autoAppendOnAdd: true,
						liveRemoval: true,
						confirmRemoveFolder: true,
						confirmClearPlaylist: true,
						confirmCloseMpv: true,
						confirmPlayNew: true,
						confirmFolderSwitch: true,
						clearOnItemFinish: false,
						clearOnCompletion: "no",
						clearScope: "session",
						anilistPanelVisible: false,
						enableDblclickCopy: false,
						anilistImageHeight: 126,
						lockAnilistPanel: false,
						forcePanelAttached: false,
						anilistAttachOnOpen: true,
						popupWidth: 600,
						ytUseCookies: true,
						ytMarkWatched: true,
						ytIgnoreConfig: true,
						otherSitesUseCookies: true,
						showWatchedStatusGui: true,
						minimizedStubPosition: { top: "15px", left: "15px" },
						showMinimizedStub: true,
						enableSmartResume: true,
						enableActiveItemHighlight: true,
						disableNetworkOverrides: false,
						enableCache: true,
						httpPersistence: "auto",
						demuxerMaxBytes: "1G",
						demuxerMaxBackBytes: "500M",
						cacheSecs: 500,
						demuxerReadaheadSecs: 500,
						streamBufferSize: "10M",
						ytdlpConcurrentFragments: 4,
						enableReconnect: true,
						reconnectDelay: 4,
						performanceProfile: "default",
						restrictedDomains: [],
						kbAddPlaylist: "Shift+A",
						kbPlayPlaylist: "Shift+P",
						kbToggleController: "Shift+S",
						kbSwitchPlaylist: "Shift+Tab",
						kbOpenPopup: "Alt+P",
						dependencyStatus: {
							mpv: { found: null, path: null },
							ytdlp: { found: null, path: null },
							ffmpeg: { found: null, path: null },
							node: { found: null, path: null },
						},
					},
					domains: {},
				},
			},
		};
	}

	_validateData(data) {
		if (!data || typeof data !== "object")
			throw new Error("Data must be an object");

		// Prototype Pollution Protection
		const isPoisoned = (obj) => {
			if (!obj || typeof obj !== "object") return false;
			if (
				Object.keys(obj).some(
					(k) => k === "__proto__" || k === "constructor" || k === "prototype",
				)
			)
				return true;
			return Object.values(obj).some(
				(v) => typeof v === "object" && isPoisoned(v),
			);
		};
		if (isPoisoned(data))
			throw new Error("Malicious data detected (Prototype Pollution)");

		if (!data.folders || typeof data.folders !== "object")
			throw new Error("Data must contain a 'folders' object");
		if (!data.settings || typeof data.settings !== "object")
			throw new Error("Data must contain a 'settings' object");

		// Validate folders
		for (const [id, folder] of Object.entries(data.folders)) {
			if (id.length > 64)
				throw new Error(`Folder ID '${id}' exceeds 64 characters`);
			if (!folder.playlist || !Array.isArray(folder.playlist))
				throw new Error(`Folder '${id}' must have a playlist array`);

			folder.playlist.forEach((item, index) => {
				if (!item.url)
					throw new Error(`Item at index ${index} in '${id}' missing URL`);
				if (!item.id) item.id = crypto.randomUUID(); // Auto-fix missing IDs
			});
		}
	}

	async _runDataMigrations() {
		const data = await this.get();
		let needsUpdate = false;

		// Ensure all items have unique IDs, settings, and camelCase keys
		for (const folderId in data.folders) {
			const folder = data.folders[folderId];
			if (folder.playlist) {
				folder.playlist = folder.playlist.map((item) => {
					if (typeof item === "object" && item !== null) {
						let modified = false;
						const newItem = { ...item };

						if (!newItem.id) {
							newItem.id = crypto.randomUUID();
							modified = true;
						}
						if (!newItem.settings) {
							newItem.settings = {};
							modified = true;
						}

						// Migration: resume_time -> resumeTime
						if (newItem.resume_time !== undefined && newItem.resumeTime === undefined) {
							newItem.resumeTime = newItem.resume_time;
							delete newItem.resume_time;
							modified = true;
						}

						// Migration: marked_as_watched -> markedAsWatched
						if (newItem.marked_as_watched !== undefined && newItem.markedAsWatched === undefined) {
							newItem.markedAsWatched = newItem.marked_as_watched;
							delete newItem.marked_as_watched;
							modified = true;
						}

						if (modified) {
							needsUpdate = true;
							return newItem;
						}
					}
					return item;
				});
			}
		}
		if (needsUpdate) await this.set(data);
	}
}
