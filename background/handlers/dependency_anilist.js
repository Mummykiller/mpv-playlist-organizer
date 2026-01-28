// background/handlers/dependency_anilist.js

import { nativeLink } from "../../utils/nativeLink.js";
import { broadcastLog } from "../messaging.js";
import { createHandler } from "../handler_factory.js";

// In-flight request tracker to prevent redundant calls to the native host
let _inFlightReleasesRequest = null;

export const handleGetAnilistReleases = createHandler(async ({ request, data }) => {
	const forceRefresh = request.force ?? false;
	const daysOffset = request.days ?? 0;
	const isCacheDisabled = data.settings.uiPreferences.global.disableAnilistCache ?? false;

	const requestKey = `anilist_${daysOffset}_${forceRefresh}`;
	if (_inFlightReleasesRequest === requestKey && !isCacheDisabled) {
		return { success: true, message: "Request already in flight." };
	}

	_inFlightReleasesRequest = requestKey;

	try {
		const nativeResponse = await nativeLink.getAnilistReleases({
			force: forceRefresh || isCacheDisabled,
			deleteCache: isCacheDisabled,
			isCacheDisabled: isCacheDisabled,
			days: daysOffset,
		});

		return nativeResponse;
	} finally {
		_inFlightReleasesRequest = null;
	}
});

export const handleYtdlpUpdateCheck = createHandler(async ({ request, data, sender }) => {
	if (request.log) broadcastLog(request.log);

	const tabId = sender.tab?.id;
	const updateBehavior = data.settings.uiPreferences.global.ytdlpUpdateBehavior || "manual";

	if (updateBehavior === "manual") return { success: true, message: "Manual mode." };

	if (updateBehavior === "ask") {
		if (!tabId) return { success: false, error: "No active tab." };
		chrome.tabs.sendMessage(tabId, { action: "ytdlp_update_confirm" }).catch(() => {});
		return { success: true, message: "Confirmation requested." };
	}
	
	if (updateBehavior === "auto") return nativeLink.runYtdlpUpdate();
});

export const handleUserConfirmedYtdlpUpdate = createHandler(async () => {
	broadcastLog({ text: `[Background]: Starting yt-dlp update...`, type: "info" });
	return nativeLink.runYtdlpUpdate();
});

export const handleManualYtdlpUpdate = createHandler(async () => {
	broadcastLog({ text: `[Background]: Manual yt-dlp update triggered.`, type: "info" });
	return nativeLink.runYtdlpUpdate();
});