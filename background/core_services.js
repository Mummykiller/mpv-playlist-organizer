// background/core_services.js

import { nativeLink } from "../utils/nativeLink.js";
import { broadcastLog, broadcastToTabs } from "./messaging.js";
import { storage } from "./storage_instance.js";

/**
 * core_services.js
 * High-level orchestration services that might depend on both storage and native connection.
 */

export { storage, broadcastLog, broadcastToTabs };

export const _syncToNativeHostFile = async (folderId = null) => {
	try {
		await nativeLink.syncToFile(folderId);
	} catch (e) {
		console.error(`[CoreSync] ${e.message}`);
		broadcastLog({
			text: `[Background]: Sync failed: ${e.message}`,
			type: "error",
		});
	}
};

export const debouncedSyncToNativeHostFile = (
	folderId = null,
	immediate = false,
) => {
	if (immediate) {
		_syncToNativeHostFile(folderId);
		chrome.alarms.clear("sync-to-native-host");
	} else {
		chrome.alarms.create("sync-to-native-host", { delayInMinutes: 1 });
	}
};
