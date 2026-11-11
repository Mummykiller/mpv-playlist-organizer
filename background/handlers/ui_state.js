// background/handlers/ui_state.js

import {
	isYouTubeUrl,
	normalizeYouTubeUrl,
	DOMAIN_SPECIFIC_KEYS,
} from "../../utils/commUtils.module.js";
import { updateContextMenus } from "../../utils/contextMenu.js";
import { nativeLink } from "../../utils/nativeLink.js";
import { createHandler } from "../handler_factory.js";
import { broadcastLog, broadcastToTabs } from "../messaging.js";
import { storage } from "../storage_instance.js";
import { broadcastPlaylistState, getVisualPlaybackState, isFolderActive } from "../ui_broadcaster.js";
import { playbackManager } from "../playback_manager.js";
import * as m3u8_scanner_handlers from "./m3u8_scanner.js";
import * as playback_handlers from "./playback.js";

// Cache for native host info to speed up UI preference retrieval
const _nativeInfoCache = {
	decoder: null,
	timestamp: 0,
};
const CACHE_TTL_MS = 600000; // 10 minutes

// Helper to get current popup port (assigned by background.js)
let popupPort = null;
export function setPopupPort(port) {
	popupPort = port;
}

export async function handleContentScriptInit(request, sender) {
	const tabId = sender.tab?.id;
	const origin = sender.origin;

	if (tabId && origin && sender.tab) {
		const data = await storage.get();
		const globalPrefs = data.settings.uiPreferences.global;

		let domain = null;
		if (origin && (origin.startsWith("http:") || origin.startsWith("https:"))) {
			try {
				domain = new URL(origin).hostname;
			} catch (e) {
				console.debug("[UiState] Invalid origin URL:", origin, e);
			}
		}

		// Defensive check for domains object
		const domains = data.settings.uiPreferences.domains || {};
		const domainPrefs = domain ? domains[domain] || {} : {};

		let isMinimized;
		if (typeof domainPrefs.minimized === "boolean") {
			isMinimized = domainPrefs.minimized;
		} else {
			isMinimized = globalPrefs.mode === "minimized";
		}

		const mpvStatus = await playback_handlers.handleIsMpvRunning().catch(() => ({ isRunning: false }));
		const currentMpvFolderId = (mpvStatus?.success && mpvStatus.isRunning && mpvStatus.folderId) ? mpvStatus.folderId : null;
		
		const folderId = currentMpvFolderId || data.settings.lastUsedFolderId || Object.keys(data.folders)[0];
		const isFolderActive = !!(currentMpvFolderId && currentMpvFolderId === folderId);
		const folder = data.folders[folderId];
		
		let lastPlayedId = folder?.lastPlayedId;
		let isPaused = false;
		let needsAppend = false;

		if (isFolderActive) {
			const { isActive, isPaused: vPaused, needsAppend: vNeedsAppend, lastPlayedId: vLastPlayedId } = 
				await getVisualPlaybackState(folderId, folder?.playlist);
			
			if (isActive) {
				lastPlayedId = vLastPlayedId || lastPlayedId;
				isPaused = vPaused;
				needsAppend = vNeedsAppend;
			}
		}

		const detectedUrl = m3u8_scanner_handlers.handleGetDetectedUrlForTab(tabId);

		await chrome.tabs.sendMessage(tabId, {
			action: "init_ui_state",
			tabId: tabId,
			shouldBeMinimized: isMinimized,
			folderId: folderId,
			lastPlayedId: lastPlayedId,
			isFolderActive: isFolderActive,
			isPaused: isPaused,
			needsAppend: needsAppend,
			playlist: folder?.playlist || [],
			detectedUrl: detectedUrl,
		}).catch(() => {});

		// STICKY PROMPT: If there's a pending clear for THIS folder, re-trigger it
		const session = playbackManager.findSessionByFolderId(folderId);
		if (session && session.pendingClear) {
			const { playedIds, sessionIds, scope, titles, isQuitting } = session.pendingClear;
			chrome.tabs.sendMessage(tabId, {
				action: "show_clear_confirmation",
				folderId: folderId,
				playedIds,
				sessionIds,
				scope,
				count: (playedIds || []).length,
				titles,
				isQuitting
			}).catch(() => {});
		}
	}
}

export const handleGetUiStateForTab = createHandler(async ({ request }) => {
	const tabId = request.tabId;
	const tab = await chrome.tabs.get(tabId);
	const data = await storage.get();
	const globalPrefs = data.settings.uiPreferences.global;

	let domain = null;
	if (tab.url && (tab.url.startsWith("http:") || tab.url.startsWith("https:"))) {
		try {
			domain = new URL(tab.url).hostname;
		} catch (e) {
			console.debug("[UiState] Invalid tab URL:", tab.url, e);
		}
	}

	const domains = data.settings.uiPreferences.domains || {};
	const domainPrefsRaw = domain ? domains[domain] || {} : {};
	
	const domainPrefs = {};
	DOMAIN_SPECIFIC_KEYS.forEach(key => {
		if (domainPrefsRaw[key] !== undefined) {
			domainPrefs[key] = domainPrefsRaw[key];
		}
	});

	const finalPrefs = { ...globalPrefs, ...domainPrefs };

	return {
		success: true,
		state: {
			minimized: finalPrefs.minimized ?? finalPrefs.mode === "minimized",
			preferences: finalPrefs,
			detectedUrl: m3u8_scanner_handlers.handleGetDetectedUrlForTab(tabId),
		},
	};
}, {
	manualPersistence: true,
});

export async function handleReportPageUrl(request, sender) {
	const tabId = sender.tab?.id;
	if (!tabId || !request.url) return;

	let urlToReport = request.url;

	if (isYouTubeUrl(urlToReport)) {
		const isWatchPage = urlToReport.includes("/watch") || urlToReport.includes("youtu.be/");
		const isPlaylistPage = urlToReport.includes("/playlist");

		if (isWatchPage || isPlaylistPage) {
			urlToReport = normalizeYouTubeUrl(urlToReport);
			const currentState = m3u8_scanner_handlers.handleGetDetectedUrlForTab(tabId);

			if (currentState !== urlToReport && (!currentState || isYouTubeUrl(currentState))) {
				m3u8_scanner_handlers.handleUpdateDetectedUrlForTab(tabId, urlToReport);
				broadcastToTabs({
					action: "detected_url_changed",
					tabId: tabId,
					url: urlToReport,
				});
			}
		}
	}
}

export const handleSetLastFolderId = createHandler(async ({ request, data }) => {
	const { folderId } = request;
	if (!folderId) return { success: false, error: "No folderId provided." };

	data.settings.lastUsedFolderId = folderId;
	return { success: true };
}, {
	onSuccess: async (result, { folderId }) => {
		await broadcastPlaylistState(folderId, null, "last_folder_changed");
		await updateContextMenus(storage);
	}
});

export const handleSwitchPlaylist = createHandler(async ({ data }) => {
	const folderOrder = data.folderOrder || Object.keys(data.folders);
	if (folderOrder.length <= 1) return { success: true };

	const currentFolderId = data.settings.lastUsedFolderId || folderOrder[0];
	const currentIndex = folderOrder.indexOf(currentFolderId);
	const nextFolderId = folderOrder[(currentIndex + 1) % folderOrder.length];

	data.settings.lastUsedFolderId = nextFolderId;
	return { success: true, folderId: nextFolderId };
}, {
	onSuccess: async (result) => {
		await broadcastPlaylistState(result.folderId, null, "last_folder_changed");
		updateContextMenus(storage).catch((e) => console.error("Failed to update context menus:", e));
	}
});

// Settings that are strictly UI-side and should not be synced to the native host
export const UI_ONLY_KEYS = [
	...DOMAIN_SPECIFIC_KEYS,
	"logVisible",
	"launchGeometry",
	"customGeometryWidth",
	"customGeometryHeight",
	"customMpvFlags",
	"forceTerminal",
	"showPlayNewButton",
	"duplicateUrlBehavior",
	"syncGlobalRemovals",
	"syncGlobalRemovalsLive",
	"autoAppendOnAdd",
	"autoAddInactivityTimeout",
	"autoAddAutoOff",
	"confirmRemoveFolder",
	"confirmClearPlaylist",
	"confirmCloseMpv",
	"confirmPlayNew",
	"confirmFolderSwitch",
	"clearScope",
	"enableDblclickCopy",
	"anilistImageHeight",
	"lockAnilistPanel",
	"forcePanelAttached",
	"anilistAttachOnOpen",
	"popupWidth",
	"showWatchedStatusGui",
	"showMinimizedStub",
	"oneClickAdd",
	"restrictedDomains",
	"kbAddPlaylist",
	"kbPlayPlaylist",
	"kbToggleController",
	"kbSwitchPlaylist",
	"kbOpenPopup",
	"dependencyStatus",
];

export const handleGetUiPreferences = createHandler(async ({ request, data, sender }) => {
	const globalPrefs = { ...data.settings.uiPreferences.global };

	const now = Date.now();
	if (_nativeInfoCache.timestamp && now - _nativeInfoCache.timestamp < CACHE_TTL_MS) {
		if (_nativeInfoCache.decoder) globalPrefs.mpvDecoder = _nativeInfoCache.decoder;
		if (_nativeInfoCache.ffmpegPath && !globalPrefs.ffmpegPath) globalPrefs.ffmpegPath = _nativeInfoCache.ffmpegPath;
		if (_nativeInfoCache.nodePath && !globalPrefs.nodePath) globalPrefs.nodePath = _nativeInfoCache.nodePath;
	} else {
		try {
			const nativeSettings = await nativeLink.getUiPreferences();
			if (nativeSettings?.success && nativeSettings.preferences) {
				const np = nativeSettings.preferences;
				if (np.mpvDecoder) {
					globalPrefs.mpvDecoder = np.mpvDecoder;
					_nativeInfoCache.decoder = np.mpvDecoder;
				}
				if (np.ffmpegPath) {
					if (!globalPrefs.ffmpegPath) globalPrefs.ffmpegPath = np.ffmpegPath;
					_nativeInfoCache.ffmpegPath = np.ffmpegPath;
				}
				if (np.nodePath) {
					if (!globalPrefs.nodePath) globalPrefs.nodePath = np.nodePath;
					_nativeInfoCache.nodePath = np.nodePath;
				}
				_nativeInfoCache.timestamp = now;
			}
		} catch (e) {
			console.warn("Could not sync native settings:", e);
		}
	}

	let domain = null;
	if (sender.origin && (sender.origin.startsWith("http:") || sender.origin.startsWith("https:"))) {
		try {
			domain = new URL(sender.origin).hostname;
		} catch (e) {
			console.debug("[UiState] Invalid sender origin URL:", sender.origin, e);
		}
	}

	if (!domain && sender.tab?.url) {
		try {
			domain = new URL(sender.tab.url).hostname;
		} catch (e) {
			console.debug("[UiState] Invalid sender tab URL:", sender.tab.url, e);
		}
	}

	if (!domain && sender.url) {
		try {
			domain = new URL(sender.url).hostname;
		} catch (e) {
			console.debug("[UiState] Invalid sender URL:", sender.url, e);
		}
	}

	if (!domain && request.tabId) {
		try {
			const tab = await chrome.tabs.get(request.tabId);
			if (tab?.url) domain = new URL(tab.url).hostname;
		} catch (e) {
			console.debug("[UiState] Failed to get tab URL for tabId:", request.tabId, e);
		}
	}

	if (domain) {
		const domains = data.settings.uiPreferences.domains || {};
		const domainPrefsRaw = domains[domain] || {};
		
		// Only merge allowed domain-specific overrides
		const domainPrefs = {};
		DOMAIN_SPECIFIC_KEYS.forEach(key => {
			if (domainPrefsRaw[key] !== undefined) {
				domainPrefs[key] = domainPrefsRaw[key];
			}
		});

		return { success: true, preferences: { ...globalPrefs, ...domainPrefs } };
	}
	return { success: true, preferences: globalPrefs };
}, {
	manualPersistence: true,
});

export const handleSetUiPreferences = createHandler(async ({ request, data, sender }) => {
	const newPreferences = request.preferences || {};
	let domain = null;

	if (sender.origin && (sender.origin.startsWith("http:") || sender.origin.startsWith("https:"))) {
		try {
			domain = new URL(sender.origin).hostname;
		} catch (e) {
			console.debug("[UiState] Invalid sender origin URL in setUiPreferences:", sender.origin, e);
		}
	}

	if (!domain && sender.tab?.url) {
		try {
			domain = new URL(sender.tab.url).hostname;
		} catch (e) {
			console.debug("[UiState] Invalid sender tab URL in setUiPreferences:", sender.tab.url, e);
		}
	}

	if (!domain && sender.url) {
		try {
			domain = new URL(sender.url).hostname;
		} catch (e) {
			console.debug("[UiState] Invalid sender URL in setUiPreferences:", sender.url, e);
		}
	}

	if (!domain && request.tabId) {
		try {
			const tab = await chrome.tabs.get(request.tabId);
			if (tab?.url) domain = new URL(tab.url).hostname;
		} catch (e) {
			console.debug("[UiState] Failed to get tab URL for tabId in setUiPreferences:", request.tabId, e);
		}
	}

	const domainPrefs = {};
	const globalPrefs = {};

	// Categorize preferences based on whether they are domain-specific or global
	for (const [key, value] of Object.entries(newPreferences)) {
		if (DOMAIN_SPECIFIC_KEYS.includes(key)) {
			if (domain) {
				domainPrefs[key] = value;
			}
			// Never let domain-specific keys spill into globalPrefs
		} else {
			globalPrefs[key] = value;
		}
	}

	// Update Global Preferences
	if (Object.keys(globalPrefs).length > 0) {
		data.settings.uiPreferences.global = { 
			...data.settings.uiPreferences.global, 
			...globalPrefs 
		};
		_nativeInfoCache.decoder = null;
		_nativeInfoCache.timestamp = 0;
	}

	// Update Domain Preferences
	if (domain && Object.keys(domainPrefs).length > 0) {
		if (!data.settings.uiPreferences.domains) data.settings.uiPreferences.domains = {};
		const existingDomainPrefs = data.settings.uiPreferences.domains[domain] || {};
		data.settings.uiPreferences.domains[domain] = { 
			...existingDomainPrefs, 
			...domainPrefs 
		};
	}

	// Broadcast IMMEDIATELY for responsiveness
	broadcastToTabs({
		action: "preferences_changed",
		preferences: newPreferences,
		domain: domain,
	});

	return { success: true, domain, newPreferences, globalPrefs, domainPrefs };
}, {
	onSuccess: async (result, { data }) => {
		const { domain, newPreferences } = result;
		if (!domain) {
			try {
				const syncPrefs = {};
				const globalPrefs = data.settings.uiPreferences.global;

				// Sync all global keys that are not UI-exclusive
				for (const key in globalPrefs) {
					if (!UI_ONLY_KEYS.includes(key)) {
						syncPrefs[key] = globalPrefs[key];
					}
				}

				if (Object.keys(syncPrefs).length > 0) await nativeLink.setUiPreferences(syncPrefs);
			} catch (e) {
				console.warn("Failed to sync preferences to native host:", e);
			}

			if (result.globalPrefs && "oneClickAdd" in result.globalPrefs) {
				updateContextMenus(storage).catch((e) =>
					console.error("Failed to update context menus:", e),
				);
			}
		}
	}
});

export const handleGetDefaultAutomaticFlags = createHandler(async () => {
	try {
		const response = await nativeLink.getDefaultAutomaticFlags();
		if (response.success && response.flags) return { success: true, flags: response.flags };
	} catch (e) {
		broadcastLog({ text: `[Background]: Failed to fetch default flags: ${e.message}`, type: "error" });
	}

	const defaultData = storage._getDefaultData();
	return { success: true, flags: defaultData.settings.uiPreferences.global.automaticMpvFlags };
}, {
	manualPersistence: true,
});

export const handleSetMinimizedState = createHandler(async ({ request, data }) => {
	const { minimized, tabId } = request;
	let domain = null;
	
	// PERSISTENCE: If we have a tabId, update the domain preference
	if (tabId) {
		try {
			const tab = await chrome.tabs.get(tabId);
			if (tab?.url && (tab.url.startsWith("http:") || tab.url.startsWith("https:"))) {
				domain = new URL(tab.url).hostname;
				if (!data.settings.uiPreferences.domains) data.settings.uiPreferences.domains = {};
				if (!data.settings.uiPreferences.domains[domain]) data.settings.uiPreferences.domains[domain] = {};
				data.settings.uiPreferences.domains[domain].minimized = minimized;
				console.log(`[Background]: Persisted minimized=${minimized} for domain: ${domain}`);
			}
		} catch (e) {
			console.warn("[Background]: Failed to persist minimized state for domain:", e);
		}
	}

	// Broadcast to tabs. If it was a domain-specific action (via tabId), specify the domain
	// so that other domains don't mirror the change.
	broadcastToTabs({
		action: "set_minimized_state",
		minimized,
		domain: domain,
	});
	
	return { success: true };
});

export function handleHeartbeat() {
	return { success: true };
}

export function handleForceReloadSettings() {
	broadcastToTabs({ action: "preferences_changed", preferences: {} });
	return { success: true };
}

export const handleForceRefreshDependencies = createHandler(async ({ data }) => {
	_nativeInfoCache.decoder = null;
	_nativeInfoCache.timestamp = 0;
	const response = await nativeLink.call("check_dependencies", { forceRefresh: true });

	if (response.success) {
		data.settings.uiPreferences.global.dependencyStatus = {
			mpv: response.mpv, ytdlp: response.ytdlp, ffmpeg: response.ffmpeg, node: response.node,
		};
		broadcastToTabs({
			action: "preferences_changed",
			preferences: { dependencyStatus: data.settings.uiPreferences.global.dependencyStatus },
		});
		broadcastLog({ text: "[Background]: Dependency status refreshed successfully.", type: "info" });
	}
	return response;
});

export async function handleOpenPopup(request, sender) {
	if (popupPort) {
		try { 
			popupPort.postMessage({ action: "close_popup" }); 
		} catch (e) {
			console.debug("[UiState] Failed to post close_popup message:", e);
		}
		return { success: true };
	}

	if (chrome.action && chrome.action.openPopup) {
		chrome.action.openPopup({ windowId: sender?.tab?.windowId }).catch(() => {});
		return { success: true };
	}
	return { success: false, error: "openPopup not supported." };
}
