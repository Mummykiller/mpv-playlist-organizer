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

// HAIL MARY RECOVERY: Check if we just restarted due to an injection failure
chrome.storage.local.get("hail_mary_pending", (data) => {
	if (data.hail_mary_pending) {
		setTimeout(() => {
			broadcastLog({ 
				text: "[System]: Extension was automatically restarted to recover from a blocked or unresponsive on-page controller.", 
				type: "info"
			});
			chrome.storage.local.remove("hail_mary_pending");
		}, 1000); // Small delay to ensure UIs are ready to receive the log
	}
});

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

	// 1. CAPTURE SNAPSHOT IMMEDIATELY (Lock-on to the current page state)
	const snapshot = {
		title: tab?.title || url,
		url: tab?.url || null,
		tabId: tab?.id
	};

	startAutoAddTimer();
	
	const data = await storage.get();
	const folderId = data.settings.lastUsedFolderId;
	if (!folderId) return;

	// 2. Add IMMEDIATELY with the snapshot title
	const initialScrape = { url, title: snapshot.title, isProvisional: true };
	
	const addPromise = playlistManager.handleAdd({
		action: "add",
		folderId,
		data: initialScrape,
		tab,
		isAutoAdd: true,
		isStreamUrl: true
	}, { tab });

	// 3. Start ASYNC Watcher IN PARALLEL (Locked to the snapshot)
	if (snapshot.tabId) {
		(async () => {
			try {
				const finalDetails = await m3u8_scanner_handlers._safeScrapeDetails(
					snapshot.tabId, 
					url, 
					snapshot.title,
					snapshot.url,
					snapshot.title // originTitle snapshot
				);
				
				if (finalDetails && finalDetails.title && !finalDetails.isProvisional) {
					// We need the itemId from the addPromise to update it
					const response = await addPromise;
					if (response?.success && response.item?.id) {
						playlistManager.handleUpdateItemTitle({
							folderId,
							itemId: response.item.id,
							newTitle: finalDetails.title
						});
					}
				}
			} catch (e) {
				console.warn("[Auto-Add] Failed to watch for better title:", e);
			}
		})();
	}
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
	update_item_title: playlistManager.handleUpdateItemTitle,
	reorder_live: async (request) => {
		const newOrder = request.new_order || request.newOrder;
		return nativeLink.reorderLive(request.folderId, newOrder);
	},
	get_smart_reorder: playlistManager.handleGetSmartReorder,
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

async function injectIntoTab(tabOrId, attempt = 1) {
	const tabId = typeof tabOrId === "object" ? tabOrId.id : tabOrId;
	if (!tabId) {
		logger.warn("[Background] injectIntoTab called without valid tabId.", { persist: true });
		return;
	}

	logger.info(`[Background] injectIntoTab ENTRY: Tab ${tabId} (Attempt ${attempt})`, { persist: true });

	// 1. Fetch fresh tab data
	const tab = await chrome.tabs.get(tabId).catch(() => null);
	if (!tab) {
		logger.info(`[Background] injectIntoTab: Tab ${tabId} no longer exists. Skipping.`, { persist: true });
		return;
	}

	if (!tab.url) {
		logger.info(`[Background] injectIntoTab: Tab ${tabId} has no URL. (Attempt ${attempt}). Skipping.`, { persist: true });
		return;
	}

	if (
		tab.url.startsWith("chrome://") ||
		tab.url.startsWith("about:") ||
		tab.url.includes("chrome.google.com/webstore")
	) {
		logger.info(`[Background] injectIntoTab: Tab ${tabId} is a restricted extension page. Skipping.`, { persist: true });
		return;
	}

	const MAX_ATTEMPTS = 3;
	const RETRY_DELAY = 2000;

	const manifest = chrome.runtime.getManifest();
	const jsFiles = manifest.content_scripts[0].js;

	try {
		const data = await storage.get();
		const restrictedDomains =
			data.settings.uiPreferences.global.restrictedDomains || [];
		
		const url = new URL(tab.url);
		if (
			restrictedDomains.some(
				(domain) =>
					url.hostname === domain || url.hostname.endsWith("." + domain),
			)
		) {
			logger.info(`[Background] Skipping injection for restricted domain: ${url.hostname}`, { persist: true });
			return;
		}

		// 2. Early Exit Check - ONLY on the first attempt.
		if (attempt === 1) {
			const isAlive = await chrome.tabs
				.sendMessage(tab.id, { action: "ping" })
				.then((res) => res?.success)
				.catch(() => false);

			if (isAlive) {
				logger.info(`[Background] Tab ${tab.id} already has a responsive script. Syncing...`, { persist: true });
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
		}

		logger.info(`[Background] Injecting content script into tab ${tab.id} (Attempt ${attempt}/${MAX_ATTEMPTS})...`, { persist: true });

		// 3. Cleanup & Inject
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
						const el = document.getElementById(id);
						if (el) el.remove();
					});
					window.mpvControllerInitialized = false;
				},
			})
			.catch(() => {});

		await chrome.scripting.executeScript({
			target: { tabId: tab.id },
			files: jsFiles,
		});

		// 4. Verification Ping (with a small delay to allow scripts to boot)
		await new Promise(r => setTimeout(r, 200));
		const confirmedAlive = await chrome.tabs
			.sendMessage(tab.id, { action: "ping" })
			.then((res) => res?.success)
			.catch(() => false);

		if (!confirmedAlive && attempt < MAX_ATTEMPTS) {
			logger.warn(`[Background] Injection Verification FAILED for tab ${tab.id}. Retrying in ${RETRY_DELAY/1000}s...`, { persist: true });
			setTimeout(() => injectIntoTab(tabId, attempt + 1), RETRY_DELAY);
		} else if (!confirmedAlive && attempt === MAX_ATTEMPTS) {
			logger.error(`[Background] ALL injection attempts failed for tab ${tab.id}. Triggering Hail Mary reload...`, { persist: true });
			await chrome.storage.local.set({ hail_mary_pending: true });
			chrome.runtime.reload();
		} else if (confirmedAlive) {
			logger.info(`[Background] Content script successfully injected and verified for tab ${tab.id} (Attempt ${attempt}).`, { persist: true });
		}
	} catch (err) {
		const errorMsg = err.message || "Unknown error";
		if (attempt < MAX_ATTEMPTS) {
			logger.warn(`[Background] Error in injection attempt ${attempt} for tab ${tabId}: ${errorMsg}. Retrying...`, { persist: true });
			setTimeout(() => injectIntoTab(tabId, attempt + 1), RETRY_DELAY);
		} else {
			logger.error(`[Background] Fatal injection error after ${MAX_ATTEMPTS} attempts for tab ${tabId}: ${errorMsg}`, { persist: true });
		}
	}
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