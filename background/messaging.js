// background/messaging.js

/**
 * Broadcasts a message to all content scripts in open tabs and other extension contexts.
 */
export function broadcastToTabs(message) {
    chrome.runtime.sendMessage(message).catch(() => {});

    chrome.tabs.query({ url: ["http://*/*", "https://*/*"] }, (tabs) => {
        for (const tab of tabs) {
            try {
                chrome.tabs.sendMessage(tab.id, message).catch(() => {});
            } catch (e) {}
        }
    });
}

/**
 * Broadcasts a log message to all content scripts and the popup.
 */
export function broadcastLog(logObject) {
    const message = { log: logObject };
    broadcastToTabs(message);
}
