/**
 * A promise-based wrapper for chrome.runtime.sendMessage.
 * This is needed because the renderer is used in contexts (content script)
 * that don't have this function defined globally.
 * @param {object} payload The message to send.
 * @returns {Promise<any>} A promise that resolves with the response.
 */
const sendMessageAsyncInternal = (payload) => new Promise((resolve, reject) => {
    // Safety check: if extension context is invalidated, fail gracefully
    if (!chrome.runtime?.id) {
        return reject(new Error("Extension context invalidated."));
    }
    chrome.runtime.sendMessage(payload, (response) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve(response);
    });
});

class AniListRenderer {
    // --- Memory Cache & In-flight Tracker ---
    static _cache = null;
    static _cacheTimestamp = 0;
    static _inFlightRequest = null;
    static CACHE_DURATION_MS = 60 * 1000; // 1 minute local cache

    /**
     * Fetches AniList releases from the background script.
     * @param {boolean} forceRefresh - Whether to force a refresh of the data.
     * @returns {Promise<object>} The release data.
     */
    static async fetchReleases(forceRefresh = false) {
        const now = Date.now();

        // 1. Check Memory Cache (unless forcing refresh)
        if (!forceRefresh && this._cache && (now - this._cacheTimestamp < this.CACHE_DURATION_MS)) {
            return this._cache;
        }

        // 2. Check In-flight Request (deduplicate simultaneous calls)
        if (this._inFlightRequest && !forceRefresh) {
            return this._inFlightRequest;
        }

        this._inFlightRequest = (async () => {
            try {
                const response = await sendMessageAsyncInternal({ action: 'get_anilist_releases', force: forceRefresh });
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

    /**
     * Renders the list of AniList releases into a given container element.
     * @param {HTMLElement} container - The element to render the list into.
     * @param {object} releases - The release data object from fetchReleases.
     */
    static render(container, releases) {
        container.innerHTML = ''; // Clear spinner or old content

        if (!releases || !releases.releases || releases.releases.length === 0) {
            const noReleasesItem = document.createElement('li');
            noReleasesItem.className = 'anilist-empty-message';
            noReleasesItem.textContent = 'No anime episodes found releasing today.';
            container.appendChild(noReleasesItem);
            return;
        }

        const list = document.createElement('ul');
        list.className = 'anilist-releases-list';

        releases.releases.forEach(item => {
            const listItem = document.createElement('li');
            listItem.className = 'anilist-release-item';

            const imageLink = document.createElement('a');
            imageLink.href = `https://anilist.co/anime/${item.id}`;
            imageLink.target = '_blank';
            imageLink.title = 'View on AniList';

            const coverImage = document.createElement('img');
            coverImage.src = item.cover_image;
            coverImage.alt = `${item.title} cover`;
            coverImage.className = 'release-cover-image';
            imageLink.appendChild(coverImage);

            const itemDetails = document.createElement('div');
            itemDetails.className = 'release-details';

            const title = document.createElement('div');
            title.className = 'release-title';
            title.textContent = item.title;
            title.title = item.title;

            const episodeInfo = document.createElement('div');
            episodeInfo.className = 'release-episode-info';
            episodeInfo.textContent = `Ep ${item.episode}`;

            const bottomInfo = document.createElement('div');
            bottomInfo.className = 'release-bottom-info';

            const airingTime = document.createElement('div');
            airingTime.className = 'release-airing-time';
            airingTime.textContent = item.airing_at;

            bottomInfo.append(episodeInfo, airingTime);
            itemDetails.append(title, bottomInfo);

            listItem.append(imageLink, itemDetails);
            list.appendChild(listItem);
        });
        container.appendChild(list);
    }
}