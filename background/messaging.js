import { storage } from "./storage_instance.js";

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
 * Supports automatic title resolution if itemId and folderId are provided.
 */
export async function broadcastLog(logObject) {
	const finalLog = { ...logObject };

	// 1. Title Resolution Logic
	if (finalLog.itemId && finalLog.folderId) {
		try {
			const data = await storage.get();
			const folder = data.folders[finalLog.folderId];
			if (folder && folder.playlist) {
				const item = folder.playlist.find((i) => i.id === finalLog.itemId);
				const title = item?.title || item?.url;

				if (title) {
					// Replace ID or append title to text
					const displayTitle = `'[${title}]'`;
					if (finalLog.text.includes(finalLog.itemId)) {
						finalLog.text = finalLog.text.replace(finalLog.itemId, displayTitle);
					} else {
						finalLog.text = `${finalLog.text}: ${displayTitle}`;
					}
				} else {
					// Fallback: Short ID
					const shortId = finalLog.itemId.substring(0, 8);
					finalLog.text = finalLog.text.replace(finalLog.itemId, shortId);
				}
			}
		} catch (e) {
			console.error("[Messaging] Failed to resolve title for log:", e);
		}
	}

	const message = { action: "log", log: finalLog };
	broadcastToTabs(message);
}
