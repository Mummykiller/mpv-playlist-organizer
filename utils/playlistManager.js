/**
 * Manages all playlist-related actions like adding, removing, clearing, and reordering.
 */

import { debouncedSyncToNativeHostFile } from "../background/core_services.js";
import { findM3u8InUrl } from "../background/handlers/m3u8_scanner.js";
import { createHandler } from "../background/handler_factory.js";
import { broadcastPlaylistState, isFolderActive } from "../background/ui_broadcaster.js";
import { broadcastLog } from "../background/messaging.js";
import { normalizeYouTubeUrl } from "./commUtils.module.js";
import { nativeLink } from "./nativeLink.js";
import { storage } from "../background/storage_instance.js";
import { processPlaylistItem } from "./item_processor.js";

// Keep track of URLs currently being processed to avoid concurrent duplicates
const scrapingInProgress = new Set();

/**
 * Low-level helper to add a URL to a specific folder's data object.
 * Handles duplicate checking and persistence.
 */
async function addUrlToFolder(
	folderId,
	url,
	title,
	originalTab = null,
	sender = null,
	isAutoAdd = false,
) {
	try {
		let data = await storage.get();
		const actualFolderId = Object.keys(data.folders).find(
			(id) => id.toLowerCase() === folderId.toLowerCase()
		);

		if (!actualFolderId || !data.folders[actualFolderId]) {
			return { success: false, error: `Folder '${folderId}' not found.` };
		}

		const playlist = data.folders[actualFolderId].playlist;
		const duplicateBehavior =
			data.settings.uiPreferences.global.duplicateUrlBehavior || "ask";
		const normalizedUrl = normalizeYouTubeUrl(url);

		const isDuplicate = playlist.some(
			(item) => normalizeYouTubeUrl(item.url) === normalizedUrl,
		);

		if (isDuplicate) {
			if (isAutoAdd) return { success: true, message: "Silent duplicate rejection." };
			if (duplicateBehavior === "never") {
				const logMessage = `[Background]: URL already in folder '${actualFolderId}'. "Never Add" is on.`;
				broadcastLog({ text: logMessage, type: "info" });
				return { success: true, message: logMessage };
			}

			if (duplicateBehavior === "ask") {
				// Delegate to UI for confirmation if possible
				const confirmed = await broadcastPlaylistState(actualFolderId, {
					action: "show_confirmation",
					message: `URL is already in folder '${actualFolderId}'. Add it again?`,
				});
				if (!confirmed) return { success: true, message: "Add cancelled by user." };
			}
		}

		// Use the centralized item processor to create the standard item object
		const newItem = processPlaylistItem({ url, title });
		if (!newItem) return { success: false, error: "Failed to process item." };

		data.folders[actualFolderId].playlist.push(newItem);
		await storage.set(data, actualFolderId);

		debouncedSyncToNativeHostFile(actualFolderId, true);

		broadcastLog({
			text: `[Background]: Added to '${actualFolderId}': ${newItem.title}`,
			type: "info",
		});

		// Check for live append
		const isActive = isFolderActive(actualFolderId);
		if (isActive && data.settings.uiPreferences.global.autoAppendOnAdd) {
			nativeLink.call("add_item_live", {
				folderId: actualFolderId,
				item: newItem,
			}).catch((e) => console.warn("[PlaylistManager] Live append failed:", e));
		}

		return { success: true, item: newItem };
	} catch (error) {
		console.error("[PlaylistManager] Error adding URL:", error);
		return { success: false, error: error.message };
	}
}

/**
 * Handles complex URL addition including YouTube scraping and M3U8 scanning.
 */
async function _scrapeAndAddUrl(
	folderId,
	urlToAdd,
	tab,
	sender,
	skipYouTubeCheck = false,
	isAutoAdd = false,
) {
	const isYouTubeUrl = urlToAdd.includes("youtube.com/") || urlToAdd.includes("youtu.be/");

	if (isYouTubeUrl && !skipYouTubeCheck) {
		broadcastLog({
			text: `[Background]: YouTube URL detected. Scraping title...`,
			type: "info",
		});

		try {
			const videoId = urlToAdd.split("v=")[1]?.split("&")[0] || urlToAdd.split("/").pop();
			const oEmbedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
			const response = await fetch(oEmbedUrl);
			const videoDetails = await response.json();

			const isPlaylist = urlToAdd.includes("/playlist?list=");
			const itemTitle =
				videoDetails.title ||
				(isPlaylist ? "YouTube Playlist" : "YouTube Video");
			const finalTitle = videoDetails.author_name
				? `${videoDetails.author_name} - ${itemTitle}`
				: itemTitle;

			return await addUrlToFolder(folderId, urlToAdd, finalTitle, tab, sender, isAutoAdd);
		} catch (e) {
			broadcastLog({
				text: `[Background]: YouTube oEmbed scrape failed: ${e.message}. Adding URL directly without scanner.`,
				type: "warning",
			});
			const isPlaylist = urlToAdd.includes("/playlist?list=");
			const fallbackTitle = isPlaylist ? "YouTube Playlist" : "YouTube Video";
			return await addUrlToFolder(folderId, urlToAdd, fallbackTitle, tab, sender, isAutoAdd);
		}
	} else {
		broadcastLog({
			text: `[Background]: Non-YouTube URL detected. Scanning for stream and title...`,
			type: "info",
		});

		let scanResult;
		try {
			scanResult = await findM3u8InUrl(urlToAdd, tab);
			// Refinement 4: Only fail if the URL is missing.
			// findM3u8InUrl already handles fallback titles.
			if (scanResult.url) {
				return await addUrlToFolder(
					folderId,
					scanResult.url,
					scanResult.title || "Scanned Stream",
					tab,
					sender,
					isAutoAdd,
				);
			} else {
				const message = `[Background]: Scanner did not detect a video stream on '${urlToAdd}'. Nothing added.`;
				broadcastLog({ text: message, type: "info" });
				return { success: false, error: message };
			}
		} catch (error) {
			const message = `[Background]: Scanner failed for '${urlToAdd}'. Adding original URL as fallback. Error: ${error.message}`;
			broadcastLog({ text: message, type: "info" });
			return await addUrlToFolder(folderId, urlToAdd, urlToAdd, tab, sender, isAutoAdd);
		} finally {
			if (scanResult?.scannerTab?.windowId) {
				chrome.windows.remove(scanResult.scannerTab.windowId).catch(() => {});
			}
		}
	}
}

/**
 * Orchestrates the addition of a URL based on an incoming request.
 */
export async function handleAdd(request, sender) {
	let tabId = request.tabId || sender.tab?.id;
	const folderId = request.folderId;
	let tab = request.tab || sender.tab;
	const isAutoAdd = !!request.isAutoAdd;
	const isStreamUrl = !!request.isStreamUrl;

	if (!tab && tabId) {
		try {
			tab = await chrome.tabs.get(tabId);
		} catch (e) {}
	}
	if (!tab) {
		const [activeTab] = await chrome.tabs.query({
			active: true,
			currentWindow: true,
		});
		tab = activeTab;
		tabId = tab?.id;
	}

	const urlToProcess = request.data?.url || tab?.url;
	if (urlToProcess && scrapingInProgress.has(urlToProcess)) {
		return { success: true, message: "Scraping already in progress." };
	}

	if (!folderId) {
		return { success: false, error: "Missing folderId for add action." };
	}

	// Case 1: We already have URL and Title (Manual or simple direct add)
	if (request.data?.url && request.data?.title) {
		scrapingInProgress.add(request.data.url);
		try {
			return await addUrlToFolder(
				folderId,
				request.data.url,
				request.data.title,
				tab,
				sender,
				isAutoAdd
			);
		} finally {
			scrapingInProgress.delete(request.data.url);
		}
	} 
	
	// Case 2: We have a URL but no title, and it's marked as a stream URL (Bypass Scanner)
	// This is the specific path used by Auto-Add to avoid opening scanner windows.
	if (isStreamUrl && request.data?.url) {
		scrapingInProgress.add(request.data.url);
		try {
			// Just use the page title or URL as title
			const title = tab?.title || request.data.url;
			return await addUrlToFolder(
				folderId,
				request.data.url,
				title,
				tab,
				sender,
				isAutoAdd
			);
		} finally {
			scrapingInProgress.delete(request.data.url);
		}
	}

	// Case 3: Need to scrape (Normal Add button click or Context Menu)
	const urlToScan = request.data?.url || tab?.url;
	if (!urlToScan) {
		return { success: false, error: "Cannot scrape this page. URL missing." };
	}
	scrapingInProgress.add(urlToScan);
	try {
		return await _scrapeAndAddUrl(folderId, urlToScan, tab, sender, false, isAutoAdd);
	} finally {
		scrapingInProgress.delete(urlToScan);
	}
}

export const handleClear = createHandler(async ({ folderId, data }) => {
	const actualFolderId = Object.keys(data.folders).find(
		(id) => id.toLowerCase() === folderId.toLowerCase()
	);

	if (!actualFolderId || !data.folders[actualFolderId])
		return { success: false, error: "Folder not found." };

	data.folders[actualFolderId].playlist = [];

	if (data.settings.uiPreferences.global.liveRemoval !== false) {
		nativeLink.clearLive(actualFolderId).catch(() => {});
	}
	
	return { success: true, message: `Playlist for '${actualFolderId}' cleared.` };
}, {
	requireFolder: true,
	syncToNative: true,
	syncImmediate: true,
	broadcastPlaylist: true
});

export const handleRemoveItem = createHandler(async ({ request, folderId, data }) => {
	const indexToRemove = request.data?.index;
	const idToRemove = request.data?.id;

	const actualFolderId = Object.keys(data.folders).find(
		(id) => id.toLowerCase() === folderId.toLowerCase()
	);

	if (actualFolderId && data.folders[actualFolderId]) {
		const playlist = data.folders[actualFolderId].playlist;
		let finalIndex = -1;

		if (idToRemove) {
			finalIndex = playlist.findIndex((item) => item.id === idToRemove);
		} else if (typeof indexToRemove === "number") {
			finalIndex = indexToRemove;
		}

		if (finalIndex >= 0 && finalIndex < playlist.length) {
			const itemToRemove = playlist[finalIndex];
			playlist.splice(finalIndex, 1);

			if (data.settings.uiPreferences.global.liveRemoval !== false) {
				nativeLink.call("remove_item_live", {
					folderId: actualFolderId,
					itemId: itemToRemove.id,
				}).catch((e) => console.warn("[PlaylistManager] Live removal failed:", e));
			}
			return { success: true, message: "Item removed." };
		}
	}
	return { success: false, error: "Invalid item index or ID." };
}, {
	requireFolder: true,
	syncToNative: true,
	syncImmediate: true,
	broadcastPlaylist: true
});

export const handleSetPlaylistOrder = createHandler(async ({ request, folderId, data }) => {
	const { order } = request.data;
	const actualFolderId = Object.keys(data.folders).find(
		(id) => id.toLowerCase() === folderId.toLowerCase()
	);

	if (!actualFolderId || !data.folders[actualFolderId]) return { success: false };

	data.folders[actualFolderId].playlist = order;
	nativeLink.reorderLive(actualFolderId, order).catch(() => {});
	
	return { success: true };
}, {
	requireFolder: true,
	syncToNative: true,
	syncImmediate: true,
	broadcastPlaylist: true
});

export async function handleAddFromContextMenu(folderId, urlToAdd, title, tab) {
	if (scrapingInProgress.has(urlToAdd)) return { success: true };
	scrapingInProgress.add(urlToAdd);
	try {
		return await _scrapeAndAddUrl(folderId, urlToAdd, tab, null);
	} finally {
		scrapingInProgress.delete(urlToAdd);
	}
}

export async function handleGetPlaylist(request) {
	// Optimization: Use getFolder to avoid loading the entire library
	const { folder, settings } = await storage.getFolder(request.folderId);

	const { mpv_playback_cache } = await chrome.storage.local.get("mpv_playback_cache");
	
	// Fast Path: Check if cache already has status for THIS folder
	let finalStatus = null;
	if (mpv_playback_cache && mpv_playback_cache.folderId === request.folderId) {
		finalStatus = {
			isRunning: mpv_playback_cache.isRunning !== false,
			isPaused: mpv_playback_cache.isPaused,
			isIdle: mpv_playback_cache.isIdle,
			sessionIds: mpv_playback_cache.sessionIds,
			lastPlayedId: mpv_playback_cache.lastPlayedId,
			folderId: mpv_playback_cache.folderId,
		};
	}

	// Deep Check: Only query native host if cache is missing or says it's running (to get latest readahead/sessionIds)
	if (!finalStatus || finalStatus.isRunning) {
		const statusResponse = await nativeLink.getPlaybackStatus().catch(() => null);
		
		if (statusResponse?.success) {
			finalStatus = statusResponse;
		}
	}

	let isActive = !!(
		finalStatus?.isRunning && finalStatus.folderId === request.folderId
	);
	let needsAppend = false;
	const lastPlayedId = finalStatus?.lastPlayedId || folder.lastPlayedId;

	// Calculate if we need append based on session IDs in cache vs current playlist
	if (isActive && finalStatus.sessionIds) {
		const sessionIds = new Set(finalStatus.sessionIds);
		needsAppend = folder.playlist.some((item) => !sessionIds.has(item.id));
	}

	return {
		success: true,
		list: folder.playlist,
		lastPlayedId: lastPlayedId,
		isRunning: isActive,
		needsAppend: needsAppend,
		isPaused: (finalStatus?.isPaused || finalStatus?.isIdle) ?? false,
		isIdle: finalStatus?.isIdle ?? false
	};
}
