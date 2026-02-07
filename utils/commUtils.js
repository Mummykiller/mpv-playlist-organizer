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
		return url.includes("youtube.com/") || url.includes("youtu.be/");
	}

	const getYoutubeId = MPV.getYoutubeId = function getYoutubeId(url) {
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
	const normalizeYouTubeUrl = MPV.normalizeYouTubeUrl = function normalizeYouTubeUrl(ytUrl) {
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

	const Logger = MPV.Logger = class Logger {
		constructor(tag = "BG") {
			this.tag = tag;
		}
		_format(msg) {
			const time = new Date().toLocaleTimeString([], {
				hour12: false,
				hour: "2-digit",
				minute: "2-digit",
				second: "2-digit",
			});
			return `[${time}] [${this.tag}]: ${msg}`;
		}
		info(msg) {
			console.log(this._format(msg));
		}
		warn(msg) {
			console.warn(this._format(msg));
		}
		error(msg) {
			console.error(this._format(msg));
		}
		debug(msg) {
			console.debug(this._format(msg));
		}
	}

	/**
	 * Recursively normalizes keys in an object from snake_case to camelCase.
	 * Excludes whitelisted keys like 'request_id'.
	 */
	const normalizeKeys = MPV.normalizeKeys = function normalizeKeys(data) {
		if (!data || typeof data !== "object") return data;

		if (Array.isArray(data)) {
			return data.map(normalizeKeys);
		}

		const WHITELIST = new Set(["request_id", "url", "m3u8"]);

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

})();