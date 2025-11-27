/**
 * A promise-based wrapper for chrome.runtime.sendMessage.
 * This is needed because the renderer is used in contexts (content script)
 * that don't have this function defined globally.
 * @param {object} payload The message to send.
 * @returns {Promise<any>} A promise that resolves with the response.
 */
const sendMessageAsyncInternal = (payload) => new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve(response);
    });
});

class AniListRenderer {
    /**
     * Fetches AniList releases from the background script.
     * @param {boolean} forceRefresh - Whether to force a refresh of the data.
     * @returns {Promise<object>} The release data.
     */
    static async fetchReleases(forceRefresh = false) {
        const response = await sendMessageAsyncInternal({ action: 'get_anilist_releases', force: forceRefresh });
        if (response.success) {
            return response.output;
        }
        throw new Error(response.error || 'Failed to fetch releases.');
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

// Make the class available in both module and classic script environments.
if (typeof window !== 'undefined') {
    window.AniListRenderer = AniListRenderer;
}