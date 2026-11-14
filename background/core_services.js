// background/core_services.js

import { nativeLink } from "../utils/nativeLink.js";
import { broadcastLog, broadcastToTabs } from "./messaging.js";
import { storage } from "./storage_instance.js";

/**
 * core_services.js
 * High-level orchestration services that might depend on both storage and native connection.
 */

export { storage, broadcastLog, broadcastToTabs };

const SYNC_STATE_KEY = "mpv_pending_sync_state";
const SYNC_ALARM_NAME = "sync-to-native-host";

let syncQueue = Promise.resolve();
const pendingSyncFolders = new Set();
let pendingFullSync = false;

const getSessionStorage = () => {
	if (typeof chrome !== "undefined" && chrome?.storage?.session) {
		return chrome.storage.session;
	}
	if (typeof chrome !== "undefined" && chrome?.storage?.local) {
		return chrome.storage.local;
	}
	return null;
};

const persistPendingSyncState = async () => {
	const store = getSessionStorage();
	if (!store) return;
	try {
		if (!pendingFullSync && pendingSyncFolders.size === 0) {
			await store.remove(SYNC_STATE_KEY);
		} else {
			await store.set({
				[SYNC_STATE_KEY]: {
					pendingFullSync,
					pendingSyncFolders: Array.from(pendingSyncFolders),
				},
			});
		}
	} catch (e) {
		console.error(`[CoreSync] Failed to persist pending sync state: ${e.message}`);
	}
};

const syncInitPromise = (async () => {
	const store = getSessionStorage();
	if (!store) return;
	try {
		const res = await store.get(SYNC_STATE_KEY);
		const saved = res?.[SYNC_STATE_KEY];
		if (saved && typeof saved === "object") {
			if (saved.pendingFullSync) {
				pendingFullSync = true;
			}
			if (Array.isArray(saved.pendingSyncFolders)) {
				for (const id of saved.pendingSyncFolders) {
					if (id) pendingSyncFolders.add(id);
				}
			}
		}
	} catch (e) {
		console.error(`[CoreSync] Failed to restore pending sync state: ${e.message}`);
	}
})();

export const _syncToNativeHostFile = async (folderId = null) => {
	await syncInitPromise;
	if (folderId === null) {
		pendingFullSync = false;
		pendingSyncFolders.clear();
	} else {
		pendingSyncFolders.delete(folderId);
	}
	syncQueue = syncQueue.then(async () => {
		try {
			const res = await nativeLink.syncToFile(folderId);
			if (res && res.success === false) {
				throw new Error(res.error || "Sync failed");
			}
			await persistPendingSyncState();
		} catch (e) {
			if (folderId === null) {
				pendingFullSync = true;
			} else {
				pendingSyncFolders.add(folderId);
			}
			await persistPendingSyncState();
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
			chrome.alarms.clear(SYNC_ALARM_NAME);
		}
	} else {
		if (folderId === null) {
			pendingFullSync = true;
		} else {
			pendingSyncFolders.add(folderId);
		}
		persistPendingSyncState();
		chrome.alarms.create(SYNC_ALARM_NAME, { delayInMinutes: 1 });
	}
};

/**
 * Flushes any pending debounced syncs (either full or per-folder) and clears pending state.
 */
export const flushPendingSync = async () => {
	await syncInitPromise;
	if (pendingFullSync) {
		return _syncToNativeHostFile(null);
	}
	if (pendingSyncFolders.size === 0) {
		return;
	}
	const foldersToSync = Array.from(pendingSyncFolders);
	return Promise.all(foldersToSync.map((id) => _syncToNativeHostFile(id)));
};
