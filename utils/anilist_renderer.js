/**
 * @class AniListRenderer
 */
window.MPV_INTERNAL = window.MPV_INTERNAL || {};

(function() {
    'use strict';

    const MPV = window.MPV_INTERNAL;

    MPV.AniListRenderer = class AniListRenderer {
        static _cache = null;
        static _cacheTimestamp = 0;
        static _inFlightRequest = null;
        static CACHE_DURATION_MS = 60 * 1000;

        static async fetchReleases(forceRefresh = false) {
            const now = Date.now();
            if (!forceRefresh && this._cache && (now - this._cacheTimestamp < this.CACHE_DURATION_MS)) return this._cache;
            if (this._inFlightRequest && !forceRefresh) return this._inFlightRequest;
            this._inFlightRequest = (async () => {
                try {
                    const response = await MPV.sendMessageAsync({ action: 'get_anilist_releases', force: forceRefresh });
                    if (response.success) {
                        this._cache = response.output;
                        this._cacheTimestamp = Date.now();
                        return response.output;
                    }
                    throw new Error(response.error || 'Failed to fetch releases.');
                } finally {
                    this._inFlightRequest = null;
                }
            })();
            return this._inFlightRequest;
        }

        static render(container, releases) {
            if (!container) return;
            container.innerHTML = '';
            if (!releases || !releases.releases || releases.releases.length === 0) {
                container.innerHTML = '<li class="anilist-empty-message">No anime episodes found releasing today.</li>';
                return;
            }
            const list = document.createElement('ul');
            list.className = 'anilist-releases-list';
            releases.releases.forEach(item => {
                const li = document.createElement('li');
                li.className = 'anilist-release-item';
                li.innerHTML = `
                    <a href="https://anilist.co/anime/${item.id}" target="_blank" title="View on AniList">
                        <img src="${item.cover_image}" alt="${item.title}" class="release-cover-image">
                    </a>
                    <div class="release-details">
                        <div class="release-title" title="${item.title}">${item.title}</div>
                        <div class="release-bottom-info">
                            <div class="release-episode-info">Ep ${item.episode}</div>
                            <div class="release-airing-time">${item.airing_at}</div>
                        </div>
                    </div>`;
                list.appendChild(li);
            });
            container.appendChild(list);
        }
    };
})();
