// background/playback_manager.js

import { storage } from "./storage_instance.js";
import { nativeLink } from "../utils/nativeLink.js";
import { broadcastLog } from "./messaging.js";
import { broadcastPlaylistState } from "./ui_broadcaster.js";

const SESSIONS_STORAGE_KEY = "mpv_playback_sessions";

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
			store.set({ [SESSIONS_STORAGE_KEY]: serialized }).catch(() => {});
		} catch (e) {
			console.debug("[PlaybackManager] Failed to persist sessions:", e);
		}
	}

	async _initFromCache() {
		try {
			const store = getSessionStorage();
			const [localRes, sessionRes] = await Promise.all([
				chrome.storage.local.get("mpv_playback_cache").catch(() => ({})),
				store ? store.get(SESSIONS_STORAGE_KEY).catch(() => ({})) : Promise.resolve({}),
			]);

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

	getSession(folderId) {
		if (!this.sessions.has(folderId)) {
			this.sessions.set(
				folderId,
				new PlaybackSession(folderId, () => this.persistSessions()),
			);
		}
		const session = this.sessions.get(folderId);

		if (!session.isPlaying && this.syncCache) {
			if (
				this.syncCache.folderId === folderId &&
				this.syncCache.isRunning !== false &&
				!this.syncCache.isIdle
			) {
				session.isPlaying = true;
			}
		}

		return session;
	}

	cleanupSession(folderId) {
		this.sessions.delete(folderId);
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
}

export const playbackManager = new PlaybackManager();
