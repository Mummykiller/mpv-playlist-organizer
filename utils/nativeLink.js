/**
 * @class NativeLink
 * Centralized service for JavaScript-to-Python communication.
 * Provides a type-safe, semantic API for the Native Host.
 */

import { callNativeHost } from "./nativeConnection.module.js";
import { storage } from "../background/storage_instance.js";

class NativeLink {
	constructor() {
		// Generic filesystem namespace
		this.fileSystem = {
			listFiles: () => this.call("list_import_files"),
			openExportFolder: () => this.call("open_export_folder"),
			call: (action, data = {}) => this.call(action, data),
		};
	}

	/**
	 * Generic passthrough for any action not explicitly defined.
	 * @param {string} action The snake_case action name.
	 * @param {object} data Payload data.
	 * @param {boolean} shouldThrow Whether to throw on error.
	 */
	async call(action, data = {}, shouldThrow = false) {
		return callNativeHost({ action, ...data }, shouldThrow);
	}

	// --- Heartbeat & Status ---
	async ping() {
		return this.call("ping");
	}

	async isMpvRunning() {
		return this.call("is_mpv_running");
	}

	async getPlaybackStatus() {
		return this.call("get_playback_status");
	}

	// --- Lifecycle ---
	async closeMpv(folderId = null) {
		return this.call("close_mpv", { folderId });
	}

	// --- Playback & Queue Management ---

	/**
	 * Plays a single item or folder.
	 */
	async play(item, folderId, options = {}) {
		const data = await storage.get();
		const globalPrefs = data.settings.uiPreferences.global;

		const isPlayNew = options.playNewInstance || false;
		const action = isPlayNew ? "play_new_instance" : "play";

		const payload = {
			action,
			urlItem: this._injectItemSettings(item, globalPrefs),
			folderId,
			playlistStartId: options.playlistStartId,
			...this._enrichPayload(globalPrefs, options),
		};

		if (isPlayNew && item) {
			payload.playlist = [payload.urlItem];
		}

		return this.call(action, payload);
	}

	/**
	 * Plays an M3U playlist (items, content, or path).
	 */
	async playM3U(m3uData, folderId, options = {}) {
		const data = await storage.get();
		const globalPrefs = data.settings.uiPreferences.global;

		const isPlayNew = options.playNewInstance || false;
		const action = isPlayNew ? "play_new_instance" : "play_m3u";

		const payload = {
			action,
			m3uData: m3uData,
			folderId,
			playlistStartId: options.playlistStartId,
			...this._enrichPayload(globalPrefs, options),
		};

		if (isPlayNew && m3uData.type === "items") {
			payload.playlist = m3uData.value.map((item) =>
				this._injectItemSettings(item, globalPrefs),
			);
		}

		return this.call(action, payload);
	}

	/**
	 * Appends one or more items to the active session.
	 */
	async append(items, folderId) {
		const data = await storage.get();
		const globalPrefs = data.settings.uiPreferences.global;

		const itemList = Array.isArray(items) ? items : [items];
		const processedItems = itemList.map((item) =>
			this._injectItemSettings(item, globalPrefs),
		);

		return this.call("append", {
			urlItems: processedItems,
			folderId,
		});
	}

	async clearLive(folderId) {
		return this.call("clear_live", { folderId });
	}

	async reorderLive(folderId, newOrder) {
		return this.call("reorder_live", { folderId, newOrder: newOrder });
	}

	// --- UI State & Preferences ---
	/**
	 * Syncs the current state to the native host's persistent storage.
	 * @param {string} folderId Optional ID for incremental sync.
	 */
	async syncToFile(folderId = null) {
		const data = await storage.get();
		const payload = {
			action: "export_data",
		};

		if (folderId && data.folders[folderId]) {
			payload.data = { [folderId]: data.folders[folderId] };
			payload.isIncremental = true;
		} else {
			payload.data = data.folders;
			payload.isIncremental = false;
		}

		return this.call("export_data", payload);
	}

	async setUiPreferences(preferences) {
		return this.call("set_ui_preferences", { preferences });
	}

	async getUiPreferences() {
		return this.call("get_ui_preferences");
	}

	async getDefaultAutomaticFlags() {
		return this.call("get_default_automatic_flags");
	}

	async setMinimizedState(minimized) {
		return this.call("set_minimized_state", { minimized });
	}

	// --- Dependency & External Services ---
	async getAnilistReleases(params = {}) {
		return this.call("get_anilist_releases", params);
	}

	async checkYtdlpUpdate() {
		return this.call("ytdlp_update_check");
	}

	async runYtdlpUpdate() {
		return this.call("run_ytdlp_update");
	}

	// --- Internal Helpers ---

	/**
	 * Injects granular item settings based on global preferences.
	 */
	_injectItemSettings(item, globalPrefs) {
		if (!item) return item;
		const settings = item.settings || {};
		return {
			...item,
			settings: {
				...settings,
				ytUseCookies: globalPrefs.ytUseCookies ?? true,
				ytMarkWatched: globalPrefs.ytMarkWatched ?? true,
				ytIgnoreConfig: globalPrefs.ytIgnoreConfig ?? true,
				otherSitesUseCookies: globalPrefs.otherSitesUseCookies ?? true,
			},
		};
	}

	/**
	 * Enriches the payload with global preferences and caller overrides.
	 */
	_enrichPayload(globalPrefs, overrides = {}) {
		return {
			geometry:
				overrides.geometry ||
				(globalPrefs.launchGeometry === "custom"
					? null
					: globalPrefs.launchGeometry),
			customWidth:
				overrides.customWidth ||
				(globalPrefs.launchGeometry === "custom"
					? globalPrefs.customGeometryWidth
					: null),
			customHeight:
				overrides.customHeight ||
				(globalPrefs.launchGeometry === "custom"
					? globalPrefs.customGeometryHeight
					: null),
			customMpvFlags:
				overrides.customMpvFlags || globalPrefs.customMpvFlags || "",
			automaticMpvFlags: globalPrefs.automaticMpvFlags || [],
			forceTerminal: globalPrefs.forceTerminal ?? false,
			clearOnCompletion:
				overrides.clearOnCompletion ?? globalPrefs.clearOnCompletion ?? false,
			startPaused: overrides.startPaused ?? false,
			// Networking & Performance Sync
			disableNetworkOverrides: globalPrefs.disableNetworkOverrides ?? false,
			enableCache: globalPrefs.enableCache ?? true,
			httpPersistence: globalPrefs.httpPersistence || "auto",
			demuxerMaxBytes: globalPrefs.demuxerMaxBytes || "1G",
			demuxerMaxBackBytes: globalPrefs.demuxerMaxBackBytes || "500M",
			cacheSecs: globalPrefs.cacheSecs || 500,
			demuxerReadaheadSecs: globalPrefs.demuxerReadaheadSecs || 500,
			streamBufferSize: globalPrefs.streamBufferSize || "10M",
			ytdlpConcurrentFragments: globalPrefs.ytdlpConcurrentFragments || 4,
			enableReconnect: globalPrefs.enableReconnect ?? true,
			reconnectDelay: globalPrefs.reconnectDelay || 4,
			mpvDecoder: globalPrefs.mpvDecoder || "auto",
			ytdlQuality: globalPrefs.ytdlQuality || "best",
			performanceProfile: globalPrefs.performanceProfile || "default",
			enablePreciseResume: globalPrefs.enablePreciseResume ?? true,
			ultraScalers: globalPrefs.ultraScalers ?? true,
			ultraVideoSync: globalPrefs.ultraVideoSync ?? true,
			ultraInterpolation: globalPrefs.ultraInterpolation || "oversample",
			ultraDeband: globalPrefs.ultraDeband ?? true,
			ultraFbo: globalPrefs.ultraFbo ?? true,
		};
	}
}

export const nativeLink = new NativeLink();
