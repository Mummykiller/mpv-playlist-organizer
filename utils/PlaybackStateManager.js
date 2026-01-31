/**
 * @class PlaybackStateManager
 * Unified Singleton Observable for MPV playback status.
 * Manages the transition between STOPPED, LOADING, PLAYING, and PAUSED.
 */
window.MPV_INTERNAL = window.MPV_INTERNAL || {};

(() => {
	const MPV = window.MPV_INTERNAL;

	const PlaybackStatus = {
		STOPPED: "stopped",
		LOADING: "loading",
		PLAYING: "playing",
		PAUSED: "paused",
	};

	class PlaybackStateManager {
		constructor() {
			this.state = {
				status: PlaybackStatus.STOPPED,
				folderId: null,
				lastPlayedId: null,
				isPaused: false,
				isIdle: false,
				isRunning: false,
				needsAppend: false,
				isClosing: false,
			};
			this.listeners = new Set();
			this._initStorageListener();
			this._loadInitialState();
		}

		async _loadInitialState() {
			const data = await chrome.storage.local.get("active_playback_state");
			if (data.active_playback_state) {
				this.update(data.active_playback_state);
			}
		}

		_initStorageListener() {
			// PROACTIVE: Listen to storage changes instead of broadcast messages
			chrome.storage.onChanged.addListener((changes, area) => {
				if (area === "local" && changes.active_playback_state) {
					this.update(changes.active_playback_state.newValue);
				}
			});

			// FALLBACK: Still keep message listener for legacy/direct triggers
			chrome.runtime.onMessage.addListener((msg) => {
				if (msg.action === "playback_state_changed") {
					this.update(msg.state);
				}
			});
		}

		/**
		 * Subscribes a callback to state changes.
		 * @param {Function} callback
		 * @returns {Function} Unsubscribe function
		 */
		subscribe(callback) {
			this.listeners.add(callback);
			// Immediate push of current state
			callback(this.state);
			return () => this.listeners.delete(callback);
		}

		notify() {
			const clonedState = JSON.parse(JSON.stringify(this.state));
			this.listeners.forEach((cb) => cb(clonedState));
		}

		/**
		 * Main logic to derive status from raw playback data.
		 */
		update(newData) {
			if (!newData) return;
			const oldStatus = this.state.status;
			
			// 1. Handle folder and ID tracking
			if (newData.folderId) this.state.folderId = newData.folderId;
			if (newData.lastPlayedId) this.state.lastPlayedId = newData.lastPlayedId;
			if (newData.needsAppend !== undefined) this.state.needsAppend = newData.needsAppend;
			if (newData.isClosing !== undefined) this.state.isClosing = newData.isClosing;

			// 2. Derive Status
			let isRunning = newData.isRunning ?? this.state.isRunning;
			const isPaused = newData.isPaused ?? this.state.isPaused;
			const isIdle = newData.isIdle ?? this.state.isIdle;

			// If the player is NOT running, we must clear the needsAppend state
			if (!isRunning) {
				this.state.needsAppend = false;
			}

			let newStatus = PlaybackStatus.STOPPED;

			if (isRunning) {
				if (isPaused) {
					newStatus = PlaybackStatus.PAUSED;
				} else if (isIdle) {
					if (oldStatus === PlaybackStatus.PLAYING || oldStatus === PlaybackStatus.LOADING || oldStatus === PlaybackStatus.PAUSED) {
						newStatus = oldStatus; 
					} else {
						newStatus = PlaybackStatus.LOADING;
					}
				} else {
					newStatus = PlaybackStatus.PLAYING;
				}
			}

			this.state.isRunning = isRunning;
			this.state.isPaused = isPaused;
			this.state.isIdle = isIdle;
			this.state.status = newStatus;

			this.notify();
		}

		/**
		 * Force transition to LOADING state when a play command is sent.
		 */
		setLoading(folderId) {
			this.state.status = PlaybackStatus.LOADING;
			this.state.isRunning = true;
			this.state.isIdle = true;
			this.state.isClosing = false;
			if (folderId) this.state.folderId = folderId;
			this.notify();
		}

		/**
		 * Requests an immediate state sync from the background script.
		 */
		async requestSync() {
			try {
				// Use the existing bridge or global sendMessage
				chrome.runtime.sendMessage({ action: "get_playback_status" }, (response) => {
					if (response) this.update(response);
				});
			} catch (e) {
				console.warn("[StateManager] Sync request failed:", e);
			}
		}
	}

	// Singleton instance
	MPV.playbackStateManager = new PlaybackStateManager();
	MPV.PlaybackStatus = PlaybackStatus;
})();
