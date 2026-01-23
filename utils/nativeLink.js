/**
 * @class NativeLink
 * Centralized service for JavaScript-to-Python communication.
 * Provides a type-safe, semantic API for the Native Host.
 */

import { callNativeHost } from "./nativeConnection.js";
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
		const globalPrefs = data.settings.ui_preferences.global;

		const isPlayNew = options.play_new_instance || false;
		const action = isPlayNew ? "play_new_instance" : "play";

		const payload = {
			action,
			url_item: this._injectItemSettings(item, globalPrefs),
			folderId,
			...this._enrichPayload(globalPrefs, options),
		};

		if (isPlayNew && item) {
			payload.playlist = [item.url];
		}

		return this.call(action, payload);
	}

	/**
	 * Plays an M3U playlist (items, content, or path).
	 */
	async playM3U(m3uData, folderId, options = {}) {
		const data = await storage.get();
		const globalPrefs = data.settings.ui_preferences.global;

		const isPlayNew = options.play_new_instance || false;
		const action = isPlayNew ? "play_new_instance" : "play_m3u";

		const payload = {
			action,
			m3u_data: m3uData,
			folderId,
			...this._enrichPayload(globalPrefs, options),
		};

		if (isPlayNew && m3uData.type === "items") {
			payload.playlist = m3uData.value.map((item) => item.url);
		}

		return this.call(action, payload);
	}

	/**
	 * Appends one or more items to the active session.
	 */
	async append(items, folderId) {
		const data = await storage.get();
		const globalPrefs = data.settings.ui_preferences.global;

		const itemList = Array.isArray(items) ? items : [items];
		const processedItems = itemList.map((item) =>
			this._injectItemSettings(item, globalPrefs),
		);

		return this.call("append", {
			url_items: processedItems,
			folderId,
		});
	}

	async clearLive(folderId) {
		return this.call("clear_live", { folderId });
	}

	async reorderLive(folderId, newOrder) {
		return this.call("reorder_live", { folderId, new_order: newOrder });
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
			payload.is_incremental = true;
		} else {
			payload.data = data.folders;
			payload.is_incremental = false;
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
				yt_use_cookies: globalPrefs.yt_use_cookies ?? true,
				yt_mark_watched: globalPrefs.yt_mark_watched ?? true,
				yt_ignore_config: globalPrefs.yt_ignore_config ?? true,
				other_sites_use_cookies: globalPrefs.other_sites_use_cookies ?? true,
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
				(globalPrefs.launch_geometry === "custom"
					? null
					: globalPrefs.launch_geometry),
			custom_width:
				overrides.custom_width ||
				(globalPrefs.launch_geometry === "custom"
					? globalPrefs.custom_geometry_width
					: null),
			custom_height:
				overrides.custom_height ||
				(globalPrefs.launch_geometry === "custom"
					? globalPrefs.custom_geometry_height
					: null),
			custom_mpv_flags:
				overrides.custom_mpv_flags || globalPrefs.custom_mpv_flags || "",
			automatic_mpv_flags: globalPrefs.automatic_mpv_flags || [],
			force_terminal: globalPrefs.force_terminal ?? false,
			clear_on_completion:
				overrides.clear_on_completion ?? globalPrefs.clear_on_completion ?? false,
			start_paused: overrides.start_paused ?? false,
			// Networking & Performance Sync
			disable_network_overrides: globalPrefs.disable_network_overrides ?? false,
			enable_cache: globalPrefs.enable_cache ?? true,
			http_persistence: globalPrefs.http_persistence || "auto",
			demuxer_max_bytes: globalPrefs.demuxer_max_bytes || "1G",
			demuxer_max_back_bytes: globalPrefs.demuxer_max_back_bytes || "500M",
			cache_secs: globalPrefs.cache_secs || 500,
			demuxer_readahead_secs: globalPrefs.demuxer_readahead_secs || 500,
			stream_buffer_size: globalPrefs.stream_buffer_size || "10M",
			ytdlp_concurrent_fragments: globalPrefs.ytdlp_concurrent_fragments || 4,
			enable_reconnect: globalPrefs.enable_reconnect ?? true,
			reconnect_delay: globalPrefs.reconnect_delay || 4,
			mpv_decoder: globalPrefs.mpv_decoder || "auto",
			ytdl_quality: globalPrefs.ytdl_quality || "best",
			performance_profile: globalPrefs.performance_profile || "default",
			enable_precise_resume: globalPrefs.enable_precise_resume ?? true,
			ultra_scalers: globalPrefs.ultra_scalers ?? true,
			ultra_video_sync: globalPrefs.ultra_video_sync ?? true,
			ultra_interpolation: globalPrefs.ultra_interpolation || "oversample",
			ultra_deband: globalPrefs.ultra_deband ?? true,
			ultra_fbo: globalPrefs.ultra_fbo ?? true,
		};
	}
}

export const nativeLink = new NativeLink();
