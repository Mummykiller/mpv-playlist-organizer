// background/handlers/m3u8_scanner.js

let _storage;
let _broadcastLog;
let _broadcastToTabs;

// A simple in-memory cache to avoid sending the same URL repeatedly to a tab.
// The key is the tabId, and the value is the last detected URL.
const lastDetectedUrls = {};
// A map to hold promises for M3U8 detection in temporary tabs.
// The key is the tabId, and the value is { resolve, reject, timeoutId }.
let m3u8DetectionPromises = {};

// Keep track of detected URLs per tab for the UI.
// This is separate from tabUiState in background.js to prevent circular dependency issues
// and to centralize m3u8 detection state management within this module.
let _detectedUrlsState = {};

export function init(dependencies) {
    _storage = dependencies.storage;
    _broadcastLog = dependencies.broadcastLog;
    _broadcastToTabs = dependencies.broadcastToTabs;

    // Register webRequest listener
    chrome.webRequest.onBeforeRequest.addListener(
        (details) => {
            // --- NEW: Inactivity timeout logic for scanner windows ---
            const promiseInfo = m3u8DetectionPromises[details.tabId];
            if (promiseInfo) {
                const INACTIVITY_TIMEOUT_MS = 15000; // 15 seconds of inactivity
                clearTimeout(promiseInfo.timeoutId); // Clear the previous timeout

                // Set a new inactivity timeout
                promiseInfo.timeoutId = setTimeout(() => {
                    // Check if the promise is still pending before rejecting
                    if (m3u8DetectionPromises[details.tabId]) {
                        // Use the reject function from the promise which will also clean up the map entry
                        m3u8DetectionPromises[details.tabId].reject(new Error(`M3U8 detection timed out after ${INACTIVITY_TIMEOUT_MS / 1000} seconds of network inactivity.`));
                    }
                }, INACTIVITY_TIMEOUT_MS);
            }
            // --- END of new logic ---

            // Optimization: Ignore requests originating from our own extension to prevent loops.
            if (details.initiator && details.initiator.startsWith(`chrome-extension://${chrome.runtime.id}`)) {
                return;
            }

            // Check if the URL's path ends with .m3u8.
            try {
                const url = new URL(details.url);
                if (!url.pathname.endsWith('.m3u8')) return;
            } catch (e) {
                return; // Invalid URL, ignore.
            }

            // Avoid sending the same URL repeatedly for the same tab.
            if (lastDetectedUrls[details.tabId] === details.url) {
                return;
            }
            lastDetectedUrls[details.tabId] = details.url;

            // Update state immediately and notify popup
            _detectedUrlsState[details.tabId] = details.url;
            _broadcastToTabs({ action: 'detected_url_changed', tabId: details.tabId, url: details.url });

            // Check if a scanner window is waiting for this URL.
            // Re-use promiseInfo from the inactivity check
            if (promiseInfo) {
                promiseInfo.resolve(details.url);
                return;
            }

            // Send the detected URL to the content script of the tab where the request originated.
            chrome.tabs.sendMessage(details.tabId, { m3u8: details.url })
                .catch(error => {
                    if (!error.message.includes('Receiving end does not exist')) {
                        console.error(`[Background]: Error sending M3U8 URL to tab ${details.tabId}:`, error);
                    }
                });
        },
        {
            urls: ["<all_urls>"],
            types: ["xmlhttprequest", "other", "media", "main_frame"] // Listen on more types for broader compatibility
        }
    );

    // Register tab lifecycle listeners
    chrome.tabs.onRemoved.addListener((tabId) => {
        if (_detectedUrlsState[tabId]) {
            delete _detectedUrlsState[tabId];
        }
        // If a tab with a pending detection is closed, reject the promise.
        if (m3u8DetectionPromises[tabId]) {
            m3u8DetectionPromises[tabId].reject(new Error('Tab was closed before M3U8 detection completed.'));
        }
        if (lastDetectedUrls[tabId]) {
            delete lastDetectedUrls[tabId];
        }
    });

    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
        if (changeInfo.status === 'loading') {
            // A new page is loading, so reset the stream detection caches for this tab.
            if (lastDetectedUrls[tabId]) delete lastDetectedUrls[tabId];
            if (_detectedUrlsState[tabId]) delete _detectedUrlsState[tabId];
            _broadcastToTabs({ action: 'detected_url_changed', tabId: tabId, url: null }); // Notify UI that detected URL is cleared
        }
    });
}

/**
 * Creates a new popup window for the user to interact with to trigger stream detection.
 * @param {string} url The URL to open in the new window.
 * @returns {Promise<chrome.tabs.Tab>} A promise that resolves with the tab object of the new window.
 */
async function _createScannerWindow(url) {
    let finalUrl = url;
    try {
        // Add a parameter to the URL to identify it as a scanner window.
        // This prevents the content script from injecting the UI into it.
        const scannerUrl = new URL(url);
        scannerUrl.searchParams.set('mpv_playlist_scanner', 'true');
        finalUrl = scannerUrl.toString();
    } catch (e) {
        // If URL parsing fails, use the original URL. This is a fallback.
        console.warn(`Could not parse URL to add scanner parameter: ${url}`);
    }

    const newWindow = await chrome.windows.create({
        url: finalUrl,
        type: 'popup',
        width: 1024,
        height: 768,
    });

    if (!newWindow?.tabs?.length) {
        throw new Error("Failed to create scanner window.");
    }

    _broadcastLog({
        text: `[Scanner]: A scanner window has been opened. Please manually start the video in that window to capture the stream.`,
        type: 'info'
    });

    return newWindow.tabs[0];
}

/**
 * Waits for the webRequest listener to detect an M3U8 stream in a specific tab.
 * @param {number} tabId The ID of the tab to listen on.
 * @param {number} timeoutInSeconds The number of seconds to wait before timing out.
 * @returns {Promise<string>} A promise that resolves with the detected M3U8 URL.
 */
async function _waitForM3u8Detection(tabId, timeoutInSeconds) {
    return new Promise((resolve, reject) => {
        const timeoutDuration = timeoutInSeconds * 1000;

        const timeoutId = setTimeout(() => {
            if (m3u8DetectionPromises[tabId]) {
                delete m3u8DetectionPromises[tabId];
                reject(new Error(`M3U8 detection timed out. User did not initiate video playback within ${timeoutInSeconds} seconds.`));
            }
        }, timeoutDuration);

        // Store the promise's handlers so the webRequest listener can use them.
        m3u8DetectionPromises[tabId] = {
            resolve: (url) => {
                clearTimeout(timeoutId);
                delete m3u8DetectionPromises[tabId];
                resolve(url);
            },
            reject: (err) => {
                clearTimeout(timeoutId);
                delete m3u8DetectionPromises[tabId];
                reject(err);
            },
            timeoutId: timeoutId // Store the initial timeout ID
        };
    });
}

/**
 * Switches focus back to the user's original tab and window after scanning is complete.
 * @param {chrome.tabs.Tab} originalTab The tab object to return focus to.
 */
async function _focusOriginalTab(originalTab) {
    if (!originalTab) return;
    if (originalTab.windowId) {
        await chrome.windows.update(originalTab.windowId, { focused: true }).catch(() => {});
    }
    if (originalTab.id) {
        await chrome.tabs.update(originalTab.id, { active: true }).catch(() => {});
    }
}

/**
 * Opens a URL in a hidden tab to find an M3U8 stream URL.
 * @param {string} url The page URL to scan.
 * @returns {Promise<{url: string, title: string, scannerTab: chrome.tabs.Tab}>} A promise that resolves with the detected URL, title, and the scanner tab.
 */
export async function findM3u8InUrl(url, originalTab) {
    let scannerTab; // The tab inside the new window

    try {
        const data = await _storage.get();
        const timeoutInSeconds = data.settings.ui_preferences.global.stream_scanner_timeout || 60;

        scannerTab = await _createScannerWindow(url);

        await new Promise((resolve) => {
            const listener = (tabId, changeInfo) => {
                if (tabId === scannerTab.id && changeInfo.status === 'complete') {
                    chrome.tabs.onUpdated.removeListener(listener);
                    resolve();
                }
            };
            chrome.tabs.onUpdated.addListener(listener);
        });

        const streamPromise = _waitForM3u8Detection(scannerTab.id, timeoutInSeconds);
        const titlePromise = chrome.tabs.sendMessage(scannerTab.id, { action: 'scrape_and_get_details' })
            .catch(() => ({ title: url, url: url }));

        let detectedStreamUrl = null;
        let scrapedDetails = { title: url, url: url };
        try {
            [detectedStreamUrl, scrapedDetails] = await Promise.all([streamPromise, titlePromise]);
        } catch (error) {
            _broadcastLog({ text: `[Scanner]: Stream detection failed or timed out: ${error.message}`, type: 'warning' });
            // This block will be entered if the stream detection times out or the tab is closed.
            // We only need the title, so we'll still wait for that promise to resolve.
            scrapedDetails = await titlePromise;
        }

        const finalUrl = detectedStreamUrl; // Only use the detected stream.
        const finalTitle = scrapedDetails.title;

        return { url: finalUrl, title: finalTitle, scannerTab: scannerTab, originalUrl: url };

    } finally {
        await _focusOriginalTab(originalTab);
    }
}

// Handler for the 'get_detected_url_for_tab' action, to be called from background.js
export function handleGetDetectedUrlForTab(tabId) {
    return _detectedUrlsState[tabId] || null;
}