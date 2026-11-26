// background/playback_manager.js

import { storage } from "./storage_instance.js";
import { nativeLink } from "../utils/nativeLink.js";
import { broadcastLog } from "./messaging.js";
import { broadcastPlaylistState } from "./ui_broadcaster.js";

const SESSIONS_STORAGE_KEY = "mpv_playback_sessions";
const EARLY_CLEARS_STORAGE_KEY = "mpv_early_clears_in_progress";

const getSessionStorage = () => {
	if (typeof chrome !== "undefined" && chrome?.storage?.session) {
		return chrome.storage.session;
	}
	return chrome?.storage?.local || null;
};

export class PlaybackSession {
	constructor(folderId, onChange = null) {
		this.folderId = folderId;
		this.queue = [];
		this.isPlaying = false;
		this.isProcessingQueue = false;
		this.currentPlayingItem = null; // { urlItem, folderId, isLastInFolder }
		this.completedItemIds = new Set();
		this.watchedItemIds = new Set();
		this.pendingClear = null; // { folderId, playedIds, sessionIds, scope, titles, isQuitting }
		this._onChange = onChange;
	}

	clearPlaylist() {
		this.queue = [];
		this.currentPlayingItem = null;
		this.isProcessingQueue = false;
		this._onChange?.();
	}

	/**
	 * Sends a single URL item to the native host for playback.
	 */
	async _playSingleUrlItem(urlItem, globalPrefs) {
		return nativeLink.play(urlItem, this.folderId, {
			startPaused: false,
			playlistStartId: urlItem.id,
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
			const globalPrefs = data.settings.uiPreferences.global;

			while (this.queue.length > 0) {
				if (this.isPlaying) {
					// --- BATCH APPEND OPTIMIZATION ---
					const batch = [...this.queue];
					const batchItems = batch.map((q) => q.urlItem);

					broadcastLog({
						text: `[Background]: Appending batch of ${batch.length} items to active session (${this.folderId})...`,
						type: "info",
					});

					try {
						const response = await nativeLink.append(batchItems, this.folderId);

						if (response.success) {
							this.queue.splice(0, batch.length);
							const lastBatchItem = batch[batch.length - 1];

							if (this.queue.length === 0) {
								const folder = data.folders[this.folderId];
								if (folder && folder.playlist && folder.playlist.length > 0) {
									lastBatchItem.isLastInFolder =
										folder.playlist[folder.playlist.length - 1].id ===
										lastBatchItem.urlItem.id;
								}
							}

							this.currentPlayingItem = lastBatchItem;
							this._onChange?.();
							// Notify UI immediately after successful append to clear "Needs Append" status
							broadcastPlaylistState(this.folderId).catch(() => {});
							continue;
						} else {
							this.isPlaying = false;
						}
					} catch (e) {
						this.isPlaying = false;
					}
				}

				if (this.queue.length === 0) break;

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
					this.queue.shift();
					this.currentPlayingItem = nextItem;
					this._onChange?.();
				} catch (error) {
					broadcastLog({
						text: `[Background]: Error playing item: ${error.message}`,
						type: "error",
					});
					this.queue.shift();
					this.isPlaying = false;
					this._onChange?.();
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
			this._onChange?.();
		}
	}
}

export class PlaybackManager {
	constructor() {
		this.sessions = new Map(); // folderId -> PlaybackSession
		this.syncCache = null; // Synchronous copy of mpv_playback_cache
		this.earlyClearsInProgress = new Set(); // Track folders being cleared during shutdown
		this.initPromise = this._initFromCache();
	}

	persistSessions() {
		try {
			const store = getSessionStorage();
			if (!store) return;
			const serialized = {};
			for (const [folderId, session] of this.sessions.entries()) {
				const hasQueue = Array.isArray(session.queue) && session.queue.length > 0;
				const hasCompleted = session.completedItemIds?.size > 0;
				const hasWatched = session.watchedItemIds?.size > 0;
				const hasPendingClear = Boolean(session.pendingClear);
				if (hasQueue || hasCompleted || hasWatched || hasPendingClear || session.isPlaying) {
					serialized[folderId] = {
						folderId: session.folderId,
						queue: hasQueue ? session.queue : [],
						completedItemIds: Array.from(session.completedItemIds || []),
						watchedItemIds: Array.from(session.watchedItemIds || []),
						pendingClear: session.pendingClear || null,
						isPlaying: Boolean(session.isPlaying),
						currentPlayingItem: session.currentPlayingItem || null,
					};
				}
			}
			store.set({
				[SESSIONS_STORAGE_KEY]: serialized,
				[EARLY_CLEARS_STORAGE_KEY]: Array.from(this.earlyClearsInProgress),
			}).catch(() => {});
		} catch (e) {
			console.debug("[PlaybackManager] Failed to persist sessions:", e);
		}
	}

	markEarlyClear(folderId) {
		if (!folderId) return;
		this.earlyClearsInProgress.add(folderId.toLowerCase());
		this.persistSessions();
	}

	clearEarlyClear(folderId) {
		if (!folderId) return;
		if (this.earlyClearsInProgress.delete(folderId.toLowerCase())) {
			this.persistSessions();
		}
	}

	hasEarlyClear(folderId) {
		if (!folderId) return false;
		return this.earlyClearsInProgress.has(folderId.toLowerCase());
	}

	async _initFromCache() {
		try {
			const store = getSessionStorage();
			const [localRes, sessionRes] = await Promise.all([
				chrome.storage.local.get("mpv_playback_cache").catch(() => ({})),
				store
					? store.get([SESSIONS_STORAGE_KEY, EARLY_CLEARS_STORAGE_KEY]).catch(() => ({}))
					: Promise.resolve({}),
			]);

			const savedEarlyClears = sessionRes?.[EARLY_CLEARS_STORAGE_KEY];
			if (Array.isArray(savedEarlyClears)) {
				for (const id of savedEarlyClears) {
					if (typeof id === "string" && id) {
						this.earlyClearsInProgress.add(id.toLowerCase());
					}
				}
			}

			const savedSessions = sessionRes?.[SESSIONS_STORAGE_KEY];
			if (savedSessions && typeof savedSessions === "object") {
				for (const [folderId, saved] of Object.entries(savedSessions)) {
					if (!saved || typeof saved !== "object") continue;
					const session = this.getSession(folderId);
					if (session.queue.length === 0 && Array.isArray(saved.queue) && saved.queue.length > 0) {
						session.queue = saved.queue;
					}
					if (Array.isArray(saved.completedItemIds)) {
						for (const id of saved.completedItemIds) {
							session.completedItemIds.add(id);
						}
					}
					if (Array.isArray(saved.watchedItemIds)) {
						for (const id of saved.watchedItemIds) {
							session.watchedItemIds.add(id);
						}
					}
					if (!session.pendingClear && saved.pendingClear) {
						session.pendingClear = saved.pendingClear;
					}
					if (!session.currentPlayingItem && saved.currentPlayingItem) {
						session.currentPlayingItem = saved.currentPlayingItem;
					}
					if (!session.isPlaying && saved.isPlaying) {
						session.isPlaying = true;
					}
					if (session.queue.length > 0 && !session.isProcessingQueue) {
						session.processQueue();
					}
				}
			}

			const mpv_playback_cache = localRes?.mpv_playback_cache;
			if (mpv_playback_cache) {
				this.syncCache = mpv_playback_cache;
				if (mpv_playback_cache.folderId) {
					const session = this.getSession(mpv_playback_cache.folderId);
					session.isPlaying = true;
				}
			}
		} catch (e) {
			console.debug("[PlaybackManager] Failed to init from cache:", e);
		}
	}

	async setPlaybackCache(cache) {
		this.syncCache = cache || null;
		if (chrome.storage?.local?.set) {
			await chrome.storage.local.set({ mpv_playback_cache: this.syncCache }).catch(() => {});
		}
	}

	async clearPlaybackCache() {
		this.syncCache = null;
		if (chrome.storage?.local?.remove) {
			await chrome.storage.local.remove("mpv_playback_cache").catch(() => {});
		}
	}

	getSession(folderId) {
		let session = this.findSessionByFolderId(folderId);
		if (!session) {
			session = new PlaybackSession(folderId, () => this.persistSessions());
			this.sessions.set(folderId, session);
		}

		if (!session.isPlaying && this.syncCache) {
			if (
				this.syncCache.folderId?.toLowerCase() === folderId?.toLowerCase() &&
				this.syncCache.isRunning !== false &&
				!this.syncCache.isIdle
			) {
				session.isPlaying = true;
			}
		}

		return session;
	}

	cleanupSession(folderId) {
		if (!folderId) return;
		if (this.sessions.has(folderId)) {
			this.sessions.delete(folderId);
		} else {
			const lower = folderId.toLowerCase();
			for (const key of this.sessions.keys()) {
				if (key.toLowerCase() === lower) {
					this.sessions.delete(key);
					break;
				}
			}
		}
		this.persistSessions();
	}

	findSessionByFolderId(folderId) {
		if (!folderId) return null;
		if (this.sessions.has(folderId)) return this.sessions.get(folderId);
		const lower = folderId.toLowerCase();
		for (const [key, session] of this.sessions.entries()) {
			if (key.toLowerCase() === lower) return session;
		}
		return null;
	}

	/**
	 * Reconciles and clears stale local playback state when the native host reports
	 * no live MPV session (e.g., after PC sleep/wake or missed mpv_exited events).
	 */
	async clearStalePlaybackState(targetFolderId = null, { preserveRecentLaunch = false } = {}) {
		await this.initPromise;
		const stored = chrome.storage?.local?.get
			? await chrome.storage.local
					.get(["mpv_playback_cache", "active_playback_state"])
					.catch(() => ({}))
			: {};
		const cache = stored?.mpv_playback_cache || this.syncCache;
		const pbState = stored?.active_playback_state || null;

		if (
			preserveRecentLaunch &&
			cache?.isLaunching &&
			typeof cache.timestamp === "number" &&
			Date.now() - cache.timestamp < 30000
		) {
			return { cleared: false, folderIds: [] };
		}

		const targetLower = targetFolderId ? targetFolderId.toLowerCase() : null;
		const affected = new Set();
		let didChange = false;

		for (const [key, session] of this.sessions.entries()) {
			if (targetLower && key.toLowerCase() !== targetLower) continue;
			if (session.isPlaying || session.currentPlayingItem) {
				session.isPlaying = false;
				session.currentPlayingItem = null;
				affected.add(key);
				didChange = true;
			}
		}
		if (didChange) {
			this.persistSessions();
		}

		if (cache && (!targetLower || cache.folderId?.toLowerCase() === targetLower)) {
			if (cache.folderId) affected.add(cache.folderId);
			this.syncCache = null;
			if (chrome.storage?.local?.remove) {
				await chrome.storage.local.remove("mpv_playback_cache").catch(() => {});
			}
			didChange = true;
		} else if (!targetLower && this.syncCache) {
			if (this.syncCache.folderId) affected.add(this.syncCache.folderId);
			this.syncCache = null;
			didChange = true;
		}

		if (
			pbState &&
			(pbState.isRunning || pbState.isLaunching) &&
			(!targetLower || pbState.folderId?.toLowerCase() === targetLower)
		) {
			if (pbState.folderId) affected.add(pbState.folderId);
			if (chrome.storage?.local?.set) {
				await chrome.storage.local
					.set({
						active_playback_state: {
							...pbState,
							isRunning: false,
							isLaunching: false,
							isPaused: false,
							isIdle: false,
							sessionIds: [],
						},
					})
					.catch(() => {});
			}
			didChange = true;
		}

		if (targetFolderId && didChange) {
			affected.add(targetFolderId);
		}

		return { cleared: didChange, folderIds: Array.from(affected) };
	}
}

export const playbackManager = new PlaybackManager();
