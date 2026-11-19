// AUTO-GENERATED from commUtils.module.js. DO NOT EDIT MANUALLY.
window.MPV_INTERNAL = window.MPV_INTERNAL || {};
(() => {
	const MPV = window.MPV_INTERNAL;
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
	const DOMAIN_SPECIFIC_KEYS = MPV.DOMAIN_SPECIFIC_KEYS = [
		"minimized",
		"mode",
		"position",
		"minimizedStubPosition",
		"pinned",
		"anilistPanelVisible",
		"anilistPanelPosition",
		"anilistPanelSize",
	];

	const debounce = MPV.debounce = function debounce(func, wait) {
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

	const sendMessageAsync = MPV.sendMessageAsync = (payload) =>
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

	const isExtensionReloadError = MPV.isExtensionReloadError = function isExtensionReloadError(errOrMsg) {
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
	const getActiveTab = MPV.getActiveTab = async function getActiveTab() {
		if (typeof chrome === "undefined" || !chrome.tabs?.query) return null;
		const tabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch((err) => {
			const logger = (typeof window !== "undefined" && window.MPV_INTERNAL?.logger) || (typeof globalThis !== "undefined" && globalThis.MPV_INTERNAL?.logger);
			logger?.debug?.("[commUtils] chrome.tabs.query failed:", { data: err });
			return [];
		});
		return tabs[0] || null;
	}

	/**
	 * Sanitizes strings for safe use in filenames or OSD titles.
	 * @param {string} str The string to sanitize.
	 * @param {boolean} isFilename If true, applies strict filesystem-safe filtering.
	 */
	const sanitizeString = MPV.sanitizeString = function sanitizeString(str, isFilename = false) {
		if (typeof str !== "string") return str;
		if (isFilename) {
			// Strict filtering for filenames (strips / \ : * ? " < > | $ ; & ` and newlines)
			return str.replace(/[\\/:*?"<>|$;&`\n\r\t]/g, "").trim();
		} else {
			// Minimal filtering for Titles/URLs (strips " ` and newlines)
			return str.replace(/["`\n\r\t]/g, "").trim();
		}
	}

	const isYouTubeUrl = MPV.isYouTubeUrl = function isYouTubeUrl(url) {
		if (!url || typeof url !== "string") return false;
		try {
			const parsed = new URL(url);
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
			const host = parsed.hostname.toLowerCase();
			return host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be";
		} catch (_err) {
			return false;
		}
	}

	const getYoutubeId = MPV.getYoutubeId = function getYoutubeId(url) {
		if (!url || typeof url !== "string" || !isYouTubeUrl(url)) return null;
		const videoMatch = url.match(
			/(?:[?&]v=|\/v\/|\/embed\/|youtu\.be\/|\/shorts\/|\/live\/)([a-zA-Z0-9_-]{11})/,
		);
		if (videoMatch) return videoMatch[1];
		const listMatch = url.match(/[?&]list=([a-zA-Z0-9_-]+)/);
		if (listMatch) return listMatch[1];
		return null;
	}

	/**
	 * Normalizes YouTube URLs by removing timestamps and other tracking parameters.
	 */
	const normalizeYouTubeUrl = MPV.normalizeYouTubeUrl = function normalizeYouTubeUrl(ytUrl) {
		if (!ytUrl || typeof ytUrl !== "string") return ytUrl;
		try {
			const urlObj = new URL(ytUrl);
			if (urlObj.protocol !== "http:" && urlObj.protocol !== "https:") return ytUrl;
			const host = urlObj.hostname.toLowerCase();
			const path = urlObj.pathname;

			const isYtDomain = host === "youtube.com" || host.endsWith(".youtube.com");
			const isStandard = isYtDomain && path === "/watch";
			const isShorts = isYtDomain && path.startsWith("/shorts/");
			const isLive = isYtDomain && path.startsWith("/live/");
			const isPlaylist = isYtDomain && path.replace(/\/+$/, "") === "/playlist";
			const isShortLink = host === "youtu.be";

			if (isStandard || isShortLink || isShorts || isLive || isPlaylist) {
				// Strip timestamps and tracking/index parameters that break resume/deduplication logic
				["t", "index", "start", "ab_channel", "attr_tag", "si", "pp", "feature"].forEach((p) => {
					urlObj.searchParams.delete(p);
				});
				return urlObj.toString();
			}
		} catch (e) {
			const logger = (typeof window !== "undefined" && window.MPV_INTERNAL?.logger) || (typeof globalThis !== "undefined" && globalThis.MPV_INTERNAL?.logger);
			logger?.debug?.("[commUtils] Error normalizing YouTube URL:", { data: e });
		}
		return ytUrl;
	}

	const NORMALIZE_WHITELIST = new Set(["request_id", "url", "m3u8", "mp4"]);
	const PRESERVE_MAP_KEYS = new Set(["customNames", "custom_names", "folders", "domains"]);

	/**
	 * Recursively normalizes keys in an object from snake_case to camelCase.
	 * Excludes whitelisted keys like 'request_id', and preserves child dictionary
	 * keys verbatim under map containers in PRESERVE_MAP_KEYS.
	 */
	const normalizeKeys = MPV.normalizeKeys = function normalizeKeys(data, preserveChildKeys = false) {
		if (!data || typeof data !== "object") return data;

		if (Array.isArray(data)) {
			return data.map((item) => normalizeKeys(item, false));
		}

		const snakeToCamel = (str) => {
			if (NORMALIZE_WHITELIST.has(str)) return str;
			return str.replace(/([-_][a-z])/g, (group) =>
				group.toUpperCase().replace("-", "").replace("_", ""),
			);
		};

		// Only "__proto__" can mutate the prototype chain via assignment; "constructor"/"prototype"
		// are harmless own keys and must survive (e.g. user folders with those names).
		const FORBIDDEN_KEYS = new Set(["__proto__"]);
		const normalized = {};
		for (const key in data) {
			if (Object.prototype.hasOwnProperty.call(data, key)) {
				if (FORBIDDEN_KEYS.has(key)) continue;
				const outKey = preserveChildKeys ? key : snakeToCamel(key);
				if (FORBIDDEN_KEYS.has(outKey)) continue;
				const shouldPreserveGrandchildren =
					!preserveChildKeys &&
					(PRESERVE_MAP_KEYS.has(key) || PRESERVE_MAP_KEYS.has(outKey));
				normalized[outKey] = normalizeKeys(data[key], shouldPreserveGrandchildren);
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
	const promptUserConfirmation = MPV.promptUserConfirmation = async function promptUserConfirmation(message, preferredTabId = null, defaultOnUnreachable = false) {
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

	/**
	 * Dispatches a status banner update to the open popup or the active tab.
	 * @param {string} message - Message text.
	 * @param {boolean|Object} [options] - Boolean isError or options object { isError, isSuccess, tabId }.
	 * @returns {Promise<boolean>} Whether at least one receiver acknowledged the notification.
	 */
	const notifyStatusBanner = MPV.notifyStatusBanner = async function notifyStatusBanner(message, options = {}) {
		const isError = typeof options === "boolean" ? options : !!options.isError;
		const isSuccess = typeof options === "object" ? !!options.isSuccess : !isError;
		const targetTabId = typeof options === "object" ? options.tabId : null;
		const payload = { action: "show_status_banner", message, isError, isSuccess };

		let delivered = false;

		// 1. Try sending to open popup
		if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
			try {
				const res = await new Promise((resolve) => {
					chrome.runtime.sendMessage(payload, (resp) => {
						if (chrome.runtime.lastError) resolve(null);
						else resolve(resp);
					});
				});
				if (res?.success) delivered = true;
			} catch (e) {
				const logger = (typeof window !== "undefined" && window.MPV_INTERNAL?.logger) || (typeof globalThis !== "undefined" && globalThis.MPV_INTERNAL?.logger);
				logger?.debug?.("[commUtils] notifyStatusBanner runtime send failed:", { data: e });
			}
		}

		// 2. Try sending to tab
		let tabId = targetTabId;
		if (!tabId) {
			const activeTab = await getActiveTab();
			tabId = activeTab?.id || null;
		}

		if (tabId && typeof chrome !== "undefined" && chrome.tabs?.sendMessage) {
			try {
				const res = await new Promise((resolve) => {
					chrome.tabs.sendMessage(tabId, payload, (resp) => {
						if (chrome.runtime.lastError) resolve(null);
						else resolve(resp);
					});
				});
				if (res?.success) delivered = true;
			} catch (e) {
				const logger = (typeof window !== "undefined" && window.MPV_INTERNAL?.logger) || (typeof globalThis !== "undefined" && globalThis.MPV_INTERNAL?.logger);
				logger?.debug?.("[commUtils] notifyStatusBanner tab send failed:", { data: e });
			}
		}

		return delivered;
	}

	/**
	 * Reports a browser error to the background script and SystemLogger.
	 * @param {string} context - Source context (e.g., 'Popup', 'ContentScript', 'MpvController').
	 * @param {Error|string} errorOrMessage - Error object or error message string.
	 * @param {Object} [extra] - Additional metadata or options.
	 */
	const reportBrowserError = MPV.reportBrowserError = async function reportBrowserError(context, errorOrMessage, extra = {}) {
		const message = errorOrMessage instanceof Error ? errorOrMessage.message : String(errorOrMessage);
		const stack = (errorOrMessage instanceof Error ? errorOrMessage.stack : extra.stack) || "";

		const logger = (typeof window !== "undefined" && window.MPV_INTERNAL?.logger) || (typeof globalThis !== "undefined" && globalThis.MPV_INTERNAL?.logger);
		if (logger?.error) {
			logger.error(`[${context}] ${message}`, { persist: true, stack, data: extra.data });
		}

		if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
			try {
				await sendMessageAsync({
					action: "log_browser_error",
					context,
					message,
					stack,
				});
			} catch (e) {
				logger?.debug?.(`[${context}] Failed to send error to background logger: ${e.message}`);
			}
		}
	}

})();