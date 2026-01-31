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
            if (newItemCount > oldItemCount && oldHeight > 0) {
                this.container.scrollTop = this.container.scrollHeight;
            } else {
                this.container.scrollTop = oldScrollTop;
            }

            if (isActive && lastPlayedId) {
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
            const div = document.createElement("div");
            div.className = "list-item";
            
            const isWatched = item.markedAsWatched || item.watched;
            if (isWatched) {
                div.classList.add("item-watched");
            }

            div.draggable = true;
            div.dataset.id = item.id;
            div.dataset.url = item.url;
            div.dataset.title = item.title;
            div.dataset.index = index;

            if (status.highlightEnabled && status.lastPlayedId && item.id === status.lastPlayedId) {
                div.classList.add(status.isActive ? "active-item" : "last-played-item");
            }

            // Restore Double-Click to Copy Title
            div.ondblclick = (e) => {
                if (this.prefs.enableDblclickCopy) {
                    navigator.clipboard.writeText(item.title)
                        .then(() => {
                            if (this.callbacks.onLog) this.callbacks.onLog({ text: "Copied title to clipboard.", type: "info" });
                            div.classList.add("title-copied");
                            setTimeout(() => div.classList.remove("title-copied"), 1500);
                        });
                }
            };

            if (this.prefs.showCopyTitleButton) {
                div.appendChild(this._createIconButton("copy", item.url));
            }

            const indexSpan = document.createElement("span");
            indexSpan.className = "url-index";
            indexSpan.textContent = (index + 1) + ".";
            div.appendChild(indexSpan);

            const isYouTube = item.url.indexOf("youtube.com/") !== -1 || item.url.indexOf("youtu.be/") !== -1 || item.url.indexOf("youtube.com/shorts/") !== -1;

            if (isWatched && !isYouTube) {
                const check = document.createElement("span");
                check.className = "watched-checkmark index-checkmark";
                check.innerHTML = "✔";
                div.appendChild(check);
            }

            const titleSpan = document.createElement("span");
            titleSpan.className = "url-text";
            this._formatTitle(titleSpan, item);
            div.appendChild(titleSpan);

            const isYouTube = item.url.indexOf("youtube.com/") !== -1 || item.url.indexOf("youtu.be/") !== -1 || item.url.indexOf("youtube.com/shorts/") !== -1;
            if (this.prefs.showWatchedStatusGui && isYouTube) {
                div.appendChild(this._createWatchedCheckbox(item));
                
                const isWatched = item.markedAsWatched || item.watched;
                if (isWatched) {
                    const check = document.createElement("span");
                    check.className = "watched-checkmark checkbox-checkmark";
                    check.innerHTML = "✔";
                    div.appendChild(check);
                }
            }

            div.appendChild(this._createRemoveButton(index, item.id));

            return div;
        }

        _createIconButton(type, value) {
            const btn = document.createElement("button");
            btn.className = "btn-" + type + "-item";
            btn.title = type === "copy" ? "Copy URL" : type;
            
            if (type === "copy") {
                btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
                btn.onclick = (e) => {
                    e.stopPropagation();
                    if (this.callbacks.onCopy) this.callbacks.onCopy(value);
                };
            }
            return btn;
        }

        _createWatchedCheckbox(item) {
            const input = document.createElement("input");
            input.type = "checkbox";
            input.className = "item-watched-checkbox";
            // Check both flags - if either is true, it's watched.
            const isWatched = item.markedAsWatched || item.watched;
            input.checked = !isWatched;
            input.title = input.checked ? "Will mark as watched on YouTube" : "Already marked or watched locally";
            
            input.onclick = (e) => e.stopPropagation();
            input.onchange = (e) => {
                // When toggling manually, we update both for consistency
                if (this.callbacks.onWatchedToggle) this.callbacks.onWatchedToggle(item.id, !e.target.checked);
            };
            return input;
        }

        _createRemoveButton(index, id) {
            const btn = document.createElement("button");
            btn.className = "btn-remove-item";
            btn.textContent = "×";
            btn.title = "Remove Item";
            btn.onclick = (e) => {
                e.stopPropagation();
                const listItem = btn.closest(".list-item");
                if (listItem) listItem.classList.add("removing");
                if (this.callbacks.onRemove) this.callbacks.onRemove(index, id);
            };
            return btn;
        }

        _formatTitle(span, item) {
            const titleParts = item.title.split(" - ");
            const isYT = item.url.indexOf("youtube.com/") !== -1 || item.url.indexOf("youtu.be/") !== -1 || item.url.indexOf("youtube.com/shorts/") !== -1;
            const isEp = titleParts.length > 1 && /^(s\d+)?e\d+(\.\d+)?$/i.test(titleParts[0].trim());

            if (isEp || (isYT && titleParts.length > 1)) {
                const prefix = document.createElement("span");
                prefix.textContent = titleParts.shift() + " - ";
                const main = document.createElement("span");
                main.className = "main-title-highlight";
                main.textContent = titleParts.join(" - ");
                span.appendChild(prefix);
                span.appendChild(main);
            } else {
                span.textContent = item.title;
            }
        }

        /**
         * Delta update for a single item DOM node.
         */
        updateItemDelta(itemId, delta) {
            const itemDiv = this.container.querySelector(`[data-id="${itemId}"]`);
            if (!itemDiv) return;

            if (delta.watched !== undefined || delta.markedAsWatched !== undefined) {
                const isWatched = !!(delta.watched || delta.markedAsWatched);
                itemDiv.classList.toggle("item-watched", isWatched);

                const isYouTube = itemDiv.dataset.url?.includes("youtube.com") || itemDiv.dataset.url?.includes("youtu.be");
                
                // 1. Index Checkmark (non-YT)
                const existingIndexCheck = itemDiv.querySelector(".index-checkmark");
                if (isWatched && !isYouTube && !existingIndexCheck) {
                    const check = document.createElement("span");
                    check.className = "watched-checkmark index-checkmark";
                    check.innerHTML = "✔";
                    const indexSpan = itemDiv.querySelector(".url-index");
                    if (indexSpan) indexSpan.after(check);
                } else if (!isWatched && existingIndexCheck) {
                    existingIndexCheck.remove();
                }

                // 2. Checkbox Checkmark (YT)
                const existingCheckboxCheck = itemDiv.querySelector(".checkbox-checkmark");
                const checkbox = itemDiv.querySelector(".item-watched-checkbox");
                if (isWatched && isYouTube && checkbox && !existingCheckboxCheck) {
                    const check = document.createElement("span");
                    check.className = "watched-checkmark checkbox-checkmark";
                    check.innerHTML = "✔";
                    checkbox.after(check);
                } else if (!isWatched && existingCheckboxCheck) {
                    existingCheckboxCheck.remove();
                }

                if (checkbox) checkbox.checked = !isWatched;
            }
        }
    };
})();

// Export for module environments
const root = typeof globalThis !== "undefined" ? globalThis : (typeof self !== "undefined" ? self : window);
export const PlaylistRenderer = root.MPV_INTERNAL.PlaylistRenderer;
