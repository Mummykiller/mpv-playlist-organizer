/**
 * MPV Playlist Organizer: Security Hub (ES Module)
 * Centralized validation and sanitization for the Chrome Extension.
 */
export const SECURITY_LIMITS = {
	MAX_TITLE_LENGTH: 255,
	MAX_URL_LENGTH: 2048,
	MAX_PLAYLIST_ITEMS: 5000,
	MAX_FOLDER_NAME_LENGTH: 100,
};

export const ALLOWED_PROTOCOLS = [
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
export function isValidUrl(urlString) {
	if (!urlString || typeof urlString !== "string") return false;
	if (urlString.length > SECURITY_LIMITS.MAX_URL_LENGTH) return false;

	try {
		const url = new URL(urlString);
		return ALLOWED_PROTOCOLS.includes(url.protocol);
	} catch (e) {
		return ALLOWED_PROTOCOLS.some((p) => urlString.toLowerCase().startsWith(p));
	}
}
