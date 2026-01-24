import {
	addNativeListener,
} from "../../utils/nativeConnection.module.js";
import { nativeLink } from "../../utils/nativeLink.js";
import { debouncedSyncToNativeHostFile } from "../core_services.js";
import { broadcastLog, broadcastToTabs } from "../messaging.js";
import { storage } from "../storage_instance.js";
import { createHandler } from "../handler_factory.js";
import { playbackManager } from "../playback_manager.js";
import { 
	broadcastPlaylistState, 
	broadcastPlaybackState, 
	getVisualPlaybackState, 
	isFolderActive 
} from "../ui_broadcaster.js";

const MPV_PLAYLIST_COMPLETED_EXIT_CODE = 99;

// Register listeners for unsolicited native host events
addNativeListener("mpv_exited", (data) => handleMpvExited(data));
addNativeListener("update_last_played", (data) => handleUpdateLastPlayed(data));
addNativeListener("update_item_resume_time", (data) =>
	handleUpdateItemResumeTime(data),
);
addNativeListener("update_item_marked_as_watched", (data) =>
	handleUpdateItemMarkedAsWatched(data),
);
addNativeListener("playback_status_changed", (data) =>
	handlePlaybackStatusChanged(data),
);
addNativeListener("item_natural_completion", (data) =>
	handleItemNaturalCompletion(data),
);
addNativeListener("mpv_quitting", (data) => handleMpvQuitting(data));
addNativeListener("session_restored", (data) => handleSessionRestored(data));

export async function handleItemNaturalCompletion(data) {
	const { folderId, itemId } = data;
	if (!folderId || !itemId) return;

	const storageData = await storage.get();
	const globalPrefs = storageData.settings.ui_preferences.global;
	const clearMode = globalPrefs.clear_on_completion || "no";
	
	if (globalPrefs.clear_on_item_finish && clearMode !== "no") {
		const session = playbackManager.getSession(folderId);
		session.completedItemIds.add(itemId);
		
		// Flag this folder so handleMpvExited knows a batch clear is already being managed
		playbackManager.earlyClearsInProgress.add(folderId);

		if (clearMode === "yes") {
			// Mode: "yes" -> Clear immediately and silently
			broadcastLog({
				text: `[Background]: Item '${itemId}' finished. Auto-clearing from '${folderId}'.`,
				type: "info",
			});
			await clearFolderPlaylist(folderId, {
				playedIds: [itemId],
				scope: "played",
			});
			// Still remove from session set just in case
			session.completedItemIds.delete(itemId);
		} else if (clearMode === "confirm") {
			// Mode: "confirm" -> Visual clear nice + Stacked popup
			broadcastLog({
				text: `[Background]: Item finished. Staging for batch clear (Items in stack: ${session.completedItemIds.size}).`,
				type: "info",
			});

			// 1. Refresh UI to hide the completed items visually
			await broadcastPlaylistState(folderId);

			// 2. Trigger/update the stacked confirmation
			const [activeTab] = await chrome.tabs.query({
				active: true,
				currentWindow: true,
			});
			
			if (activeTab) {
				const completedList = Array.from(session.completedItemIds);
				chrome.tabs
					.sendMessage(activeTab.id, {
						action: "show_clear_confirmation",
						folderId: folderId,
						playedIds: completedList,
						sessionIds: completedList,
						scope: "played",
						count: completedList.length
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
	
	broadcastPlaybackState(folderId, { isClosing: true, isRunning: false });

	await broadcastPlaylistState(folderId, null, "render_playlist");

	// --- Early Clear/Confirm Logic ---
	if (isNaturalCompletion && folderId) {
		const storageData = await storage.get();
		const folder = storageData.folders[folderId];
		
		if (!folder || !folder.playlist) return;

		// THE DECIDER: Use items that actually passed the threshold
		const watchedSet = new Set(watchedIds || playedIds || []);
		const folderIds = folder.playlist.map(i => i.id);
		
		// If everything currently in the folder was "watched" (not just touched), we clear all.
		const isFullFolderComplete = folderIds.length > 0 && folderIds.every(id => watchedSet.has(id));
		
		const globalPrefs = storageData.settings.ui_preferences.global;
		const clearMode = globalPrefs.clear_on_completion || "no";
		// Default to 'session' scope for natural completion if not a full clear
		const clearScope = isFullFolderComplete ? "all" : (globalPrefs.clear_scope || "session");

		if (clearMode !== "no") {
			broadcastLog({
				text: `[Background]: Completion detected for '${folderId}'. (Full: ${isFullFolderComplete}). Mode: ${clearMode}.`,
				type: "info",
			});
			playbackManager.earlyClearsInProgress.add(folderId);

			if (clearMode === "yes") {
				await clearFolderPlaylist(folderId, {
					playedIds,
					sessionIds,
					scope: clearScope,
				});
			} else if (clearMode === "confirm") {
				const [activeTab] = await chrome.tabs.query({
					active: true,
					currentWindow: true,
				});
				if (activeTab) {
					chrome.tabs
						.sendMessage(activeTab.id, {
							action: "show_clear_confirmation",
							folderId: folderId,
							playedIds,
							sessionIds,
							scope: clearScope,
						})
						.catch(() => {});
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
			const globalPrefs = storageData.settings.ui_preferences.global;
			const clearMode = globalPrefs.clear_on_completion || "no";
			
			const watchedSet = new Set(data.watchedIds || data.playedIds || []);
			const folderIds = folder.playlist.map(i => i.id);
			const isFullFolderComplete = folderIds.length > 0 && folderIds.every(id => watchedSet.has(id));
			const clearScope = isFullFolderComplete ? "all" : (globalPrefs.clear_scope || "session");

			if (clearMode === "yes") {
				broadcastLog({
					text: `[Background]: Auto-clearing session items for '${folderId}' (Full: ${isFullFolderComplete}).`,
					type: "info",
				});
				await clearFolderPlaylist(folderId, {
					playedIds,
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
					chrome.tabs
						.sendMessage(activeTab.id, {
							action: "show_clear_confirmation",
							folderId: folderId,
							playedIds,
							sessionIds,
							scope: clearScope,
						})
						.catch(() => {});
				}
			}
		} else if (isNaturalCompletion === false && (storageData?.settings?.ui_preferences?.global?.clear_on_completion || "no") !== "no") {
			broadcastLog({
				text: `[Background]: MPV exited with code ${returnCode}. Playlist will not be cleared (requires natural completion).`,
				type: "info",
			});
		}
	} else {
		console.debug(`[Background]: Cleanup for '${folderId}' already triggered during quitting phase.`);
	}

	// Cleanup the session from manager if it's finished
	if (session && session.queue.length === 0) {
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

		// Correctly handle the scope to avoid clearing the whole folder
		if (scope === "played" && Array.isArray(playedIds) && playedIds.length > 0) {
			const playedSet = new Set(playedIds);
			console.log(`[Background] clearFolderPlaylist: Removing ${playedIds.length} items from storage:`, playedIds);
			folder.playlist = folder.playlist.filter(
				(item) => !playedSet.has(item.id),
			);
		} else if (scope === "session" && Array.isArray(sessionIds) && sessionIds.length > 0) {
			const sessionSet = new Set(sessionIds);
			folder.playlist = folder.playlist.filter(
				(item) => !sessionSet.has(item.id),
			);
		} else if (scope === "all") {
			folder.playlist = [];
		} else {
			// If scope is unknown or IDs are missing, DO NOT clear everything.
			// This prevents accidental wiping of the whole playlist.
			console.warn(`[Background] clearFolderPlaylist: Aborted clear. Scope '${scope}' was requested but no valid IDs were provided.`);
			return false;
		}

		const removedCount = originalCount - folder.playlist.length;
		if (removedCount > 0) {
			broadcastLog({
				text: `[Background]: Removed ${removedCount} item(s) from '${folderId}' based on clear scope '${scope}'.`,
				type: "info",
			});
		}

		await storage.set(storageData, folderId);
		debouncedSyncToNativeHostFile(true);
		await broadcastPlaylistState(folderId, folder.playlist);
		return true;
	}
	return false;
}

export const handleClearPlaylistConfirmation = createHandler(async ({ request }) => {
	const folderId = request.folderId;
	if (!folderId) return { success: false };

	const playedIds = request.playedIds; // Handled by normalization
	const sessionIds = request.sessionIds;
	const scope = request.scope;

	if (request.confirmed) {
		const clearCount = playedIds?.length || 0;
		broadcastLog({
			text: `[Background]: Confirmed! Removing ${clearCount} item(s) from '${folderId}'.`,
			type: "info",
		});

		// PERMANENT DELETE only on confirm
		await clearFolderPlaylist(folderId, {
			playedIds,
			sessionIds,
			scope,
		});

		// Clear the staged list
		const session = playbackManager.findSessionByFolderId(folderId);
		if (session) {
			const confirmedIds = new Set(playedIds || []);
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
			await broadcastPlaylistState(folderId);
		}
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
			statusResponse?.success === false ||
			statusResponse?.is_running === false
		)
			return true;

		// If the target folder is already active in MPV, proceed.
		if (statusResponse.folderId === targetFolderId) return true;

		// Determine currently playing folder from native host or local state fallback
		const currentFolderId = statusResponse.folderId;

		if (currentFolderId && currentFolderId !== targetFolderId) {
			const data = await storage.get();
			const shouldConfirm =
				data.settings.ui_preferences.global.confirm_folder_switch ?? true;

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

export const handlePlay = createHandler(async ({ request, folderId, data }) => {
	const { url_item, play_new_instance } = request;

	if (url_item) {
		if (!play_new_instance && folderId && !(await checkAndConfirmFolderSwitch(folderId))) {
			return { success: true, message: "Folder switch cancelled by user." };
		}

		broadcastLog({
			text: `[Background]: Received 'play' request for single item: ${url_item.title || url_item.url}${play_new_instance ? " (New Instance)" : ""}`,
			type: "info",
		});

		const options = {
			play_new_instance: request.play_new_instance,
			geometry: request.geometry,
			custom_width: request.custom_width,
			custom_height: request.custom_height,
			custom_mpv_flags: request.custom_mpv_flags,
			start_paused: request.start_paused,
			clear_on_completion: request.clear_on_completion,
		};

		console.log("[BG] handlePlay: Calling nativeLink.play with folderId:", folderId);
		const response = await nativeLink.play(url_item, folderId, options);

		if (response.success && !play_new_instance) {
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
					isLast = lastItem.id === url_item.id;
				}
			}

			session.currentPlayingItem = {
				urlItem: url_item,
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

		return handlePlayM3U({
			action: "play_m3u",
			m3u_data: { type: "items", value: folder.playlist },
			folderId: folderId,
			custom_mpv_flags: request.custom_mpv_flags,
			geometry: request.geometry,
			custom_width: request.custom_width,
			custom_height: request.custom_height,
			start_paused: request.start_paused,
			clear_on_completion: request.clear_on_completion,
			play_new_instance: play_new_instance,
		});
	}
	return { success: false, error: "No URL item or Folder ID provided to play." };
}, {
	broadcastPlaylist: true,
	onBefore: async ({ request, folderId }) => {
		if (!request.play_new_instance && folderId) {
			const session = playbackManager.findSessionByFolderId(folderId);
			if (!session || !session.isPlaying) {
				const cacheData = {
					folderId,
					is_running: true,
					isLaunching: true,
					timestamp: Date.now(),
				};
				await chrome.storage.local.set({ mpv_playback_cache: cacheData });
				broadcastPlaybackState(folderId, { isLaunching: true, isRunning: true });
			}
		}
	}
});

export const handlePlayM3U = createHandler(async ({ request, folderId, data }) => {
	const { m3u_data, play_new_instance } = request;

	if (!play_new_instance && folderId && !(await checkAndConfirmFolderSwitch(folderId))) {
		return { success: true, message: "Folder switch cancelled by user." };
	}

	if (!play_new_instance) {
		const session = playbackManager.getSession(folderId);
		session.queue = [];
		if (session.folderId !== folderId || !session.isPlaying) {
			session.isPlaying = false;
			session.currentPlayingItem = null;
		}
		session.isProcessingQueue = false;
	}

	const options = {
		play_new_instance: request.play_new_instance,
		geometry: request.geometry,
		custom_width: request.custom_width,
		custom_height: request.custom_height,
		custom_mpv_flags: request.custom_mpv_flags,
		start_paused: request.start_paused,
		clear_on_completion: request.clear_on_completion,
	};

	const response = await nativeLink.playM3U(m3u_data, folderId, options);

	if (response.success && !play_new_instance) {
		const { mpv_playback_cache: current } = await chrome.storage.local.get("mpv_playback_cache");
		if (current && current.folderId === folderId) {
			await chrome.storage.local.set({
				mpv_playback_cache: { ...current, isLaunching: false }
			});
		}

		const session = playbackManager.getSession(folderId);
		session.isPlaying = true;
		session.currentPlayingItem = { folderId: folderId, isLastInFolder: true };

		if (response.playlist_items && folderId && data.folders[folderId]) {
			broadcastLog({
				text: `[Background]: Syncing Smart Resume reordering for folder '${folderId}'.`,
				type: "info",
			});
			data.folders[folderId].playlist = response.playlist_items;
			if (response.playlist_items.length > 0) {
				data.folders[folderId].last_played_id = response.playlist_items[0].id;
			}
			await broadcastPlaylistState(folderId, response.playlist_items);
		}

		const successMessage = (response.already_active || response.handled_directly)
			? null
			: response.message || `Playback initiated for playlist '${folderId}'.`;
		
		return {
			success: true,
			message: successMessage,
			playlist_items: response.playlist_items,
		};
	}
	return response;
}, {
	broadcastPlaylist: true,
	onBefore: async ({ request, folderId }) => {
		if (!request.play_new_instance && folderId) {
			const session = playbackManager.findSessionByFolderId(folderId);
			if (!session || !session.isPlaying) {
				const cacheData = {
					folderId,
					is_running: true,
					isLaunching: true,
					timestamp: Date.now(),
				};
				await chrome.storage.local.set({ mpv_playback_cache: cacheData });
				broadcastPlaybackState(folderId, { isLaunching: true, isRunning: true });
			}
		}
	}
});

export async function handleUpdateLastPlayed(data) {
	const { folderId, itemId, is_pending } = data;
	if (!folderId || !itemId || itemId === -1 || itemId === "-1") return;

	if (!is_pending) {
		broadcastLog({
			text: `[Background]: Tracker reported last_played_id update for folder '${folderId}': ${itemId}`,
			type: "info",
		});

		const storageData = await storage.get();
		if (storageData.folders[folderId]) {
			storageData.folders[folderId].last_played_id = itemId;
			await storage.set(storageData, folderId);

			const currentCache = (await chrome.storage.local.get("mpv_playback_cache")).mpv_playback_cache || {};
			if (currentCache.folderId === folderId) {
				currentCache.isIdle = false;
				currentCache.is_running = true;
				await chrome.storage.local.set({ mpv_playback_cache: currentCache });
			}
		}
	}

	const finalData = await storage.get();
	if (finalData.folders[folderId]) {
		await broadcastPlaylistState(folderId, finalData.folders[folderId].playlist);
	}
}

export async function handleUpdateItemResumeTime(data) {
	const { folderId, itemId, resumeTime } = data;
	if (!folderId || !itemId || itemId === -1 || itemId === "-1") return;

	const storageData = await storage.get();
	if (storageData.folders[folderId]) {
		const folder = storageData.folders[folderId];
		for (const item of folder.playlist) {
			if (item.id === itemId) {
				item.resume_time = resumeTime;
				await storage.set(storageData, folderId);
				break;
			}
		}
	}
}

export async function handlePlaybackStatusChanged(data) {
	const { folderId, isPaused, isIdle, sessionIds, lastPlayedId } = data;
	if (!folderId) return;

	const cacheData = {
		folderId,
		is_running: true, // If we got a status update, it's definitely running
		isPaused: isPaused,
		isIdle: isIdle,
		lastPlayedId: lastPlayedId,
		sessionIds: sessionIds || [],
		isLaunching: false, // Got a status update, so launch is finished
		timestamp: Date.now(),
	};

	await chrome.storage.local.set({ mpv_playback_cache: cacheData });
	playbackManager.syncCache = cacheData;

	broadcastPlaybackState(folderId);

	const storageData = await storage.get();
	const folder = storageData.folders[folderId];
	if (folder) {
		await broadcastPlaylistState(folderId, folder.playlist);
	}
}

export async function handleUpdateItemMarkedAsWatched(data) {
	const { folderId, itemId, markedAsWatched } = data;
	if (!folderId || !itemId || itemId === -1 || itemId === "-1") return;

	const storageData = await storage.get();
	if (storageData.folders[folderId]) {
		const folder = storageData.folders[folderId];
		for (const item of folder.playlist) {
			if (item.id === itemId) {
				item.marked_as_watched = markedAsWatched;
				await storage.set(storageData, folderId);
				await broadcastPlaylistState(folderId, folder.playlist);
				break;
			}
		}
	}
}

export const handleAppend = createHandler(async ({ request, folderId }) => {
	const { url_item } = request;
	if (!url_item) return { success: false, error: "No URL item provided to append." };

	const session = playbackManager.getSession(folderId);
	session.queue.push({
		urlItem: url_item,
		folderId: folderId,
		isLastInFolder: false,
	});

	broadcastLog({
		text: `[Background]: Received 'queue' request for (${folderId}): ${url_item.title || url_item.url}`,
		type: "info",
	});

	session.processQueue();
	return {
		success: true,
		message: `Queued ${url_item.title || url_item.url} to playlist`,
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
			is_running: true, 
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
			is_running: true,
			isPaused: false,
			isIdle: false,
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
			if (result.lastPlayedId && result.lastPlayedId !== folder.last_played_id) {
				folder.last_played_id = result.lastPlayedId;
				needsSave = true;
			}

			if (result.playlist && Array.isArray(result.playlist)) {
				const diskPlaylistMap = new Map(result.playlist.map((item) => [item.id, item]));
				folder.playlist.forEach((item) => {
					const diskItem = diskPlaylistMap.get(item.id);
					if (diskItem && diskItem.resume_time !== undefined && item.resume_time !== diskItem.resume_time) {
						item.resume_time = diskItem.resume_time;
						needsSave = true;
					}
				});
			}

			if (needsSave) storage.set(storageData, folderId);
			broadcastPlaylistState(folderId, folder.playlist);
		});
	}
}
