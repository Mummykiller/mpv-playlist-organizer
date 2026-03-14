/**
 * @module domUtils
 * Shared DOM utilities for MPV Playlist Organizer.
 * Supports both standard DOM and Shadow DOM contexts.
 */

window.MPV_INTERNAL = window.MPV_INTERNAL || {};

(() => {
    const MPV = window.MPV_INTERNAL;

    const domUtils = {
        /**
         * Smoothly scrolls a container to a target vertical position.
         * @param {HTMLElement} container - The element to scroll.
         * @param {number} to - The target position to scroll to.
         * @param {number} duration - The duration of the scroll in milliseconds.
         */
        smoothScrollTo(container, to, duration) {
            if (!container) return;
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
            if (!item.title) {
                urlSpan.textContent = item.url;
                return;
            }
            const titleParts = item.title.split(" - ");
            const isYT = item.url.includes("youtube.com/") || item.url.includes("youtu.be/");
            
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
         * @param {HTMLElement} itemDiv - The .list-item DOM node.
         * @param {Object} delta - The changes to apply (watched, markedAsWatched).
         */
        updateItemDelta(itemDiv, delta) {
            if (!itemDiv) return;
            const url = itemDiv.dataset.url || "";
            const isYouTube = url.includes("youtube.com") || url.includes("youtu.be");

            // 1. Gray out (watched)
            if (delta.watched !== undefined) {
                itemDiv.classList.toggle("item-watched", !!delta.watched);
                
                const existingIndexCheck = itemDiv.querySelector(".index-checkmark");
                if (delta.watched && !isYouTube && !existingIndexCheck) {
                    const check = document.createElement("span");
                    check.className = "watched-checkmark index-checkmark";
                    check.innerHTML = "✔";
                    const indexSpan = itemDiv.querySelector(".url-index");
                    if (indexSpan) indexSpan.after(check);
                } else if (!delta.watched && existingIndexCheck) {
                    existingIndexCheck.remove();
                }
            }

            // 2. Checkbox & Checkmark (markedAsWatched vs watched)
            if (delta.markedAsWatched !== undefined || delta.watched !== undefined) {
                const checkbox = itemDiv.querySelector(".item-watched-checkbox");
                
                // Checkbox strictly follows sync status
                if (delta.markedAsWatched !== undefined && checkbox) {
                    checkbox.checked = !!delta.markedAsWatched;
                    checkbox.title = delta.markedAsWatched ? "Already marked as watched" : "Click to mark as watched on YouTube";
                }

                // Checkmark strictly follows local watched status
                const existingCheckboxCheck = itemDiv.querySelector(".checkbox-checkmark");
                if (isYouTube && checkbox) {
                    const currentlyWatched = delta.watched !== undefined ? delta.watched : !!itemDiv.classList.contains("item-watched");
                    
                    if (currentlyWatched && !existingCheckboxCheck) {
                        const check = document.createElement("span");
                        check.className = "watched-checkmark checkbox-checkmark";
                        check.innerHTML = "✔";
                        checkbox.after(check);
                    } else if (!currentlyWatched && existingCheckboxCheck) {
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
        }
    };

    MPV.domUtils = domUtils;
})();

// Export for module environments
const root = typeof globalThis !== "undefined" ? globalThis : (typeof self !== "undefined" ? self : window);
export const domUtils = root.MPV_INTERNAL.domUtils;
