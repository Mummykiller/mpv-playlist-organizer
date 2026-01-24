// background/playback_manager.js

import { storage } from "./storage_instance.js";
import { nativeLink } from "../utils/nativeLink.js";
import { broadcastLog } from "./messaging.js";
import { broadcastPlaylistState } from "./ui_broadcaster.js";

export class PlaybackSession {
	constructor(folderId) {
		this.folderId = folderId;
		this.queue = [];
		this.isPlaying = false;
		this.isProcessingQueue = false;
		this.currentPlayingItem = null; // { urlItem, folderId, isLastInFolder }
		this.completedItemIds = new Set();
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
				} catch (error) {
					broadcastLog({
						text: `[Background]: Error playing item: ${error.message}`,
						type: "error",
					});
					this.queue.shift();
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

export class PlaybackManager {
	constructor() {
		this.sessions = new Map(); // folderId -> PlaybackSession
		this.syncCache = null; // Synchronous copy of mpv_playback_cache
		this.earlyClearsInProgress = new Set(); // Track folders being cleared during shutdown
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
					const session = this.getSession(mpv_playback_cache.folderId);
					session.isPlaying = true;
				}
			}
		} catch (e) {}
	}

	getSession(folderId) {
		if (!this.sessions.has(folderId)) {
			this.sessions.set(folderId, new PlaybackSession(folderId));
		}
		const session = this.sessions.get(folderId);

		if (!session.isPlaying && this.syncCache) {
			if (
				this.syncCache.folderId === folderId &&
				(this.syncCache.isRunning || this.syncCache.is_running !== false) &&
				!this.syncCache.isIdle
			) {
				session.isPlaying = true;
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
