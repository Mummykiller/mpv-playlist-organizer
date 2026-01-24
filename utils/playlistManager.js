/**
 * Manages all playlist-related actions like adding, removing, clearing, and reordering.
 */

import { debouncedSyncToNativeHostFile } from "../background/core_services.js";
import { findM3u8InUrl } from "../background/handlers/m3u8_scanner.js";
import {
	getMpvPlaylistCompletedExitCode,
	handleAppend,
} from "../background/handlers/playback.js";
import {
	broadcastPlaylistState,
	broadcastPlaybackState,
	getVisualPlaybackState,
	isFolderActive,
} from "../background/ui_broadcaster.js";
import { broadcastLog, broadcastToTabs } from "../background/messaging.js";
import { storage } from "../background/storage_instance.js";
import {
	normalizeYouTubeUrl,
	sanitizeString,
	sendMessageAsync,
} from "./commUtils.module.js";
import { processPlaylistItem } from "./item_processor.js";
import { nativeLink } from "./nativeLink.js";
import { createHandler } from "../background/handler_factory.js";

// A lock to prevent multiple scraping processes for the same URL at the same time.
const scrapingInProgress = new Set();

async function addUrlToFolder(
	folderId,
	url,
	title,
	originalTab = null,
	sender = null,
) {
	try {
		let data = await storage.get();
		if (!data.folders[folderId]) {
			data.folders[folderId] = { playlist: [], last_played_id: null };
		}

		const playlist = data.folders[folderId].playlist;
		const duplicateBehavior = data.settings.ui_preferences.global.duplicate_url_behavior || "ask";
		const normalizedUrl = normalizeYouTubeUrl(sanitizeString(url));

		const isDuplicate = playlist.some(
			(item) => normalizeYouTubeUrl(item.url) === normalizedUrl,
		);

		if (isDuplicate) {
			if (duplicateBehavior === "never") {
				const logMessage = `[Background]: URL already in folder '${folderId}'. "Never Add" is on.`;
				broadcastLog({ text: logMessage, type: "info" });
				return { success: true, message: logMessage };
			}
			if (duplicateBehavior === "ask") {
				const isFromPopup = sender?.url?.startsWith("chrome-extension://");
				let confirmed = false;

				if (isFromPopup) {
					try {
						const response = await sendMessageAsync({
							action: "show_popup_confirmation",
							message: `This URL is already in the playlist for "${folderId}". Add it again?`,
						});
						confirmed = !!response?.confirmed;
					} catch (e) {
						console.warn("[PlaylistManager] Popup confirmation failed:", e);
						confirmed = true;
					}
				} else {
					let targetTabId = originalTab?.id;
					if (!targetTabId) {
						const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
						targetTabId = activeTab?.id;
					}

					if (targetTabId) {
						try {
							const response = await chrome.tabs.sendMessage(targetTabId, {
								action: "show_confirmation",
								message: `This URL is already in the playlist for "${folderId}". Add it again?`,
							});
							confirmed = !!response?.confirmed;
						} catch (e) {
							broadcastLog({
								text: `[Background]: Could not ask for confirmation on tab ${targetTabId}. Adding duplicate.`,
								type: "info",
							});
							confirmed = true;
						}
					} else {
						confirmed = true;
					}
				}

				if (!confirmed) {
					const logMessage = `[Background]: Add action cancelled by user for folder '${folderId}'.`;
					broadcastLog({ text: logMessage, type: "info" });
					return { success: true, message: logMessage };
				}

				data = await storage.get();
				if (!data.folders[folderId]) data.folders[folderId] = { playlist: [] };
			}
		}

		const newItem = processPlaylistItem({ url, title });
		if (!newItem) return { success: false, error: "Failed to process item." };

		data.folders[folderId].playlist.push(newItem);
		await storage.set(data, folderId);

		debouncedSyncToNativeHostFile(folderId, true);
		await broadcastPlaylistState(folderId, data.folders[folderId].playlist);

		const { mpv_playback_cache: playbackCache } = await chrome.storage.local.get("mpv_playback_cache");
		const isMpvAlive = playbackCache && playbackCache.folderId === folderId && (playbackCache.is_running || !playbackCache.isIdle);

		if (isMpvAlive && data.settings.ui_preferences.global.auto_append_on_add !== false) {
			handleAppend({
				url_item: newItem,
				folderId: folderId,
			}).catch(() => {});
		}

		const logMessage = `[Background]: Added "${newItem.title}" to folder '${folderId}'.`;
		broadcastLog({ text: logMessage, type: "info" });
		return { success: true, message: logMessage };
	} catch (e) {
		const logMessage = `[Background]: Error adding to folder '${folderId}': ${e.message}`;
		broadcastLog({ text: logMessage, type: "error" });
		return { success: false, error: logMessage };
	}
}

/**
 * Centralized function to scrape details for a URL and add it to a folder.
 */
async function _scrapeAndAddUrl(
	folderId,
	urlToAdd,
	tab,
	sender,
	skipYouTubeCheck = false,
) {
	const isYouTubeUrl = /youtube\.com\/(watch|playlist)/.test(urlToAdd);

	if (isYouTubeUrl && !skipYouTubeCheck) {
		broadcastLog({
			text: `[Background]: YouTube URL detected. Scraping title via oEmbed...`,
			type: "info",
		});
		try {
			const oEmbedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(urlToAdd)}&format=json`;
			const response = await fetch(oEmbedUrl);
			if (!response.ok)
				throw new Error(`oEmbed request failed: ${response.status}`);

			const videoDetails = await response.json();
			const isPlaylist = urlToAdd.includes("/playlist?list=");
			const itemTitle =
				videoDetails.title ||
				(isPlaylist ? "YouTube Playlist" : "YouTube Video");
			const finalTitle = videoDetails.author_name
				? `${videoDetails.author_name} - ${itemTitle}`
				: itemTitle;

			return await addUrlToFolder(folderId, urlToAdd, finalTitle, tab, sender);
		} catch (e) {
			broadcastLog({
				text: `[Background]: YouTube oEmbed scrape failed: ${e.message}. Falling back to scanner.`,
				type: "info",
			});
			return await _scrapeAndAddUrl(folderId, urlToAdd, tab, sender, true);
		}
	} else {
		broadcastLog({
			text: `[Background]: Non-YouTube URL detected. Scanning for stream and title...`,
			type: "info",
		});
		let scanResult;
		try {
			scanResult = await findM3u8InUrl(urlToAdd, tab);
			if (scanResult.url) {
				return await addUrlToFolder(
					folderId,
					scanResult.url,
					scanResult.title,
					tab,
					sender,
				);
			} else {
				const message = `[Background]: Scanner did not detect a video stream on '${urlToAdd}'. Nothing added.`;
				broadcastLog({ text: message, type: "info" });
				return { success: false, error: message };
			}
		} catch (error) {
			const message = `[Background]: Scanner failed for '${urlToAdd}'. Adding original URL as fallback. Error: ${error.message}`;
			broadcastLog({ text: message, type: "info" });
			return await addUrlToFolder(folderId, urlToAdd, urlToAdd, tab, sender);
		} finally {
			if (scanResult?.scannerTab?.windowId) {
				chrome.windows.remove(scanResult.scannerTab.windowId).catch(() => {});
			}
		}
	}
}

export async function handleAdd(request, sender) {
	let tabId = request.tabId || sender.tab?.id;
	const folderId = request.folderId;
	let tab = request.tab || sender.tab;

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

	if (request.data?.url && request.data?.title) {
		scrapingInProgress.add(request.data.url);
		try {
			return await addUrlToFolder(
				folderId,
				request.data.url,
				request.data.title,
				tab,
				sender,
			);
		} finally {
			scrapingInProgress.delete(request.data.url);
		}
	} else {
		const urlToScan = tab?.url;
		if (!urlToScan) {
			return { success: false, error: "Cannot scrape this page. URL missing." };
		}
		scrapingInProgress.add(urlToScan);
		try {
			return await _scrapeAndAddUrl(folderId, urlToScan, tab, sender);
		} finally {
			scrapingInProgress.delete(urlToScan);
		}
	}
}

export const handleClear = createHandler(async ({ folderId, data }) => {
	if (!data.folders[folderId])
		return { success: false, error: "Folder not found." };

	data.folders[folderId].playlist = [];
	nativeLink.clearLive(folderId).catch(() => {});
	
	return { success: true, message: `Playlist for '${folderId}' cleared.` };
}, {
	requireFolder: true,
	syncToNative: true,
	syncImmediate: true,
	broadcastPlaylist: true
});

export const handleRemoveItem = createHandler(async ({ request, folderId, data }) => {
	const indexToRemove = request.data?.index;
	const idToRemove = request.data?.id;

	if (data.folders[folderId]) {
		const playlist = data.folders[folderId].playlist;
		let finalIndex = -1;

		if (idToRemove) {
			finalIndex = playlist.findIndex((item) => item.id === idToRemove);
		} else if (typeof indexToRemove === "number") {
			finalIndex = indexToRemove;
		}

		if (finalIndex >= 0 && finalIndex < playlist.length) {
			const itemToRemove = playlist[finalIndex];
			playlist.splice(finalIndex, 1);

			if (data.settings.ui_preferences.global.live_removal !== false) {
				nativeLink.call("remove_item_live", {
					folderId,
					item_id: itemToRemove.id,
				}).catch(() => {});
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
	if (!data.folders[folderId]) return { success: false };

	data.folders[folderId].playlist = order;
	nativeLink.reorderLive(folderId, order).catch(() => {});
	
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
			is_running: mpv_playback_cache.is_running !== false,
			is_paused: mpv_playback_cache.isPaused,
			isIdle: mpv_playback_cache.isIdle,
			sessionIds: mpv_playback_cache.sessionIds,
			lastPlayedId: mpv_playback_cache.lastPlayedId,
			folderId: mpv_playback_cache.folderId,
		};
	}

	// Deep Check: Only query native host if cache is missing or says it's running (to get latest readahead/sessionIds)
	if (!finalStatus || finalStatus.is_running) {
		const statusResponse = await nativeLink.getPlaybackStatus().catch(() => null);
		
		if (statusResponse?.success) {
			finalStatus = statusResponse;
		}
	}

	let isActive = !!(
		(finalStatus?.is_running || finalStatus?.isRunning) && finalStatus.folderId === request.folderId
	);
	let needsAppend = false;
	const lastPlayedId = finalStatus?.lastPlayedId || folder.last_played_id;

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
		isPaused: (finalStatus?.isPaused || finalStatus?.is_paused || finalStatus?.isIdle || finalStatus?.is_idle) ?? false,
		isIdle: (finalStatus?.isIdle || finalStatus?.is_idle) ?? false
	};
}