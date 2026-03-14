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
        }
    };

    MPV.domUtils = domUtils;
})();

// Export for module environments
const root = typeof globalThis !== "undefined" ? globalThis : (typeof self !== "undefined" ? self : window);
export const domUtils = root.MPV_INTERNAL.domUtils;
