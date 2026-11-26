// background/handlers/m3u8_scanner.js

import { broadcastLog, broadcastToTabs } from "../messaging.js";
import { storage } from "../storage_instance.js";

// A simple in-memory cache to avoid sending the same URL repeatedly to a tab.
const lastDetectedUrls = {};
const m3u8DetectionPromises = {};
const _detectedUrlsState = {};
let _onDetectionCallback = null;

const SCANNER_STATE_KEY = "m3u8_scanner_state";

const getSessionStorage = () => {
	if (typeof chrome !== "undefined" && chrome?.storage?.session) {
		return chrome.storage.session;
	}
	return chrome?.storage?.local || null;
};

export const scannerInitPromise = (async () => {
	try {
		const store = getSessionStorage();
		if (!store) return;
		const res = await store.get(SCANNER_STATE_KEY);
		const saved = res?.[SCANNER_STATE_KEY];
		if (!saved || typeof saved !== "object") return;

		if (saved.detectedUrlsState && typeof saved.detectedUrlsState === "object") {
			for (const [tabId, url] of Object.entries(saved.detectedUrlsState)) {
				if (!(tabId in _detectedUrlsState) && typeof url === "string") {
					_detectedUrlsState[tabId] = url;
				}
			}
		}
		if (saved.lastDetectedUrls && typeof saved.lastDetectedUrls === "object") {
			for (const [tabId, entry] of Object.entries(saved.lastDetectedUrls)) {
				if (!(tabId in lastDetectedUrls) && entry && typeof entry.url === "string") {
					lastDetectedUrls[tabId] = entry;
				}
			}
		}
	} catch (e) {
		console.debug("[Scanner] Failed to rehydrate state:", e?.message || e);
	}
})();

function persistScannerState() {
	try {
		const store = getSessionStorage();
		if (!store) return;
		scannerInitPromise
			.then(() =>
				store.set({
					[SCANNER_STATE_KEY]: {
						detectedUrlsState: { ..._detectedUrlsState },
						lastDetectedUrls: { ...lastDetectedUrls },
					},
				}),
			)
			.catch(() => {});
	} catch (e) {
		console.debug("[Scanner] Failed to persist state:", e?.message || e);
	}
}

export function setDetectionCallback(cb) {
	_onDetectionCallback = cb;
}

function clearDetectedUrl(tabId) {
	delete lastDetectedUrls[tabId];
	delete _detectedUrlsState[tabId];
	persistScannerState();
	broadcastToTabs({
		action: "detected_url_changed",
		tabId: tabId,
		url: null,
	});
}

// We use an auto-init pattern since this module needs to register listeners immediately
function setupListeners() {
	if (!chrome?.webRequest?.onBeforeRequest) return;
	chrome.webRequest.onBeforeRequest.addListener(
		(details) => {
			if (typeof details.tabId !== "number" || details.tabId < 0) return;

			let pathname = "";
			try {
				pathname = new URL(details.url).pathname.toLowerCase();
			} catch {
				pathname = (details.url || "").split(/[?#]/)[0].toLowerCase();
			}
			const isM3u8 = pathname.endsWith(".m3u8");
			const isMp4 = pathname.endsWith(".mp4");

			if (!isM3u8 && !isMp4) return;

			const promiseInfo = m3u8DetectionPromises[details.tabId];
			if (promiseInfo) {
				// Respect user preference for timeout instead of hardcoded 15s
				storage.get().then((data) => {
					const activePromise = m3u8DetectionPromises[details.tabId];
					if (!activePromise || activePromise !== promiseInfo) return;
					const timeoutMs =
						(data.settings.uiPreferences.global.streamScannerTimeout || 60) *
						1000;
					clearTimeout(activePromise.timeoutId);
					activePromise.timeoutId = setTimeout(() => {
						if (m3u8DetectionPromises[details.tabId]) {
							m3u8DetectionPromises[details.tabId].reject(
								new Error(
									`Stream detection timed out after ${timeoutMs / 1000}s.`,
								),
							);
						}
					}, timeoutMs);
				});
			}

			const detectedUrl = details.url;
			const typeLabel = isM3u8 ? "M3U8" : "MP4";

			const now = Date.now();
			const lastData = lastDetectedUrls[details.tabId];
			if (
				lastData &&
				lastData.url === detectedUrl &&
				now - lastData.timestamp < 2000
			) {
				return;
			}
			lastDetectedUrls[details.tabId] = { url: detectedUrl, timestamp: now };

			broadcastLog({
				text: `[Scanner]: Detected ${typeLabel} stream: ${detectedUrl}`,
				type: "info",
			});

			_detectedUrlsState[details.tabId] = detectedUrl;
			persistScannerState();
			
			if (_onDetectionCallback) {
				_onDetectionCallback(detectedUrl, details.tabId);
			}

			broadcastToTabs({
				action: "detected_url_changed",
				tabId: details.tabId,
				url: detectedUrl,
			});

			if (promiseInfo) {
				promiseInfo.resolve(detectedUrl);
				return;
			}
		},
		{
			urls: ["<all_urls>"],
			types: ["xmlhttprequest", "other", "media", "main_frame", "sub_frame"],
		},
	);

	chrome.tabs.onRemoved.addListener(async (tabId) => {
		await scannerInitPromise;
		delete _detectedUrlsState[tabId];
		delete lastDetectedUrls[tabId];
		persistScannerState();
		if (m3u8DetectionPromises[tabId]) {
			m3u8DetectionPromises[tabId].reject(new Error("Tab closed."));
		}
	});

	chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
		const changedUrl = changeInfo?.url;
		const status = changeInfo?.status;
		const tabUrl = tab?.url;
		await scannerInitPromise;
		if (changedUrl) {
			clearDetectedUrl(tabId);
		} else if (
			status === "loading" &&
			tabUrl &&
			!tabUrl.startsWith("chrome")
		) {
			const now = Date.now();
			const lastData = lastDetectedUrls[tabId];
			if (!lastData || now - lastData.timestamp > 5000) {
				clearDetectedUrl(tabId);
			}
		}
	});
}

// Call setup immediately on load
setupListeners();

/**
 * Creates a new popup window for the user to interact with to trigger stream detection.
 * @param {string} url The URL to open in the new window.
 * @returns {Promise<chrome.tabs.Tab>} A promise that resolves with the tab object of the new window.
 */
async function _createScannerWindow(url) {
	let finalUrl = url;
	try {
		const scannerUrl = new URL(url);
		scannerUrl.searchParams.set("mpv_playlist_scanner", "true");
		finalUrl = scannerUrl.toString();
	} catch (e) {
		console.warn(`Could not parse URL to add scanner parameter: ${url}`);
	}

	const newWindow = await chrome.windows.create({
		url: finalUrl,
		type: "popup",
		width: 1024,
		height: 768,
	});

	if (!newWindow?.tabs?.length) {
		throw new Error("Failed to create scanner window.");
	}

	broadcastLog({
		text: `[Scanner]: A scanner window has been opened. Please manually start the video in that window to capture the stream.`,
		type: "info",
	});

	return newWindow.tabs[0];
}

/**
 * Waits for the webRequest listener to detect an M3U8 or MP4 stream in a specific tab.
 * @param {number} tabId The ID of the tab to listen on.
 * @param {number} timeoutInSeconds The number of seconds to wait before timing out.
 * @returns {Promise<string>} A promise that resolves with the detected stream URL.
 */
async function _waitForM3u8Detection(tabId, timeoutInSeconds) {
	await scannerInitPromise;
	// Refinement 1: Check if already detected during the tab's loading phase
	if (_detectedUrlsState[tabId]) {
		return _detectedUrlsState[tabId];
	}

	return new Promise((resolve, reject) => {
		const timeoutDuration = timeoutInSeconds * 1000;

		const timeoutId = setTimeout(() => {
			if (m3u8DetectionPromises[tabId]) {
				delete m3u8DetectionPromises[tabId];
				reject(
					new Error(
						`Stream detection timed out. User did not initiate video playback within ${timeoutInSeconds} seconds.`,
					),
				);
			}
		}, timeoutDuration);

		// Store the promise's handlers so the webRequest listener can use them.
		const promiseEntry = {
			resolve: (url) => {
				clearTimeout(promiseEntry.timeoutId);
				delete m3u8DetectionPromises[tabId];
				resolve(url);
			},
			reject: (err) => {
				clearTimeout(promiseEntry.timeoutId);
				delete m3u8DetectionPromises[tabId];
				reject(err);
			},
			timeoutId: timeoutId, // Store the initial timeout ID
		};
		m3u8DetectionPromises[tabId] = promiseEntry;
	});
}

/**
 * Checks whether a tab title is provisional/loading (e.g., URL, hostname, or generic placeholder).
 */
export function isProvisionalTabTitle(title, url = null) {
	if (!title || typeof title !== "string") return true;
	const cleanTitle = title.replace(/^\(\d+\)\s*/, "").trim();
	if (!cleanTitle || cleanTitle.length < 2 || !/[\p{L}\p{N}]/u.test(cleanTitle)) {
		return true;
	}

	if (url && typeof url === "string") {
		const cleanUrl = url.trim();
		if (cleanTitle === cleanUrl) return true;
		try {
			const hostname = new URL(cleanUrl).hostname.replace(/^www\./, "").toLowerCase();
			if (hostname && cleanTitle.toLowerCase() === hostname) return true;
		} catch (e) {
			console.debug("[Scanner] Ignoring malformed URL during provisional check:", e?.message || e);
		}
	}

	const provisionalPatterns = [
		/^loading\.{0,3}$/i,
		/^connecting\.{0,3}$/i,
		/^please wait\.{0,3}$/i,
		/^untitled$/i,
		/^youtube$/i,
		/^animeheaven\.me$/i,
		/^animepahe$/i,
		/^gogoanime$/i,
	];
	return provisionalPatterns.some((p) => p.test(cleanTitle));
}

/**
 * Safely attempts to scrape details from a tab with retries and readiness checks.
 */
export async function _safeScrapeDetails(
	tabId,
	detectedUrl,
	fallbackTitle,
	originPageUrl = null,
	originTitle = null,
	options = {},
) {
	const maxRetries = 2;
	const retryDelays = [200, 500];
	const timeoutMs =
		typeof options?.timeoutMs === "number" && options.timeoutMs > 0
			? options.timeoutMs
			: 1500;

	for (let i = 0; i <= maxRetries; i++) {
		try {
			// Verify tab exists and is ready
			const tab = await new Promise((resolve) => {
				chrome.tabs.get(tabId, (tab) => {
					if (chrome.runtime.lastError) resolve(null);
					else resolve(tab);
				});
			});

			if (!tab) return { title: fallbackTitle, url: detectedUrl };

			// If tab has already moved away from the original page URL, stop immediately
			if (originPageUrl && tab.url !== originPageUrl) {
				console.warn("[Scanner] Tab URL changed. Aborting.", {
					current: tab.url,
					origin: originPageUrl,
				});
				return { title: fallbackTitle, url: detectedUrl, isProvisional: true };
			}

			// Guard: Only enforce title mismatch when originPageUrl is unavailable and originTitle was already non-provisional,
			// so loading/SPA title updates on the same URL are never aborted.
			if (
				!originPageUrl &&
				originTitle &&
				tab.title &&
				tab.title !== originTitle &&
				!isProvisionalTabTitle(originTitle, detectedUrl)
			) {
				const cleanCurrent = tab.title.replace(/^\(\d+\)\s*/, "").trim();
				const cleanOrigin = originTitle.replace(/^\(\d+\)\s*/, "").trim();

				if (cleanCurrent !== cleanOrigin) {
					console.warn(
						"[Scanner] Tab title changed before scrape. Aborting to prevent mismatch.",
						{
							current: cleanCurrent,
							origin: cleanOrigin,
						},
					);
					return { title: fallbackTitle, url: detectedUrl, isProvisional: true };
				}
			}

			// Attempt message immediately regardless of tab.status
			const response = await chrome.tabs.sendMessage(tabId, {
				action: "scrape_and_get_details",
				detectedUrl: detectedUrl,
				originPageUrl: originPageUrl,
				timeoutMs: timeoutMs,
			});

			if (response && response.title) {
				return response;
			}
		} catch (e) {
			if (i < maxRetries) {
				await new Promise((r) => setTimeout(r, retryDelays[i] ?? 500));
			}
		}
	}
	return { title: fallbackTitle, url: detectedUrl };
}

/**
 * Switches focus back to the user's original tab and window after scanning is complete.
 * @param {chrome.tabs.Tab} originalTab The tab object to return focus to.
 */
async function _focusOriginalTab(originalTab) {
	if (!originalTab) return;
	try {
		if (originalTab.windowId) {
			// Verify window still exists
			const win = await new Promise((resolve) => {
				chrome.windows.get(originalTab.windowId, (win) => {
					if (chrome.runtime.lastError) resolve(null);
					else resolve(win);
				});
			});
			if (win) {
				await chrome.windows
					.update(originalTab.windowId, { focused: true })
					.catch(() => {});
			}
		}
		if (originalTab.id) {
			// Verify tab still exists
			const tab = await new Promise((resolve) => {
				chrome.tabs.get(originalTab.id, (tab) => {
					if (chrome.runtime.lastError) resolve(null);
					else resolve(tab);
				});
			});
			if (tab) {
				await chrome.tabs
					.update(originalTab.id, { active: true })
					.catch(() => {});
			}
		}
	} catch (e) {
		console.debug("[Scanner] Focus restoration failed:", e?.message || e);
	}
}

/**
 * Opens a URL in a hidden tab to find an M3U8 or MP4 stream URL.
 * @param {string} url The page URL to scan.
 * @returns {Promise<{url: string, title: string, scannerTab: chrome.tabs.Tab}>} A promise that resolves with the detected URL, title, and the scanner tab.
 */
export async function findM3u8InUrl(url, originalTab) {
	let scannerTab; // The tab inside the new window

	try {
		const data = await storage.get();
		const timeoutInSeconds =
			data.settings.uiPreferences.global.streamScannerTimeout || 60;

		scannerTab = await _createScannerWindow(url);

		if (scannerTab.status !== "complete") {
			const loadTimeoutMs = Math.max(timeoutInSeconds, 15) * 1000;
			await new Promise((resolve, reject) => {
				let settled = false;
				let timeoutId = null;
				const cleanup = () => {
					if (timeoutId !== null) {
						clearTimeout(timeoutId);
						timeoutId = null;
					}
					chrome.tabs.onUpdated.removeListener(onUpdated);
					chrome.tabs.onRemoved.removeListener(onRemoved);
				};
				const settle = (fn, arg) => {
					if (settled) return;
					settled = true;
					cleanup();
					fn(arg);
				};
				const onUpdated = (tabId, changeInfo) => {
					if (tabId === scannerTab.id && changeInfo.status === "complete") {
						settle(resolve);
					}
				};
				const onRemoved = (tabId) => {
					if (tabId === scannerTab.id) {
						settle(
							reject,
							new Error("Scanner window was closed before loading completed."),
						);
					}
				};
				chrome.tabs.onUpdated.addListener(onUpdated);
				chrome.tabs.onRemoved.addListener(onRemoved);
				timeoutId = setTimeout(() => {
					settle(
						reject,
						new Error(
							`Scanner window timed out waiting for page load after ${loadTimeoutMs / 1000}s.`,
						),
					);
				}, loadTimeoutMs);

				// Re-query tab status after registering listeners to close any completion race
				if (chrome.tabs.get) {
					chrome.tabs.get(scannerTab.id, (currentTab) => {
						if (chrome.runtime?.lastError || !currentTab) {
							settle(
								reject,
								new Error("Scanner window was closed before loading completed."),
							);
						} else if (currentTab.status === "complete") {
							settle(resolve);
						}
					});
				}
			});
		}

		const streamPromise = _waitForM3u8Detection(
			scannerTab.id,
			timeoutInSeconds,
		);

		let detectedStreamUrl = null;
		let scrapedDetails = { title: url, url: url };
		try {
			detectedStreamUrl = await streamPromise;

			// Refinement 3: Settling delay after detection
			await new Promise((r) => setTimeout(r, 500));

			// Refinement 2: Safe scraping with fallback
			scrapedDetails = await _safeScrapeDetails(
				scannerTab.id,
				detectedStreamUrl,
				"Scanned Stream",
			);
		} catch (error) {
			broadcastLog({
				text: `[Scanner]: Stream detection failed or timed out: ${error.message}`,
				type: "warning",
			});
			// Fallback scrape if detection fails
			scrapedDetails = await _safeScrapeDetails(scannerTab.id, null, url);
		}

		const finalUrl = detectedStreamUrl; // Only use the detected stream.
		const finalTitle = scrapedDetails.title;

		return {
			url: finalUrl,
			title: finalTitle,
			scannerTab: finalUrl ? scannerTab : null,
			originalUrl: url,
		};
	} finally {
		await _focusOriginalTab(originalTab);
	}
}

// Handler for the 'get_detected_url_for_tab' action, to be called from background.js

export async function handleGetDetectedUrlForTab(tabId) {
	await scannerInitPromise;
	return _detectedUrlsState[tabId] || null;
}

export function handleUpdateDetectedUrlForTab(tabId, url) {
	if (url) {
		_detectedUrlsState[tabId] = url;
	} else {
		delete _detectedUrlsState[tabId];
	}
	persistScannerState();
}
