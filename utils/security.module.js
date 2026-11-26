/**
 * MPV Playlist Organizer: Security Hub (ES Module)
 * Centralized validation and sanitization for the Chrome Extension.
 */
export const SECURITY_LIMITS = {
	MAX_TITLE_LENGTH: 512,
	MAX_URL_LENGTH: 4096,
	MAX_PLAYLIST_ITEMS: 10000,
	MAX_FOLDER_NAME_LENGTH: 128,
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

export const ALLOWED_WEB_PROTOCOLS = [
	"http:",
	"https:",
];

export const BLOCKED_HOSTNAMES = [
	"localhost",
	"localhost.localdomain",
	"ip6-localhost",
	"ip6-loopback",
	"metadata.google.internal",
	"metadata.internal",
	"instance-data",
];

/**
 * Validates that a URL strictly uses web protocols (http:, https:).
 * Enforces security limits and rejects local schemes.
 * Supports batch arrays of strings or URL item objects.
 */
export function isValidWebUrl(urlString) {
	if (!urlString) return false;
	if (Array.isArray(urlString)) {
		if (urlString.length === 0) return true;
		return urlString.every((item) => {
			const u = typeof item === "string" ? item : (item && typeof item === "object" ? item.url : null);
			return typeof u === "string" && isValidWebUrl(u);
		});
	}
	if (typeof urlString !== "string") return false;
	if (urlString.length > SECURITY_LIMITS.MAX_URL_LENGTH) return false;

	try {
		const url = new URL(urlString);
		return ALLOWED_WEB_PROTOCOLS.includes(url.protocol);
	} catch (e) {
		return false;
	}
}

/**
 * Validates a URL against protocol allowlists and length limits.
 * Supports batch arrays of strings or URL item objects.
 * Optional options: { webOnly: boolean } or a boolean flag.
 */
export function isValidUrl(urlString, options = {}) {
	if (!urlString) return false;
	if (Array.isArray(urlString)) {
		if (urlString.length === 0) return true;
		return urlString.every((item) => {
			const u = typeof item === "string" ? item : (item && typeof item === "object" ? item.url : null);
			return typeof u === "string" && isValidUrl(u, options);
		});
	}
	if (typeof urlString !== "string") return false;
	if (urlString.length > SECURITY_LIMITS.MAX_URL_LENGTH) return false;

	const webOnly = typeof options === "boolean" ? options : Boolean(options?.webOnly);
	const protocols = webOnly ? ALLOWED_WEB_PROTOCOLS : ALLOWED_PROTOCOLS;

	try {
		const url = new URL(urlString);
		return protocols.includes(url.protocol);
	} catch (e) {
		return false;
	}
}

/**
 * Validates a batch array of URLs or URL item objects.
 * @param {Array<string|object>} items - Array of URLs or item objects with a `url` property.
 * @param {object} [options] - Optional validation options.
 * @returns {boolean}
 */
export function areValidUrls(items, options = {}) {
	return isValidUrl(items, options);
}

/**
 * Validates a URL against SSRF attacks (private networks, cloud metadata, loopback)
 * and malicious protocol smuggling.
 * Supports batch arrays of strings or URL item objects.
 * @param {string|Array<string|object>} urlString - URL or batch array to test.
 * @param {object} [options] - Configuration { allowLocal: boolean, webOnly: boolean }.
 * @returns {boolean}
 */
export function isSafeUrl(urlString, options = {}) {
	if (!urlString) return false;
	if (Array.isArray(urlString)) {
		if (urlString.length === 0) return true;
		return urlString.every((item) => {
			const u = typeof item === "string" ? item : (item && typeof item === "object" ? item.url : null);
			return typeof u === "string" && isSafeUrl(u, options);
		});
	}
	const allowLocal = Boolean(options.allowLocal);
	const webOnly = Boolean(options.webOnly);

	if (!isValidUrl(urlString, { webOnly })) return false;

	try {
		const parsed = new URL(urlString);
		const protocol = parsed.protocol.toLowerCase();

		if (protocol === "file:") {
			return allowLocal && !parsed.hostname && !/^file:\/\/[^/]/i.test(urlString.trim());
		}

		let hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
		if (!hostname) return false;

		// Strip IPv6 zone ID if present (e.g., fe80::1%eth0)
		if (hostname.includes("%")) {
			hostname = hostname.split("%")[0];
		}

		// Blocked loopback / internal metadata hostnames
		if (
			BLOCKED_HOSTNAMES.includes(hostname) ||
			hostname.endsWith(".localhost") ||
			hostname.endsWith(".local")
		) {
			return false;
		}

		// Helper to verify if an IPv4 octet group is a private or restricted network
		const isPrivateIpv4 = (a, b, c, d) => {
			if (a === 127) return true; // Loopback
			if (a === 10) return true; // RFC 1918 Private Class A
			if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918 Private Class B
			if (a === 192 && b === 168) return true; // RFC 1918 Private Class C
			if (a === 169 && b === 254) return true; // Link-local & Cloud Metadata (169.254.169.254)
			if (a === 0) return true; // 0.0.0.0/8 (current network / Linux local)
			if (a === 100 && b >= 64 && b <= 127) return true; // Carrier-Grade NAT (RFC 6598)
			if (a >= 224 && protocol !== "udp:") return true; // Multicast / Broadcast (except UDP streams)
			return false;
		};

		// 1. Dotted & Dword IPv4 (1, 2, 3, or 4 parts; decimal, octal, or hex)
		const ipv4Parts = hostname.split(".");
		if (
			ipv4Parts.length >= 1 &&
			ipv4Parts.length <= 4 &&
			ipv4Parts.every((p) => /^(0x[0-9a-f]+|0[0-7]*|\d+)$/i.test(p))
		) {
			const nums = [];
			let validParts = true;
			for (const p of ipv4Parts) {
				const pLower = p.toLowerCase();
				let n;
				if (pLower.startsWith("0x")) {
					n = parseInt(pLower, 16);
				} else if (pLower.startsWith("0") && pLower.length > 1) {
					if (!/^0[0-7]+$/.test(pLower)) {
						validParts = false;
						break;
					}
					n = parseInt(pLower, 8);
				} else {
					n = parseInt(pLower, 10);
				}
				if (Number.isNaN(n) || n < 0) {
					validParts = false;
					break;
				}
				nums.push(n);
			}
			if (validParts) {
				let ipv4Int = null;
				if (nums.length === 4 && nums.every((n) => n <= 255)) {
					ipv4Int = ((nums[0] << 24) | (nums[1] << 16) | (nums[2] << 8) | nums[3]) >>> 0;
				} else if (nums.length === 3 && nums[0] <= 255 && nums[1] <= 255 && nums[2] <= 0xffff) {
					ipv4Int = ((nums[0] << 24) | (nums[1] << 16) | nums[2]) >>> 0;
				} else if (nums.length === 2 && nums[0] <= 255 && nums[1] <= 0xffffff) {
					ipv4Int = ((nums[0] << 24) | nums[1]) >>> 0;
				} else if (nums.length === 1 && nums[0] <= 0xffffffff) {
					ipv4Int = nums[0] >>> 0;
				}
				if (ipv4Int !== null) {
					const a = (ipv4Int >>> 24) & 255;
					const b = (ipv4Int >>> 16) & 255;
					const c = (ipv4Int >>> 8) & 255;
					const d = ipv4Int & 255;
					if (isPrivateIpv4(a, b, c, d)) return false;
				}
			}
		}

		// 2. IPv6 loopback, unspecified, link-local (fe80::/10), unique-local (fc00::/7), and multicast (ff00::/8)
		if (
			hostname === "::1" ||
			hostname === "::" ||
			/^fe[89ab][0-9a-f]:/i.test(hostname) ||
			/^(fc|fd)[0-9a-f]{2}:/i.test(hostname) ||
			(/^ff[0-9a-f]{2}:/i.test(hostname) && protocol !== "udp:")
		) {
			return false;
		}

		// 4. IPv4-mapped IPv6 addresses (::ffff:127.0.0.1 or canonical hex ::ffff:7f00:1)
		if (hostname.startsWith("::ffff:")) {
			const mapped = hostname.replace("::ffff:", "");
			if (/^\d+\.\d+\.\d+\.\d+$/.test(mapped)) {
				const octets = mapped.split(".").map(Number);
				if (isPrivateIpv4(octets[0], octets[1], octets[2], octets[3])) return false;
			} else {
				const parts = mapped.split(":");
				if (parts.length === 2) {
					const high = parseInt(parts[0], 16);
					const low = parseInt(parts[1], 16);
					const a = (high >> 8) & 255;
					const b = high & 255;
					const c = (low >> 8) & 255;
					const d = low & 255;
					if (isPrivateIpv4(a, b, c, d)) return false;
				}
			}
		}

		return true;
	} catch (e) {
		return false;
	}
}

/**
 * Validates that a URL is both a valid web protocol and safe from SSRF.
 */
export function isSafeWebUrl(urlString) {
	return isSafeUrl(urlString, { allowLocal: false, webOnly: true });
}
