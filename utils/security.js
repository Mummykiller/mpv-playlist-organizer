// AUTO-GENERATED from security.module.js. DO NOT EDIT MANUALLY.
window.MPV_SECURITY = window.MPV_SECURITY || {};
(() => {
	const MPV = window.MPV_SECURITY;
	/**
	 * MPV Playlist Organizer: Security Hub (ES Module)
	 * Centralized validation and sanitization for the Chrome Extension.
	 */
	const SECURITY_LIMITS = MPV.SECURITY_LIMITS = {
		MAX_TITLE_LENGTH: 255,
		MAX_URL_LENGTH: 2048,
		MAX_PLAYLIST_ITEMS: 5000,
		MAX_FOLDER_NAME_LENGTH: 100,
	};

	const ALLOWED_PROTOCOLS = MPV.ALLOWED_PROTOCOLS = [
		"http:",
		"https:",
		"file:",
		"udp:",
		"rtmp:",
		"rtsp:",
		"mms:",
	];

	/**
	 * Validates a URL against the protocol allowlist and length limits.
	 */
	const isValidUrl = MPV.isValidUrl = function isValidUrl(urlString) {
		if (!urlString || typeof urlString !== "string") return false;
		if (urlString.length > SECURITY_LIMITS.MAX_URL_LENGTH) return false;

		try {
			const url = new URL(urlString);
			return ALLOWED_PROTOCOLS.includes(url.protocol);
		} catch (e) {
			return ALLOWED_PROTOCOLS.some((p) => urlString.toLowerCase().startsWith(p));
		}
	}

	/**
	 * Sanitizes strings for safe OSD display or communication.
	 */
	const sanitizeString = MPV.sanitizeString = function sanitizeString(str, isFilename = false) {
		if (typeof str !== "string") return str;

		const limit = isFilename
			? SECURITY_LIMITS.MAX_FOLDER_NAME_LENGTH
			: SECURITY_LIMITS.MAX_TITLE_LENGTH;
		let sanitized = str.substring(0, limit);

		if (isFilename) {
			return sanitized.replace(/[\\/:*?"<>|$;&`\n\r\t]/g, "").trim();
		} else {
			return sanitized.replace(/["\n\r\t]/g, "").trim();
		}
	}

})();