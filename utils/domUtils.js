// AUTO-GENERATED from domUtils.module.js. DO NOT EDIT MANUALLY.
window.MPV_INTERNAL = window.MPV_INTERNAL || {};
(() => {
	const MPV = window.MPV_INTERNAL;
	/**
	 * @module domUtils
	 * Shared DOM utilities for MPV Playlist Organizer.
	 * Supports both standard DOM and Shadow DOM contexts.
	 */

	const domUtils = MPV.domUtils = {
	        /**
	         * Smoothly scrolls a container to a target vertical position.
	         * @param {HTMLElement} container - The element to scroll.
	         * @param {number} to - The target position to scroll to.
	         * @param {number} duration - The duration of the scroll in milliseconds.
	         */
	        smoothScrollTo(container, to, duration) {
	            if (!container) return;
	            if (!duration || duration <= 0) {
	                container.scrollTop = to;
	                return;
	            }
	            const start = container.scrollTop;
	            const change = to - start;
	            let startTime = null;

	            // Easing function: easeInOutQuad for a gentle acceleration and deceleration.
	            const easeInOutQuad = (t, b, c, d) => {
	                t /= d / 2;
	                if (t < 1) return (c / 2) * t * t + b;
	                t--;
	                return (-c / 2) * (t * (t - 2) - 1) + b;
	            };

	            const animateScroll = (currentTime) => {
	                if (startTime === null) startTime = currentTime;
	                const timeElapsed = currentTime - startTime;
	                const run = easeInOutQuad(timeElapsed, start, change, duration);
	                container.scrollTop = run;
	                if (timeElapsed < duration) {
	                    requestAnimationFrame(animateScroll);
	                }
	            };
	            requestAnimationFrame(animateScroll);
	        },

	        /**
	         * Determines the element after which a dragged item should be dropped.
	         * @param {HTMLElement} container - The container holding the draggable items.
	         * @param {number} y - The current Y-coordinate of the mouse.
	         * @param {string} selector - The CSS selector for draggable items.
	         * @returns {HTMLElement|null} The element to drop before, or null if dropping at the end.
	         */
	        getDragAfterElement(container, y, selector = ".list-item:not(.dragging)") {
	            const draggableElements = [...container.querySelectorAll(selector)];
	            return draggableElements.reduce(
	                (closest, child) => {
	                    const box = child.getBoundingClientRect();
	                    const offset = y - box.top - box.height / 2;
	                    if (offset < 0 && offset > closest.offset)
	                        return { offset: offset, element: child };
	                    else return closest;
	                },
	                { offset: Number.NEGATIVE_INFINITY }
	            ).element;
	        },

	        /**
	         * Formats and highlights the title of a playlist item.
	         * @param {HTMLElement} urlSpan - The element to populate with the title.
	         * @param {Object} item - The playlist item object.
	         */
	        formatTitle(urlSpan, item) {
	            const url = String(item.url || "");
	            if (!item.title) {
	                urlSpan.textContent = url;
	                return;
	            }
	            const titleParts = item.title.split(" - ");
	            const isYT = url.includes("youtube.com/") || url.includes("youtu.be/");

	            // Matches S01E01, E01, or YouTube titles with at least one " - "
	            const episodeRegex = /^(s\d+)?e\d+(\.\d+)?$/i;

	            if (
	                titleParts.length > 1 &&
	                (episodeRegex.test(titleParts[0].trim()) || isYT)
	            ) {
	                const prefix = document.createElement("span");
	                prefix.textContent = titleParts.shift() + " - ";
	                const main = document.createElement("span");
	                main.className = "main-title-highlight";
	                main.textContent = titleParts.join(" - ");

	                urlSpan.innerHTML = ""; // Clear existing
	                urlSpan.append(prefix, main);
	            } else {
	                urlSpan.textContent = item.title;
	            }
	        },

	        /**
	         * Performs a surgical delta update on a playlist item node.
	         * @param {HTMLElement} itemDivOrContainer - The .list-item DOM node (or container when 3 args provided).
	         * @param {Object|string} deltaOrItemId - The changes to apply, or itemId when 3 args provided.
	         * @param {Object} [maybeDelta] - The changes to apply when called as (container, itemId, delta).
	         */
	        updateItemDelta(itemDivOrContainer, deltaOrItemId, maybeDelta) {
	            let itemDiv = itemDivOrContainer;
	            let delta = deltaOrItemId;
	            if (maybeDelta !== undefined && itemDivOrContainer?.querySelector) {
	                const safeId = typeof CSS !== "undefined" && typeof CSS.escape === "function"
	                    ? CSS.escape(String(deltaOrItemId ?? ""))
	                    : String(deltaOrItemId ?? "").replace(/["\\]/g, "\\$&");
	                itemDiv = itemDivOrContainer.querySelector(`[data-id="${safeId}"]`);
	                delta = maybeDelta;
	            }
	            if (!itemDiv || !delta) return;
	            const url = itemDiv.dataset.url || "";
	            const isYouTube = url.includes("youtube.com") || url.includes("youtu.be");

	            // 1. Title Update
	            if (delta.title !== undefined) {
	                itemDiv.dataset.title = delta.title;
	                const titleSpan = itemDiv.querySelector(".url-text");
	                if (titleSpan) {
	                    this.formatTitle(titleSpan, { url, title: delta.title });
	                }
	            }

	            // 2. Watched / markedAsWatched state (consistent with createPlaylistItemElement)
	            if (delta.markedAsWatched !== undefined || delta.watched !== undefined) {
	                const checkbox = itemDiv.querySelector(".item-watched-checkbox");

	                // Checkbox strictly follows sync status
	                if (delta.markedAsWatched !== undefined && checkbox) {
	                    checkbox.checked = !!delta.markedAsWatched;
	                    checkbox.title = delta.markedAsWatched ? "Already marked as watched" : "Click to mark as watched on YouTube";
	                }

	                const existingCheckboxCheck = itemDiv.querySelector(".checkbox-checkmark");
	                const effectiveWatched = delta.watched !== undefined
	                    ? !!delta.watched
	                    : (isYouTube && checkbox ? !!existingCheckboxCheck : itemDiv.classList.contains("item-watched"));
	                const effectiveMarked = delta.markedAsWatched !== undefined
	                    ? !!delta.markedAsWatched
	                    : (checkbox ? !!checkbox.checked : false);
	                const isEffectivelyWatched = effectiveWatched || effectiveMarked;

	                itemDiv.classList.toggle("item-watched", isEffectivelyWatched);

	                const existingIndexCheck = itemDiv.querySelector(".index-checkmark");
	                if (isEffectivelyWatched && !isYouTube && !existingIndexCheck) {
	                    const check = document.createElement("span");
	                    check.className = "watched-checkmark index-checkmark";
	                    check.innerHTML = "✔";
	                    const indexSpan = itemDiv.querySelector(".url-index");
	                    if (indexSpan) indexSpan.after(check);
	                } else if (!isEffectivelyWatched && existingIndexCheck) {
	                    existingIndexCheck.remove();
	                }

	                // Checkmark strictly follows local watched status
	                if (isYouTube && checkbox && delta.watched !== undefined) {
	                    if (effectiveWatched && !existingCheckboxCheck) {
	                        const check = document.createElement("span");
	                        check.className = "watched-checkmark checkbox-checkmark";
	                        check.innerHTML = "✔";
	                        checkbox.after(check);
	                    } else if (!effectiveWatched && existingCheckboxCheck) {
	                        existingCheckboxCheck.remove();
	                    }
	                }
	            }
	        },

	        /**
	         * Displays a confirmation modal.
	         * @param {string} message - The message to display.
	         * @param {Object} options - Configuration options (modalId, messageId, confirmId, cancelId).
	         * @returns {Promise<boolean>} Resolves to true if confirmed, false otherwise.
	         */
	        confirm(message, options = {}) {
	            return new Promise((resolve) => {
	                // POPUP MODE: If IDs are provided, use existing DOM elements
	                if (options.modalId) {
	                    const modal = document.getElementById(options.modalId);
	                    const messageEl = document.getElementById(options.messageId);
	                    const confirmBtn = document.getElementById(options.confirmId);
	                    const cancelBtn = document.getElementById(options.cancelId);

	                    if (modal && messageEl && confirmBtn && cancelBtn) {
	                        messageEl.textContent = message;
	                        modal.style.display = "flex";

	                        const handleKeyDown = (e) => {
	                            if (e.key === "Enter") { e.preventDefault(); close(true); }
	                            else if (e.key === "Escape") { e.preventDefault(); close(false); }
	                        };

	                        const close = (result) => {
	                            modal.style.display = "none";
	                            window.removeEventListener("keydown", handleKeyDown, true);
	                            confirmBtn.onclick = null;
	                            cancelBtn.onclick = null;
	                            resolve(result);
	                        };

	                        confirmBtn.onclick = () => close(true);
	                        cancelBtn.onclick = () => close(false);
	                        window.addEventListener("keydown", handleKeyDown, true);
	                        confirmBtn.focus();
	                        return;
	                    }
	                }

	                // PAGE MODE: Create a fresh Shadow DOM modal
	                if (document.getElementById("mpv-page-level-modal-host")) {
	                    resolve(false);
	                    return;
	                }

	                const modalHost = document.createElement("div");
	                modalHost.id = "mpv-page-level-modal-host";
	                Object.assign(modalHost.style, {
	                    position: "fixed", top: "0", left: "0", width: "100%", height: "100%", zIndex: "2147483647"
	                });

	                const shadowRoot = modalHost.attachShadow({ mode: "open" });
	                const style = document.createElement("style");
	                style.textContent = `
	                    :host {
	                        --surface-color: #1d1f23; --border-color: #33363b; --text-primary: #e1e1e1;
	                        --accent-primary: #5865f2; --accent-primary-hover: #4f5bda;
	                        --surface-hover-color: #2c2e33; --font-sans: -apple-system, sans-serif;
	                        --border-radius: 6px;
	                    }
	                    #overlay {
	                        position: absolute; top: 0; left: 0; right: 0; bottom: 0;
	                        background-color: rgba(0, 0, 0, 0.8); display: flex;
	                        align-items: center; justify-content: center; font-family: var(--font-sans);
	                    }
	                    .modal-content {
	                        background-color: var(--surface-color); color: var(--text-primary);
	                        padding: 24px; border-radius: var(--border-radius);
	                        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5); text-align: center;
	                        border: 1px solid var(--border-color); display: flex;
	                        flex-direction: column; gap: 20px; max-width: 600px; width: 95%;
	                    }
	                    p { margin: 0; font-size: 16px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
	                    .modal-actions { display: flex; justify-content: center; gap: 12px; }
	                    button {
	                        color: #fff; border: none; border-radius: var(--border-radius);
	                        padding: 10px 20px; font-size: 14px; font-weight: 600;
	                        cursor: pointer; transition: all 0.15s ease;
	                    }
	                    #confirm-btn { background-color: var(--accent-primary); }
	                    #confirm-btn:hover { background-color: var(--accent-primary-hover); }
	                    #cancel-btn { background-color: var(--surface-hover-color); }
	                    #cancel-btn:hover { background-color: var(--border-color); }
	                `;

	                const modalWrapper = document.createElement("div");
	                modalWrapper.id = "overlay";
	                modalWrapper.innerHTML = `
	                    <div class="modal-content">
	                        <p id="message"></p>
	                        <div class="modal-actions">
	                            <button id="confirm-btn">Confirm</button>
	                            <button id="cancel-btn">Cancel</button>
	                        </div>
	                    </div>
	                `;

	                shadowRoot.append(style, modalWrapper);
	                shadowRoot.getElementById("message").textContent = message;

	                const handleKeyDown = (e) => {
	                    if (e.key === "Enter") { e.preventDefault(); close(true); }
	                    else if (e.key === "Escape") { e.preventDefault(); close(false); }
	                };

	                const close = (result) => {
	                    window.removeEventListener("keydown", handleKeyDown, true);
	                    modalHost.remove();
	                    resolve(result);
	                };

	                shadowRoot.getElementById("confirm-btn").onclick = () => close(true);
	                shadowRoot.getElementById("cancel-btn").onclick = () => close(false);

	                window.addEventListener("keydown", handleKeyDown, true);
	                document.body.appendChild(modalHost);
	                shadowRoot.getElementById("confirm-btn").focus();
	            });
	        },

	        /**
	         * Displays a stacked confirmation modal on the page, reusing an existing host if already open.
	         * @param {string} folderId - ID of the target folder.
	         * @param {string} message - Confirmation message.
	         * @param {Object} requestData - Associated request payload.
	         * @returns {Promise<Object|boolean|null>} Resolves to updated request data, false, or null if stacked.
	         */
	        confirmStacked(folderId, message, requestData) {
	            const existingHost = document.getElementById("mpv-page-level-modal-host");
	            if (existingHost) {
	                if (existingHost.dataset.folderId !== folderId) {
	                    return Promise.resolve(false);
	                }
	                const shadow = existingHost.shadowRoot;
	                const messageEl = shadow ? shadow.getElementById("message") : null;
	                const contentEl = shadow ? shadow.querySelector(".modal-content") : null;
	                if (messageEl) {
	                    messageEl.textContent = message;
	                    if (contentEl) {
	                        contentEl.style.transition = "transform 0.1s ease";
	                        contentEl.style.transform = "scale(1.02)";
	                        setTimeout(() => (contentEl.style.transform = "scale(1)"), 100);
	                    }
	                }
	                existingHost.dataset.latestRequest = JSON.stringify(requestData);
	                return Promise.resolve(null);
	            }

	            return new Promise((resolve) => {
	                let modalHostRef = null;
	                this.confirm(message).then((confirmed) => {
	                    let dataToReturn = requestData;
	                    if (modalHostRef && modalHostRef.dataset.latestRequest) {
	                        try {
	                            dataToReturn = JSON.parse(modalHostRef.dataset.latestRequest);
	                        } catch (e) {
	                            const logger = (typeof window !== "undefined" && window.MPV_INTERNAL?.logger) || null;
	                            if (logger) logger.warn("[domUtils] Failed to parse latestRequest data:", { data: e });
	                        }
	                    }
	                    resolve(confirmed ? dataToReturn : false);
	                });

	                modalHostRef = document.getElementById("mpv-page-level-modal-host");
	                if (modalHostRef) {
	                    modalHostRef.dataset.folderId = folderId;
	                    modalHostRef.dataset.latestRequest = JSON.stringify(requestData);
	                }
	            });
	        },

	        /**
	         * Updates a status banner or status message in the given DOM context (popup or on-page controller).
	         * @param {HTMLElement|ShadowRoot|null} targetOrRoot - Container, ShadowRoot, or status element.
	         * @param {string} text - Message text.
	         * @param {boolean|Object} [options] - Boolean isSuccess/isError or options object { isSuccess, isError, timeout }.
	         * @returns {boolean} Whether an element was found and updated.
	         */
	        updateStatusBanner(targetOrRoot, text, options = {}) {
	            const isError = typeof options === "boolean" ? !options : !!options.isError;
	            const isSuccess = typeof options === "boolean" ? options : (options.isSuccess !== undefined ? !!options.isSuccess : !isError);

	            if (!targetOrRoot) {
	                this.showNotificationBanner(text, { isError, duration: options.timeout });
	                return true;
	            }

	            // Controller UI: has #status-banner and/or #stream-status
	            const statusBanner = targetOrRoot.id === "status-banner"
	                ? targetOrRoot
	                : (targetOrRoot.getElementById ? targetOrRoot.getElementById("status-banner") : targetOrRoot.querySelector?.("#status-banner"));
	            const streamStatus = targetOrRoot.id === "stream-status"
	                ? targetOrRoot
	                : (targetOrRoot.getElementById ? targetOrRoot.getElementById("stream-status") : targetOrRoot.querySelector?.("#stream-status"));

	            if (statusBanner || streamStatus) {
	                if (streamStatus) streamStatus.textContent = text;
	                if (statusBanner) statusBanner.classList.toggle("detected", isSuccess);
	                return true;
	            }

	            // Popup UI: has #status-message
	            const statusMessage = targetOrRoot.id === "status-message"
	                ? targetOrRoot
	                : (targetOrRoot.getElementById ? targetOrRoot.getElementById("status-message") : targetOrRoot.querySelector?.("#status-message"));

	            if (statusMessage) {
	                statusMessage.textContent = text;
	                statusMessage.style.color = isError ? "var(--accent-danger)" : "var(--accent-success)";
	                return true;
	            }

	            // Fallback: floating notification banner
	            this.showNotificationBanner(text, { isError, duration: options.timeout });
	            return true;
	        },

	        /**
	         * Displays a non-intrusive floating status notification banner in the viewport.
	         * Compliant with Shadow DOM styles rule (<style> textContent only, no external link, no innerHTML wipe).
	         * @param {string} message - Message to display.
	         * @param {Object} [options] - Options { isError, isSuccess, duration }.
	         */
	        showNotificationBanner(message, options = {}) {
	            if (typeof document === "undefined" || !document.body) return;
	            const isError = !!options.isError;
	            const duration = options.duration || 4000;

	            let host = document.getElementById("mpv-notification-banner-host");
	            let shadowRoot;

	            if (!host) {
	                host = document.createElement("div");
	                host.id = "mpv-notification-banner-host";
	                Object.assign(host.style, {
	                    position: "fixed",
	                    top: "16px",
	                    right: "16px",
	                    zIndex: "2147483647",
	                    pointerEvents: "none",
	                    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
	                });

	                shadowRoot = host.attachShadow({ mode: "open" });
	                const style = document.createElement("style");
	                style.textContent = `
	                    .banner-container {
	                        display: flex;
	                        flex-direction: column;
	                        gap: 8px;
	                        align-items: flex-end;
	                        pointer-events: none;
	                    }
	                    .banner-item {
	                        pointer-events: auto;
	                        background: #1e1f22;
	                        color: #e1e1e1;
	                        border: 1px solid #33363b;
	                        border-left: 4px solid var(--banner-accent, #5865f2);
	                        border-radius: 6px;
	                        padding: 10px 16px;
	                        box-shadow: 0 4px 14px rgba(0,0,0,0.45);
	                        font-size: 13px;
	                        line-height: 1.4;
	                        max-width: 380px;
	                        word-break: break-word;
	                        opacity: 0;
	                        transform: translateY(-8px);
	                        transition: opacity 0.2s ease, transform 0.2s ease;
	                        cursor: pointer;
	                        user-select: none;
	                    }
	                    .banner-item.visible {
	                        opacity: 1;
	                        transform: translateY(0);
	                    }
	                    .banner-item.error {
	                        --banner-accent: #ed4245;
	                    }
	                    .banner-item.success {
	                        --banner-accent: #57f287;
	                    }
	                    .banner-item.info {
	                        --banner-accent: #5865f2;
	                    }
	                `;

	                const container = document.createElement("div");
	                container.className = "banner-container";
	                shadowRoot.append(style, container);

	                const mountTarget = document.body || document.documentElement;
	                if (mountTarget) mountTarget.appendChild(host);
	            } else {
	                shadowRoot = host.shadowRoot;
	            }

	            if (!shadowRoot) return;
	            const container = shadowRoot.querySelector(".banner-container");
	            if (!container) return;

	            const banner = document.createElement("div");
	            banner.className = `banner-item ${isError ? "error" : (options.isSuccess ? "success" : "info")}`;
	            banner.textContent = message;

	            const dismiss = () => {
	                banner.classList.remove("visible");
	                setTimeout(() => {
	                    banner.remove();
	                    if (container.children.length === 0 && host) {
	                        host.remove();
	                    }
	                }, 200);
	            };

	            banner.onclick = dismiss;
	            container.appendChild(banner);

	            requestAnimationFrame(() => banner.classList.add("visible"));

	            if (duration > 0) {
	                setTimeout(dismiss, duration);
	            }
	        },

	        /**
	         * Resolves the visual state (playing class, title, and state key) for play buttons.
	         * @param {Object} options
	         * @param {boolean} options.isActive
	         * @param {boolean} options.needsAppend
	         * @returns {{ isPlaying: boolean, title: string, stateKey: string }}
	         */
	        getPlayButtonVisual({ isActive, needsAppend }) {
	            const isEffectiveActive = !!isActive;
	            const showingNeedsAppend = isEffectiveActive && !!needsAppend;
	            let title = "Play Playlist";
	            let stateKey = "play";

	            if (showingNeedsAppend) {
	                title = "Queue to Playlist";
	                stateKey = "queue";
	            } else if (isEffectiveActive) {
	                title = "Play/Pause Playlist";
	                stateKey = "pause";
	            }

	            return {
	                isPlaying: isEffectiveActive || showingNeedsAppend,
	                title,
	                stateKey
	            };
	        },

	        /**
	         * Builds a shared `.list-item` DOM element for both PlaylistRenderer (popup) and PlaylistUI (content script).
	         * @param {Object} item - Playlist item ({ id, url, title, watched, markedAsWatched, currentlyPlaying }).
	         * @param {number} index - Zero-based item index.
	         * @param {Object} [options] - Rendering and callback options.
	         * @returns {HTMLDivElement}
	         */
	        createPlaylistItemElement(item, index, options = {}) {
	            const {
	                highlightEnabled = true,
	                lastPlayedId = null,
	                isActive = false,
	                showCopyButton = false,
	                showWatchedGui = true,
	                setUrlTitle = false,
	                setDatasetIndex = false,
	                checkboxBeforeTitle = false,
	                onCopy = null,
	                onWatchedToggle = null,
	                onRemove = null,
	                onDblClick = null,
	            } = options;

	            const div = document.createElement("div");
	            div.className = "list-item";

	            const isWatched = !!(item.markedAsWatched || item.watched);
	            if (isWatched) {
	                div.classList.add("item-watched");
	            }

	            const isCurrent = !!item.currentlyPlaying || (!!lastPlayedId && item.id === lastPlayedId);
	            if (highlightEnabled && isCurrent) {
	                div.classList.add(isActive ? "active-item" : "last-played-item");
	            }

	            div.draggable = true;
	            if (setUrlTitle && item.url) div.title = item.url;
	            div.dataset.id = item.id || "";
	            div.dataset.url = item.url || "";
	            div.dataset.title = item.title || "";
	            if (setDatasetIndex) div.dataset.index = index;

	            if (onDblClick) {
	                div.ondblclick = (e) => onDblClick(item, div, e);
	            }

	            if (showCopyButton) {
	                const copyBtn = document.createElement("button");
	                copyBtn.className = "btn-copy-item";
	                copyBtn.dataset.url = item.url || "";
	                copyBtn.title = "Copy URL";
	                copyBtn.innerHTML =
	                    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
	                if (onCopy) {
	                    copyBtn.onclick = (e) => {
	                        e.stopPropagation();
	                        onCopy(item.url, e);
	                    };
	                }
	                div.appendChild(copyBtn);
	            }

	            const indexSpan = document.createElement("span");
	            indexSpan.className = "url-index";
	            indexSpan.textContent = `${index + 1}.`;
	            div.appendChild(indexSpan);

	            const urlStr = item.url || "";
	            const isYouTube = urlStr.includes("youtube.com/") || urlStr.includes("youtu.be/");

	            if (isWatched && !isYouTube) {
	                const check = document.createElement("span");
	                check.className = "watched-checkmark index-checkmark";
	                check.textContent = "✔";
	                div.appendChild(check);
	            }

	            const titleSpan = document.createElement("span");
	            titleSpan.className = "url-text";
	            this.formatTitle(titleSpan, item);

	            const appendWatchedControls = () => {
	                if (!showWatchedGui || !isYouTube) return;
	                const checkbox = document.createElement("input");
	                checkbox.type = "checkbox";
	                checkbox.className = "item-watched-checkbox";
	                checkbox.checked = !!item.markedAsWatched;
	                checkbox.title = checkbox.checked
	                    ? "Already marked as watched"
	                    : "Click to mark as watched on YouTube";
	                checkbox.onclick = (e) => e.stopPropagation();
	                checkbox.onchange = (e) => {
	                    e.stopPropagation();
	                    if (onWatchedToggle) onWatchedToggle(item.id, e.target.checked, e);
	                };
	                div.appendChild(checkbox);

	                if (item.watched) {
	                    const check = document.createElement("span");
	                    check.className = "watched-checkmark checkbox-checkmark";
	                    check.textContent = "✔";
	                    div.appendChild(check);
	                }
	            };

	            if (checkboxBeforeTitle) {
	                appendWatchedControls();
	                div.appendChild(titleSpan);
	            } else {
	                div.appendChild(titleSpan);
	                appendWatchedControls();
	            }

	            const removeBtn = document.createElement("button");
	            removeBtn.className = "btn-remove-item";
	            removeBtn.dataset.index = index;
	            removeBtn.textContent = "×";
	            removeBtn.title = "Remove Item";
	            if (onRemove) {
	                removeBtn.onclick = (e) => {
	                    e.stopPropagation();
	                    onRemove(index, item.id, removeBtn, e);
	                };
	            }
	            div.appendChild(removeBtn);

	            return div;
	        }
	};

	if (typeof window !== "undefined") {
	    window.MPV_INTERNAL = window.MPV_INTERNAL || {};
	    window.MPV_INTERNAL.domUtils = domUtils;
	}

})();