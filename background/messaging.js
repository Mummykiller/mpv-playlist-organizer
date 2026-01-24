// background/messaging.js

/**
 * Broadcasts a message only to active tabs and the extension's internal contexts (like the popup).
 * This significantly reduces CPU overhead by not "waking up" background tabs.
 */
export async function broadcastToTabs(message) {
	// 1. Send to internal extension contexts (e.g., the Popup)
	chrome.runtime.sendMessage(message).catch(() => {});

	// 2. Only target active tabs in each window
	try {
		const activeTabs = await chrome.tabs.query({ active: true });
		// Parallel broadcast to all active tabs
		await Promise.all(
			activeTabs.map((tab) => {
				if (tab.id) {
					return chrome.tabs.sendMessage(tab.id, message).catch(() => {});
				}
				return Promise.resolve();
			}),
		);
	} catch (e) {
		console.error("[Messaging] Failed to query active tabs:", e);
	}
}

/**
 * Broadcasts a log message to active content scripts and the popup.
 */
export function broadcastLog(logObject) {
	const message = { action: "log", log: logObject };
	broadcastToTabs(message);
}
