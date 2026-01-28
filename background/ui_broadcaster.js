// background/ui_broadcaster.js

import { storage } from "./storage_instance.js";
import { nativeLink } from "../utils/nativeLink.js";
import { broadcastToTabs } from "./messaging.js";
import { playbackManager } from "./playback_manager.js";

/**
 * Checks if a specific folder is currently active in MPV.
 * @param {string} folderId The ID of the folder to check.
 * @returns {boolean} True if the folder is active and playing.
 */
export function isFolderActive(folderId) {
	const session = playbackManager.findSessionByFolderId(folderId);
	return !!(session && session.isPlaying);
}

/**
 * Robust async check for visual playback state.
 * Returns { isActive, isPaused } and accounts for sync status (UI Reversion).
 */
export async function getVisualPlaybackState(folderId, playlist = null) {
	try {
		// 1. Try to get real-time status with a tight timeout
		const statusResponse = await nativeLink.getPlaybackStatus().catch(() => null);

		// 2. If native host is not available/timed out, fallback to local cache
		let finalStatus = statusResponse;
		if (!finalStatus) {
			const { mpv_playback_cache } = await chrome.storage.local.get(
				"mpv_playback_cache",
			);
			if (mpv_playback_cache && mpv_playback_cache.folderId === folderId) {
				finalStatus = {
					isRunning: mpv_playback_cache.isRunning !== false,
					isPaused: mpv_playback_cache.isPaused,
					sessionIds: mpv_playback_cache.sessionIds,
					lastPlayedId: mpv_playback_cache.lastPlayedId,
					folderId: mpv_playback_cache.folderId,
				};
			}
		}

		if (!finalStatus)
			return { isActive: false, isPaused: false, needsAppend: false };

		// Rely on automated normalization
		const isProcessRunning = !!finalStatus.isRunning;
		const isManagerActive = isFolderActive(folderId);
		
		let isActive = (isProcessRunning || isManagerActive) && (finalStatus.folderId === folderId || !finalStatus.folderId);
		
		const isPaused = (finalStatus.isPaused || finalStatus.isIdle) ?? false;
		let needsAppend = false;
		const lastPlayedId = finalStatus.lastPlayedId;

		const rawSessionIds = finalStatus.sessionIds;
		if (isActive && rawSessionIds && playlist) {
			const sessionIdsSet = new Set(rawSessionIds);
			needsAppend = playlist.some((item) => !sessionIdsSet.has(item.id));
		}

		return { isActive, isPaused, needsAppend, lastPlayedId };
	} catch (e) {
		console.error("[UIBroadcaster] Error getting playback state:", e);
		return { isActive: false, isPaused: false, needsAppend: false };
	}
}

/**
 * Broadcasts a full playlist update to all UI components.
 * Standardizes the payload structure to prevent UI flicker/mismatches.
 */
export async function broadcastPlaylistState(folderId, playlist = null, action = "render_playlist") {
	const data = await storage.get();
	const targetPlaylist = playlist || data.folders[folderId]?.playlist || [];
	
	const { isActive, isPaused, needsAppend, lastPlayedId } = 
		await getVisualPlaybackState(folderId, targetPlaylist);

	// Get completed items for visual filtering
	const session = playbackManager.findSessionByFolderId(folderId);
	const completedIds = session ? Array.from(session.completedItemIds) : [];

	broadcastToTabs({
		action: action,
		folderId: folderId,
		playlist: targetPlaylist,
		lastPlayedId: lastPlayedId || data.folders[folderId]?.lastPlayedId,
		isFolderActive: isActive,
		isPaused: isPaused,
		needsAppend: needsAppend,
		completedIds: completedIds,
	});

	broadcastPlaybackState(folderId, { needsAppend });
}

/**
 * Broadcasts a lightweight playback state update to all UI components.
 */
export async function broadcastPlaybackState(folderId, statusOverride = {}) {
	const { mpv_playback_cache: storageCache } = await chrome.storage.local.get("mpv_playback_cache");
	const mpv_playback_cache = storageCache || playbackManager.syncCache;
	
	const targetFolderId = folderId || mpv_playback_cache?.folderId;
	if (!targetFolderId) return;

	const isActive = isFolderActive(targetFolderId);
	const cacheIsActive = !!(mpv_playback_cache && mpv_playback_cache.isRunning !== false && mpv_playback_cache.folderId === targetFolderId);
	
	let needsAppend = false;
	if (isActive || cacheIsActive) {
		const storageData = await storage.get();
		const folder = storageData.folders[targetFolderId];
		const rawSessionIds = mpv_playback_cache?.sessionIds;
		
		if (folder && folder.playlist && rawSessionIds) {
			const sessionSet = new Set(rawSessionIds);
			needsAppend = folder.playlist.some(item => !sessionSet.has(item.id));
		}
	}

	const state = {
		folderId: targetFolderId,
		isRunning: isActive || cacheIsActive,
		isPaused: mpv_playback_cache?.isPaused || false,
		isIdle: mpv_playback_cache?.isIdle || false,
		lastPlayedId: mpv_playback_cache?.lastPlayedId,
		needsAppend: needsAppend,
		...statusOverride
	};

	broadcastToTabs({
		action: "playback_state_changed",
		state: state
	});
}