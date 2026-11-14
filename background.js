// background.js
// --- Core Module Imports ---

import {
	debouncedSyncToNativeHostFile,
	flushPendingSync,
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
import { getActiveTab } from "./utils/commUtils.module.js";
import { logger } from "./utils/SystemLogger.module.js";
import { addNativeListener, setLogBroadcaster } from "./utils/nativeConnection.module.js";
import { nativeLink } from "./utils/nativeLink.js";
import * as playlistManager from "./utils/playlistManager.js";
import { isValidUrl, isValidWebUrl } from "./utils/security.module.js";

setLogBroadcaster(broadcastLog);

// --- Shared State ---
let nativeHostStatus = { status: "unknown", lastCheck: 0, info: null };
let autoAddActive = false;
const AUTO_ADD_ALARM_NAME = "auto-add-inactivity";

// Helper to access session storage with local fallback (preserves state across MV3 worker terminations)
const getSessionStorage = () => {
	if (typeof chrome !== "undefined" && chrome?.storage?.session) {
		return chrome.storage.session;
	}
	return chrome.storage.local;
};

const setAutoAddActive = async (val) => {
	autoAddActive = Boolean(val);
	try {
		await getSessionStorage().set({ autoAddActive });
	} catch (e) {
		logger.debug(`[Background] Failed to persist autoAddActive: ${e?.message}`);
	}
};

const autoAddCooldowns = new Map();

const persistAutoAddState = () => {
	try {
		const now = Date.now();
		for (const [k, ts] of autoAddCooldowns.entries()) {
			if (typeof ts !== "number" || now - ts >= 5000) {
				autoAddCooldowns.delete(k);
			}
		}
		getSessionStorage()
			.set({
				autoAddActive,
				autoAddCooldowns: Object.fromEntries(autoAddCooldowns),
			})
			.catch(() => {});
	} catch (e) {
		logger.debug(`[Background] Failed to persist autoAddCooldowns: ${e?.message}`);
	}
};
const persistAutoAddCooldowns = persistAutoAddState;

// Rehydrate autoAddActive, autoAddCooldowns & nativeHostStatus on worker initialization
const autoAddInitPromise = (async () => {
	try {
		const res = await getSessionStorage().get([
			"autoAddActive",
			"autoAddCooldowns",
			"nativeHostStatus",
		]);
		if (res && typeof res.autoAddActive === "boolean") {
			autoAddActive = res.autoAddActive;
		}
		if (res?.autoAddCooldowns && typeof res.autoAddCooldowns === "object") {
			const now = Date.now();
			for (const [url, ts] of Object.entries(res.autoAddCooldowns)) {
				if (typeof ts === "number" && now - ts < 5000 && !autoAddCooldowns.has(url)) {
					autoAddCooldowns.set(url, ts);
				}
			}
		}
		if (
			res?.nativeHostStatus &&
			typeof res.nativeHostStatus === "object" &&
			nativeHostStatus.status === "unknown"
		) {
			nativeHostStatus = res.nativeHostStatus;
		}
	} catch (e) {
		logger.debug(`[Background] Failed to restore autoAdd state: ${e?.message}`);
	}
})();

const startAutoAddTimer = async () => {
	await chrome.alarms.clear(AUTO_ADD_ALARM_NAME);
	const data = await storage.get();
	const timeoutSeconds = data.settings.uiPreferences.global.autoAddInactivityTimeout || 30;
	const autoOff = data.settings.uiPreferences.global.autoAddAutoOff !== false;

	if (autoOff) {
		chrome.alarms.create(AUTO_ADD_ALARM_NAME, {
			when: Date.now() + timeoutSeconds * 1000,
		});
	}
};

const handleAutoAdd = async (url, tab) => {
	await autoAddInitPromise;
	if (!autoAddActive || !url) return;

	// 1. CAPTURE SNAPSHOT IMMEDIATELY (Lock-on to the current page state)
	const snapshot = {
		title: tab?.title || url,
		url: tab?.url || null,
		tabId: tab?.id
	};

	const data = await storage.get();
	const folderId = data?.settings?.lastUsedFolderId;
	if (!folderId) return;

	// URL-level cooldown to prevent "500 windows" if a page spams the same stream
	const now = Date.now();
	if (autoAddCooldowns.has(url) && now - autoAddCooldowns.get(url) < 5000) {
		return;
	}
	autoAddCooldowns.set(url, now);
	persistAutoAddState();

	startAutoAddTimer();

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

				const response = await addPromise;
				if (!response?.success) {
					autoAddCooldowns.delete(url);
					persistAutoAddState();
					return;
				}
				
				if (finalDetails && finalDetails.title && !finalDetails.isProvisional && response.item?.id) {
					await playlistManager.handleUpdateItemTitle({
						folderId,
						itemId: response.item.id,
						newTitle: finalDetails.title
					});
				}
			} catch (e) {
				logger.warn(`[Auto-Add] Failed to watch for better title: ${e.message}`, { data: e });
			}
		})();
	}

	try {
		const response = await addPromise;
		if (!response?.success) {
			autoAddCooldowns.delete(url);
			persistAutoAddState();
		}
	} catch (e) {
		autoAddCooldowns.delete(url);
		persistAutoAddState();
		logger.warn(`[Auto-Add] Failed to add item: ${e.message}`, { data: e });
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

// --- Global Service Worker Error Capturing ---
self.addEventListener("error", (event) => {
	const err = event.error;
	const msg = err ? (err.message || String(err)) : (event.message || "Unknown error");
	const stack = err?.stack || "";
	logger.error(`[Background] ${msg}`, { persist: true, stack });
});

self.addEventListener("unhandledrejection", (event) => {
	const reason = event.reason;
	const msg = reason ? (reason.message || String(reason)) : String(reason);
	const stack = reason?.stack || "";
	logger.error(`[Background] Unhandled rejection: ${msg}`, { persist: true, stack });
});

// --- Main Message Listener ---
const actionHandlers = {
	log_browser_error: async (request) => {
		const MAX_LOG_LEN = 4096;
		const context = String(request.context || "Browser").slice(0, 256);
		const rawMessage = request.message || request.error || "Unknown error";
		const message = String(rawMessage).slice(0, MAX_LOG_LEN);
		const stack = String(request.stack || "").slice(0, MAX_LOG_LEN);
		logger.error(`[${context}] ${message}`, { persist: false, stack });
		try {
			await nativeLink.call("log_browser_error", {
				context,
				message,
				stack,
			});
		} catch (e) {
			logger.debug(`[Background] Failed to forward browser error to native host: ${e.message}`);
		}
		return { success: true };
	},
	get_extension_styles: async () => {
		try {
			const [shared, content] = await Promise.all([
				fetch(chrome.runtime.getURL("shared.css")).then((r) => (r.ok ? r.text() : "")).catch(() => ""),
				fetch(chrome.runtime.getURL("content.css")).then((r) => (r.ok ? r.text() : "")).catch(() => ""),
			]);
			return { success: true, css: `${shared}\n${content}`.trim() };
		} catch (e) {
			logger.warn(`[Background] Failed to load extension styles: ${e.message}`);
			return { success: false, error: e.message };
		}
	},
	// UI State
	content_script_init: ui_state_handlers.handleContentScriptInit,
	get_ui_state_for_tab: ui_state_handlers.handleGetUiStateForTab,
	report_page_url: ui_state_handlers.handleReportPageUrl,
	set_last_folder_id: ui_state_handlers.handleSetLastFolderId,
	switch_playlist: ui_state_handlers.handleSwitchPlaylist,
	get_last_folder_id: createHandler(async ({ data }) => {
		return {
			folderId: data?.settings?.lastUsedFolderId || Object.keys(data?.folders || {})[0] || null,
		};
	}),
	set_ui_preferences: ui_state_handlers.handleSetUiPreferences,
	get_ui_preferences: ui_state_handlers.handleGetUiPreferences,
	get_default_automatic_flags: ui_state_handlers.handleGetDefaultAutomaticFlags,
	set_minimized_state: ui_state_handlers.handleSetMinimizedState,
	toggle_auto_add: async (request) => {
		await autoAddInitPromise;
		await setAutoAddActive(!autoAddActive);
		if (autoAddActive) {
			startAutoAddTimer();
			broadcastLog({ text: "[Auto-Add]: Enabled. Watching for streams...", type: "info" });
			
			// Retroactive detection: Check current tab if it already has a detected URL
			try {
				const activeTab = await getActiveTab();
				if (activeTab?.id) {
					const detectedUrl = await m3u8_scanner_handlers.handleGetDetectedUrlForTab(activeTab.id);
					if (detectedUrl) {
						broadcastLog({ text: "[Auto-Add]: Processing existing stream detection...", type: "info" });
						await handleAutoAdd(detectedUrl, activeTab);
					}
				}
			} catch (e) {
				logger.warn(`[Auto-Add] Retroactive check failed: ${e.message}`, { data: e });
			}
		} else {
			await chrome.alarms.clear(AUTO_ADD_ALARM_NAME);
			broadcastLog({ text: "[Auto-Add]: Disabled.", type: "info" });
		}
		broadcastToTabs({ action: "auto_add_state_changed", active: autoAddActive });
		return { success: true, active: autoAddActive };
	},
	get_auto_add_state: async () => {
		try {
			const res = await getSessionStorage().get("autoAddActive");
			if (res && typeof res.autoAddActive === "boolean") {
				autoAddActive = res.autoAddActive;
			}
		} catch (e) {
			logger.debug(`[Background] Failed to read autoAddActive from session: ${e?.message}`);
		}
		return { success: true, active: autoAddActive };
	},
	report_detected_url: async (request, sender) => {
		const tabId = sender.tab?.id;
		if (tabId) {
			m3u8_scanner_handlers.handleUpdateDetectedUrlForTab(tabId, request.url);
			if (request.url) {
				await handleAutoAdd(request.url, sender.tab);
			}
		}
	},
	force_reload_settings: ui_state_handlers.handleForceReloadSettings,
	force_refresh_dependencies: ui_state_handlers.handleForceRefreshDependencies,
	open_popup: ui_state_handlers.handleOpenPopup,
	heartbeat: ui_state_handlers.handleHeartbeat,
	get_native_host_status: async () => {
		await autoAddInitPromise;
		return { success: true, ...nativeHostStatus };
	},
	// Folder Management
	create_folder: folder_management_handlers.handleCreateFolder,
	get_all_folder_ids: folder_management_handlers.handleGetAllFolderIds,
	remove_folder: folder_management_handlers.handleRemoveFolder,
	rename_folder: folder_management_handlers.handleRenameFolder,
	set_folder_order: folder_management_handlers.handleSetFolderOrder,
	// MPV and Playlist Actions
	is_mpv_running: playback_handlers.handleIsMpvRunning,
	get_playback_status: async (request) => {
		const data = await storage.get();
		const { mpv_playback_cache } = await chrome.storage.local.get("mpv_playback_cache");
		const folderId =
			request.folderId ||
			mpv_playback_cache?.folderId ||
			data.settings.lastUsedFolderId;
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
	cancel_task: async (request) => {
		const taskId = request.taskId || request.task_id;
		return nativeLink.cancelTask(taskId);
	},
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
	get_unified_diagnostics: async () => {
		const jsDiagnostics = logger.getDiagnostics();
		const response = await nativeLink.call("get_unified_diagnostics", {
			data: jsDiagnostics,
		});
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
const activeTasksInitPromise = (async () => {
	try {
		const res = await chrome.storage.local.get("mpv_active_tasks");
		if (Array.isArray(res?.mpv_active_tasks)) {
			for (const t of res.mpv_active_tasks) {
				if (t?.id) {
					activeTasks.set(t.id, t);
				}
			}
		}
	} catch (e) {
		logger.debug(`[Background] Failed to restore activeTasks: ${e?.message}`);
	}
})();

addNativeListener("update_item_title", async (data) => {
	try {
		await playlistManager.handleUpdateItemTitle(data);
	} catch (e) {
		logger.warn(`[Background] update_item_title listener failed: ${e.message}`);
	}
});

addNativeListener("task_update", async (data) => {
	try {
		await activeTasksInitPromise;
		const { task, removed, taskId, task_id } = data;
		const id = taskId || task_id || task?.id;
		if (!id) return;

		if (removed) {
			activeTasks.delete(id);
		} else {
			activeTasks.set(id, task);
		}

		// Sync to storage for UI observation
		const taskList = Array.from(activeTasks.values());
		await chrome.storage.local.set({ mpv_active_tasks: taskList });
	} catch (e) {
		logger.warn(`[Background] task_update listener failed: ${e.message}`);
	}
});

m3u8_scanner_handlers.setDetectionCallback(async (url, tabId) => {
	await autoAddInitPromise;
	if (autoAddActive) {
		try {
			const tab = await chrome.tabs.get(tabId);
			await handleAutoAdd(url, tab);
		} catch (e) {
			logger.debug(`[Background] Failed to get tab for auto-add: ${e.message}`);
		}
	}
});

const NATIVE_HOST_HEARTBEAT_MIN_INTERVAL_MS = 30 * 1000;

async function performNativeHostHeartbeat() {
	try {
		getSessionStorage()
			.set({ lastNativeHostHeartbeatAt: Date.now() })
			.catch(() => {});
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
		logger.debug(`[Background] Native host heartbeat failed: ${e.message}`);
	}
	try {
		await getSessionStorage().set({ nativeHostStatus });
	} catch (e) {
		logger.debug(`[Background] Failed to persist nativeHostStatus: ${e?.message}`);
	}
}

const METADATA_SYNC_MIN_INTERVAL_MS = 5 * 60 * 1000;

async function syncMetadataCache() {
	try {
		const now = Date.now();
		const { lastMetadataSyncAt } = await chrome.storage.local.get("lastMetadataSyncAt");
		if (typeof lastMetadataSyncAt === "number" && now - lastMetadataSyncAt < METADATA_SYNC_MIN_INTERVAL_MS) {
			logger.debug("[BG] Skipping metadata cache sync (throttled).");
			return;
		}
		await chrome.storage.local.set({ lastMetadataSyncAt: now });

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

async function startNativeHostHeartbeat() {
	try {
		const store = getSessionStorage();
		const now = Date.now();
		const { lastNativeHostHeartbeatAt } = await store.get("lastNativeHostHeartbeatAt");
		if (
			typeof lastNativeHostHeartbeatAt !== "number" ||
			now - lastNativeHostHeartbeatAt >= NATIVE_HOST_HEARTBEAT_MIN_INTERVAL_MS
		) {
			await store.set({ lastNativeHostHeartbeatAt: now });
			performNativeHostHeartbeat();
		} else {
			logger.debug("[BG] Skipping startup native host heartbeat (throttled).");
		}
	} catch (e) {
		logger.debug(`[Background] Heartbeat throttle check failed: ${e?.message}`);
		performNativeHostHeartbeat();
	}
	try {
		const heartbeatAlarm = await chrome.alarms.get("native-host-heartbeat");
		if (!heartbeatAlarm) {
			chrome.alarms.create("native-host-heartbeat", { periodInMinutes: 5 });
		}
		const metadataAlarm = await chrome.alarms.get("metadata-cache-sync");
		if (!metadataAlarm) {
			chrome.alarms.create("metadata-cache-sync", { periodInMinutes: 30 });
		}
	} catch (e) {
		logger.debug(`[Background] Failed to ensure heartbeat alarms: ${e?.message}`);
	}
}

startNativeHostHeartbeat();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
	if (sender.id && sender.id !== chrome.runtime.id) return false;
	if (request.log && !request.action) return;
	if (!request?.action || !Object.hasOwn(actionHandlers, request.action)) {
		return false;
	}
	const handler = actionHandlers[request.action];
	if (typeof handler === "function") {
		(async () => {
			try {
				await Promise.all([
					autoAddInitPromise,
					m3u8_scanner_handlers.scannerInitPromise,
				]);
				const response = await handler(request, sender);
				if (response !== undefined) {
					sendResponse(response);
				} else {
					// Fallback for void handlers to prevent "channel closed" errors
					sendResponse({ success: true });
				}
			} catch (e) {
				logger.error(`[BG] Error handling action '${request.action}': ${e.message}`, {
					persist: false,
					data: e,
				});
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
	try {
		await storage.initialize();
		await updateContextMenus(storage);
		chrome.alarms.create("periodic-storage-janitor", { periodInMinutes: 10080 });
		await reinjectContentScripts();
		logger.info("[BG] MPV Handler extension installed and initialized.");
	} catch (e) {
		logger.error(`[Background] onInstalled failed: ${e.message}`, { persist: true, stack: e.stack });
	}
});

if (chrome.runtime.onStartup?.addListener) {
	chrome.runtime.onStartup.addListener(async () => {
		try {
			await reinjectContentScripts();
		} catch (e) {
			logger.error(`[Background] onStartup failed: ${e.message}`, { persist: true, stack: e.stack });
		}
	});
}

chrome.alarms.onAlarm.addListener((alarm) => {
	try {
		if (alarm.name === "periodic-storage-janitor") {
			storage
				.runJanitorTasks()
				.catch((e) => logger.error("Janitor alarm failed:", e));
		} else if (alarm.name === "native-host-heartbeat") {
			performNativeHostHeartbeat().catch((e) => logger.debug(`[Background] Alarm heartbeat failed: ${e.message}`));
		} else if (alarm.name === "metadata-cache-sync") {
			syncMetadataCache().catch((e) => logger.debug(`[Background] Alarm metadata sync failed: ${e.message}`));
		} else if (alarm.name === "sync-to-native-host") {
			flushPendingSync().catch((e) => logger.debug(`[Background] Sync alarm failed: ${e.message}`));
		} else if (alarm.name === AUTO_ADD_ALARM_NAME) {
			(async () => {
				await autoAddInitPromise;
				if (autoAddActive) {
					await setAutoAddActive(false);
					broadcastToTabs({ action: "auto_add_state_changed", active: false });
					broadcastLog({ text: "[Auto-Add]: Disabled due to inactivity.", type: "info" });
				}
			})().catch((e) => logger.debug(`[Background] Auto-add inactivity alarm failed: ${e.message}`));
		}
	} catch (e) {
		logger.error(`[Background] onAlarm failed: ${e.message}`, { persist: true, stack: e.stack });
	}
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
	try {
		const { menuItemId, linkUrl, srcUrl, pageUrl } = info;
		const targetUrl = linkUrl || srcUrl || pageUrl;
		if (!targetUrl || !isValidWebUrl(targetUrl)) {
			logger.warn(`[Background] Rejected unsafe/invalid context menu URL: ${String(targetUrl || "").slice(0, 128)}`);
			return;
		}

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
			if (
				menuItemId.startsWith("add-playlist-to-folder-") ||
				menuItemId === "add-playlist-to-last-used"
			) {
				await playlistManager.handleAddFromContextMenu(
					folderId,
					targetUrl,
					"YouTube Playlist",
					tab,
				);
			} else {
				await playlistManager.handleAddFromContextMenu(
					folderId,
					targetUrl,
					tab?.title || targetUrl,
					tab,
				);
			}
		}
	} catch (e) {
		logger.error(`[Background] contextMenu click failed: ${e.message}`, { persist: true, stack: e.stack });
	}
});

function isScriptableUrl(urlStr) {
	if (!urlStr) return false;
	try {
		const parsed = new URL(urlStr);
		if (!["http:", "https:", "file:"].includes(parsed.protocol)) {
			return false;
		}
		if (
			parsed.hostname === "chromewebstore.google.com" ||
			(parsed.hostname === "chrome.google.com" && parsed.pathname.startsWith("/webstore"))
		) {
			return false;
		}
		return true;
	} catch {
		return false;
	}
}

async function injectIntoTab(tabOrId, attempt = 1) {
	const tabId = typeof tabOrId === "object" ? tabOrId.id : tabOrId;
	if (!tabId) {
		logger.warn("[Background] injectIntoTab called without valid tabId.", { persist: true });
		return;
	}

	logger.debug(`[Background] injectIntoTab ENTRY: Tab ${tabId} (Attempt ${attempt})`, { persist: false });

	// 1. Fetch fresh tab data
	const tab = await chrome.tabs.get(tabId).catch((err) => {
		logger.debug(`[Background] Failed to get tab ${tabId}: ${err?.message}`);
		return null;
	});
	if (!tab) {
		logger.debug(`[Background] injectIntoTab: Tab ${tabId} no longer exists. Skipping.`, { persist: false });
		return;
	}

	if (tab.status !== "complete") {
		logger.debug(`[Background] injectIntoTab: Tab ${tabId} status is '${tab.status}' (not complete). Skipping.`, { persist: false });
		return;
	}

	if (!tab.url) {
		logger.debug(`[Background] injectIntoTab: Tab ${tabId} has no URL. (Attempt ${attempt}). Skipping.`, { persist: false });
		return;
	}

	if (!isScriptableUrl(tab.url)) {
		logger.debug(`[Background] injectIntoTab: Tab ${tabId} (${tab.url}) is a restricted or non-scriptable page. Skipping.`);
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
			logger.debug(`[Background] Skipping injection for restricted domain: ${url.hostname}`, { persist: false });
			return;
		}

		// 2. Early Exit Check - ONLY on the first attempt.
		if (attempt === 1) {
			const isAlive = await chrome.tabs
				.sendMessage(tab.id, { action: "ping" })
				.then((res) => res?.success)
				.catch((err) => {
					logger.debug(`[Background] Early exit ping failed: ${err?.message}`);
					return false;
				});

			if (isAlive) {
				logger.debug(`[Background] Tab ${tab.id} already has a responsive script. Syncing...`, { persist: false });
				let origin = null;
				try {
					origin = new URL(tab.url).origin;
				} catch (e) {
					logger.debug(`[Background] URL origin parse failed: ${e.message}`);
				}
				await ui_state_handlers.handleContentScriptInit(
					{},
					{ tab: tab, origin: origin },
				);
				return;
			}
		}

		logger.debug(`[Background] Injecting content script into tab ${tab.id} (Attempt ${attempt}/${MAX_ATTEMPTS})...`, { persist: false });

		// 3. Cleanup & Inject
		await chrome.scripting
			.executeScript({
				target: { tabId: tab.id },
				func: () => {
					if (
						window.mpvControllerInstance &&
						typeof window.mpvControllerInstance.teardown === "function"
					) {
						window.mpvControllerInstance.teardown();
					}
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
			.catch((err) => {
				logger.debug(`[Background] Script pre-cleanup error: ${err?.message}`);
			});

		await chrome.scripting.executeScript({
			target: { tabId: tab.id },
			files: jsFiles,
		});

		// 4. Verification Ping (with a small delay to allow scripts to boot)
		await new Promise(r => setTimeout(r, 200));
		const confirmedAlive = await chrome.tabs
			.sendMessage(tab.id, { action: "ping" })
			.then((res) => res?.success)
			.catch((err) => {
				logger.debug(`[Background] Verification ping failed: ${err?.message}`);
				return false;
			});

		if (!confirmedAlive && attempt < MAX_ATTEMPTS) {
			logger.warn(`[Background] Injection Verification FAILED for tab ${tab.id}. Retrying in ${RETRY_DELAY/1000}s...`, { persist: true });
			setTimeout(() => injectIntoTab(tabId, attempt + 1), RETRY_DELAY);
		} else if (!confirmedAlive && attempt === MAX_ATTEMPTS) {
			logger.error(`[Background] ALL injection attempts failed for tab ${tab.id}. Content script could not be verified.`, { persist: true });
			broadcastLog({
				text: `[System]: Failed to connect to page controller on tab ${tab.id} after ${MAX_ATTEMPTS} attempts. Please refresh the tab.`,
				type: "error",
			});
		} else if (confirmedAlive) {
			logger.debug(`[Background] Content script successfully injected and verified for tab ${tab.id} (Attempt ${attempt}).`, { persist: false });
		}
	} catch (err) {
		const errorMsg = err.message || "Unknown error";
		const isPermissionError =
			errorMsg.includes("Cannot access contents of the page") ||
			errorMsg.includes("Extension manifest must request permission") ||
			errorMsg.includes("The extensions gallery cannot be scripted");

		if (isPermissionError) {
			logger.debug(`[Background] Skipping injection for tab ${tabId} (${errorMsg}).`, { persist: false });
			return;
		}

		if (attempt < MAX_ATTEMPTS) {
			logger.warn(`[Background] Error in injection attempt ${attempt} for tab ${tabId}: ${errorMsg}. Retrying...`, { persist: true });
			setTimeout(() => injectIntoTab(tabId, attempt + 1), RETRY_DELAY);
		} else {
			logger.error(`[Background] Fatal injection error after ${MAX_ATTEMPTS} attempts for tab ${tabId}: ${errorMsg}`, { persist: true });
			broadcastLog({
				text: `[System]: Content script injection failed for tab ${tabId}: ${errorMsg}`,
				type: "error",
			});
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
	} catch (err) {
		logger.warn(`[Background] reinjectContentScripts failed: ${err.message}`);
	}
}

// Lazy injection: inject when a user actually switches to a tab
chrome.tabs.onActivated.addListener(async (activeInfo) => {
	try {
		await autoAddInitPromise;
		const tab = await chrome.tabs.get(activeInfo.tabId);
		await injectIntoTab(tab);

		chrome.tabs
			.sendMessage(activeInfo.tabId, {
				action: "auto_add_state_changed",
				active: autoAddActive,
			})
			.catch((err) => {
				logger.debug(`[Background] Failed to sync auto_add_state_changed to tab ${activeInfo.tabId}: ${err?.message}`);
			});

		// Proactive broadcast: Ensure the newly activated tab catches up on global state.
		const data = await storage.get();
		const currentStatus = await playback_handlers.handleIsMpvRunning().catch((err) => {
			logger.debug(`[Background] handleIsMpvRunning failed: ${err?.message}`);
			return { isRunning: false };
		});
		
		const targetFolderId = currentStatus?.folderId || data?.settings?.lastUsedFolderId || Object.keys(data?.folders || {})[0];
		await broadcastPlaylistState(targetFolderId);
	} catch (e) {
		logger.warn(`[Background] tabs.onActivated handler failed: ${e.message}`);
	}
});
