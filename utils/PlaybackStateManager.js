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
			this._initGlobalListener();
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
			const oldStatus = this.state.status;
			
			// 1. Handle folder and ID tracking
			if (newData.folderId) this.state.folderId = newData.folderId;
			if (newData.lastPlayedId) this.state.lastPlayedId = newData.lastPlayedId;
			if (newData.needsAppend !== undefined) this.state.needsAppend = newData.needsAppend;
			if (newData.isClosing !== undefined) this.state.isClosing = newData.isClosing;

			// 2. Derive Status
			let newStatus = PlaybackStatus.STOPPED;
			const isRunning = newData.isRunning ?? this.state.isRunning;
			const isPaused = newData.isPaused ?? this.state.isPaused;
			const isIdle = newData.isIdle ?? this.state.isIdle;

			if (isRunning) {
				if (isPaused) {
					newStatus = PlaybackStatus.PAUSED;
				} else if (isIdle) {
					// Graceful Idle Transition:
					// If we were PLAYING or LOADING, don't drop to STOPPED during blips.
					// Stay in the existing high-level state until playback resumes or process dies.
					if (oldStatus === PlaybackStatus.PLAYING || oldStatus === PlaybackStatus.LOADING || oldStatus === PlaybackStatus.PAUSED) {
						newStatus = oldStatus; 
					} else {
						newStatus = PlaybackStatus.LOADING;
					}
				} else {
					newStatus = PlaybackStatus.PLAYING;
				}
			}

			// Special Guard: Ensure 'needsAppend' (Queue) triggers a UI state that allows the Queue button to show.
			// The button logic usually looks for (!needsAppend) to show Play/Pause.
			// No change to 'status' here, as Queue is an overlay property.

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
				const response = await MPV.sendMessageAsync({ action: "get_playback_status" });
				if (response) {
					this.update(response);
				}
			} catch (e) {
				console.warn("[StateManager] Sync request failed:", e);
			}
		}

		_initGlobalListener() {
			chrome.runtime.onMessage.addListener((msg) => {
				if (msg.action === "playback_state_changed") {
					this.update(msg.state);
				} else if (msg.action === "render_playlist") {
					// Fallback support for the heavier event if it contains status
					if (msg.isFolderActive !== undefined || msg.isClosing !== undefined) {
						this.update({
							folderId: msg.folderId,
							isRunning: msg.isFolderActive,
							isPaused: msg.isPaused,
							isClosing: msg.isClosing,
							lastPlayedId: msg.lastPlayedId,
							needsAppend: msg.needsAppend
						});
					}
				}
			});
		}
	}

	// Singleton instance
	MPV.playbackStateManager = new PlaybackStateManager();
	MPV.PlaybackStatus = PlaybackStatus;
})();
