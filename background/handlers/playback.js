import {
	addNativeListener,
} from "../../utils/nativeConnection.js";
import { nativeLink } from "../../utils/nativeLink.js";
import { debouncedSyncToNativeHostFile } from "../core_services.js";
import { broadcastLog, broadcastToTabs } from "../messaging.js";
import { storage } from "../storage_instance.js";

const MPV_PLAYLIST_COMPLETED_EXIT_CODE = 99;

// Track folders that are already in the process of being cleared/confirmed 
// during the quitting phase to avoid redundant triggers when the process finally exits.
const earlyClearsInProgress = new Set();

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
addNativeListener("mpv_quitting", (data) => handleMpvQuitting(data));
addNativeListener("session_restored", (data) => handleSessionRestored(data));

class PlaybackSession {
	constructor(folderId) {
		this.folderId = folderId;
		this.queue = [];
		this.isPlaying = false;
		this.isProcessingQueue = false;
		this.currentPlayingItem = null; // { urlItem, folderId, isLastInFolder }
	}

	/**
	 * Sends a single URL item to the native host for playback.
	 */
	async _playSingleUrlItem(url_item, globalPrefs) {
		return nativeLink.play(url_item, this.folderId, {
			start_paused: false,
		});
	}

	/**
	 * Processes the playback queue for this session.
	 */
	async processQueue() {
		if (this.isProcessingQueue) return;
		this.isProcessingQueue = true;

		try {
			const data = await storage.get();
			const globalPrefs = data.settings.ui_preferences.global;

			while (this.queue.length > 0) {
				if (this.isPlaying) {
					// --- BATCH APPEND OPTIMIZATION ---
					// Take ALL currently queued items and send them in one single native host call.
					const batch = [...this.queue];
					const batchItems = batch.map((q) => q.urlItem);

					broadcastLog({
						text: `[Background]: Appending batch of ${batch.length} items to active session (${this.folderId})...`,
						type: "info",
					});

					try {
						const response = await nativeLink.append(batchItems, this.folderId);

						if (response.success) {
							// Successfully appended the entire batch
							this.queue.splice(0, batch.length);

							const lastBatchItem = batch[batch.length - 1];

							// If the queue is now empty, check if this is the final item in the FOLDER
							if (this.queue.length === 0) {
								const folder = data.folders[this.folderId];
								if (folder && folder.playlist && folder.playlist.length > 0) {
									lastBatchItem.isLastInFolder =
										folder.playlist[folder.playlist.length - 1].id ===
										lastBatchItem.urlItem.id;
								}
							}

							this.currentPlayingItem = lastBatchItem; // Track last item
							continue; // Queue might have grown while we were awaiting, so continue loop
						} else {
							// Append failed (likely MPV closed), fall through to start new session
							this.isPlaying = false;
						}
					} catch (e) {
						this.isPlaying = false;
					}
				}

				if (this.queue.length === 0) break;

				// Start a new session with the first item in the queue
				const nextItem = this.queue[0];
				const { urlItem } = nextItem;

				broadcastLog({
					text: `[Background]: Starting playback (${this.folderId}): ${urlItem.title || urlItem.url}`,
					type: "info",
				});
				try {
					const response = await this._playSingleUrlItem(urlItem, globalPrefs);
					if (!response.success) {
						throw new Error(
							response.error || "Failed to start playback session.",
						);
					}
					this.isPlaying = true;
					// No artificial delay needed here, as the next iteration will use the batch append logic
					this.queue.shift(); // Successfully started, remove from queue
					this.currentPlayingItem = nextItem;
				} catch (error) {
					broadcastLog({
						text: `[Background]: Error playing item: ${error.message}`,
						type: "error",
					});
					this.queue.shift(); // Remove failed item to prevent infinite loop
					this.isPlaying = false;
				}
			}

			if (this.queue.length === 0 && !this.isPlaying) {
				this.currentPlayingItem = null;
				broadcastLog({
					text: `[Background]: Playback queue for '${this.folderId}' finished.`,
					type: "info",
				});
			}
		} finally {
			this.isProcessingQueue = false;
		}
	}
}

class PlaybackManager {
	constructor() {
		this.sessions = new Map(); // folderId -> PlaybackSession
		this.syncCache = null; // Synchronous copy of mpv_playback_cache
		this._initFromCache();
	}

	async _initFromCache() {
		try {
			const { mpv_playback_cache } = await chrome.storage.local.get(
				"mpv_playback_cache",
			);
			if (mpv_playback_cache) {
				this.syncCache = mpv_playback_cache;
				if (mpv_playback_cache.folderId) {
					// Optimistically create a session if we think one was running
					const session = this.getSession(mpv_playback_cache.folderId);
					session.isPlaying = true;
					console.log(
						`[BG] PlaybackManager: Initialized optimistic session for '${mpv_playback_cache.folderId}' from cache.`,
					);
				}
			}
		} catch (e) {}
	}

	getSession(folderId) {
		if (!this.sessions.has(folderId)) {
			this.sessions.set(folderId, new PlaybackSession(folderId));
		}
		const session = this.sessions.get(folderId);

		// Proactive check: If we think we are not playing, but cache says otherwise, trust the cache.
		// Use syncCache for immediate (synchronous) check to avoid race conditions in handleAppend.
		if (!session.isPlaying && this.syncCache) {
			if (
				this.syncCache.folderId === folderId &&
				(this.syncCache.isRunning || this.syncCache.is_running !== false) &&
				!this.syncCache.isIdle
			) {
				session.isPlaying = true;
				console.log(
					`[BG] PlaybackManager: Updated session '${folderId}' to isPlaying=true from synchronous cache check.`,
				);
			}
		}

		return session;
	}

	cleanupSession(folderId) {
		this.sessions.delete(folderId);
	}

	findSessionByFolderId(folderId) {
		return this.sessions.get(folderId);
	}
}

export const playbackManager = new PlaybackManager();

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
					is_running: mpv_playback_cache.is_running !== false,
					is_paused: mpv_playback_cache.isPaused,
					sessionIds: mpv_playback_cache.sessionIds,
					lastPlayedId: mpv_playback_cache.lastPlayedId,
					folderId: mpv_playback_cache.folderId,
				};
			}
		}

		if (!finalStatus)
			return { isActive: false, isPaused: false, needsAppend: false };

		// Robust Active check: 
		// If (Process is running OR background manager has an active session) AND folder matches
		const isProcessRunning = !!(finalStatus.isRunning || finalStatus.is_running);
		const isManagerActive = isFolderActive(folderId);
		
		let isActive = (isProcessRunning || isManagerActive) && (finalStatus.folderId === folderId || !finalStatus.folderId);
		
		const isPaused =
			(finalStatus.isPaused || finalStatus.is_paused || finalStatus.isIdle || finalStatus.is_idle) ?? false;
		let needsAppend = false;
		const lastPlayedId = finalStatus.lastPlayedId;

		if (isActive && finalStatus.sessionIds && playlist) {
			const sessionIds = new Set(finalStatus.sessionIds);
			needsAppend = playlist.some((item) => !sessionIds.has(item.id));
		}

		return { isActive, isPaused, needsAppend, lastPlayedId };
	} catch (e) {
		return { isActive: false, isPaused: false, needsAppend: false };
	}
}

/**
 * Checks if a specific folder is currently active in MPV.
 * @param {string} folderId The ID of the folder to check.
 * @returns {boolean} True if the folder is active and playing.
 */
export function isFolderActive(folderId) {
	const session = playbackManager.findSessionByFolderId(folderId);
	return !!(session && session.isPlaying);
}

export async function handleMpvQuitting(data) {
	const { folderId, isNaturalCompletion, playedIds, sessionIds } = data;
	broadcastLog({
		text: `[Background]: MPV shutdown sequence started for '${folderId}'.`,
		type: "info",
	});
	
	broadcastPlaybackState(folderId, { isClosing: true, isRunning: false });

	broadcastToTabs({
		action: "render_playlist",
		folderId: folderId,
		isClosing: true,
	});

	// --- Early Clear/Confirm Logic ---
	if (isNaturalCompletion && folderId) {
		const session = playbackManager.findSessionByFolderId(folderId);
		const storageData = await storage.get();
		const folder = storageData.folders[folderId];
		
		if (!folder || !folder.playlist) return;

		// VERIFICATION SYSTEM: Ensure we are actually at the end of the ENTIRE list
		const sessionSet = new Set(sessionIds || []);
		const isLastItemInSession = folder.playlist.length > 0 && 
			sessionSet.has(folder.playlist[folder.playlist.length - 1].id);
		
		// Only proceed if the intent was the last item AND the reality matches
		const isActuallyComplete = isLastItemInSession && (session?.currentPlayingItem?.isLastInFolder ?? true);

		if (!isActuallyComplete) {
			broadcastLog({
				text: `[Background]: Natural completion ignored for '${folderId}'. Entire list was not played.`,
				type: "info",
			});
			return;
		}

		const globalPrefs = storageData.settings.ui_preferences.global;
		const clearMode = globalPrefs.clear_on_completion || "no";
		const clearScope = globalPrefs.clear_scope || "all";

		if (clearMode !== "no") {
			broadcastLog({
				text: `[Background]: Early completion detected for '${folderId}'. Triggering ${clearMode} logic.`,
				type: "info",
			});
			earlyClearsInProgress.add(folderId);

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
	const wasEarlyHandled = earlyClearsInProgress.has(folderId);
	earlyClearsInProgress.delete(folderId); // Cleanup for next session

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
	}

	const storageData = await storage.get();
	const globalPrefs = storageData.settings.ui_preferences.global;
	const clearMode = globalPrefs.clear_on_completion || "no";
	const clearScope = globalPrefs.clear_scope || "all";

	// Only attempt to clear if it wasn't already handled early AND it looks like a natural completion
	if (!wasEarlyHandled) {
		const session = playbackManager.findSessionByFolderId(folderId);
		const storageData = await storage.get();
		const folder = storageData.folders[folderId];

		// MPV_PLAYLIST_COMPLETED_EXIT_CODE (99) indicates natural playlist completion via custom script.
		const isNaturalCompletion = returnCode === MPV_PLAYLIST_COMPLETED_EXIT_CODE;

		if (isNaturalCompletion) {
			broadcastLog({
				text: `[Background]: Playlist for folder '${folderId}' finished naturally (Exit Code 99).`,
				type: "info",
			});

			if (folder && folder.playlist) {
				const sessionSet = new Set(sessionIds || []);
				const isLastItemInSession = folder.playlist.length > 0 && 
					sessionSet.has(folder.playlist[folder.playlist.length - 1].id);
				
				// Verification: Did we intend to finish the list, and did we actually reach the end?
				const isActuallyComplete = isLastItemInSession && (session?.currentPlayingItem?.isLastInFolder ?? true);

				if (!isActuallyComplete) {
					broadcastLog({
						text: `[Background]: Natural completion (99) ignored for '${folderId}'. Entire list was not played.`,
						type: "info",
					});
					return;
				}
			}
		}

		if (
			isNaturalCompletion &&
			session &&
			session.currentPlayingItem &&
			session.currentPlayingItem.folderId === folderId &&
			session.currentPlayingItem.isLastInFolder
		) {
			if (clearMode === "yes") {
				broadcastLog({
					text: `[Background]: Auto-clearing items for '${folderId}' (Scope: ${clearScope}).`,
					type: "info",
				});
				await clearFolderPlaylist(folderId, {
					playedIds,
					sessionIds,
					scope: clearScope,
				});
			} else if (clearMode === "confirm") {
				broadcastLog({
					text: `[Background]: Requesting confirmation to clear playlist for '${folderId}'.`,
					type: "info",
				});
				// Send a message to the active tab to show a confirmation dialog
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
		} else if (isNaturalCompletion === false && clearMode !== "no") {
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
	const finalData = await storage.get();
	const folder = finalData.folders[folderId] || { playlist: [] };
	broadcastToTabs({
		action: "render_playlist",
		folderId: folderId,
		playlist: folder.playlist,
		lastPlayedId: folder.last_played_id,
		isFolderActive: false,
	});
}

async function clearFolderPlaylist(folderId, options = {}) {
	const { playedIds, sessionIds, scope = "all" } = options;
	const storageData = await storage.get();

	if (storageData.folders[folderId]) {
		const folder = storageData.folders[folderId];
		const originalCount = folder.playlist.length;

		if (scope === "played" && playedIds && playedIds.length > 0) {
			const playedSet = new Set(playedIds);
			folder.playlist = folder.playlist.filter(
				(item) => !playedSet.has(item.id),
			);
		} else if (scope === "session" && sessionIds && sessionIds.length > 0) {
			const sessionSet = new Set(sessionIds);
			folder.playlist = folder.playlist.filter(
				(item) => !sessionSet.has(item.id),
			);
		} else {
			// Default 'all' behavior (or fallback if IDs missing)
			folder.playlist = [];
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
		broadcastToTabs({
			action: "render_playlist",
			folderId: folderId,
			playlist: folder.playlist,
			isFolderActive: false,
		});
		return true;
	}
	return false;
}

export async function handleClearPlaylistConfirmation(request) {
	if (request.confirmed && request.folderId) {
		broadcastLog({
			text: `[Background]: User confirmed clearing playlist for '${request.folderId}'.`,
			type: "info",
		});
		await clearFolderPlaylist(request.folderId, {
			playedIds: request.playedIds,
			sessionIds: request.sessionIds,
			scope: request.scope,
		});
		return { success: true };
	}
	broadcastLog({
		text: `[Background]: User declined clearing playlist for '${request.folderId}'.`,
		type: "info",
	});
	return { success: true };
}

export async function handleIsMpvRunning() {
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
}

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

export async function handlePlay(request) {
	const {
		url_item,
		folderId,
		play_new_instance,
	} = request;

	if (url_item) {
		// Single item play logic remains similar but uses the session manager
		if (
			!play_new_instance &&
			folderId &&
			!(await checkAndConfirmFolderSwitch(folderId))
		) {
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

		if (!play_new_instance && folderId) {
			const session = playbackManager.findSessionByFolderId(folderId);
			const isAlreadyActive = session && session.isPlaying;

			if (!isAlreadyActive) {
				// Update cache to show loading state instantly (Incremental)
				const { mpv_playback_cache: existing } = await chrome.storage.local.get("mpv_playback_cache");
				await chrome.storage.local.set({
					mpv_playback_cache: {
						...(existing || {}),
						folderId,
						is_running: true,
						isLaunching: true,
						timestamp: Date.now(),
					},
				});
			}
		}

		const response = await nativeLink.play(url_item, folderId, options);

		if (response.success && !play_new_instance) {
			// Proactively clear launching state once command is accepted
			const { mpv_playback_cache: current } = await chrome.storage.local.get("mpv_playback_cache");
			if (current && current.folderId === folderId) {
				await chrome.storage.local.set({
					mpv_playback_cache: { ...current, isLaunching: false }
				});
			}

			const session = playbackManager.getSession(folderId);
			session.isPlaying = true;

			// Smart Detection: Is this actually the last item in the folder?
			const data = await storage.get();
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
		const data = await storage.get();
		const folder = data.folders[folderId];
		if (!folder || !folder.playlist || folder.playlist.length === 0) {
			return {
				success: false,
				error: `Playlist in folder "${folderId}" is empty.`,
			};
		}

		// Delegate to handlePlayM3U for folder playback
		return handlePlayM3U({
			m3u_data: {
				type: "items",
				value: folder.playlist,
			},
			folderId: folderId,
			custom_mpv_flags: request.custom_mpv_flags,
			geometry: request.geometry,
			custom_width: request.custom_width,
			custom_height: request.custom_height,
			start_paused: request.start_paused,
			clear_on_completion: request.clear_on_completion,
			play_new_instance: play_new_instance,
		});
	} else {
		return {
			success: false,
			error: "No URL item or Folder ID provided to play.",
		};
	}
}

export async function handlePlayM3U(request) {
	const {
		m3u_data,
		folderId,
		play_new_instance,
	} = request;

	if (
		!play_new_instance &&
		folderId &&
		!(await checkAndConfirmFolderSwitch(folderId))
	) {
		return { success: true, message: "Folder switch cancelled by user." };
	}

	// Managed sessions only: reset queue and playback state
	if (!play_new_instance) {
		const session = playbackManager.getSession(folderId);
		session.queue = [];
		// Only reset playing state if we are switching folders or starting fresh
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

	if (!play_new_instance && folderId) {
		const session = playbackManager.findSessionByFolderId(folderId);
		const isAlreadyActive = session && session.isPlaying;

		if (!isAlreadyActive) {
			// Update cache to show loading state instantly (Incremental)
			const { mpv_playback_cache: existing } = await chrome.storage.local.get("mpv_playback_cache");
						await chrome.storage.local.set({
							mpv_playback_cache: {
								...(existing || {}),
								folderId,
								is_running: true,
								isLaunching: true,
								timestamp: Date.now(),
							},
						});		}
	}

	const response = await nativeLink.playM3U(m3u_data, folderId, options);

	if (response.success && !play_new_instance) {
		// Proactively clear launching state once command is accepted
		const { mpv_playback_cache: current } = await chrome.storage.local.get("mpv_playback_cache");
		if (current && current.folderId === folderId) {
			await chrome.storage.local.set({
				mpv_playback_cache: { ...current, isLaunching: false }
			});
		}

		const session = playbackManager.getSession(folderId);
		session.isPlaying = true;
		session.currentPlayingItem = { folderId: folderId, isLastInFolder: true }; // Mark as playing this folder

		// --- Smart Resume Sync ---
		if (response.playlist_items && folderId) {
			broadcastLog({
				text: `[Background]: Syncing Smart Resume reordering for folder '${folderId}'.`,
				type: "info",
			});
			const storageData = await storage.get();
			if (storageData.folders[folderId]) {
				storageData.folders[folderId].playlist = response.playlist_items;
				// We also update the last_played_id immediately if it was returned
				if (response.playlist_items.length > 0) {
					storageData.folders[folderId].last_played_id =
						response.playlist_items[0].id;
				}
				await storage.set(storageData, folderId);
				broadcastToTabs({
					action: "render_playlist",
					folderId: folderId,
					playlist: response.playlist_items,
				});
			}
		}

		const successMessage = (response.already_active || response.handled_directly)
			? null
			: response.message || `Playback initiated for playlist '${folderId}'.`;
		return {
			success: true,
			message: successMessage,
			playlist_items: response.playlist_items,
		};
	} else {
		return response;
	}
}

/**
 * Handles the 'update_last_played' message from the native host tracker.
 */
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

			// Also update playback cache for instant render consistency
			const currentCache =
				(await chrome.storage.local.get("mpv_playback_cache"))
					.mpv_playback_cache || {};
			if (currentCache.folderId === folderId) {
				currentCache.isIdle = false;
				currentCache.is_running = true;
				await chrome.storage.local.set({ mpv_playback_cache: currentCache });
			}
		}
	}

	const finalData = await storage.get();
	if (finalData.folders[folderId]) {
		// Calculate full visual state for a complete broadcast
		const {
			isActive,
			isPaused,
			needsAppend,
			lastPlayedId,
		} = await getVisualPlaybackState(folderId, finalData.folders[folderId].playlist);

		// Broadcast the update so the UI highlights the new item immediately
		broadcastToTabs({
			action: "render_playlist",
			folderId: folderId,
			playlist: finalData.folders[folderId].playlist,
			lastPlayedId: lastPlayedId || itemId,
			isFolderActive: isActive,
			isPaused: isPaused,
			needsAppend: needsAppend,
		});
	}
}

/**
 * Handles the 'update_item_resume_time' message from the native host tracker.
 */
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

/**
 * Broadcasts a lightweight playback state update to all UI components.
 */
export async function broadcastPlaybackState(folderId, statusOverride = {}) {
	const { mpv_playback_cache: storageCache } = await chrome.storage.local.get("mpv_playback_cache");
	const mpv_playback_cache = storageCache || playbackManager.syncCache;
	
	const targetFolderId = folderId || mpv_playback_cache?.folderId;
	if (!targetFolderId) return;

	const isActive = isFolderActive(targetFolderId);
	const cacheIsActive = !!(mpv_playback_cache && mpv_playback_cache.is_running !== false && mpv_playback_cache.folderId === targetFolderId);
	
	let needsAppend = false;
	if (isActive || cacheIsActive) {
		const storageData = await storage.get();
		const folder = storageData.folders[targetFolderId];
		const sessionIds = mpv_playback_cache?.sessionIds;
		
		if (folder && folder.playlist && sessionIds) {
			const sessionSet = new Set(sessionIds);
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

/**
 * Handles 'playback_status_changed' from the native host tracker.
 * Caches the state in storage for instant UI access.
 */
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

	// Cache in local storage for instant popup access
	await chrome.storage.local.set({ mpv_playback_cache: cacheData });
	playbackManager.syncCache = cacheData;

	// 1. Lightweight status sync
	broadcastPlaybackState(folderId);

	// 2. Heavy data sync (Playlist render)
	const storageData = await storage.get();
	const folder = storageData.folders[folderId];
	if (folder) {
		const {
			isActive,
			isPaused: vPaused,
			needsAppend,
			lastPlayedId: vLastPlayedId,
		} = await getVisualPlaybackState(folderId, folder.playlist);

		broadcastToTabs({
			action: "render_playlist",
			folderId: folderId,
			playlist: folder.playlist,
			lastPlayedId: vLastPlayedId || folder.last_played_id,
			isFolderActive: isActive,
			isPaused: vPaused,
			needsAppend: needsAppend,
		});
	}
}

/**
 * Handles the 'update_item_marked_as_watched' message from the native host tracker.
 */
export async function handleUpdateItemMarkedAsWatched(data) {
	const { folderId, itemId, markedAsWatched } = data;
	if (!folderId || !itemId || itemId === -1 || itemId === "-1") return;

	const storageData = await storage.get();
	if (storageData.folders[folderId]) {
		const folder = storageData.folders[folderId];
		for (const item of folder.playlist) {
			if (item.id === itemId) {
				item.url = item.url; // No-op to trigger change detection if needed? No, just keep consistency.
				item.marked_as_watched = markedAsWatched;
				await storage.set(storageData, folderId);

				// Broadcast update so all UI instances refresh (Tabs + Popup)
				const {
					isActive,
					isPaused,
					needsAppend,
					lastPlayedId,
				} = await getVisualPlaybackState(folderId, folder.playlist);

				broadcastToTabs({
					action: "render_playlist",
					folderId: folderId,
					playlist: folder.playlist,
					lastPlayedId: lastPlayedId || folder.last_played_id,
					isFolderActive: isActive,
					isPaused: isPaused,
					needsAppend: needsAppend,
				});
				break;
			}
		}
	}
}

export async function handleAppend(request) {
	const { url_item, folderId } = request;
	if (!url_item) {
		return { success: false, error: "No URL item provided to append." };
	}

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

	session.processQueue(); // Process the queue to append the item
	return {
		success: true,
		message: `Queued ${url_item.title || url_item.url} to playlist`,
	};
}

export async function handleCloseMpv(request) {
	const folderId = request?.folderId;
	// Immediate UI feedback
	broadcastToTabs({
		action: "render_playlist",
		folderId: folderId,
		isClosing: true,
	});
	return nativeLink.closeMpv(folderId);
}

export function getMpvPlaylistCompletedExitCode() {
	return MPV_PLAYLIST_COMPLETED_EXIT_CODE;
}

export function handleSessionRestored(request) {
	// The Python 'success' responder flattens dicts into the top level.
	// After translation, the keys will be camelCased.
	const result = request.wasStale !== undefined ? request : request.result;

	if (!result || (result.wasStale === undefined && result.folderId === undefined)) {
		broadcastLog({
			text: `[Background]: No active session found to restore.`,
			type: "info",
		});
		return;
	}

	if (result.wasStale) {
		broadcastLog({
			text: `[Background]: Detected stale MPV session for folder '${result.folderId}'.`,
			type: "info",
		});
		// Trigger the same cleanup logic as when MPV exits.
		handleMpvExited(result);
	} else {
		broadcastLog({
			text: `[Background]: Re-establishing connection to active MPV session for folder '${result.folderId}'...`,
			type: "info",
		});

		const session = playbackManager.getSession(result.folderId);
		session.queue = [];
		session.isPlaying = true;
		session.isProcessingQueue = false;
		session.currentPlayingItem = {
			folderId: result.folderId,
			isLastInFolder: true,
		};

		// Proactively update cache for restoration
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

		// Notify UI to show active highlight and provide feedback
		storage.get().then((storageData) => {
			const folderId = result.folderId;
			const folder = storageData.folders[folderId];

			if (!folder) {
				broadcastLog({
					text: `[Background]: Restoration rejected. Folder '${folderId}' not found in browser storage.`,
					type: "warning",
				});
				return;
			}

			const folderName = folder.name || folderId;
			broadcastLog({
				text: `Reconnected to mpv playlist (${folderName})`,
				type: "info",
			});

			const lastPlayedId = result.lastPlayedId || folder.last_played_id;
			let needsSave = false;

			// 1. Sync Last Played ID
			if (
				result.lastPlayedId &&
				result.lastPlayedId !== folder.last_played_id
			) {
				folder.last_played_id = result.lastPlayedId;
				needsSave = true;
			}

			// 2. Deep Sync Resume Times for all items
			if (result.playlist && Array.isArray(result.playlist)) {
				const diskPlaylistMap = new Map(
					result.playlist.map((item) => [item.id, item]),
				);

				folder.playlist.forEach((item) => {
					const diskItem = diskPlaylistMap.get(item.id);
					if (diskItem && diskItem.resume_time !== undefined) {
						if (item.resume_time !== diskItem.resume_time) {
							item.resume_time = diskItem.resume_time;
							needsSave = true;
						}
					}
				});
			}

			if (needsSave) {
				storage.set(storageData, folderId); // Save async
			}

			broadcastToTabs({
				action: "render_playlist",
				folderId: folderId,
				playlist: folder.playlist,
				lastPlayedId: lastPlayedId,
				isFolderActive: true,
				isClosing: false,
			});
		});
	}
}
