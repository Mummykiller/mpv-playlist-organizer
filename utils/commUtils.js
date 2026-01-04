/**
 * Shared communication utilities for the MPV Playlist Organizer.
 * This file is for use in non-module contexts (content scripts, popup).
 */

/**
 * Creates a debounced function that delays invoking `func` until after `wait`
 * milliseconds have elapsed since the last time the debounced function was
 * invoked.
 */
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func.apply(this, args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

/**
 * A promise-based wrapper for chrome.runtime.sendMessage.
 * Includes safety checks for extension context invalidation.
 */
function sendMessageAsync(payload) {
    return new Promise((resolve, reject) => {
        if (typeof chrome === 'undefined' || !chrome.runtime?.id) {
            return reject(new Error("Extension context invalidated."));
        }
        chrome.runtime.sendMessage(payload, (response) => {
            if (chrome.runtime.lastError) {
                return reject(new Error(chrome.runtime.lastError.message));
            }
            resolve(response);
        });
    });
}
