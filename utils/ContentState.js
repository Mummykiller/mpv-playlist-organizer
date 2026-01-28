/**
 * @class ContentState
 * Manages the UI state and synchronization with persistence.
 */
window.MPV_INTERNAL = window.MPV_INTERNAL || {};

(() => {
	const MPV = window.MPV_INTERNAL;
	window.MPV_INTERNAL.ContentState = class ContentState {
		constructor({ onUpdate }) {
			this.onUpdate = onUpdate || (() => {});
			this.isDestroyed = false;

			this.state = {
				minimized: false,
				pinned: false,
				uiMode: "full",
				logVisible: true,
				logFilters: { info: true, error: true },
				detectedUrl: null,
				currentFolderId: "Default",
				isFolderActive: false,
				lastPlayedId: null,
				anilistVisible: false,
				anilistImageHeight: 126,
				kbAddPlaylist: "Shift+A",
				kbToggleController: "Shift+S",
				kbOpenPopup: "Alt+P",
				kbPlayPlaylist: "Shift+P",
				kbSwitchPlaylist: "Shift+Tab",
				settings: {
					enableActiveItemHighlight: true,
					enableSmartResume: true,
					showMinimizedStub: true,
					showPlayNewButton: false,
					enableAnilistIntegration: true,
					showWatchedStatusGui: true,
					lockAnilistPanel: false,
					forcePanelAttached: false,
					anilistAttachOnOpen: true,
				},
			};
		}

		update(delta, silent = false) {
			if (this.isDestroyed) return;

			for (const [key, value] of Object.entries(delta)) {
				if (
					value &&
					typeof value === "object" &&
					!Array.isArray(value) &&
					this.state[key]
				) {
					this.state[key] = { ...this.state[key], ...value };
				} else {
					this.state[key] = value;
				}
			}

			if (!silent) {
				const clonedState = JSON.parse(JSON.stringify(this.state));
				this.onUpdate(clonedState);
			}
		}

		destroy() {
			this.isDestroyed = true;
		}
	};
})();
