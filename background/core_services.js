// background/core_services.js

import { callNativeHost } from "../utils/nativeConnection.js";
import { broadcastLog, broadcastToTabs } from "./messaging.js";
import { storage } from "./storage_instance.js";

/**
 * core_services.js
 * High-level orchestration services that might depend on both storage and native connection.
 */

export { storage, broadcastLog, broadcastToTabs };

export const _syncToNativeHostFile = async (folderId = null) => {
	const data = await storage.get();
	try {
		const payload = {
			action: "export_data",
		};

		if (folderId && data.folders[folderId]) {
			payload.data = { [folderId]: data.folders[folderId] };
			payload.is_incremental = true;
		} else {
			payload.data = data.folders;
			payload.is_incremental = false;
		}

		await callNativeHost(payload);
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
