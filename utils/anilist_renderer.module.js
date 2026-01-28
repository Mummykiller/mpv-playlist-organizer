/**
 * ES Module version of AniListRenderer for Background/Module context.
 */
import { sendMessageAsync } from "./commUtils.module.js";

export class AniListRenderer {
	static _cache = null;
	static _cacheTimestamp = 0;
	static _inFlightRequest = null;
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

		if (AniListRenderer._inFlightRequest && !forceRefresh)
			return AniListRenderer._inFlightRequest;
		AniListRenderer._inFlightRequest = (async () => {
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
				AniListRenderer._inFlightRequest = null;
			}
		})();
		return AniListRenderer._inFlightRequest;
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
			li.innerHTML = `
                <a href="https://anilist.co/anime/${item.id}" target="_blank" title="View on AniList">
                    <img src="${item.coverImage}" alt="${item.title}" class="release-cover-image">
                </a>
                <div class="release-details">
                    <div class="release-title" title="${item.title}">${item.title}</div>
                    <div class="release-bottom-info">
                        <div class="release-episode-info">Ep ${item.episode}</div>
                        <div class="release-airing-time">${item.airingAt}</div>
                    </div>
                </div>`;
			list.appendChild(li);
		});
		container.appendChild(list);
	}
}
