/**
 * MPV Playlist Organizer: Security Hub (JS)
 * Centralized validation and sanitization for the Chrome Extension.
 */
const SECURITY_LIMITS = {
	MAX_TITLE_LENGTH: 255,
	MAX_URL_LENGTH: 2048,
	MAX_PLAYLIST_ITEMS: 5000,
	MAX_FOLDER_NAME_LENGTH: 100,
};

const ALLOWED_PROTOCOLS = [
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
function isValidUrl(urlString) {
	if (!urlString || typeof urlString !== "string") return false;
	if (urlString.length > SECURITY_LIMITS.MAX_URL_LENGTH) return false;

	try {
		const url = new URL(urlString);
		return ALLOWED_PROTOCOLS.includes(url.protocol);
	} catch (e) {
		// Fallback for non-standard protocols or local paths that URL() might fail on
		return ALLOWED_PROTOCOLS.some((p) => urlString.toLowerCase().startsWith(p));
	}
}

/**
 * Sanitizes strings for safe OSD display or communication.
 */
function sanitizeString(str, isFilename = false) {
	if (typeof str !== "string") return str;

	const limit = isFilename
		? SECURITY_LIMITS.MAX_FOLDER_NAME_LENGTH
		: SECURITY_LIMITS.MAX_TITLE_LENGTH;
	let sanitized = str.substring(0, limit);

	if (isFilename) {
		// Strict filtering for filenames (strips / \ : * ? " < > | $ ; & ` and newlines)
		return sanitized.replace(/[\\/:*?"<>|$;&`\n\r\t]/g, "").trim();
	} else {
		// Minimal filtering for Titles/URLs (strips " ` and newlines)
		return sanitized.replace(/["`\n\r\t]/g, "").trim();
	}
}

// Export for module and global contexts
if (typeof module !== "undefined" && module.exports) {
	module.exports = { SECURITY_LIMITS, isValidUrl, sanitizeString };
} else {
	window.MPV_SECURITY = { SECURITY_LIMITS, isValidUrl, sanitizeString };
}
