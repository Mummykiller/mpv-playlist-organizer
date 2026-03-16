// background.js
// --- Core Module Imports ---

import {
	_syncToNativeHostFile,
	debouncedSyncToNativeHostFile,
} from "./background/core_services.js";
import { createHandler } from "./background/handler_factory.js";
import * as dependency_anilist_handlers from "./background/handlers/dependency_anilist.js";
import * as folder_management_handlers from "./background/handlers/folder_management.js";
import * as import_export_handlers from "./background/handlers/import_export.js";
import * as m3u8_scanner_handlers from "./background/handlers/m3u8_scanner.js";
import * as playback_handlers from "./background/handlers/playback.js";

// --- Handler Imports ---
import * as ui_state_handlers from "./background/handlers/ui_state.js";
import { broadcastPlaylistState, getVisualPlaybackState } from "./background/ui_broadcaster.js";
import { broadcastLog, broadcastToTabs } from "./background/messaging.js";
import { storage } from "./background/storage_instance.js";
import { updateContextMenus } from "./utils/contextMenu.js";
import { logger } from "./utils/SystemLogger.module.js";
import { addNativeListener } from "./utils/nativeConnection.module.js";
import { nativeLink } from "./utils/nativeLink.js";
import * as playlistManager from "./utils/playlistManager.js";

// --- Shared State ---
let nativeHostStatus = { status: "unknown", lastCheck: 0, info: null };
let autoAddActive = false;
let autoAddTimer = null;

const startAutoAddTimer = async () => {
	if (autoAddTimer) clearTimeout(autoAddTimer);
	const data = await storage.get();
	const timeout = (data.settings.uiPreferences.global.autoAddInactivityTimeout || 30) * 1000;
	const autoOff = data.settings.uiPreferences.global.autoAddAutoOff !== false;

	if (autoOff) {
		autoAddTimer = setTimeout(() => {
			if (autoAddActive) {
				autoAddActive = false;
				broadcastToTabs({ action: "auto_add_state_changed", active: false });
				broadcastLog({ text: "[Auto-Add]: Disabled due to inactivity.", type: "info" });
			}
		}, timeout);
	}
};

const autoAddCooldowns = new Map();

const handleAutoAdd = async (url, tab) => {
	if (!autoAddActive || !url) return;
	
	// URL-level cooldown to prevent "500 windows" if a page spams the same stream
	const now = Date.now();
	if (autoAddCooldowns.has(url) && now - autoAddCooldowns.get(url) < 5000) {
		return;
	}
	autoAddCooldowns.set(url, now);

	startAutoAddTimer();
	
	const data = await storage.get();
	const folderId = data.settings.lastUsedFolderId;
	if (!folderId) return;

	// Request accurate details from the tab's PageScraper
	let scrapeData = { url, title: tab?.title || url };
	if (tab?.id) {
		try {
			const response = await chrome.tabs.sendMessage(tab.id, { 
				action: "scrape_and_get_details",
				detectedUrl: url
			});
			if (response && response.title) {
				scrapeData = response;
			}
		} catch (e) {
			console.warn("[Auto-Add] Failed to message tab for scrape:", e);
		}
	}

	// Use handleAdd with isAutoAdd flag to ensure silent duplicate rejection
	playlistManager.handleAdd({
		action: "add",
		folderId,
		data: scrapeData,
		tab,
		isAutoAdd: true,
		isStreamUrl: true
	}, { tab }).catch(e => console.warn("[Auto-Add] Failed:", e));
};

chrome.runtime.onConnect.addListener((port) => {
	if (port.name === "popup-lifecycle") {
		ui_state_handlers.setPopupPort(port);
		port.onDisconnect.addListener(() => {
			ui_state_handlers.setPopupPort(null);
		});
	}
});

// --- Main Message Listener ---
const actionHandlers = {
	// UI State
	content_script_init: ui_state_handlers.handleContentScriptInit,
	get_ui_state_for_tab: ui_state_handlers.handleGetUiStateForTab,
	report_page_url: ui_state_handlers.handleReportPageUrl,
	set_last_folder_id: ui_state_handlers.handleSetLastFolderId,
	switch_playlist: ui_state_handlers.handleSwitchPlaylist,
	get_last_folder_id: createHandler(async ({ data }) => {
		return {
			folderId: data.settings.lastUsedFolderId || Object.keys(data.folders)[0],
		};
	}),
	set_ui_preferences: ui_state_handlers.handleSetUiPreferences,
	get_ui_preferences: ui_state_handlers.handleGetUiPreferences,
	get_default_automatic_flags: ui_state_handlers.handleGetDefaultAutomaticFlags,
	set_minimized_state: ui_state_handlers.handleSetMinimizedState,
	toggle_auto_add: async (request) => {
		autoAddActive = !autoAddActive;
		if (autoAddActive) {
			startAutoAddTimer();
			broadcastLog({ text: "[Auto-Add]: Enabled. Watching for streams...", type: "info" });
			
			// Retroactive detection: Check current tab if it already has a detected URL
			try {
				const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
				if (activeTab?.id) {
					const detectedUrl = m3u8_scanner_handlers.handleGetDetectedUrlForTab(activeTab.id);
					if (detectedUrl) {
						broadcastLog({ text: "[Auto-Add]: Processing existing stream detection...", type: "info" });
						handleAutoAdd(detectedUrl, activeTab);
					}
				}
			} catch (e) {
				console.warn("[Auto-Add] Retroactive check failed:", e);
			}
		} else {
			if (autoAddTimer) clearTimeout(autoAddTimer);
			broadcastLog({ text: "[Auto-Add]: Disabled.", type: "info" });
		}
		broadcastToTabs({ action: "auto_add_state_changed", active: autoAddActive });
		return { success: true, active: autoAddActive };
	},
	get_auto_add_state: () => ({ success: true, active: autoAddActive }),
	report_detected_url: (request, sender) => {
		const tabId = sender.tab?.id;
		if (tabId) {
			m3u8_scanner_handlers.handleUpdateDetectedUrlForTab(tabId, request.url);
			if (autoAddActive && request.url) {
				handleAutoAdd(request.url, sender.tab);
			}
		}
	},
	force_reload_settings: ui_state_handlers.handleForceReloadSettings,
	force_refresh_dependencies: ui_state_handlers.handleForceRefreshDependencies,
	open_popup: ui_state_handlers.handleOpenPopup,
	heartbeat: ui_state_handlers.handleHeartbeat,
	get_native_host_status: () => ({ success: true, ...nativeHostStatus }),
	// Folder Management
	create_folder: folder_management_handlers.handleCreateFolder,
	get_all_folder_ids: folder_management_handlers.handleGetAllFolderIds,
	remove_folder: folder_management_handlers.handleRemoveFolder,
	rename_folder: folder_management_handlers.handleRenameFolder,
	set_folder_order: folder_management_handlers.handleSetFolderOrder,
	// MPV and Playlist Actions
	is_mpv_running: playback_handlers.handleIsMpvRunning,
	get_playback_status: async (request) => {
		const folderId = request.folderId;
		const data = await storage.get();
		const playlist = folderId ? data.folders[folderId]?.playlist : null;
		return getVisualPlaybackState(folderId, playlist);
	},
	update_item_resume_time: playback_handlers.handleUpdateItemResumeTime,
	update_item_marked_as_watched:
		playback_handlers.handleUpdateItemMarkedAsWatched,
	play: playback_handlers.handlePlay,
	play_new_instance: playback_handlers.handlePlayNewInstance,
	play_m3u: playback_handlers.handlePlayM3U,
	append: playback_handlers.handleAppend,
	confirm_clear_playlist: playback_handlers.handleClearPlaylistConfirmation,
	close_mpv: playback_handlers.handleCloseMpv,
	add: playlistManager.handleAdd,
	get_playlist: playlistManager.handleGetPlaylist,
	clear: playlistManager.handleClear,
	remove_item: playlistManager.handleRemoveItem,
	set_playlist_order: playlistManager.handleSetPlaylistOrder,
	// Import/Export
	export_all_playlists_separately:
		import_export_handlers.handleExportAllPlaylistsSeparately,
	export_folder_playlist: import_export_handlers.handleExportFolderPlaylist,
	export_settings: import_export_handlers.handleExportSettings,
	import_from_file: import_export_handlers.handleImportFromFile,
	list_import_files: import_export_handlers.handleListImportFiles,
	open_export_folder: import_export_handlers.handleOpenExportFolder,
	get_anilist_releases: dependency_anilist_handlers.handleGetAnilistReleases,
	ytdlp_update_check: dependency_anilist_handlers.handleYtdlpUpdateCheck,
	user_confirmed_ytdlp_update:
		dependency_anilist_handlers.handleUserConfirmedYtdlpUpdate,
	manual_ytdlp_update: dependency_anilist_handlers.handleManualYtdlpUpdate,
	get_js_diagnostics: async () => ({
		success: true,
		errors: logger.getDiagnostics().errors,
	}),
	get_unified_diagnostics: async () => {
		const jsDiagnostics = logger.getDiagnostics();
		const response = await nativeLink.call("get_unified_diagnostics", jsDiagnostics);
		return response;
	},
};

actionHandlers["session_restored"] = playback_handlers.handleSessionRestored;

// Centralized Python Log Listener
addNativeListener("log", (data) => {
	if (data.log) {
		// Log to JS console for visibility, but don't send back to Python
		const level = data.log.type === "error" ? "error" : "info";
		// Safely handle unknown levels
		const logFn = logger[level] ? logger[level].bind(logger) : logger.info.bind(logger);
		logFn(`[PY] ${data.log.text}`, { persist: false });
		
		broadcastLog(data.log);
	}
});

const activeTasks = new Map();

addNativeListener("task_update", async (data) => {
	const { task, removed, task_id } = data;
	const id = task_id || task?.id;
	if (!id) return;

	if (removed) {
		activeTasks.delete(id);
	} else {
		activeTasks.set(id, task);
	}

	// Sync to storage for UI observation
	const taskList = Array.from(activeTasks.values());
	await chrome.storage.local.set({ mpv_active_tasks: taskList });
});

m3u8_scanner_handlers.setDetectionCallback(async (url, tabId) => {
	if (autoAddActive) {
		try {
			const tab = await chrome.tabs.get(tabId);
			handleAutoAdd(url, tab);
		} catch (e) {}
	}
});

async function performNativeHostHeartbeat() {
	try {
		const response = await nativeLink.ping();
		if (response?.success) {
			nativeHostStatus = {
				status: "online",
				lastCheck: Date.now(),
				info: { python: response.pythonVersion, platform: response.platform },
			};
			// Proactively sync metadata cache when native host is confirmed online
			syncMetadataCache();
		} else {
			nativeHostStatus.status = "error";
			nativeHostStatus.lastCheck = Date.now();
		}
	} catch (e) {
		nativeHostStatus.status = "offline";
		nativeHostStatus.lastCheck = Date.now();
	}
}

async function syncMetadataCache() {
	try {
		const shardsResult = await nativeLink.getMetadataCache();
		if (shardsResult?.success && shardsResult.shards) {
			logger.info(`[BG] Syncing ${shardsResult.shards.length} metadata shards...`);
			for (const shard of shardsResult.shards) {
				const content = await nativeLink.getMetadataCache(shard);
				if (content?.success && content.data) {
					const storageKey = `mpv_meta_cache_${shard}`;
					await chrome.storage.local.set({ [storageKey]: content.data });
				}
			}
		}
	} catch (e) {
		logger.warn(`[BG] Metadata cache sync failed: ${e.message}`);
	}
}

function startNativeHostHeartbeat() {
	performNativeHostHeartbeat();
	chrome.alarms.create("native-host-heartbeat", { periodInMinutes: 5 });
	chrome.alarms.create("metadata-cache-sync", { periodInMinutes: 30 });
}

startNativeHostHeartbeat();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
	if (request.log && !request.action) return;
	const handler = actionHandlers[request.action];
	if (handler) {
		(async () => {
			try {
				const response = await handler(request, sender);
				if (response !== undefined) {
					sendResponse(response);
				} else {
					// Fallback for void handlers to prevent "channel closed" errors
					sendResponse({ success: true });
				}
			} catch (e) {
				logger.error(`[BG] Error handling action '${request.action}':`, e);
				broadcastLog({
					text: `[Background] Error in ${request.action}: ${e.message}`,
					type: "error",
				});
				sendResponse({ success: false, error: e.message });
			}
		})();
		return true;
	}
	return false;
});

chrome.runtime.onInstalled.addListener(async () => {
	await storage.initialize();
	await updateContextMenus(storage);
	chrome.alarms.create("periodic-storage-janitor", { periodInMinutes: 10080 });
	logger.info("[BG] MPV Handler extension installed and initialized.");
});

chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name === "periodic-storage-janitor") {
		storage
			.runJanitorTasks()
			.catch((e) => logger.error("Janitor alarm failed:", e));
	} else if (alarm.name === "native-host-heartbeat") {
		performNativeHostHeartbeat();
	} else if (alarm.name === "metadata-cache-sync") {
		syncMetadataCache();
	} else if (alarm.name === "sync-to-native-host") {
		_syncToNativeHostFile();
	}
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
	const { menuItemId, linkUrl, srcUrl, pageUrl } = info;
	const urlToAdd = linkUrl || srcUrl || pageUrl;
	if (!urlToAdd) return;

	const getFolderId = async () => {
		if (menuItemId.startsWith("add-to-folder-"))
			return menuItemId.substring("add-to-folder-".length);
		if (menuItemId.startsWith("add-playlist-to-folder-"))
			return menuItemId.substring("add-playlist-to-folder-".length);
		const data = await storage.get();
		return data.settings.lastUsedFolderId;
	};

	const folderId = await getFolderId();
	if (folderId) {
		if (menuItemId.startsWith("add-playlist-to-folder-")) {
			playlistManager.handleAddFromContextMenu(
				folderId,
				urlToAdd,
				"YouTube Playlist",
				tab,
			);
		} else {
			playlistManager.handleAddFromContextMenu(
				folderId,
				urlToAdd,
				tab.title || urlToAdd,
				tab,
			);
		}
	}
});

async function injectIntoTab(tab) {
	if (!tab.id || !tab.url) return;
	if (
		tab.url.startsWith("chrome://") ||
		tab.url.startsWith("about:") ||
		tab.url.includes("chrome.google.com/webstore")
	)
		return;

	const manifest = chrome.runtime.getManifest();
	const jsFiles = manifest.content_scripts[0].js;

	try {
		const data = await storage.get();
		const restrictedDomains =
			data.settings.uiPreferences.global.restrictedDomains || [];
		try {
			const url = new URL(tab.url);
			if (
				restrictedDomains.some(
					(domain) =>
						url.hostname === domain || url.hostname.endsWith("." + domain),
				)
			)
				return;
		} catch (e) {
			return;
		}

		const isAlive = await chrome.tabs
			.sendMessage(tab.id, { action: "ping" })
			.then((res) => res?.success)
			.catch(() => false);
		if (isAlive) {
			// Script is already there, but might have stale data. Refresh it.
			let origin = null;
			try {
				origin = new URL(tab.url).origin;
			} catch (e) {}
			await ui_state_handlers.handleContentScriptInit(
				{},
				{ tab: tab, origin: origin },
			);
			return;
		}

		await chrome.scripting
			.executeScript({
				target: { tabId: tab.id },
				func: () => {
					[
						"m3u8-controller-host",
						"m3u8-minimized-host",
						"anilist-panel-host",
						"mpv-organizer-host-styles",
					].forEach((id) => {
						document.getElementById(id)?.remove();
					});
					window.mpvControllerInitialized = false;
				},
			})
			.catch(() => {});

		await chrome.scripting.executeScript({
			target: { tabId: tab.id },
			files: jsFiles,
		});
	} catch (err) {}
}

async function reinjectContentScripts() {
	try {
		// Only inject into active tabs on startup/reload
		const tabs = await chrome.tabs.query({ active: true });
		for (const tab of tabs) {
			await injectIntoTab(tab);
		}
	} catch (err) {}
}

// Lazy injection: inject when a user actually switches to a tab
chrome.tabs.onActivated.addListener(async (activeInfo) => {
	try {
		const tab = await chrome.tabs.get(activeInfo.tabId);
		await injectIntoTab(tab);

		// Proactive broadcast: Even if the script is already there,
		// tell it to refresh its view of the global playback state.
		const data = await storage.get();
		const currentStatus = await playback_handlers.handleIsMpvRunning().catch(() => ({ isRunning: false }));
		
		if (currentStatus?.isRunning) {
			await broadcastPlaylistState(currentStatus.folderId);
		}
	} catch (e) {}
});

reinjectContentScripts();