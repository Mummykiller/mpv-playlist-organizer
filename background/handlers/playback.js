import {
	addNativeListener,
} from "../../utils/nativeConnection.module.js";
import { nativeLink, buildPlaybackSettingsPayload } from "../../utils/nativeLink.js";
import { normalizeYouTubeUrl, getActiveTab, promptUserConfirmation } from "../../utils/commUtils.module.js";
import { debouncedSyncToNativeHostFile } from "../core_services.js";
import { broadcastLog, broadcastToTabs } from "../messaging.js";
import { storage } from "../storage_instance.js";
import { createHandler } from "../handler_factory.js";
import { playbackManager } from "../playback_manager.js";
import { 
	broadcastPlaylistState, 
	broadcastPlaybackState, 
	broadcastItemUpdate,
	getVisualPlaybackState
} from "../ui_broadcaster.js";

const MPV_PLAYLIST_COMPLETED_EXIT_CODE = 99;
const RESUME_TIME_WRITE_THROTTLE_MS = 10000;
const resumeTimeThrottles = new Map();

function getCanonicalFolderId(storageData, folderId) {
	if (!folderId || !storageData?.folders) return folderId;
	return (
		Object.keys(storageData.folders).find(
			(id) => id.toLowerCase() === folderId.toLowerCase(),
		) || folderId
	);
}

/**
 * Filters out the currently active item from a list of IDs to prevent 
 * accidental removal of the video the user is currently watching.
 * @param {string} folderId 
 * @param {string[]} ids 
 * @param {string|null} ignoreItemId Item that just finished and SHOULD be cleared even if still "active" in cache.
 */
async function filterActiveItem(folderId, ids, ignoreItemId = null) {
	const { isActive, lastPlayedId } = await getVisualPlaybackState(folderId);
	if (!isActive || !lastPlayedId) return ids;
	
	// If the active item is the one that just triggered completion, we definitely want to clear it.
	if (lastPlayedId === ignoreItemId) return ids;
	
	return ids.filter(id => id !== lastPlayedId);
}

/**
 * Maps item IDs to user-friendly titles from playlist.
 */
function resolveItemTitles(playlist, ids) {
	const idMap = new Map(playlist.map(i => [i.id, i.title || i.url]));
	return ids.map(id => idMap.get(id) || id);
}

/**
 * Directional clear helper: finds target finished IDs and preceding watched items.
 */
function getDirectionalFinishedIds(playlist, finishedIds, sessionWatchedIds = null) {
	const finishedIdSet = new Set(Array.isArray(finishedIds) ? finishedIds : [finishedIds]);
	let maxFinishedIndex = -1;
	playlist.forEach((item, idx) => {
		if (finishedIdSet.has(item.id)) maxFinishedIndex = idx;
	});

	return playlist
		.filter((item, idx) => {
			const isFinished = finishedIdSet.has(item.id);
			const isPreviousWatched = idx < maxFinishedIndex && (
				item.watched || item.markedAsWatched || (sessionWatchedIds && sessionWatchedIds.has(item.id))
			);
			return isFinished || isPreviousWatched;
		})
		.map(i => i.id);
}

/**
 * Sends clear confirmation prompt to the active browser tab and stores pendingClear in session.
 */
async function promptClearConfirmation(folderId, targetIds, folder, clearScope, isQuitting = false) {
	const activeTab = await getActiveTab();
	if (!activeTab?.id) return;

	if (targetIds.length === 0) {
		console.debug(`[Background]: No items from scope '${clearScope}' remain in playlist for '${folderId}'. Skipping prompt.`);
		return;
	}

	const titles = resolveItemTitles(folder.playlist, targetIds);
	const session = playbackManager.findSessionByFolderId(folderId) || playbackManager.getSession(folderId);
	const pendingClear = {
		folderId,
		playedIds: targetIds,
		sessionIds: targetIds,
		scope: clearScope,
		titles: titles,
		...(isQuitting ? { isQuitting: true } : {})
	};
	if (session) {
		session.pendingClear = pendingClear;
		playbackManager.persistSessions();
	}

	chrome.tabs
		.sendMessage(activeTab.id, {
			action: "show_clear_confirmation",
			...pendingClear,
			count: targetIds.length,
		})
		.catch(() => {});
}

// Register listeners for unsolicited native host events
addNativeListener("mpv_exited", (data) => handleMpvExited(data));
addNativeListener("update_last_played", (data) => handleUpdateLastPlayed(data));
addNativeListener("update_item_resume_time", (data) =>
	handleUpdateItemResumeTime(data),
);
addNativeListener("update_item_marked_as_watched", (data) =>
	handleUpdateItemMarkedAsWatchedInternal(data, { isNative: true }),
);
addNativeListener("playback_status_changed", (data) =>
	handlePlaybackStatusChanged(data),
);
addNativeListener("item_natural_completion", (data) =>
	handleItemNaturalCompletion(data),
);
addNativeListener("mpv_quitting", (data) => handleMpvQuitting(data));
addNativeListener("session_restored", (data) => handleSessionRestored(data));
addNativeListener("playback_health_changed", (data) => handlePlaybackHealthChanged(data));

export async function handlePlaybackHealthChanged(data) {
	const { folderId, health } = data;
	if (!folderId) return;

	const storageData = await storage.get();
	const actualFolderId = getCanonicalFolderId(storageData, folderId);

	console.log(`[PlaybackHandler] Health changed for folder '${actualFolderId}': ${health}`);

	// Update the global playback state bucket
	const { active_playback_state: pbState } = await chrome.storage.local.get("active_playback_state");
	let clearedStale = false;
	if (health === "dead") {
		const res = await playbackManager.clearStalePlaybackState(actualFolderId);
		clearedStale = Boolean(res?.cleared);
	}
	if (pbState && pbState.folderId?.toLowerCase() === actualFolderId.toLowerCase()) {
		pbState.folderId = actualFolderId;
		pbState.health = health;
		
		// If health is dead, we should also mark it as not running to trigger UI reset
		if (health === "dead") {
			pbState.isRunning = false;
			pbState.isLaunching = false;
			pbState.isPaused = false;
			pbState.isIdle = false;
			pbState.sessionIds = [];
		}
		
		await chrome.storage.local.set({ active_playback_state: pbState });
		
		// Broadcast the new state to all tabs
		broadcastPlaybackState(actualFolderId, {
			health,
			...(health === "dead" ? { isRunning: false, isLaunching: false, isPaused: false, isIdle: false } : {}),
		});
	} else if (health === "dead" && clearedStale) {
		await broadcastPlaybackState(actualFolderId, {
			health,
			isRunning: false,
			isLaunching: false,
			isPaused: false,
			isIdle: false,
		});
		broadcastToTabs({
			action: "render_playlist",
			folderId: actualFolderId,
			isFolderActive: false,
			isClosing: false,
		});
	}
}

export async function handleItemNaturalCompletion(data) {
	await playbackManager.initPromise;
	const { folderId, itemId } = data;
	if (!folderId || !itemId) return;

	const storageData = await storage.get();
	const actualFolderId = getCanonicalFolderId(storageData, folderId);
	const folder = storageData.folders?.[actualFolderId];
	if (!folder) return;

	const item = folder.playlist.find(i => i.id === itemId);
	if (!item) {
		console.debug(`[Background]: Item ${itemId} finished but is no longer in playlist '${actualFolderId}'. Ignoring.`);
		return;
	}

	const globalPrefs = storageData.settings.uiPreferences.global;
	const clearMode = globalPrefs.clearOnCompletion || "no";
	
	if (globalPrefs.clearOnItemFinish && clearMode !== "no") {
		const session = playbackManager.getSession(actualFolderId);
		session.completedItemIds.add(itemId);
		playbackManager.persistSessions();
		
		// Flag this folder so handleMpvExited knows a batch clear is already being managed
		playbackManager.markEarlyClear(actualFolderId);

		const itemTitle = item.title || item.url || itemId;

		if (clearMode === "yes") {
			// Mode: "yes" -> Clear immediately and silently
			broadcastLog({
				text: `[Background]: Item "${itemTitle}" finished. Auto-clearing from '${actualFolderId}'.`,
				type: "info",
				itemId: itemId,
				folderId: actualFolderId
			});
			
			const allToClearRaw = getDirectionalFinishedIds(folder.playlist, itemId, session.watchedItemIds);
			const allToClear = await filterActiveItem(actualFolderId, allToClearRaw, itemId);

			await clearFolderPlaylist(actualFolderId, {
				playedIds: allToClear,
				scope: "played",
			});
			// Still remove from session set just in case
			session.completedItemIds.delete(itemId);
			session.watchedItemIds.delete(itemId);
			playbackManager.persistSessions();
			playbackManager.clearEarlyClear(actualFolderId);
		} else if (clearMode === "confirm") {
			// Mode: "confirm" -> Visual clear nice + Stacked popup
			broadcastLog({
				text: `[Background]: Item "${itemTitle}" finished. Staging for batch clear.`,
				type: "info",
				itemId: itemId,
				folderId: actualFolderId
			});

			// 1. Refresh UI to hide the completed items visually
			await broadcastPlaylistState(actualFolderId);

			// 2. Trigger/update the stacked confirmation
			const targetIdsRaw = getDirectionalFinishedIds(folder.playlist, Array.from(session.completedItemIds), session.watchedItemIds);
			const targetList = await filterActiveItem(actualFolderId, targetIdsRaw, itemId);

			await promptClearConfirmation(actualFolderId, targetList, folder, "played", false);
		}
	}
}

export async function handleMpvQuitting(data) {
	await playbackManager.initPromise;
	const { folderId, isNaturalCompletion, playedIds, watchedIds, sessionIds } = data;
	const storageData = folderId ? await storage.get() : null;
	const actualFolderId = folderId ? getCanonicalFolderId(storageData, folderId) : folderId;

	broadcastLog({
		text: `[Background]: MPV shutdown sequence started for '${actualFolderId}'.`,
		type: "info",
	});

	broadcastPlaybackState(actualFolderId, { isClosing: true, isRunning: true });
	await broadcastPlaylistState(actualFolderId, null, "render_playlist");

	// --- Early Clear/Confirm Logic ---
	if (isNaturalCompletion && actualFolderId) {
		const folder = storageData.folders?.[actualFolderId];
		
		if (!folder || !folder.playlist) return;

		// THE DECIDER: Use items that actually passed the threshold OR are already marked in storage
		const watchedSet = new Set(watchedIds || playedIds || []);
		const sessionFinishedIds = new Set(playedIds || []);
		
		// If everything currently in the folder is marked as "watched" (either now or previously), we clear all.
		// But only if we actually finished at least one item in THIS session, to prevent clearing on accidental loads.
		const isFullFolderComplete = folder.playlist.length > 0 && 
			sessionFinishedIds.size > 0 && 
			folder.playlist.every(item => 
				item.watched || item.markedAsWatched || watchedSet.has(item.id)
			);
		
		const globalPrefs = storageData.settings.uiPreferences.global;
		const clearMode = globalPrefs.clearOnCompletion || "no";
		// Default to 'session' scope for natural completion if not a full clear
		const clearScope = isFullFolderComplete ? "all" : (globalPrefs.clearScope || "session");

		if (clearMode !== "no") {
			broadcastLog({
				text: `[Background]: Completion detected for '${actualFolderId}'. (Full: ${isFullFolderComplete}). Mode: ${clearMode}.`,
				type: "info",
			});
			playbackManager.markEarlyClear(actualFolderId);

			const finishedIds = getDirectionalFinishedIds(folder.playlist, playedIds || []);

			if (clearMode === "yes") {
				const mergedPlayedIds = await filterActiveItem(actualFolderId, finishedIds);

				await clearFolderPlaylist(actualFolderId, {
					playedIds: mergedPlayedIds,
					sessionIds,
					scope: clearScope,
				});
			} else if (clearMode === "confirm") {
				const existingIds = new Set(folder.playlist.map(i => i.id));
				const targetIdsRaw = (clearScope === "all" ? Array.from(existingIds) : finishedIds)
					.filter(id => existingIds.has(id));
				
				const ignoreId = finishedIds.length > 0 ? finishedIds[finishedIds.length - 1] : null;
				const targetIds = await filterActiveItem(actualFolderId, targetIdsRaw, ignoreId);

				await promptClearConfirmation(actualFolderId, targetIds, folder, clearScope, true);
			}
		}
	}
}

export async function handleMpvExited(data) {
	await playbackManager.initPromise;
	const { folderId, returnCode, reason, playedIds, sessionIds } = data;
	if (!folderId) return;

	// Check if this folder was already handled by the early quitting logic
	const wasEarlyHandled = playbackManager.hasEarlyClear(folderId);
	playbackManager.clearEarlyClear(folderId); // Cleanup for next session

	const session = playbackManager.findSessionByFolderId(folderId);
	if (session) {
		session.isPlaying = false;
		if (typeof session.clearPlaylist === "function") {
			session.clearPlaylist();
		} else {
			session.queue = []; // Clear pending items if the player closed
		}
	}

	// Clear cache on exit before broadcasting state
	await playbackManager.clearPlaybackCache();

	// 1. Immediate UI Reset
	await broadcastPlaybackState(folderId, { isRunning: false, isClosing: false, isIdle: false });

	broadcastToTabs({
		action: "render_playlist",
		folderId: folderId,
		isFolderActive: false,
		isClosing: false,
	});

	// Mapping of common exit codes to human-readable explanations.
	const exitCodeExplanations = {
		0: "Success (Manually closed or finished naturally without custom script)",
		99: "Natural completion (Playlist finished, clearing as per settings)",
		1: "Error (Generic or playback failure)",
		2: "Initialization error",
		3: "Invalid command line arguments",
		4: "No input file provided",
		5: "Halted by user (Keyboard shortcut or quit command)",
		6: "Resource mapping error",
		11: "Signal 11 (Segmentation Fault - likely a crash)",
	};

	const explanation =
		exitCodeExplanations[returnCode] || "Unknown or unexpected exit status";
	const displayReason = reason ? ` (Host Reason: ${reason})` : "";

	broadcastLog({
		text: `[Background]: MPV session for '${folderId}' ended. Code: ${returnCode} - ${explanation}${displayReason}`,
		type: "info",
	});

	const storageData = await storage.get();
	const actualFolderId = getCanonicalFolderId(storageData, folderId);
	const folder = storageData.folders?.[actualFolderId];

	if (folder && Array.isArray(folder.playlist)) {
		let playingFlagCleared = false;
		folder.playlist.forEach((item) => {
			if (item.currentlyPlaying) {
				item.currentlyPlaying = false;
				playingFlagCleared = true;
			}
		});
		if (playingFlagCleared) {
			await storage.set(storageData, actualFolderId);
		}
	}

	// Only attempt to clear if it wasn't already handled early AND it looks like a natural completion
	if (!wasEarlyHandled) {
		// MPV_PLAYLIST_COMPLETED_EXIT_CODE (99) indicates natural playlist completion via custom script.
		const isNaturalCompletion = returnCode === MPV_PLAYLIST_COMPLETED_EXIT_CODE;

		if (isNaturalCompletion && folder && folder.playlist) {
			const globalPrefs = storageData.settings.uiPreferences.global;
			const clearMode = globalPrefs.clearOnCompletion || "no";
			
			const watchedSet = new Set(data.watchedIds || data.playedIds || []);
			const isFullFolderComplete = folder.playlist.length > 0 && folder.playlist.every(item => 
				item.watched || item.markedAsWatched || watchedSet.has(item.id)
			);
			const clearScope = isFullFolderComplete ? "all" : (globalPrefs.clearScope || "session");

			if (clearMode === "yes") {
				broadcastLog({
					text: `[Background]: Auto-clearing session items for '${actualFolderId}' (Full: ${isFullFolderComplete}).`,
					type: "info",
				});

				const watchedInStorage = folder.playlist.filter(i => i.watched || i.markedAsWatched).map(i => i.id);
				const rawMergedPlayedIds = Array.from(new Set([...(playedIds || []), ...watchedInStorage]));
				const mergedPlayedIds = await filterActiveItem(actualFolderId, rawMergedPlayedIds);

				await clearFolderPlaylist(actualFolderId, {
					playedIds: mergedPlayedIds,
					sessionIds,
					scope: clearScope,
				});
			} else if (clearMode === "confirm") {
				broadcastLog({
					text: `[Background]: Requesting confirmation to clear items for '${actualFolderId}'.`,
					type: "info",
				});

				const existingIds = new Set(folder.playlist.map(i => i.id));
				const watchedInStorage = folder.playlist.filter(i => i.watched || i.markedAsWatched).map(i => i.id);
				const mergedPlayedIds = Array.from(new Set([...(playedIds || []), ...watchedInStorage]));

				const rawTargetIds = clearScope === "all" 
					? folder.playlist.map(i => i.id) 
					: (clearScope === "session" ? sessionIds : mergedPlayedIds);
				
				const filteredTargetIds = (rawTargetIds || []).filter(id => existingIds.has(id));
				const targetIds = await filterActiveItem(actualFolderId, filteredTargetIds);

				await promptClearConfirmation(actualFolderId, targetIds, folder, clearScope, true);
			}
		} else if (isNaturalCompletion === false && (storageData?.settings?.uiPreferences?.global?.clearOnCompletion || "no") !== "no") {
			broadcastLog({
				text: `[Background]: MPV exited with code ${returnCode}. Playlist will not be cleared (requires natural completion).`,
				type: "info",
			});
		}
	} else {
		console.debug(`[Background]: Cleanup for '${actualFolderId}' already triggered during quitting phase.`);
	}

	// Cleanup the session from manager if it's finished
	if (session && session.queue.length === 0 && !session.pendingClear) {
		playbackManager.cleanupSession(actualFolderId);
	}

	// ALWAYS broadcast a refresh to all tabs after an exit to ensure UI state (like active highlight) is updated.
	await broadcastPlaylistState(actualFolderId);
}

async function clearFolderPlaylist(folderId, options = {}) {
	const { playedIds, sessionIds, scope = "all" } = options;
	const storageData = await storage.get();
	const actualFolderId = getCanonicalFolderId(storageData, folderId);

	if (storageData.folders?.[actualFolderId]) {
		const folder = storageData.folders[actualFolderId];
		const originalCount = folder.playlist.length;
		let removedUrls = new Set();

		// Correctly handle the scope to avoid clearing the whole folder
		if (scope === "played" && Array.isArray(playedIds) && playedIds.length > 0) {
			const playedSet = new Set(playedIds);
			console.log(`[Background] clearFolderPlaylist: Removing ${playedIds.length} items from storage:`, playedIds);
			
			// Capture URLs before removing (Normalized)
			folder.playlist.forEach(item => {
				if (playedSet.has(item.id)) removedUrls.add(normalizeYouTubeUrl(item.url));
			});

			folder.playlist = folder.playlist.filter(
				(item) => !playedSet.has(item.id),
			);
		} else if (scope === "session" && Array.isArray(sessionIds) && sessionIds.length > 0) {
			const sessionSet = new Set(sessionIds);
			
			// Capture URLs before removing (Normalized)
			folder.playlist.forEach(item => {
				if (sessionSet.has(item.id)) removedUrls.add(normalizeYouTubeUrl(item.url));
			});

			folder.playlist = folder.playlist.filter(
				(item) => !sessionSet.has(item.id),
			);
		} else if (scope === "all") {
			// For full clear, capture all URLs if global sync is on.
			if (storageData.settings.uiPreferences.global.syncGlobalRemovals === true) {
				folder.playlist.forEach(item => removedUrls.add(normalizeYouTubeUrl(item.url)));
			}
			folder.playlist = [];
		} else {
			console.warn(`[Background] clearFolderPlaylist: Aborted clear. Scope '${scope}' was requested but no valid IDs were provided.`);
			return false;
		}

		const removedCount = originalCount - folder.playlist.length;
		if (removedCount > 0) {
			broadcastLog({
				text: `[Background]: Removed ${removedCount} item(s) from '${actualFolderId}' based on clear scope '${scope}'.`,
				type: "info",
			});

			const { mpv_playback_cache: playbackCache } = await chrome.storage.local.get("mpv_playback_cache");
			
			// --- Local Live Removal (Mimic X-click) ---
			// If the current folder is active in MPV, remove the items from the player too.
			if (storageData.settings.uiPreferences.global.liveRemoval !== false && 
				playbackCache && playbackCache.folderId?.toLowerCase() === actualFolderId.toLowerCase() && (playbackCache.isRunning || !playbackCache.isIdle)) {
				
				// Re-identify IDs that were removed based on the original scope
				let idsToRemoveLive = [];
				if (scope === "played") idsToRemoveLive = playedIds;
				else if (scope === "session") idsToRemoveLive = sessionIds;
				else if (scope === "all") idsToRemoveLive = []; // Handle all case if needed, but usually natural completion handles it

				if (idsToRemoveLive && idsToRemoveLive.length > 0) {
					for (const rId of idsToRemoveLive) {
						try {
							await nativeLink.call("remove_item_live", {
								folderId: actualFolderId,
								itemId: rId,
							});
						} catch (e) {
							console.warn(`[PlaybackHandler] Live removal of ${rId} failed:`, e);
						}
					}
				}
			}

			let globalSyncPerformed = false;
			// --- Global URL Synchronization ---
			if (storageData.settings.uiPreferences.global.syncGlobalRemovals === true && removedUrls.size > 0) {
				const affectedFolders = new Set();
				
				for (const [fId, otherFolder] of Object.entries(storageData.folders)) {
					if (fId === actualFolderId) continue;

					const itemsToRemoveFromThisFolder = otherFolder.playlist.filter(
						(item) => removedUrls.has(normalizeYouTubeUrl(item.url))
					);
					
					if (itemsToRemoveFromThisFolder.length > 0) {
						otherFolder.playlist = otherFolder.playlist.filter(
							(item) => !removedUrls.has(normalizeYouTubeUrl(item.url))
						);
						affectedFolders.add(fId);

						// Handle live removal for synchronized folders if they are active
						if (storageData.settings.uiPreferences.global.syncGlobalRemovalsLive === true && 
							playbackCache && playbackCache.folderId?.toLowerCase() === fId.toLowerCase() && (playbackCache.isRunning || !playbackCache.isIdle)) {
							for (const syncItem of itemsToRemoveFromThisFolder) {
								nativeLink.call("remove_item_live", {
									folderId: fId,
									itemId: syncItem.id,
								}).catch(() => {});
							}
						}
					}
				}

				if (affectedFolders.size > 0) {
					globalSyncPerformed = true;
					broadcastLog({
						text: `[Background]: Globally removed ${removedUrls.size} unique URL(s) from ${affectedFolders.size} other folder(s).`,
						type: "info"
					});
					
					// Save the entire library since multiple folders were modified
					await storage.set(storageData);

					for (const fId of affectedFolders) {
						await broadcastPlaylistState(fId, storageData.folders[fId].playlist);
					}
				}
			}

			if (!globalSyncPerformed) {
				await storage.set(storageData, actualFolderId);
			}
			
			debouncedSyncToNativeHostFile(null, true);
			await broadcastPlaylistState(actualFolderId, folder.playlist);
			return true;
		}
	}
	return false;
}

export const handleClearPlaylistConfirmation = createHandler(async ({ request }) => {
	await playbackManager.initPromise;
	const folderId = request.folderId;
	if (!folderId) return { success: false };

	const playedIds = request.playedIds; // Handled by normalization
	const sessionIds = request.sessionIds;
	const scope = request.scope;

	// CLEAR PERSISTENCE
	const session = playbackManager.findSessionByFolderId(folderId);
	const wasQuitting = Boolean(session?.pendingClear?.isQuitting ?? request.isQuitting);
	if (session) {
		session.pendingClear = null;
		playbackManager.persistSessions();
	}

	if (request.confirmed) {
		// Safety check: Never clear the currently active item even if it was in the prompt list
		const filteredPlayedIds = await filterActiveItem(folderId, playedIds || []);
		const filteredSessionIds = await filterActiveItem(folderId, sessionIds || []);

		const clearCount = filteredPlayedIds.length;
		broadcastLog({
			text: `[Background]: Confirmed! Removing ${clearCount} item(s) from '${folderId}'.`,
			type: "info",
		});

		// PERMANENT DELETE only on confirm
		await clearFolderPlaylist(folderId, {
			playedIds: filteredPlayedIds,
			sessionIds: filteredSessionIds,
			scope,
		});

		// Clear the staged list
		if (session) {
			const confirmedIds = new Set(filteredPlayedIds);
			for (const id of session.completedItemIds) {
				if (confirmedIds.has(id)) {
					session.completedItemIds.delete(id);
				}
			}
			playbackManager.persistSessions();
		}
		if (!wasQuitting) {
			playbackManager.clearEarlyClear(folderId);
		}
	} else {
		broadcastLog({
			text: `[Background]: User declined clearing playlist for '${folderId}'. Items restored.`,
			type: "info",
		});

		// RESTORE items to UI if cancelled
		if (session) {
			session.completedItemIds.clear();
			session.pendingClear = null;
			playbackManager.persistSessions();
			await broadcastPlaylistState(folderId);
		}
		// Critical: Remove from early clears so next completion isn't blocked
		playbackManager.clearEarlyClear(folderId);
	}

	return { success: true };
}, { 
	manualPersistence: true 
});

/**
 * Checks if MPV is currently playing a different folder and asks for confirmation if enabled.
 */
async function checkAndConfirmFolderSwitch(targetFolderId) {
	try {
		const statusResponse = await handleIsMpvRunning();
		// If MPV is not running at all, proceed.
	if (
		statusResponse?.isRunning === false
	)
			return true;

		// If the target folder is already active in MPV, proceed.
		const currentFolderId = statusResponse.folderId;
		if (currentFolderId && currentFolderId.toLowerCase() === targetFolderId?.toLowerCase()) return true;

		if (currentFolderId && currentFolderId.toLowerCase() !== targetFolderId?.toLowerCase()) {
			const data = await storage.get();
			const shouldConfirm =
				data.settings.uiPreferences.global.confirmFolderSwitch ?? true;

			if (shouldConfirm) {
				broadcastLog({
					text: `[Background]: Prompting user for folder switch from "${currentFolderId}" to "${targetFolderId}".`,
					type: "info",
				});

				const message = `MPV is currently playing folder "${currentFolderId}". Switch to "${targetFolderId}"?`;
				// If on a restricted page where no tab can be prompted, proceed with playback rather than hanging
				const confirmed = await promptUserConfirmation(message, null, true);

				if (!confirmed) {
					broadcastLog({
						text: `[Background]: Folder switch to "${targetFolderId}" cancelled by user or prompt failed.`,
						type: "info",
					});
				}
				return confirmed;
			}
		}
	} catch (e) {
		broadcastLog({
			text: `[Background]: Error during folder switch check: ${e.message}`,
			type: "error",
		});
		return false; // Fail safe: don't switch if we can't determine status or prompt
	}
	return true;
}

async function setLaunchingCache(folderId, playNewInstance) {
	if (playNewInstance || !folderId) return;
	const session = playbackManager.findSessionByFolderId(folderId);
	if (!session || !session.isPlaying) {
		const cacheData = {
			folderId,
			isRunning: true,
			isLaunching: true,
			timestamp: Date.now(),
		};
		await playbackManager.setPlaybackCache(cacheData);
		broadcastPlaybackState(folderId, { isLaunching: true, isRunning: true });
	}
}

async function _handlePlayLogic(context) {
    await playbackManager.initPromise;
    const { request, folderId, data } = context;
    const { urlItem, playNewInstance } = request;

    if (urlItem) {
        if (!playNewInstance && folderId && !(await checkAndConfirmFolderSwitch(folderId))) {
            return { success: true, message: "Folder switch cancelled by user." };
        }
        await setLaunchingCache(folderId, playNewInstance);

        const logText = `Received 'play' request for: ${urlItem.title || urlItem.url}${playNewInstance ? " (Unmanaged Instance)" : " (Managed Playback)"}`;
        broadcastLog({
            text: `[Background]: ${logText}`,
            type: "info",
            itemId: urlItem.id,
            folderId: folderId
        });

        const options = {
            playNewInstance: request.playNewInstance,
            playlistStartId: request.playlistStartId,
            geometry: request.geometry,
            customWidth: request.customWidth,
            customHeight: request.customHeight,
            customMpvFlags: request.customMpvFlags,
            startPaused: request.startPaused,
            clearOnCompletion: request.clearOnCompletion,
        };

        const response = await nativeLink.play(urlItem, folderId, options);

        if (response.success && !playNewInstance) {
            const { mpv_playback_cache: current } = await chrome.storage.local.get("mpv_playback_cache");
            if (current && current.folderId === folderId) {
                await playbackManager.setPlaybackCache({ ...current, isLaunching: false });
            }

            const session = playbackManager.getSession(folderId);
            session.isPlaying = true;

            let isLast = true;
            if (folderId && data.folders[folderId]) {
                const playlist = data.folders[folderId].playlist;
                if (playlist.length > 0) {
                    const lastItem = playlist[playlist.length - 1];
                    isLast = lastItem.id === urlItem.id;
                }
            }

            session.currentPlayingItem = {
                urlItem: urlItem,
                folderId: folderId,
                isLastInFolder: isLast,
            };
        } else if (!response.success && !playNewInstance && folderId) {
            await playbackManager.clearPlaybackCache();
            broadcastPlaybackState(folderId, { isLaunching: false, isRunning: false, isIdle: false });
        }
        return response;
    } else if (folderId) {
        const folder = data.folders[folderId];
        if (!folder || !folder.playlist || folder.playlist.length === 0) {
            return { success: false, error: `Playlist in folder "${folderId}" is empty.` };
        }

        return _handlePlayM3ULogic({
            action: "play_m3u",
            m3uData: { type: "items", value: folder.playlist },
            folderId: folderId,
            customMpvFlags: request.customMpvFlags,
            geometry: request.geometry,
            customWidth: request.customWidth,
            customHeight: request.customHeight,
            startPaused: request.startPaused,
            clearOnCompletion: request.clearOnCompletion,
            playNewInstance: playNewInstance,
        }, data);
    }
    return { success: false, error: "No URL item or Folder ID provided to play." };
}

export const handlePlay = createHandler(_handlePlayLogic, {
    manualPersistence: true,
    broadcastPlaylist: true,
    onError: async (error, { folderId }) => {
        if (folderId) {
            await playbackManager.clearPlaybackCache();
            broadcastPlaybackState(folderId, { isLaunching: false, isRunning: false, isIdle: false });
        }
    }
});

async function _handlePlayM3ULogic(request, data) {
    const { m3uData, playNewInstance, folderId } = request;

    if (!playNewInstance && folderId && !(await checkAndConfirmFolderSwitch(folderId))) {
        return { success: true, message: "Folder switch cancelled by user." };
    }
    await setLaunchingCache(folderId, playNewInstance);

    if (!playNewInstance) {
        const session = playbackManager.getSession(folderId);
        session.queue = [];
        if (session.folderId !== folderId || !session.isPlaying) {
            session.isPlaying = false;
            session.currentPlayingItem = null;
        }
        session.isProcessingQueue = false;
        playbackManager.persistSessions();
    }

    const options = {
        playNewInstance: request.playNewInstance,
        playlistStartId: request.playlistStartId,
        geometry: request.geometry,
        customWidth: request.customWidth,
        customHeight: request.customHeight,
        customMpvFlags: request.customMpvFlags,
        startPaused: request.startPaused,
        clearOnCompletion: request.clearOnCompletion,
    };
	const response = await nativeLink.playM3U(m3uData, folderId, options);

	if (response.success && !playNewInstance) {
		const { mpv_playback_cache: current } = await chrome.storage.local.get("mpv_playback_cache");
		if (current && current.folderId === folderId) {
			await playbackManager.setPlaybackCache({ ...current, isLaunching: false });
		}

		const session = playbackManager.getSession(folderId);
		session.isPlaying = true;
		session.currentPlayingItem = { folderId: folderId, isLastInFolder: true };

		if (response.playlistItems && folderId) {
			const freshData = await storage.get();
			const actualFolderId = getCanonicalFolderId(freshData, folderId);
			if (freshData.folders?.[actualFolderId]) {
				broadcastLog({
					text: `[Background]: Syncing Smart Resume reordering for folder '${actualFolderId}'.`,
					type: "info",
				});
				freshData.folders[actualFolderId].playlist = response.playlistItems;
				if (response.playlistItems.length > 0) {
					freshData.folders[actualFolderId].lastPlayedId = response.playlistItems[0].id;
				}
				await storage.set(freshData, actualFolderId);
				await broadcastPlaylistState(actualFolderId, response.playlistItems);
			}
		}

		const successMessage = (response.alreadyActive || response.handledDirectly)
			? null
			: response.message || `Playback initiated for playlist '${folderId}'.`;
		
		return {
			success: true,
			message: successMessage,
			playlistItems: response.playlistItems,
		};
	} else if (!response.success && !playNewInstance && folderId) {
		await playbackManager.clearPlaybackCache();
		broadcastPlaybackState(folderId, { isLaunching: false, isRunning: false, isIdle: false });
	}
    return response;
}

export const handlePlayM3U = createHandler(async (context) => {
    return _handlePlayM3ULogic(context.request, context.data);
}, {
	manualPersistence: true,
	broadcastPlaylist: true,
	onError: async (error, { folderId }) => {
		if (folderId) {
			await playbackManager.clearPlaybackCache();
			broadcastPlaybackState(folderId, { isLaunching: false, isRunning: false, isIdle: false });
		}
	}
});

export async function handleUpdateLastPlayed(data) {
	let { folderId, itemId, isPending } = data;
	if (!folderId || !itemId || itemId === -1 || itemId === "-1") return;

	if (!isPending) {
		const storageData = await storage.get();
		
		// Case-insensitive lookup for folder
		const actualFolderId = getCanonicalFolderId(storageData, folderId);

		broadcastLog({
			text: `[Background]: Tracker reported lastPlayedId update for folder '${actualFolderId}': ${itemId}`,
			type: "info",
			itemId: itemId,
			folderId: actualFolderId
		});

		if (storageData.folders[actualFolderId]) {
			storageData.folders[actualFolderId].lastPlayedId = itemId;
			
			// Mutually Exclusive currentlyPlaying update
			storageData.folders[actualFolderId].playlist.forEach(item => {
				item.currentlyPlaying = (item.id === itemId);
			});

			await storage.set(storageData, actualFolderId);

			const currentCache = (await chrome.storage.local.get("mpv_playback_cache")).mpv_playback_cache || {};
			if (currentCache.folderId?.toLowerCase() === folderId.toLowerCase()) {
				currentCache.isIdle = false;
				currentCache.isRunning = true;
				await playbackManager.setPlaybackCache(currentCache);
			}
			
			// Force sync to disk so shard reflects the change
			debouncedSyncToNativeHostFile(null, true);
		}
		
		await broadcastPlaylistState(actualFolderId, storageData.folders[actualFolderId]?.playlist);
	}
}

export async function handleUpdateItemResumeTime(data) {
	const { folderId, itemId, resumeTime, lastModified } = data;
	if (!folderId || !itemId || itemId === -1 || itemId === "-1") return;

	const storageData = await storage.get();
	const actualFolderId = getCanonicalFolderId(storageData, folderId);

	if (actualFolderId && storageData.folders?.[actualFolderId]) {
		const folder = storageData.folders[actualFolderId];
		const item = folder.playlist.find(i => i.id === itemId);
		
		if (item) {
			item.resumeTime = resumeTime;
			item.lastModified = lastModified || Date.now();
			
			const now = Date.now();
			const lastWrite = resumeTimeThrottles.get(itemId) || 0;

			// PERSISTENCE THROTTLE: Only write to storage/disk every 10 seconds
			if (now - lastWrite >= RESUME_TIME_WRITE_THROTTLE_MS) {
				resumeTimeThrottles.set(itemId, now);
				await storage.set(storageData, actualFolderId);
				debouncedSyncToNativeHostFile(actualFolderId, false);
			}
			
			// REAL-TIME BROADCAST: Always send lightweight delta for UI progress bars (if any)
			broadcastItemUpdate(actualFolderId, itemId, {
				resumeTime: item.resumeTime
			});
		}
	}
}

export async function handlePlaybackStatusChanged(data) {
	await playbackManager.initPromise;
	const { folderId, isPaused, isIdle, sessionIds, watchedIds, lastPlayedId } = data;
	if (!folderId) return;

	const storageData = await storage.get();
	const actualFolderId = getCanonicalFolderId(storageData, folderId);

	const cacheData = {
		folderId: actualFolderId,
		isRunning: true,
		isPaused: isPaused,
		isIdle: isIdle,
		lastPlayedId: lastPlayedId,
		watchedIds: watchedIds || [],
		sessionIds: sessionIds || [],
		isLaunching: false,
		timestamp: Date.now(),
	};

	await playbackManager.setPlaybackCache(cacheData);

	const session = playbackManager.getSession(actualFolderId);
	if (watchedIds && Array.isArray(watchedIds)) {
		watchedIds.forEach(id => session.watchedItemIds.add(id));
		playbackManager.persistSessions();
	}

	broadcastPlaybackState(actualFolderId);

	const folder = storageData.folders[actualFolderId];
	if (folder) {
		// Sync currently_playing flag to storage so it survives browser-to-python syncs
		if (lastPlayedId) {
			let changed = false;
			folder.playlist.forEach(item => {
				const isCurrent = item.id === lastPlayedId;
				if (item.currentlyPlaying !== isCurrent) {
					item.currentlyPlaying = isCurrent;
					item.lastModified = Date.now();
					changed = true;
				}
			});
			if (changed) {
				await storage.set(storageData, actualFolderId);
			}
		}
		await broadcastPlaylistState(actualFolderId, folder.playlist);
	}
}

export const handleUpdateItemMarkedAsWatched = createHandler(async (context) => {
	const { request, folderId, data } = context;
	if (folderId && data?.folders) {
		context.folderId = getCanonicalFolderId(data, folderId);
	}
	await handleUpdateItemMarkedAsWatchedInternal(request, { isNative: false });
	return { success: true, folderId: context.folderId };
}, {
	manualPersistence: true,
	syncToNative: true,
	syncImmediate: true,
	broadcastPlaylist: true
});

export async function handleUpdateItemMarkedAsWatchedInternal(data, options = {}) {
	const folderId = data.folderId ?? data.folder_id;
	const itemId = data.itemId ?? data.item_id;
	const markedAsWatched = data.markedAsWatched ?? data.marked_as_watched;
	const watched = data.watched;
	const lastModified = data.lastModified ?? data.last_modified;
	if (!folderId || !itemId || itemId === -1 || itemId === "-1") return;

	const storageData = await storage.get();
	const actualFolderId = getCanonicalFolderId(storageData, folderId);

	if (actualFolderId && storageData.folders?.[actualFolderId]) {
		const folder = storageData.folders[actualFolderId];
		for (const item of folder.playlist) {
			if (item.id === itemId) {
				if (markedAsWatched !== undefined) item.markedAsWatched = markedAsWatched;
				if (watched !== undefined) item.watched = watched;
				item.lastModified = lastModified || Date.now();
				
				// Manual persistence here is needed if we want it to work for BOTH 
				// the createHandler wrapper AND the raw native listener.
				await storage.set(storageData, actualFolderId);
				
				// SYNC TO NATIVE: Ensure the native tracker knows about the manual update
				// Guard: Only sync if the request DID NOT come from the native host itself
				if (!options.isNative) {
					nativeLink.updateItemMarkedAsWatched(actualFolderId, itemId, {
						markedAsWatched: item.markedAsWatched,
						watched: item.watched
					}).catch(e => console.warn("[PlaybackHandler] Failed to sync watch status to native:", e));
				}

				// DELTA UPDATE: Notify UI to update just this item
				broadcastItemUpdate(actualFolderId, itemId, {
					watched: item.watched,
					markedAsWatched: item.markedAsWatched
				});
				break;
			}
		}
	}
}

export const handlePlayNewInstance = createHandler(async ({ request, folderId }) => {
	const { urlItem } = request;
	if (!urlItem) return { success: false, error: "No URL item provided to play." };

	broadcastLog({
		text: `[Background]: Initiating unmanaged/detached session for: ${urlItem.title || urlItem.url}`,
		type: "info",
		itemId: urlItem.id,
		folderId: folderId
	});

	const storageData = await storage.get();
	const globalPrefs = storageData.settings.uiPreferences.global;
	const enrichedItem = nativeLink._injectItemSettings(urlItem, globalPrefs);

	const options = {
		playNewInstance: true,
		isUnmanaged: true,
		...buildPlaybackSettingsPayload(globalPrefs, request),
	};

	return nativeLink.call("play_new_instance", {
		urlItem: enrichedItem,
		folderId,
		...options
	});
}, {
	manualPersistence: true,
});

export const handleAppend = createHandler(async ({ request, folderId }) => {
	await playbackManager.initPromise;
	const { urlItem } = request;
	if (!urlItem) return { success: false, error: "No URL item provided to append." };

	const session = playbackManager.getSession(folderId);
	session.queue.push({
		urlItem: urlItem,
		folderId: folderId,
		isLastInFolder: false,
	});
	playbackManager.persistSessions();

	broadcastLog({
		text: `[Background]: Received 'queue' request for (${folderId}): ${urlItem.title || urlItem.url}`,
		type: "info",
		itemId: urlItem.id,
		folderId: folderId
	});

	session.processQueue();
	return {
		success: true,
		message: `Queued ${urlItem.title || urlItem.url} to playlist`,
	};
}, { 
	manualPersistence: true,
	requireFolder: true,
	broadcastPlaylist: true
});

export const handleIsMpvRunning = createHandler(async () => {
	const response = await nativeLink.isMpvRunning().catch(() => null);
	if (response && response.success !== false) {
		if (!response.isRunning) {
			await playbackManager.clearStalePlaybackState(null, { preserveRecentLaunch: true });
		}
		return response;
	}

	// Only fall back to local cache when the native host is unreachable and a launch is actively in flight
	const { mpv_playback_cache } = await chrome.storage.local.get("mpv_playback_cache");
	if (
		mpv_playback_cache?.folderId &&
		mpv_playback_cache.isLaunching &&
		typeof mpv_playback_cache.timestamp === "number" &&
		Date.now() - mpv_playback_cache.timestamp < 30000
	) {
		return {
			success: true,
			isRunning: true,
			folderId: mpv_playback_cache.folderId,
			isPaused: mpv_playback_cache.isPaused,
			lastPlayedId: mpv_playback_cache.lastPlayedId,
		};
	}
	return response || { success: false, isRunning: false };
}, {
	manualPersistence: true,
});

export const handleCloseMpv = createHandler(async ({ folderId, request }) => {
	const { mpv_playback_cache } = await chrome.storage.local.get("mpv_playback_cache");
	const targetFolderId = folderId || request?.folderId || mpv_playback_cache?.folderId;
	if (targetFolderId) {
		await broadcastPlaylistState(targetFolderId, null, "render_playlist");
	}
	return nativeLink.closeMpv(targetFolderId);
}, {
	manualPersistence: true,
});

export async function handleSessionRestored(request) {
	await playbackManager.initPromise;
	const result = request.wasStale !== undefined ? request : request.result;

	if (!result || (result.wasStale === undefined && result.folderId === undefined)) {
		broadcastLog({ text: `[Background]: No active session found to restore.`, type: "info" });
		const { cleared, folderIds } = await playbackManager.clearStalePlaybackState(null, {
			preserveRecentLaunch: true,
		});
		if (cleared) {
			for (const fid of folderIds) {
				await broadcastPlaybackState(fid, {
					isRunning: false,
					isClosing: false,
					isIdle: false,
					isLaunching: false,
				});
				broadcastToTabs({
					action: "render_playlist",
					folderId: fid,
					isFolderActive: false,
					isClosing: false,
				});
			}
		}
		return;
	}

	if (result.wasStale) {
		broadcastLog({ text: `[Background]: Detected stale MPV session for folder '${result.folderId}'.`, type: "info" });
		await handleMpvExited(result);
	} else {
		broadcastLog({ text: `[Background]: Re-establishing connection to active MPV session for folder '${result.folderId}'...`, type: "info" });

		const session = playbackManager.findSessionByFolderId(result.folderId) || playbackManager.getSession(result.folderId);
		session.queue = [];
		session.isPlaying = true;
		session.isProcessingQueue = false;
		session.currentPlayingItem = { folderId: session.folderId, isLastInFolder: true };
		playbackManager.persistSessions();

		const { mpv_playback_cache: storageCache } = await chrome.storage.local.get("mpv_playback_cache");
		const existingCache = playbackManager.syncCache || storageCache;
		const response = result;

		const cacheData = {
			folderId: result.folderId,
			isRunning: true,
			isPaused:
				response.isPaused !== undefined
					? Boolean(response.isPaused)
					: Boolean(existingCache?.isPaused),
			isIdle:
				response.isIdle !== undefined
					? Boolean(response.isIdle)
					: Boolean(existingCache?.isIdle),
			lastPlayedId: result.lastPlayedId ?? existingCache?.lastPlayedId,
			sessionIds: (result.playlist || []).map(i => i.id).filter(Boolean),
			isLaunching: false,
			timestamp: Date.now(),
		};
		await playbackManager.setPlaybackCache(cacheData);

		const storageData = await storage.get();
		const rawFolderId = result.folderId;
		const folderId = getCanonicalFolderId(storageData, rawFolderId);
		const folder = storageData.folders?.[folderId];

		if (!folder) {
			broadcastLog({ text: `[Background]: Restoration rejected. Folder '${folderId}' not found in browser storage.`, type: "warning" });
			return;
		}

		broadcastLog({ text: `Reconnected to mpv playlist (${folder.name || folderId})`, type: "info" });

		let needsSave = false;
		if (result.lastPlayedId && result.lastPlayedId !== folder.lastPlayedId) {
			folder.lastPlayedId = result.lastPlayedId;
			needsSave = true;
		}

		if (result.playlist && Array.isArray(result.playlist)) {
			const diskPlaylistMap = new Map(result.playlist.map((item) => [item.id, item]));
			folder.playlist.forEach((item) => {
				const diskItem = diskPlaylistMap.get(item.id);
				if (diskItem && diskItem.resumeTime !== undefined && item.resumeTime !== diskItem.resumeTime) {
					item.resumeTime = diskItem.resumeTime;
					needsSave = true;
				}
			});
		}

		if (needsSave) await storage.set(storageData, folderId);
		await broadcastPlaylistState(folderId, folder.playlist);
	}
}
