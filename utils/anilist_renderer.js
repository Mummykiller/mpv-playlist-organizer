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

        static async fetchReleases(forceRefresh = false, daysOffset = 0) {
            const now = Date.now();
            if (daysOffset === 0 && !forceRefresh && this._cache && (now - this._cacheTimestamp < this.CACHE_DURATION_MS)) return this._cache;
            
            if (this._inFlightRequest && !forceRefresh) return this._inFlightRequest;
            this._inFlightRequest = (async () => {
                try {
                    const response = await MPV.sendMessageAsync({ 
                        action: 'get_anilist_releases', 
                        force: forceRefresh,
                        days: daysOffset
                    });
                    if (response.success) {
                        if (daysOffset === 0) {
                            this._cache = response.output;
                            this._cacheTimestamp = Date.now();
                        }
                        return response.output;
                    }
                    throw new Error(response.error || 'Failed to fetch releases.');
                } finally {
                    this._inFlightRequest = null;
                }
            })();
            return this._inFlightRequest;
        }

        static render(container, releases, offset = 0) {
            if (!container) return;
            
            // Efficiently clear container
            while (container.firstChild) {
                container.removeChild(container.lastChild);
            }

            if (!releases || !releases.releases || releases.releases.length === 0) {
                const emptyMsg = document.createElement('div');
                emptyMsg.className = 'anilist-empty-message';
                emptyMsg.textContent = offset === 0 ? 'No anime episodes found releasing today.' : 'No anime episodes found for this day.';
                container.appendChild(emptyMsg);
                return;
            }

            const list = document.createElement('ul');
            list.className = 'anilist-releases-list';
            
            const fragment = document.createDocumentFragment();

            releases.releases.forEach(item => {
                const li = document.createElement('li');
                li.className = 'anilist-release-item';
                
                // Create elements manually for better performance and security than innerHTML
                const link = document.createElement('a');
                link.href = `https://anilist.co/anime/${item.id}`;
                link.target = '_blank';
                link.title = 'View on AniList';

                const img = document.createElement('img');
                img.src = item.cover_image;
                img.alt = item.title;
                img.className = 'release-cover-image';
                img.loading = 'lazy'; // Add lazy loading for images

                link.appendChild(img);
                li.appendChild(link);

                const details = document.createElement('div');
                details.className = 'release-details';

                const title = document.createElement('div');
                title.className = 'release-title';
                title.title = item.title;
                title.textContent = item.title;

                const bottomInfo = document.createElement('div');
                bottomInfo.className = 'release-bottom-info';

                const episodeInfo = document.createElement('div');
                episodeInfo.className = 'release-episode-info';
                episodeInfo.textContent = `Ep ${item.episode}`;

                const airingTime = document.createElement('div');
                airingTime.className = 'release-airing-time';
                airingTime.textContent = item.airing_at;

                bottomInfo.appendChild(episodeInfo);
                bottomInfo.appendChild(airingTime);
                details.appendChild(title);
                details.appendChild(bottomInfo);
                li.appendChild(details);

                fragment.appendChild(li);
            });
            
            list.appendChild(fragment);
            container.appendChild(list);
        }
    };
})();
