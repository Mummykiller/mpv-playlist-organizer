// background/handlers/dependency_anilist.js

import { getActiveTab } from "../../utils/commUtils.module.js";
import { nativeLink } from "../../utils/nativeLink.js";
import { broadcastLog } from "../messaging.js";
import { createHandler } from "../handler_factory.js";

// In-flight request tracker to prevent redundant calls to the native host
const _inFlightReleasesRequests = new Map();

export const handleGetAnilistReleases = createHandler(async ({ request, data }) => {
	const forceRefresh = request.force ?? false;
	const daysOffset = request.days ?? 0;
	const isCacheDisabled = data.settings.uiPreferences.global.disableAnilistCache ?? false;

	const requestKey = `anilist_${daysOffset}_${forceRefresh}`;
	if (!isCacheDisabled && _inFlightReleasesRequests.has(requestKey)) {
		return _inFlightReleasesRequests.get(requestKey);
	}

	const requestPromise = (async () => {
		try {
			return await nativeLink.getAnilistReleases({
				force: forceRefresh || isCacheDisabled,
				deleteCache: isCacheDisabled,
				isCacheDisabled: isCacheDisabled,
				days: daysOffset,
			});
		} finally {
			if (_inFlightReleasesRequests.get(requestKey) === requestPromise) {
				_inFlightReleasesRequests.delete(requestKey);
			}
		}
	})();

	if (!isCacheDisabled) {
		_inFlightReleasesRequests.set(requestKey, requestPromise);
	}

	return requestPromise;
}, {
	manualPersistence: true,
});

export const handleYtdlpUpdateCheck = createHandler(async ({ request, data, sender }) => {
	const payload = request?.request || request || {};
	const actualSender = sender?.tab ? sender : (request?.sender || sender || null);
	if (payload.log) broadcastLog(payload.log);

	const activeTab = !actualSender?.tab?.id ? await getActiveTab() : null;
	const tabId = actualSender?.tab?.id || activeTab?.id;
	const updateBehavior = data.settings.uiPreferences.global.ytdlpUpdateBehavior || "manual";

	if (updateBehavior === "manual") return { success: true, message: "Manual mode." };

	if (updateBehavior === "ask") {
		if (!tabId) return { success: false, error: "No active tab." };
		chrome.tabs.sendMessage(tabId, { action: "ytdlp_update_confirm" }).catch(() => {});
		return { success: true, message: "Confirmation requested." };
	}
	
	if (updateBehavior === "auto") return nativeLink.runYtdlpUpdate();
	return { success: true };
}, {
	manualPersistence: true,
});

export const handleUserConfirmedYtdlpUpdate = createHandler(async () => {
	broadcastLog({ text: `[Background]: Starting yt-dlp update...`, type: "info" });
	return nativeLink.runYtdlpUpdate();
}, {
	manualPersistence: true,
});

export const handleManualYtdlpUpdate = createHandler(async () => {
	broadcastLog({ text: `[Background]: Manual yt-dlp update triggered.`, type: "info" });
	return nativeLink.runYtdlpUpdate();
}, {
	manualPersistence: true,
});