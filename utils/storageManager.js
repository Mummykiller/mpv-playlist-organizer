import { normalizeKeys } from "./commUtils.module.js";

function generateUuid() {
	return typeof crypto !== "undefined" && crypto.randomUUID
		? crypto.randomUUID()
		: Math.random().toString(36).slice(2);
}

function cloneStorageData(value) {
	if (value === null || value === undefined || typeof value !== "object") {
		return value;
	}
	if (typeof structuredClone === "function") {
		try {
			return structuredClone(value);
		} catch (e) {
			// Fallback to JSON clone if value contains non-cloneable properties
			console.debug("[Storage] structuredClone fallback:", e?.message || e);
		}
	}
	return JSON.parse(JSON.stringify(value));
}

/**
 * Manages all data persistence and migration logic for the extension.
 * Uses a granular 'Bucket' system to improve performance and memory usage.
 */
export class StorageManager {
	constructor(storageKey, broadcastLog) {
		this.STORAGE_KEY = storageKey;
		this._initPromise = null;
		this.initPromise = null;
		this._initComplete = false;
		this.broadcastLog = broadcastLog;
		this.writeQueue = Promise.resolve();
		this._lockQueue = Promise.resolve();
		this._cache = null;
	}

	async initialize() {
		if (this._initPromise) return this._initPromise;
		this._initPromise = (async () => {
			try {
				const versionData = await chrome.storage.local.get("mpv_storage_version");
				const version = versionData?.mpv_storage_version || 1;
				if (version < 2) await this._migrateToGranularStorage();
				await this._migrateToCamelCaseSettings();
				await this._runDataMigrations(true);
				await this.runJanitorTasks(true);
				this._initComplete = true;
			} catch (e) {
				this._initPromise = null;
				this.initPromise = null;
				this._initComplete = false;
				throw e;
			}
		})();
		this.initPromise = this._initPromise;
		return this._initPromise;
	}

	async _migrateToCamelCaseSettings() {
		const keys = await chrome.storage.local.get(["mpv_settings", "mpv_camel_migrated"]);
		if (!keys.mpv_settings) return;

		// SELF-HEALING: Always ensure global preferences are purged of snake_case trash and domain keys
		// This prevents sync conflicts with the native host
		if (keys.mpv_settings.uiPreferences?.global) {
			const globalPrefs = keys.mpv_settings.uiPreferences.global;
			let polluted = false;
			for (const key in globalPrefs) {
				if (key.includes("_") && key !== "request_id") {
					delete globalPrefs[key];
					polluted = true;
				}
			}
			if (globalPrefs.minimized !== undefined) {
				delete globalPrefs.minimized;
				polluted = true;
			}
			if (polluted) {
				console.log("[Storage] Purged polluted keys from global preferences.");
				await chrome.storage.local.set({ mpv_settings: keys.mpv_settings });
			}
		}

		if (keys.mpv_camel_migrated) return;

		console.log("[Storage] Migrating settings to camelCase...");
		const settings = normalizeKeys(keys.mpv_settings);
		
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

	async get(force = false, fromInit = false) {
		if (this._initPromise && !this._initComplete && !fromInit) {
			await this._initPromise;
		}
		if (this._cache && !force) return cloneStorageData(this._cache);

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
				return cloneStorageData(this._cache);
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
			return cloneStorageData(this._cache);
		} catch (e) {
			console.error("Storage get failed:", e);
			return this._getDefaultData();
		}
	}

	/**
	 * Optimized method to get data for a single folder without loading the entire library.
	 */
	async getFolder(folderId) {
		if (this._initPromise && !this._initComplete) {
			await this._initPromise;
		}
		const folderKey = `mpv_folder_data_${folderId}`;
		const result = await chrome.storage.local.get([folderKey, "mpv_settings", "mpv_folder_index"]);
		let folderData = result[folderKey];
		if (!folderData && folderId && Array.isArray(result.mpv_folder_index)) {
			const matchedId = result.mpv_folder_index.find(
				(id) => id.toLowerCase() === folderId.toLowerCase(),
			);
			if (matchedId && matchedId !== folderId) {
				const matchedKey = `mpv_folder_data_${matchedId}`;
				const matchedRes = await chrome.storage.local.get(matchedKey);
				folderData = matchedRes[matchedKey];
			}
		}
		return {
			folder: folderData || { playlist: [], lastPlayedId: null },
			settings: result.mpv_settings,
		};
	}

	async set(data, folderId = null) {
		const writePromise = this.writeQueue.then(async () => {
			try {
				// 0. Change-Aware Optimization: Get existing data to compare
				const keysToFetch = folderId
					? [`mpv_folder_data_${folderId}`, "mpv_settings", "mpv_folder_index"]
					: ["mpv_settings", "mpv_folder_index"];
				const existing = await chrome.storage.local.get(keysToFetch);

				// If folderId is provided, we only validate and save that specific folder
				if (folderId && data.folders[folderId]) {
					this._validateFolder(folderId, data.folders[folderId]);

					const folderKey = `mpv_folder_data_${folderId}`;
					const folderChanged = JSON.stringify(data.folders[folderId]) !== JSON.stringify(existing[folderKey]);
					const settingsChanged = JSON.stringify(data.settings) !== JSON.stringify(existing.mpv_settings);

					const currentOrder = Array.isArray(data.folderOrder)
						? [...data.folderOrder]
						: Array.isArray(existing.mpv_folder_index)
							? [...existing.mpv_folder_index]
							: [];
					if (!currentOrder.includes(folderId)) {
						currentOrder.push(folderId);
					}
					const indexChanged = JSON.stringify(currentOrder) !== JSON.stringify(existing.mpv_folder_index || []);

					if (!folderChanged && !settingsChanged && !indexChanged) {
						this._cache = cloneStorageData(data);
						return;
					}

					const update = {};
					if (folderChanged) update[folderKey] = data.folders[folderId];
					if (settingsChanged) update.mpv_settings = data.settings;
					if (indexChanged) update["mpv_folder_index"] = currentOrder;

					await chrome.storage.local.set(update);
					this._cache = cloneStorageData(data);
				} else {
					// Full validation and save
					this._validateData(data);
					const prevIndex = existing.mpv_folder_index || [];
					const update = {
						mpv_storage_version: 2,
						mpv_settings: data.settings,
						mpv_folder_index: data.folderOrder || Object.keys(data.folders),
					};
					for (const [fid, fData] of Object.entries(data.folders)) {
						update[`mpv_folder_data_${fid}`] = fData;
					}
					await chrome.storage.local.set(update);
					this._cache = cloneStorageData(data);

					const orphanedKeys = prevIndex
						.filter((fid) => !Object.prototype.hasOwnProperty.call(data.folders, fid))
						.map((fid) => `mpv_folder_data_${fid}`);
					if (orphanedKeys.length > 0 && chrome.storage?.local?.remove) {
						await chrome.storage.local.remove(orphanedKeys);
					}
				}
			} catch (e) {
				this._cache = null;
				console.error("Storage set failed:", e);
				if (this.broadcastLog)
					this.broadcastLog({
						text: `[Storage]: Write failed: ${e.message}`,
						type: "error",
					});
				throw e;
			}
		});
		this.writeQueue = writePromise.catch(() => {});
		return writePromise;
	}

	/**
	 * Serializes read-modify-write operations so concurrent callers cannot clobber each other.
	 * Waits for any prior queued writes before invoking `fn` without deadlocking nested `set()` calls.
	 * @template T
	 * @param {() => Promise<T> | T} fn
	 * @returns {Promise<T>}
	 */
	async withLock(fn) {
		if (typeof fn !== "function") {
			throw new TypeError("withLock requires a callback function");
		}
		const run = this._lockQueue.then(async () => {
			await this.writeQueue;
			return await fn();
		});
		this._lockQueue = run.catch(() => {});
		return run;
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
			if (!item.id) item.id = generateUuid();
		}
	}

	async runJanitorTasks(fromInit = false) {
		const data = await this.get(false, fromInit);
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

		if (chrome.storage?.local?.get && chrome.storage?.local?.remove) {
			try {
				const allStorage = await chrome.storage.local.get(null);
				if (allStorage && typeof allStorage === "object") {
					const orphanedKeys = Object.keys(allStorage).filter((key) => {
						if (!key.startsWith("mpv_folder_data_")) return false;
						const fid = key.substring("mpv_folder_data_".length);
						return !Object.prototype.hasOwnProperty.call(data.folders, fid);
					});
					if (orphanedKeys.length > 0) {
						await chrome.storage.local.remove(orphanedKeys);
					}
				}
			} catch (e) {
				console.debug("[Storage] Failed to clean orphaned folder shards:", e);
			}
		}

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
						forceTerminal: false,
						automaticMpvFlags: [
							{ flag: "--pause", description: "Start MPV paused.", enabled: false },
							{ flag: "--terminal", description: "Show a terminal window.", enabled: false },
							{ flag: "--save-position-on-quit", description: "Remember playback position on exit.", enabled: true },
							{ flag: "--loop-playlist=inf", description: "Loop the entire playlist indefinitely.", enabled: false },
							{ flag: "--ontop", description: "Keep the player window on top of other windows.", enabled: false },
							{ flag: "--force-window=immediate", description: "Open the window immediately when starting.", enabled: false },
						],
						showPlayNewButton: false,
						duplicateUrlBehavior: "ask",
						syncGlobalRemovals: false,
						syncGlobalRemovalsLive: false,
						autoAppendOnAdd: true,
						liveRemoval: true,
						autoAddInactivityTimeout: 30,
						autoAddAutoOff: true,
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
						oneClickAdd: false,
						enableUrlAnalysis: true,
						browserForUrlAnalysis: "chrome",
						enableYoutubeAnalysis: false,
						userAgentString:
							"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
						enableSmartResume: true,
						enablePreciseResume: true,
						enableActiveItemHighlight: true,
						disableNetworkOverrides: false,
						targetedDefaults: "all-none-yt",
						enableCache: true,
						httpPersistence: "auto",
						demuxerMaxBytes: "1G",
						demuxerMaxBackBytes: "500M",
						cacheSecs: 500,
						demuxerReadaheadSecs: 500,
						streamBufferSize: "10M",
						ytdlpConcurrentFragments: 4,
						ytdlQuality: "best",
						enableReconnect: true,
						reconnectDelay: 4,
						performanceProfile: "default",
						ultraScalers: true,
						enableDisplaySync: true,
						overrideDisplayFps: "",
						ultraInterpolation: "oversample",
						ultraDeband: true,
						ultraFbo: true,
						restrictedDomains: [],
						kbAddPlaylist: "Shift+A",
						kbPlayPlaylist: "Shift+P",
						kbToggleController: "Shift+S",
						kbSwitchPlaylist: "Shift+Tab",
						kbOpenPopup: "Alt+P",
						streamScannerTimeout: 30,
						autofocusNewFolder: false,
						showCopyTitleButton: false,
						enableAnilistIntegration: true,
						disableAnilistCache: false,
						ytdlpUpdateBehavior: "manual",
						popupWidthLocked: false,
						scraperFilterWords: [],
						ffmpegPath: "",
						nodePath: "",
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
				if (!item.id) item.id = generateUuid(); // Auto-fix missing IDs
			});
		}
	}

	async _runDataMigrations(fromInit = false) {
		const data = await this.get(false, fromInit);
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
						
						// Initialize defaults if missing
						if (newItem.markedAsWatched === undefined) {
							newItem.markedAsWatched = false;
							modified = true;
						}

						// NEW: Redundancy Sync - Ensure 'watched' exists
						if (newItem.watched === undefined) {
							newItem.watched = false;
							modified = true;
						}

						// Migration: currently_playing -> currentlyPlaying
						if (newItem.currently_playing !== undefined && newItem.currentlyPlaying === undefined) {
							newItem.currentlyPlaying = newItem.currently_playing;
							delete newItem.currently_playing;
							modified = true;
						}

						// NEW: Conflict Resolution - ensure lastModified exists
						if (newItem.lastModified === undefined) {
							newItem.lastModified = item.last_modified || Date.now();
							modified = true;
						}

						if (modified) {
							console.log(`[Storage] Migrated item ${newItem.id}:`, newItem);
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
