// background/handlers/dependency_anilist.js

import { nativeLink } from "../../utils/nativeLink.js";
import { broadcastLog } from "../messaging.js";
import { storage } from "../storage_instance.js";

// In-flight request tracker to prevent redundant calls to the native host
let _inFlightReleasesRequest = null;

export async function handleGetAnilistReleases(request) {
	const forceRefresh = request.force ?? false;
	const daysOffset = request.days ?? 0;
	const data = await storage.get();
	const isCacheDisabled =
		data.settings.ui_preferences.global.disable_anilist_cache ?? false;

	// Use a composite key for in-flight requests to handle different days
	const requestKey = `anilist_${daysOffset}_${forceRefresh}`;
	if (_inFlightReleasesRequest === requestKey && !isCacheDisabled)
		return _inFlightReleasesRequest;

		try {
			const deleteCache = isCacheDisabled;
			const nativeResponse = await nativeLink.getAnilistReleases({
				force: forceRefresh || isCacheDisabled, // Removed '|| daysOffset !== 0'
				delete_cache: deleteCache,
				is_cache_disabled: isCacheDisabled,
				days: daysOffset,
			});
	
			if (nativeResponse.success && nativeResponse.output) {			try {
				const data = JSON.parse(nativeResponse.output);
				return { success: true, output: data };
			} catch (e) {
				return { success: false, error: `JSON Parse failed: ${e.message}` };
			}
		}
		return nativeResponse;
	} finally {
		_inFlightReleasesRequest = null;
	}
}

export async function handleYtdlpUpdateCheck(request) {
	if (request.log) broadcastLog(request.log);

	const [activeTab] = await chrome.tabs.query({
		active: true,
		currentWindow: true,
	});
	const tabId = activeTab?.id;

	const data = await storage.get();
	const updateBehavior =
		data.settings.ui_preferences.global.ytdlp_update_behavior || "manual";

	if (updateBehavior === "manual")
		return { success: true, message: "Manual mode." };

	if (updateBehavior === "ask") {
		if (!tabId) return { success: false, error: "No active tab." };
		chrome.tabs
			.sendMessage(tabId, { action: "ytdlp_update_confirm" })
			.catch(() => {});
		return { success: true, message: "Confirmation requested." };
	}
	if (updateBehavior === "auto")
		return nativeLink.runYtdlpUpdate();
}

export async function handleUserConfirmedYtdlpUpdate() {
	broadcastLog({
		text: `[Background]: Starting yt-dlp update...`,
		type: "info",
	});
	return nativeLink.runYtdlpUpdate();
}

export async function handleManualYtdlpUpdate() {
	broadcastLog({
		text: `[Background]: Manual yt-dlp update triggered.`,
		type: "info",
	});
	return nativeLink.runYtdlpUpdate();
}
