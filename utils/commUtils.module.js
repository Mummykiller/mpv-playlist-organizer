/**
 * Shared communication utilities for the MPV Playlist Organizer.
 * ES Module version for Background/Module contexts.
 *
 * !!! SOURCE OF TRUTH !!!
 * This file is the source for 'utils/commUtils.js'.
 * The global version is auto-generated from this file.
 */

/**
 * Settings that are allowed to have domain-level overrides.
 * Shared between background and content scripts.
 */
export const DOMAIN_SPECIFIC_KEYS = [
	"minimized",
	"mode",
	"position",
	"minimizedStubPosition",
	"pinned",
	"anilistPanelVisible",
	"anilistPanelPosition",
	"anilistPanelSize",
];

export function debounce(func, wait) {
	let timeout;
	return function executedFunction(...args) {
		const later = () => {
			clearTimeout(timeout);
			func.apply(this, args);
		};
		clearTimeout(timeout);
		timeout = setTimeout(later, wait);
	};
}

export const sendMessageAsync = (payload) =>
	new Promise((resolve, reject) => {
		if (typeof chrome === "undefined" || !chrome.runtime?.id) {
			return reject(new Error("Extension context invalidated."));
		}
		chrome.runtime.sendMessage(payload, (response) => {
			if (chrome.runtime.lastError)
				return reject(new Error(chrome.runtime.lastError.message));
			resolve(response);
		});
	});

export function isExtensionReloadError(errOrMsg) {
	const msg = typeof errOrMsg === "string" ? errOrMsg : (errOrMsg?.message || "");
	return (
		msg.includes("Extension context invalidated") ||
		msg.includes("Receiving end does not exist") ||
		msg.includes("message channel closed")
	);
}

/**
 * Returns the currently active tab in the current window, or null if none/inaccessible.
 * @returns {Promise<chrome.tabs.Tab|null>}
 */
export async function getActiveTab() {
	if (typeof chrome === "undefined" || !chrome.tabs?.query) return null;
	const tabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
	return tabs[0] || null;
}

/**
 * Sanitizes strings for safe use in filenames or OSD titles.
 * @param {string} str The string to sanitize.
 * @param {boolean} isFilename If true, applies strict filesystem-safe filtering.
 */
export function sanitizeString(str, isFilename = false) {
	if (typeof str !== "string") return str;
	if (isFilename) {
		// Strict filtering for filenames (strips / \ : * ? " < > | $ ; & ` and newlines)
		return str.replace(/[\\/:*?"<>|$;&`\n\r\t]/g, "").trim();
	} else {
		// Minimal filtering for Titles/URLs (strips " ` and newlines)
		return str.replace(/["`\n\r\t]/g, "").trim();
	}
}

export function isYouTubeUrl(url) {
	if (!url || typeof url !== "string") return false;
	return url.includes("youtube.com/") || url.includes("youtu.be/");
}

export function getYoutubeId(url) {
	if (!url) return null;
	const videoMatch = url.match(
		/(?:v=|\/v\/|embed\/|youtu\.be\/|\/shorts\/)([a-zA-Z0-9_-]{11})/,
	);
	if (videoMatch) return videoMatch[1];
	const listMatch = url.match(/[?&]list=([a-zA-Z0-9_-]+)/);
	if (listMatch) return listMatch[1];
	return null;
}

/**
 * Normalizes YouTube URLs by removing timestamps and other tracking parameters.
 */
export function normalizeYouTubeUrl(ytUrl) {
	if (!ytUrl || typeof ytUrl !== "string") return ytUrl;
	try {
		const urlObj = new URL(ytUrl);
		const host = urlObj.hostname;
		const path = urlObj.pathname;

		const isStandard = host.includes("youtube.com") && path === "/watch";
		const isShorts =
			host.includes("youtube.com") && path.startsWith("/shorts/");
		const isShortLink = host.includes("youtu.be");

		if (isStandard || isShortLink || isShorts) {
			// Strip timestamps and index/shuffle parameters that break resume/deduplication logic
			["t", "index", "start", "ab_channel", "attr_tag"].forEach((p) => {
				urlObj.searchParams.delete(p);
			});
			return urlObj.toString();
		}
	} catch (e) {}
	return ytUrl;
}

/**
 * Recursively normalizes keys in an object from snake_case to camelCase.
 * Excludes whitelisted keys like 'request_id'.
 */
export function normalizeKeys(data) {
	if (!data || typeof data !== "object") return data;

	if (Array.isArray(data)) {
		return data.map(normalizeKeys);
	}

	const WHITELIST = new Set(["request_id", "url", "m3u8", "mp4"]);

	const snakeToCamel = (str) => {
		if (WHITELIST.has(str)) return str;
		return str.replace(/([-_][a-z])/g, (group) =>
			group.toUpperCase().replace("-", "").replace("_", ""),
		);
	};

	const normalized = {};
	for (const key in data) {
		if (Object.prototype.hasOwnProperty.call(data, key)) {
			const camelKey = snakeToCamel(key);
			normalized[camelKey] = normalizeKeys(data[key]);
		}
	}
	return normalized;
}

/**
 * Prompts the user for confirmation via the open popup or the active tab's on-page controller.
 * @param {string} message - The confirmation question/message to display.
 * @param {number|null} preferredTabId - Optional tab ID to prompt if popup is closed.
 * @param {boolean} defaultOnUnreachable - Value to return if neither popup nor tab can be reached.
 * @returns {Promise<boolean>}
 */
export async function promptUserConfirmation(message, preferredTabId = null, defaultOnUnreachable = false) {
	// 1. Try sending to open popup first
	const popupResponse = await new Promise((resolve) => {
		if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
			return resolve(null);
		}
		chrome.runtime.sendMessage(
			{ action: "show_popup_confirmation", message },
			(res) => {
				if (chrome.runtime.lastError) resolve(null);
				else resolve(res);
			},
		);
	});
	if (popupResponse && typeof popupResponse.confirmed === "boolean") {
		return popupResponse.confirmed;
	}

	// 2. Fall back to preferred tab or active tab
	let targetTabId = preferredTabId;
	if (!targetTabId) {
		const activeTab = await getActiveTab();
		targetTabId = activeTab?.id || null;
	}

	if (targetTabId && typeof chrome !== "undefined" && chrome.tabs?.sendMessage) {
		const tabResponse = await new Promise((resolve) => {
			chrome.tabs.sendMessage(
				targetTabId,
				{ action: "show_confirmation", message },
				(res) => {
					if (chrome.runtime.lastError) resolve(null);
					else resolve(res);
				},
			);
		});
		if (tabResponse && typeof tabResponse.confirmed === "boolean") {
			return tabResponse.confirmed;
		}
	}

	return defaultOnUnreachable;
}
