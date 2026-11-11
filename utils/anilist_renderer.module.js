/**
 * ES Module version of AniListRenderer for Background/Module context.
 */
import { sendMessageAsync } from "./commUtils.module.js";

export class AniListRenderer {
	static _cache = null;
	static _cacheTimestamp = 0;
	static _inFlightRequests = new Map();
	static CACHE_DURATION_MS = 60 * 1000;

	static async fetchReleases(forceRefresh = false, daysOffset = 0) {
		const now = Date.now();
		// Only use cache for 'today' (offset 0)
		if (
			daysOffset === 0 &&
			!forceRefresh &&
			AniListRenderer._cache &&
			now - AniListRenderer._cacheTimestamp < AniListRenderer.CACHE_DURATION_MS
		)
			return AniListRenderer._cache;

		if (AniListRenderer._inFlightRequests.has(daysOffset) && !forceRefresh)
			return AniListRenderer._inFlightRequests.get(daysOffset);

		const requestPromise = (async () => {
			try {
				const response = await sendMessageAsync({
					action: "get_anilist_releases",
					force: forceRefresh,
					days: daysOffset,
				});
				if (response.success) {
					if (daysOffset === 0) {
						AniListRenderer._cache = response.output;
						AniListRenderer._cacheTimestamp = Date.now();
					}
					return response.output;
				}
				throw new Error(response.error || "Failed to fetch releases.");
			} finally {
				if (AniListRenderer._inFlightRequests.get(daysOffset) === requestPromise) {
					AniListRenderer._inFlightRequests.delete(daysOffset);
				}
			}
		})();
		AniListRenderer._inFlightRequests.set(daysOffset, requestPromise);
		return requestPromise;
	}

	static render(container, releases, offset = 0) {
		if (!container) return;

		// Find existing list and remove it (to preserve nav controls)
		const oldList = container.querySelector(
			".anilist-releases-list, .anilist-empty-message",
		);
		if (oldList) oldList.remove();

		if (!releases || !releases.releases || releases.releases.length === 0) {
			const emptyMsg = document.createElement("div");
			emptyMsg.className = "anilist-empty-message";
			emptyMsg.textContent =
				offset === 0
					? "No anime episodes found releasing today."
					: "No anime episodes found for this day.";
			container.appendChild(emptyMsg);
			return;
		}
		const list = document.createElement("ul");
		list.className = "anilist-releases-list";
		releases.releases.forEach((item) => {
			const li = document.createElement("li");
			li.className = "anilist-release-item";

			const link = document.createElement("a");
			const safeId = encodeURIComponent(String(item.id || ""));
			link.href = `https://anilist.co/anime/${safeId}`;
			link.target = "_blank";
			link.rel = "noopener noreferrer";
			link.title = "View on AniList";

			const img = document.createElement("img");
			const coverUrl = String(item.coverImage || "");
			if (coverUrl.startsWith("https://") || coverUrl.startsWith("http://")) {
				img.src = coverUrl;
			}
			img.alt = String(item.title || "");
			img.className = "release-cover-image";
			link.appendChild(img);

			const details = document.createElement("div");
			details.className = "release-details";

			const titleDiv = document.createElement("div");
			titleDiv.className = "release-title";
			titleDiv.title = String(item.title || "");
			titleDiv.textContent = String(item.title || "");

			const bottomInfo = document.createElement("div");
			bottomInfo.className = "release-bottom-info";

			const epInfo = document.createElement("div");
			epInfo.className = "release-episode-info";
			epInfo.textContent = `Ep ${item.episode ?? ""}`;

			const airingTime = document.createElement("div");
			airingTime.className = "release-airing-time";
			airingTime.textContent = String(item.airingAt || "");

			bottomInfo.append(epInfo, airingTime);
			details.append(titleDiv, bottomInfo);
			li.append(link, details);
			list.appendChild(li);
		});
		container.appendChild(list);
	}
}
