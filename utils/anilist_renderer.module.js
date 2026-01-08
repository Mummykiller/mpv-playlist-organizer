/**
 * ES Module version of AniListRenderer for Background/Module context.
 */
import { sendMessageAsync } from './commUtils.module.js';

export class AniListRenderer {
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
                const response = await sendMessageAsync({ action: 'get_anilist_releases', force: forceRefresh });
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
            container.innerHTML = '<li>No anime episodes found releasing today.</li>';
            return;
        }
    }
}
