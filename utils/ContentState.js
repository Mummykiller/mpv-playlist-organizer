/**
 * @class ContentState
 * Manages the UI state and synchronization with persistence.
 */
window.MPV_INTERNAL = window.MPV_INTERNAL || {};

(function() {
    'use strict';

    window.MPV_INTERNAL.ContentState = class ContentState {
        constructor({ onUpdate }) {
            this.onUpdate = onUpdate || (() => {});
            this.isDestroyed = false;

            this.state = {
                minimized: false,
                pinned: false,
                uiMode: 'full',
                logVisible: true,
                logFilters: { info: true, error: true },
                detectedUrl: null,
                currentFolderId: 'Default',
                isFolderActive: false,
                lastPlayedId: null,
                anilistVisible: false,
                anilistImageHeight: 126,
                kb_add_playlist: 'Shift+A',
                kb_toggle_controller: 'Shift+S',
                kb_open_popup: 'Alt+P',
                kb_play_playlist: 'Shift+P',
                kb_switch_playlist: 'Shift+Tab',
                settings: {
                    enable_active_item_highlight: true,
                    enable_smart_resume: true,
                    show_minimized_stub: true,
                    show_play_new_button: false,
                    enable_anilist_integration: true,
                    lockAnilistPanel: false,
                    forcePanelAttached: false,
                    anilistAttachOnOpen: true
                }
            };
        }

        update(delta, silent = false) {
            if (this.isDestroyed) return;

            for (const [key, value] of Object.entries(delta)) {
                if (value && typeof value === 'object' && !Array.isArray(value) && this.state[key]) {
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
