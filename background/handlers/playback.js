import {
	addNativeListener,
} from "../../utils/nativeConnection.module.js";
import { nativeLink } from "../../utils/nativeLink.js";
import { normalizeYouTubeUrl } from "../../utils/commUtils.module.js";
import { debouncedSyncToNativeHostFile } from "../core_services.js";
import { broadcastLog, broadcastToTabs } from "../messaging.js";
import { storage } from "../storage_instance.js";
import { createHandler } from "../handler_factory.js";
import { playbackManager } from "../playback_manager.js";
import { 
	broadcastPlaylistState, 
	broadcastPlaybackState, 
	broadcastItemUpdate,
	getVisualPlaybackState, 
	isFolderActive 
} from "../ui_broadcaster.js";

const MPV_PLAYLIST_COMPLETED_EXIT_CODE = 99;
const RESUME_TIME_WRITE_THROTTLE_MS = 10000;
const resumeTimeThrottles = new Map();

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

	console.log(`[PlaybackHandler] Health changed for folder '${folderId}': ${health}`);

	// Update the global playback state bucket
	const { active_playback_state: pbState } = await chrome.storage.local.get("active_playback_state");
	if (pbState && pbState.folderId === folderId) {
		pbState.health = health;
		
		// If health is dead, we should also mark it as not running to trigger UI reset
		if (health === "dead") {
			pbState.isRunning = false;
		}
		
		await chrome.storage.local.set({ active_playback_state: pbState });
		
		// Broadcast the new state to all tabs
		broadcastPlaybackState(folderId, { health });
	}
}

export async function handleItemNaturalCompletion(data) {
	const { folderId, itemId } = data;
	if (!folderId || !itemId) return;

	const storageData = await storage.get();
	const folder = storageData.folders[folderId];
	if (!folder) return;

	const item = folder.playlist.find(i => i.id === itemId);
	if (!item) {
		console.debug(`[Background]: Item ${itemId} finished but is no longer in playlist '${folderId}'. Ignoring.`);
		return;
	}

	const globalPrefs = storageData.settings.uiPreferences.global;
	const clearMode = globalPrefs.clearOnCompletion || "no";
	
	if (globalPrefs.clearOnItemFinish && clearMode !== "no") {
		const session = playbackManager.getSession(folderId);
		session.completedItemIds.add(itemId);
		
		// Flag this folder so handleMpvExited knows a batch clear is already being managed
		playbackManager.earlyClearsInProgress.add(folderId);

		const itemTitle = item.title || item.url || itemId;

		if (clearMode === "yes") {
			// Mode: "yes" -> Clear immediately and silently
			broadcastLog({
				text: `[Background]: Item "${itemTitle}" finished. Auto-clearing from '${folderId}'.`,
				type: "info",
				itemId: itemId,
				folderId: folderId
			});
			
			// DIRECTIONAL CLEAR: Clear this item + any PREVIOUS items that are marked as watched.
			// This prevents 'ahead of me' bugs by only looking backwards in the list.
			const finishedItemIndex = folder.playlist.findIndex(i => i.id === itemId);
			const allToClearRaw = folder.playlist
				.filter((i, idx) => {
					const isTarget = i.id === itemId;
					const isPreviousWatched = idx < finishedItemIndex && (i.watched || i.markedAsWatched);
					const isSessionWatched = idx < finishedItemIndex && session.watchedItemIds.has(i.id);
					return isTarget || isPreviousWatched || isSessionWatched;
				})
				.map(i => i.id);

			const allToClear = await filterActiveItem(folderId, allToClearRaw, itemId);

			await clearFolderPlaylist(folderId, {
				playedIds: allToClear,
				scope: "played",
			});
			// Still remove from session set just in case
			session.completedItemIds.delete(itemId);
			session.watchedItemIds.delete(itemId);
		} else if (clearMode === "confirm") {
			// Mode: "confirm" -> Visual clear nice + Stacked popup
			broadcastLog({
				text: `[Background]: Item "${itemTitle}" finished. Staging for batch clear.`,
				type: "info",
				itemId: itemId,
				folderId: folderId
			});

			// 1. Refresh UI to hide the completed items visually
			await broadcastPlaylistState(folderId);

			// 2. Trigger/update the stacked confirmation
			const [activeTab] = await chrome.tabs.query({
				active: true,
				currentWindow: true,
			});
			
			if (activeTab) {
				const finishedItemIndex = folder.playlist.findIndex(i => i.id === itemId);
				const existingIds = new Set(folder.playlist.map(i => i.id));
				
				// DIRECTIONAL LIST: completed items + any PREVIOUS items marked as watched
				const targetIdsRaw = folder.playlist
					.filter((i, idx) => {
						const isCompleted = session.completedItemIds.has(i.id) || i.id === itemId;
						const isPreviousWatched = idx < finishedItemIndex && (i.watched || i.markedAsWatched || session.watchedItemIds.has(i.id));
						return isCompleted || isPreviousWatched;
					})
					.map(i => i.id);

				const targetList = await filterActiveItem(folderId, targetIdsRaw, itemId);

				if (targetList.length === 0) {
					console.debug(`[Background]: No items in completion stack remain in playlist for '${folderId}'. Skipping prompt.`);
					return;
				}

				const titles = targetList.map(id => {
					const item = folder.playlist.find(i => i.id === id);
					return item ? (item.title || item.url) : id;
				});

				// PERSISTENCE: Save to session so it can be re-triggered if tab navigates
				session.pendingClear = {
					folderId,
					playedIds: targetList,
					sessionIds: targetList,
					scope: "played",
					titles: titles
				};

				chrome.tabs
					.sendMessage(activeTab.id, {
						action: "show_clear_confirmation",
						folderId: folderId,
						playedIds: targetList,
						sessionIds: targetList,
						scope: "played",
						count: targetList.length,
						titles: titles
					})
					.catch(() => {});
			}
		}
	}
}

export async function handleMpvQuitting(data) {
	const { folderId, isNaturalCompletion, playedIds, watchedIds, sessionIds } = data;
	broadcastLog({
		text: `[Background]: MPV shutdown sequence started for '${folderId}'.`,
		type: "info",
	});

	broadcastPlaybackState(folderId, { isClosing: true, isRunning: true });
	await broadcastPlaylistState(folderId, null, "render_playlist");

	// --- Early Clear/Confirm Logic ---
	if (isNaturalCompletion && folderId) {
		const storageData = await storage.get();
		const folder = storageData.folders[folderId];
		
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
				text: `[Background]: Completion detected for '${folderId}'. (Full: ${isFullFolderComplete}). Mode: ${clearMode}.`,
				type: "info",
			});
			playbackManager.earlyClearsInProgress.add(folderId);

			if (clearMode === "yes") {
				// DIRECTIONAL: Only clear what finished + its predecessors
				const finishedIdSet = new Set(playedIds || []);
				let maxFinishedIndex = -1;
				folder.playlist.forEach((item, idx) => {
					if (finishedIdSet.has(item.id)) maxFinishedIndex = idx;
				});

				const finishedIds = folder.playlist
					.filter((i, idx) => {
						const isFinished = finishedIdSet.has(i.id);
						const isPreviousWatched = idx < maxFinishedIndex && (i.watched || i.markedAsWatched);
						return isFinished || isPreviousWatched;
					})
					.map(i => i.id);

				const mergedPlayedIds = await filterActiveItem(folderId, finishedIds);

				await clearFolderPlaylist(folderId, {
					playedIds: mergedPlayedIds,
					sessionIds,
					scope: clearScope,
				});
			} else if (clearMode === "confirm") {
				const [activeTab] = await chrome.tabs.query({
					active: true,
					currentWindow: true,
				});
				if (activeTab) {
					// Identify target IDs based on scope, but only if they still exist in the playlist
					const existingIds = new Set(folder.playlist.map(i => i.id));
					
					// DIRECTIONAL: Find the max index that reached EOF
					const finishedIdSet = new Set(playedIds || []);
					let maxFinishedIndex = -1;
					folder.playlist.forEach((item, idx) => {
						if (finishedIdSet.has(item.id)) maxFinishedIndex = idx;
					});

					const finishedIds = folder.playlist
						.filter((i, idx) => {
							const isFinished = finishedIdSet.has(i.id);
							const isPreviousWatched = idx < maxFinishedIndex && (i.watched || i.markedAsWatched);
							return isFinished || isPreviousWatched;
						})
						.map(i => i.id);

					const targetIdsRaw = (clearScope === "all" ? Array.from(existingIds) : finishedIds)
						.filter(id => existingIds.has(id));
					
					const ignoreId = finishedIds.length > 0 ? finishedIds[finishedIds.length - 1] : null;
					const targetIds = await filterActiveItem(folderId, targetIdsRaw, ignoreId);

					if (targetIds.length === 0) {
						console.debug(`[Background]: No items from scope '${clearScope}' remain in playlist for '${folderId}'. Skipping prompt.`);
						return;
					}

				const titles = targetIds.map(id => {
					const item = folder.playlist.find(i => i.id === id);
					return item ? (item.title || item.url) : id;
				});

				// PERSISTENCE: Save to session
				const session = playbackManager.getSession(folderId);
				session.pendingClear = {
					folderId,
					playedIds: targetIds,
					sessionIds: targetIds,
					scope: clearScope,
					titles: titles,
					isQuitting: true
				};

				if (activeTab) {
					chrome.tabs
						.sendMessage(activeTab.id, {
							action: "show_clear_confirmation",
							folderId: folderId,
							playedIds: targetIds, // Pass filtered list
							sessionIds: targetIds, // Pass filtered list
							scope: clearScope,
							count: targetIds.length,
							titles: titles,
							isQuitting: true
						})
						.catch(() => {});
				}
				}
			}
		}
	}
}

export async function handleMpvExited(data) {
	const { folderId, returnCode, reason, playedIds, sessionIds } = data;
	if (!folderId) return;

	// Check if this folder was already handled by the early quitting logic
	const wasEarlyHandled = playbackManager.earlyClearsInProgress.has(folderId);
	playbackManager.earlyClearsInProgress.delete(folderId); // Cleanup for next session

	// 1. Immediate UI Reset
	broadcastPlaybackState(folderId, { isRunning: false, isClosing: false, isIdle: false });

	broadcastToTabs({
		action: "render_playlist",
		folderId: folderId,
		isFolderActive: false,
		isClosing: false,
	});

	// Clear cache on exit
	await chrome.storage.local.remove("mpv_playback_cache");
	playbackManager.syncCache = null;

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

	const session = playbackManager.findSessionByFolderId(folderId);
	if (session) {
		session.isPlaying = false;
		session.queue = []; // Clear pending items if the player closed
	}

	// Only attempt to clear if it wasn't already handled early AND it looks like a natural completion
	if (!wasEarlyHandled) {
		const storageData = await storage.get();
		const folder = storageData.folders[folderId];

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
					text: `[Background]: Auto-clearing session items for '${folderId}' (Full: ${isFullFolderComplete}).`,
					type: "info",
				});

				const watchedInStorage = folder.playlist.filter(i => i.watched || i.markedAsWatched).map(i => i.id);
				const rawMergedPlayedIds = Array.from(new Set([...(playedIds || []), ...watchedInStorage]));
				const mergedPlayedIds = await filterActiveItem(folderId, rawMergedPlayedIds);

				await clearFolderPlaylist(folderId, {
					playedIds: mergedPlayedIds,
					sessionIds,
					scope: clearScope,
				});
			} else if (clearMode === "confirm") {
				broadcastLog({
					text: `[Background]: Requesting confirmation to clear items for '${folderId}'.`,
					type: "info",
				});
				const [activeTab] = await chrome.tabs.query({
					active: true,
					currentWindow: true,
				});
				if (activeTab) {
					// Identify target IDs based on scope, but only if they still exist in the playlist
					const existingIds = new Set(folder.playlist.map(i => i.id));

					// Merge storage-watched items into the session-watched list for the "played" scope
					const watchedInStorage = folder.playlist.filter(i => i.watched || i.markedAsWatched).map(i => i.id);
					const mergedPlayedIds = Array.from(new Set([...(playedIds || []), ...watchedInStorage]));

					const rawTargetIds = clearScope === "all" 
						? folder.playlist.map(i => i.id) 
						: (clearScope === "session" ? sessionIds : mergedPlayedIds);
					
					const filteredTargetIds = (rawTargetIds || []).filter(id => existingIds.has(id));
					const targetIds = await filterActiveItem(folderId, filteredTargetIds);

					if (targetIds.length === 0) {
						console.debug(`[Background]: No items from scope '${clearScope}' remain in playlist for '${folderId}'. Skipping prompt.`);
						return;
					}

					const titles = targetIds.map(id => {
						const item = folder.playlist.find(i => i.id === id);
						return item ? (item.title || item.url) : id;
					});

					// PERSISTENCE: Save to session
					if (session) {
						session.pendingClear = {
							folderId,
							playedIds: targetIds,
							sessionIds: targetIds,
							scope: clearScope,
							titles: titles,
							isQuitting: true
						};
					}

					if (activeTab) {
						chrome.tabs
							.sendMessage(activeTab.id, {
								action: "show_clear_confirmation",
								folderId: folderId,
								playedIds: targetIds, // Pass filtered list
								sessionIds: targetIds, // Pass filtered list
								scope: clearScope,
								count: targetIds.length,
								titles: titles,
								isQuitting: true
							})
							.catch(() => {});
					}
				}
			}
		} else if (isNaturalCompletion === false && (storageData?.settings?.uiPreferences?.global?.clearOnCompletion || "no") !== "no") {
			broadcastLog({
				text: `[Background]: MPV exited with code ${returnCode}. Playlist will not be cleared (requires natural completion).`,
				type: "info",
			});
		}
	} else {
		console.debug(`[Background]: Cleanup for '${folderId}' already triggered during quitting phase.`);
	}

	// Cleanup the session from manager if it's finished
	if (session && session.queue.length === 0 && !session.pendingClear) {
		playbackManager.cleanupSession(folderId);
	}

	// ALWAYS broadcast a refresh to all tabs after an exit to ensure UI state (like active highlight) is updated.
	await broadcastPlaylistState(folderId);
}

async function clearFolderPlaylist(folderId, options = {}) {
	const { playedIds, sessionIds, scope = "all" } = options;
	const storageData = await storage.get();

	if (storageData.folders[folderId]) {
		const folder = storageData.folders[folderId];
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
				text: `[Background]: Removed ${removedCount} item(s) from '${folderId}' based on clear scope '${scope}'.`,
				type: "info",
			});

			const { mpv_playback_cache: playbackCache } = await chrome.storage.local.get("mpv_playback_cache");
			
			// --- Local Live Removal (Mimic X-click) ---
			// If the current folder is active in MPV, remove the items from the player too.
			if (storageData.settings.uiPreferences.global.liveRemoval !== false && 
				playbackCache && playbackCache.folderId === folderId && (playbackCache.isRunning || !playbackCache.isIdle)) {
				
				// Re-identify IDs that were removed based on the original scope
				let idsToRemoveLive = [];
				if (scope === "played") idsToRemoveLive = playedIds;
				else if (scope === "session") idsToRemoveLive = sessionIds;
				else if (scope === "all") idsToRemoveLive = []; // Handle all case if needed, but usually natural completion handles it

				if (idsToRemoveLive && idsToRemoveLive.length > 0) {
					for (const rId of idsToRemoveLive) {
						try {
							await nativeLink.call("remove_item_live", {
								folderId: folderId,
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
					if (fId === folderId) continue;

					const itemsToRemoveFromThisFolder = otherFolder.playlist.filter(
						(item) => removedUrls.has(normalizeYouTubeUrl(item.url))
					);
					
					if (itemsToRemoveFromThisFolder.length > 0) {
						otherFolder.playlist = otherFolder.playlist.filter(
							(item) => !removedUrls.has(normalizeYouTubeUrl(item.url))
						);
						affectedFolders.add(fId);

						// Handle live removal for synchronized folders if they are active
						const { mpv_playback_cache: playbackCache } = await chrome.storage.local.get("mpv_playback_cache");
						if (storageData.settings.uiPreferences.global.syncGlobalRemovalsLive === true && 
							playbackCache && playbackCache.folderId === fId && (playbackCache.isRunning || !playbackCache.isIdle)) {
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
				await storage.set(storageData, folderId);
			}
			
			debouncedSyncToNativeHostFile(null, true);
			await broadcastPlaylistState(folderId, folder.playlist);
			return true;
		}
	}
	return false;
}

export const handleClearPlaylistConfirmation = createHandler(async ({ request }) => {
	const folderId = request.folderId;
	if (!folderId) return { success: false };

	const playedIds = request.playedIds; // Handled by normalization
	const sessionIds = request.sessionIds;
	const scope = request.scope;

	// CLEAR PERSISTENCE
	const session = playbackManager.findSessionByFolderId(folderId);
	if (session) {
		session.pendingClear = null;
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
		const session = playbackManager.findSessionByFolderId(folderId);
		if (session) {
			const confirmedIds = new Set(filteredPlayedIds);
			for (const id of session.completedItemIds) {
				if (confirmedIds.has(id)) {
					session.completedItemIds.delete(id);
				}
			}
		}
	} else {
		broadcastLog({
			text: `[Background]: User declined clearing playlist for '${folderId}'. Items restored.`,
			type: "info",
		});

		// RESTORE items to UI if cancelled
		const session = playbackManager.findSessionByFolderId(folderId);
		if (session) {
			session.completedItemIds.clear();
			session.pendingClear = null;
			await broadcastPlaylistState(folderId);
		}
		// Critical: Remove from early clears so next completion isn't blocked
		playbackManager.earlyClearsInProgress.delete(folderId);
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
		if (statusResponse.folderId === targetFolderId) return true;

		// Determine currently playing folder from native host or local state fallback
		const currentFolderId = statusResponse.folderId;

		if (currentFolderId && currentFolderId !== targetFolderId) {
			const data = await storage.get();
			const shouldConfirm =
				data.settings.uiPreferences.global.confirmFolderSwitch ?? true;

			if (shouldConfirm) {
				broadcastLog({
					text: `[Background]: Prompting user for folder switch from "${currentFolderId}" to "${targetFolderId}".`,
					type: "info",
				});

				const confirmationPayload = {
					action: "show_popup_confirmation",
					message: `MPV is currently playing folder "${currentFolderId}". Switch to "${targetFolderId}"?`,
				};

				// 1. Try sending to popup first
				let response = await _sendMessageAsync(confirmationPayload);

				// 2. Fallback to active tab if popup didn't respond
				if (response === null) {
					broadcastLog({
						text: `[Background]: Popup not available for confirmation. Falling back to active tab.`,
						type: "info",
					});
					const tabs = await new Promise((resolve) =>
						chrome.tabs.query({ active: true, currentWindow: true }, resolve),
					);
					const activeTab = tabs && tabs.length > 0 ? tabs[0] : null;

					if (activeTab?.id) {
						// Change action name for content script
						confirmationPayload.action = "show_confirmation";
						response = await new Promise((resolve) => {
							chrome.tabs.sendMessage(
								activeTab.id,
								confirmationPayload,
								(res) => {
									if (chrome.runtime.lastError) resolve(null);
									else resolve(res);
								},
							);
						});
					} else {
						// If we can't find an active tab to prompt, but we are on a restricted page,
						// it's better to proceed than to be stuck.
						broadcastLog({
							text: `[Background]: Could not prompt for folder switch (restricted page). Proceeding with playback.`,
							type: "warning",
						});
						return true;
					}
				}

				const confirmed = !!response?.confirmed;
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

// Internal helper for background-to-popup/tab messaging
const _sendMessageAsync = (payload) =>
	new Promise((resolve) => {
		chrome.runtime.sendMessage(payload, (response) => {
			if (chrome.runtime.lastError) resolve(null);
			else resolve(response);
		});
	});

async function _handlePlayLogic(context) {
    const { request, folderId, data } = context;
    const { urlItem, playNewInstance } = request;

    if (urlItem) {
        if (!playNewInstance && folderId && !(await checkAndConfirmFolderSwitch(folderId))) {
            return { success: true, message: "Folder switch cancelled by user." };
        }

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
                await chrome.storage.local.set({
                    mpv_playback_cache: { ...current, isLaunching: false }
                });
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
    broadcastPlaylist: true,
    onBefore: async ({ request, folderId }) => {
        if (!request.playNewInstance && folderId) {
            const session = playbackManager.findSessionByFolderId(folderId);
            if (!session || !session.isPlaying) {
                const cacheData = {
                    folderId,
                    isRunning: true,
                    isLaunching: true,
                    timestamp: Date.now(),
                };
                await chrome.storage.local.set({ mpv_playback_cache: cacheData });
                broadcastPlaybackState(folderId, { isLaunching: true, isRunning: true });
            }
        }
    },
    onError: async (error, { folderId }) => {
        if (folderId) {
            await chrome.storage.local.remove("mpv_playback_cache");
            broadcastPlaybackState(folderId, { isLaunching: false, isRunning: false, isIdle: false });
        }
    }
});

async function _handlePlayM3ULogic(request, data) {
    const { m3uData, playNewInstance, folderId } = request;

    if (!playNewInstance && folderId && !(await checkAndConfirmFolderSwitch(folderId))) {
        return { success: true, message: "Folder switch cancelled by user." };
    }

    if (!playNewInstance) {
        const session = playbackManager.getSession(folderId);
        session.queue = [];
        if (session.folderId !== folderId || !session.isPlaying) {
            session.isPlaying = false;
            session.currentPlayingItem = null;
        }
        session.isProcessingQueue = false;
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
			await chrome.storage.local.set({
				mpv_playback_cache: { ...current, isLaunching: false }
			});
		}

		const session = playbackManager.getSession(folderId);
		session.isPlaying = true;
		session.currentPlayingItem = { folderId: folderId, isLastInFolder: true };

		if (response.playlistItems && folderId && data.folders[folderId]) {
			broadcastLog({
				text: `[Background]: Syncing Smart Resume reordering for folder '${folderId}'.`,
				type: "info",
			});
			data.folders[folderId].playlist = response.playlistItems;
			if (response.playlistItems.length > 0) {
				data.folders[folderId].lastPlayedId = response.playlistItems[0].id;
			}
			await broadcastPlaylistState(folderId, response.playlistItems);
		}

		const successMessage = (response.alreadyActive || response.handledDirectly)
			? null
			: response.message || `Playback initiated for playlist '${folderId}'.`;
		
		return {
			success: true,
			message: successMessage,
			playlistItems: response.playlistItems,
		};
	}
    return response;
}

export const handlePlayM3U = createHandler(async (context) => {
    return _handlePlayM3ULogic(context.request, context.data);
}, {
	broadcastPlaylist: true,
	onBefore: async ({ request, folderId }) => {
		if (!request.playNewInstance && folderId) {
			const session = playbackManager.findSessionByFolderId(folderId);
			if (!session || !session.isPlaying) {
				const cacheData = {
					folderId,
					isRunning: true,
					isLaunching: true,
					timestamp: Date.now(),
				};
				await chrome.storage.local.set({ mpv_playback_cache: cacheData });
				broadcastPlaybackState(folderId, { isLaunching: true, isRunning: true });
			}
		}
	},
	onError: async (error, { folderId }) => {
		if (folderId) {
			await chrome.storage.local.remove("mpv_playback_cache");
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
		const actualFolderId = Object.keys(storageData.folders).find(
			(id) => id.toLowerCase() === folderId.toLowerCase()
		) || folderId;

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
				await chrome.storage.local.set({ mpv_playback_cache: currentCache });
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
	const actualFolderId = Object.keys(storageData.folders).find(
		(id) => id.toLowerCase() === folderId.toLowerCase()
	);

	if (actualFolderId && storageData.folders[actualFolderId]) {
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
	const { folderId, isPaused, isIdle, sessionIds, watchedIds, lastPlayedId } = data;
	if (!folderId) return;

	const cacheData = {
		folderId,
		isRunning: true,
		isPaused: isPaused,
		isIdle: isIdle,
		lastPlayedId: lastPlayedId,
		watchedIds: watchedIds || [],
		sessionIds: sessionIds || [],
		isLaunching: false,
		timestamp: Date.now(),
	};

	await chrome.storage.local.set({ mpv_playback_cache: cacheData });
	playbackManager.syncCache = cacheData;

	const session = playbackManager.getSession(folderId);
	if (watchedIds && Array.isArray(watchedIds)) {
		watchedIds.forEach(id => session.watchedItemIds.add(id));
	}

	broadcastPlaybackState(folderId);

	const storageData = await storage.get();
	const folder = storageData.folders[folderId];
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
				await storage.set(storageData, folderId);
			}
		}
		await broadcastPlaylistState(folderId, folder.playlist);
	}
}

export const handleUpdateItemMarkedAsWatched = createHandler(async ({ request, folderId }) => {
	await handleUpdateItemMarkedAsWatchedInternal(request, { isNative: false });
	return { success: true };
}, {
	syncToNative: true,
	syncImmediate: true,
	broadcastPlaylist: true
});

export async function handleUpdateItemMarkedAsWatchedInternal(data, options = {}) {
	const { folderId, itemId, markedAsWatched, watched, lastModified } = data;
	if (!folderId || !itemId || itemId === -1 || itemId === "-1") return;

	const storageData = await storage.get();
	const actualFolderId = Object.keys(storageData.folders).find(
		(id) => id.toLowerCase() === folderId.toLowerCase()
	);

	if (actualFolderId && storageData.folders[actualFolderId]) {
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

	const options = {
		playNewInstance: true,
		isUnmanaged: true,
		geometry: request.geometry || (globalPrefs.launchGeometry === "custom" ? null : globalPrefs.launchGeometry),
		customWidth: request.customWidth || (globalPrefs.launchGeometry === "custom" ? globalPrefs.customGeometryWidth : null),
		customHeight: request.customHeight || (globalPrefs.launchGeometry === "custom" ? globalPrefs.customGeometryHeight : null),
		customMpvFlags: request.customMpvFlags || globalPrefs.customMpvFlags || "",
		automaticMpvFlags: globalPrefs.automaticMpvFlags || [],
		forceTerminal: globalPrefs.forceTerminal ?? false,
		startPaused: request.startPaused ?? false,
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
		enableDisplaySync: globalPrefs.enableDisplaySync ?? true,
		overrideDisplayFps: globalPrefs.overrideDisplayFps || "",
		ultraInterpolation: globalPrefs.ultraInterpolation || "oversample",
		ultraDeband: globalPrefs.ultraDeband ?? true,
		ultraFbo: globalPrefs.ultraFbo ?? true,
	};

	return nativeLink.call("play_new_instance", {
		urlItem,
		folderId,
		...options
	});
});

export const handleAppend = createHandler(async ({ request, folderId }) => {
	const { urlItem } = request;
	if (!urlItem) return { success: false, error: "No URL item provided to append." };

	const session = playbackManager.getSession(folderId);
	session.queue.push({
		urlItem: urlItem,
		folderId: folderId,
		isLastInFolder: false,
	});

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
	requireFolder: true,
	broadcastPlaylist: true
});

export const handleIsMpvRunning = createHandler(async () => {
	const { mpv_playback_cache } = await chrome.storage.local.get("mpv_playback_cache");
	if (mpv_playback_cache && mpv_playback_cache.folderId && !mpv_playback_cache.isIdle) {
		return { 
			success: true, 
			isRunning: true, 
			folderId: mpv_playback_cache.folderId,
			isPaused: mpv_playback_cache.isPaused,
			lastPlayedId: mpv_playback_cache.lastPlayedId
		};
	}
	return nativeLink.isMpvRunning();
});

export const handleCloseMpv = createHandler(async ({ folderId }) => {
	await broadcastPlaylistState(folderId, null, "render_playlist");
	return nativeLink.closeMpv(folderId);
});

export function getMpvPlaylistCompletedExitCode() {
	return MPV_PLAYLIST_COMPLETED_EXIT_CODE;
}

export function handleSessionRestored(request) {
	const result = request.wasStale !== undefined ? request : request.result;

	if (!result || (result.wasStale === undefined && result.folderId === undefined)) {
		broadcastLog({ text: `[Background]: No active session found to restore.`, type: "info" });
		return;
	}

	if (result.wasStale) {
		broadcastLog({ text: `[Background]: Detected stale MPV session for folder '${result.folderId}'.`, type: "info" });
		handleMpvExited(result);
	} else {
		broadcastLog({ text: `[Background]: Re-establishing connection to active MPV session for folder '${result.folderId}'...`, type: "info" });

		const session = playbackManager.getSession(result.folderId);
		session.queue = [];
		session.isPlaying = true;
		session.isProcessingQueue = false;
		session.currentPlayingItem = { folderId: result.folderId, isLastInFolder: true };

		const cacheData = {
			folderId: result.folderId,
			isRunning: true,
			isPaused: result.isPaused ?? false,
			isIdle: result.isIdle ?? false,
			lastPlayedId: result.lastPlayedId,
			sessionIds: (result.playlist || []).map(i => i.id).filter(Boolean),
			isLaunching: false,
			timestamp: Date.now(),
		};
		chrome.storage.local.set({ mpv_playback_cache: cacheData });
		playbackManager.syncCache = cacheData;

		storage.get().then((storageData) => {
			const folderId = result.folderId;
			const folder = storageData.folders[folderId];

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

			if (needsSave) storage.set(storageData, folderId);
			broadcastPlaylistState(folderId, folder.playlist);
		});
	}
}
