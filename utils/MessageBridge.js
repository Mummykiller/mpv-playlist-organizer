/**
 * @class MessageBridge
 * Handles all communication between the content script and the background script.
 */
window.MPV_INTERNAL = window.MPV_INTERNAL || {};

(function() {
    'use strict';

    window.MPV_INTERNAL.MessageBridge = class MessageBridge {
        constructor({ onLog } = {}) {
            this.onLog = onLog || (() => {});
            this.isDestroyed = false;
            this.tabId = null; 
        }

        async send(action, folderId = null, data = {}) {
            if (this.isDestroyed) return { success: false, error: "Bridge destroyed" };

            const payload = { action, folderId, ...data, tabId: this.tabId };

            return new Promise((resolve) => {
                if (!chrome.runtime?.id) {
                    return resolve({ success: false, error: "Extension context invalidated" });
                }

                chrome.runtime.sendMessage(payload, (response) => {
                    if (this.isDestroyed) return;

                    if (chrome.runtime.lastError) {
                        const err = chrome.runtime.lastError;
                        const msg = err.message || "Unknown runtime error";
                        if (!this._isReloadError(msg)) {
                            this.onLog({ text: `[Content]: Error sending '${action}': ${msg}`, type: 'error' });
                        }
                        return resolve({ success: false, error: msg });
                    }

                    if (response) {
                        const silentActions = ['get_playlist', 'heartbeat'];
                        if (response.message && !silentActions.includes(action)) {
                            this.onLog({ text: `[Background]: ${response.message}`, type: 'info' });
                        }
                        if (response.error && !silentActions.includes(action)) {
                            this.onLog({ text: `[Background]: ${response.error}`, type: 'error' });
                        }
                    }
                    resolve(response || { success: false, error: "No response" });
                });
            });
        }

        _isReloadError(msg) {
            if (!msg) return false;
            return msg.includes("Extension context invalidated") || 
                   msg.includes("Receiving end does not exist") ||
                   msg.includes("message channel closed");
        }

        destroy() {
            this.isDestroyed = true;
        }
    };
})();
