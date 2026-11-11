// background/core_services.js

import { nativeLink } from "../utils/nativeLink.js";
import { broadcastLog, broadcastToTabs } from "./messaging.js";
import { storage } from "./storage_instance.js";

/**
 * core_services.js
 * High-level orchestration services that might depend on both storage and native connection.
 */

export { storage, broadcastLog, broadcastToTabs };

let syncQueue = Promise.resolve();
const pendingSyncFolders = new Set();
let pendingFullSync = false;

export const _syncToNativeHostFile = async (folderId = null) => {
	if (folderId === null) {
		pendingFullSync = false;
		pendingSyncFolders.clear();
	} else {
		pendingSyncFolders.delete(folderId);
	}
	syncQueue = syncQueue.then(async () => {
		try {
			await nativeLink.syncToFile(folderId);
		} catch (e) {
			console.error(`[CoreSync] ${e.message}`);
			broadcastLog({
				text: `[Background]: Sync failed: ${e.message}`,
				type: "error",
			});
		}
	});
	return syncQueue;
};

export const debouncedSyncToNativeHostFile = (
	folderId = null,
	immediate = false,
) => {
	if (immediate) {
		if (folderId === null) {
			pendingFullSync = false;
			pendingSyncFolders.clear();
		} else {
			pendingSyncFolders.delete(folderId);
		}
		_syncToNativeHostFile(folderId);
		if (!pendingFullSync && pendingSyncFolders.size === 0) {
			chrome.alarms.clear("sync-to-native-host");
		}
	} else {
		if (folderId === null) {
			pendingFullSync = true;
		} else {
			pendingSyncFolders.add(folderId);
		}
		chrome.alarms.create("sync-to-native-host", { delayInMinutes: 1 });
	}
};
