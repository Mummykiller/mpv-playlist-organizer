// utils/PlaylistRenderer.js
// Dual-mode version for Content Scripts and Modules

(function() {
    const root = typeof globalThis !== "undefined" ? globalThis : (typeof self !== "undefined" ? self : window);
    root.MPV_INTERNAL = root.MPV_INTERNAL || {};
    const MPV = root.MPV_INTERNAL;

    MPV.PlaylistRenderer = class PlaylistRenderer {
        constructor(container, options = {}) {
            this.container = container;
            this.callbacks = options.callbacks || {}; 
            this.prefs = options.prefs || {};
            this.lastRenderedIds = new Set();
        }

        updatePrefs(newPrefs) {
            this.prefs = Object.assign({}, this.prefs, newPrefs);
        }

        render(state) {
            let playlist = state.playlist || [];
            const completedIds = new Set(state.completedIds || []);
            
            // Filter out staged completed items for the "cleared nice" effect
            if (completedIds.size > 0) {
                playlist = playlist.filter(item => !completedIds.has(item.id));
            }

            const lastPlayedId = state.lastPlayedId;
            const isActive = state.isActive;
            const isPaused = state.isPaused;
            const needsAppend = state.needsAppend;
            
            const oldScrollTop = this.container.scrollTop;
            const oldHeight = this.container.scrollHeight;
            const oldItemCount = this.lastRenderedIds.size;

            while (this.container.firstChild) {
                this.container.removeChild(this.container.lastChild);
            }
            this.lastRenderedIds.clear();

            if (!playlist || playlist.length === 0) {
                this._renderPlaceholder();
                return;
            }

            const fragment = document.createDocumentFragment();
            const highlightEnabled = this.prefs.enableActiveItemHighlight !== false;

            playlist.forEach((item, index) => {
                this.lastRenderedIds.add(item.id);
                const itemNode = this._createItemNode(item, index, {
                    lastPlayedId,
                    isActive,
                    highlightEnabled
                });
                fragment.appendChild(itemNode);
            });

            this.container.appendChild(fragment);

            const newItemCount = playlist.length;
            if (!state.preventScroll) {
                if (newItemCount > oldItemCount && oldHeight > 0) {
                    this.container.scrollTop = this.container.scrollHeight;
                } else {
                    this.container.scrollTop = oldScrollTop;
                }
            }

            if (!state.preventScroll && isActive && lastPlayedId) {
                const activeItem = this.container.querySelector(".active-item");
                if (activeItem) {
                    activeItem.scrollIntoView({ behavior: "smooth", block: "center" });
                }
            }
        }

        _renderPlaceholder() {
            const p = document.createElement("p");
            p.className = "playlist-placeholder";
            p.textContent = "Playlist is empty.";
            this.container.appendChild(p);
        }

        _createItemNode(item, index, status) {
            const dom = MPV.domUtils || (typeof window !== "undefined" && window.MPV_INTERNAL?.domUtils);
            return dom.createPlaylistItemElement(item, index, {
                highlightEnabled: status.highlightEnabled,
                lastPlayedId: status.lastPlayedId,
                isActive: status.isActive,
                showCopyButton: !!this.prefs.showCopyTitleButton,
                showWatchedGui: !!this.prefs.showWatchedStatusGui,
                setDatasetIndex: true,
                onCopy: (url) => {
                    if (this.callbacks.onCopy) this.callbacks.onCopy(url);
                },
                onWatchedToggle: (id, checked) => {
                    if (this.callbacks.onWatchedToggle) this.callbacks.onWatchedToggle(id, checked);
                },
                onRemove: (idx, id, btn) => {
                    const listItem = btn.closest(".list-item");
                    let currentIndex = idx;
                    if (listItem) {
                        listItem.classList.add("removing");
                        const items = this.container ? [...this.container.querySelectorAll(".list-item")] : [];
                        const domIndex = items.indexOf(listItem);
                        if (domIndex !== -1) {
                            currentIndex = domIndex;
                        } else if (listItem.dataset.index !== undefined) {
                            const parsed = parseInt(listItem.dataset.index, 10);
                            if (!isNaN(parsed)) currentIndex = parsed;
                        }
                    }
                    if (this.callbacks.onRemove) this.callbacks.onRemove(currentIndex, id);
                },
                onDblClick: (clickedItem, div) => {
                    if (this.prefs.enableDblclickCopy) {
                        navigator.clipboard.writeText(clickedItem.title).then(() => {
                            if (this.callbacks.onLog) this.callbacks.onLog({ text: "Copied title to clipboard.", type: "info" });
                            div.classList.add("title-copied");
                            setTimeout(() => div.classList.remove("title-copied"), 1500);
                        });
                    }
                }
            });
        }

        _formatTitle(span, item) {
            const dom = MPV.domUtils || (typeof window !== "undefined" && window.MPV_INTERNAL?.domUtils);
            if (dom?.formatTitle) {
                dom.formatTitle(span, item);
            }
        }

        /**
         * Delta update for a single item DOM node.
         */
        updateItemDelta(itemId, delta) {
            const safeId = typeof CSS !== "undefined" && typeof CSS.escape === "function"
                ? CSS.escape(String(itemId ?? ""))
                : String(itemId ?? "").replace(/["\\]/g, "\\$&");
            const itemDiv = this.container.querySelector(`[data-id="${safeId}"]`);
            if (!itemDiv) return;

            const dom = MPV.domUtils || (typeof window !== "undefined" && window.MPV_INTERNAL?.domUtils);
            if (dom?.updateItemDelta) {
                dom.updateItemDelta(itemDiv, delta);
            }
        }
    };
})();

// Export for module environments
const root = typeof globalThis !== "undefined" ? globalThis : (typeof self !== "undefined" ? self : window);
export const PlaylistRenderer = root.MPV_INTERNAL.PlaylistRenderer;
