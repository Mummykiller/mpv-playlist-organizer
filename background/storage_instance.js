// background/storage_instance.js
import { StorageManager } from "../utils/storageManager.js";

let _logBroadcaster = null;

export function setStorageLogBroadcaster(fn) {
	_logBroadcaster = typeof fn === "function" ? fn : null;
}

export const storage = new StorageManager("mpv_organizer_data", (logObj) => {
	if (_logBroadcaster) {
		return _logBroadcaster(logObj);
	}
});
