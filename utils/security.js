// AUTO-GENERATED from security.module.js. DO NOT EDIT MANUALLY.
window.MPV_SECURITY = window.MPV_SECURITY || {};
(() => {
	const MPV = window.MPV_SECURITY;
	/**
	 * MPV Playlist Organizer: Security Hub (ES Module)
	 * Centralized validation and sanitization for the Chrome Extension.
	 */
	const SECURITY_LIMITS = MPV.SECURITY_LIMITS = {
		MAX_TITLE_LENGTH: 512,
		MAX_URL_LENGTH: 4096,
		MAX_PLAYLIST_ITEMS: 10000,
		MAX_FOLDER_NAME_LENGTH: 128,
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

	const ALLOWED_WEB_PROTOCOLS = MPV.ALLOWED_WEB_PROTOCOLS = [
		"http:",
		"https:",
	];

	const BLOCKED_HOSTNAMES = MPV.BLOCKED_HOSTNAMES = [
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
	 */
	const isValidWebUrl = MPV.isValidWebUrl = function isValidWebUrl(urlString) {
		if (!urlString || typeof urlString !== "string") return false;
		if (urlString.length > SECURITY_LIMITS.MAX_URL_LENGTH) return false;

		try {
			const url = new URL(urlString);
			return ALLOWED_WEB_PROTOCOLS.includes(url.protocol);
		} catch (e) {
			return ALLOWED_WEB_PROTOCOLS.some((p) => urlString.toLowerCase().startsWith(p));
		}
	}

	/**
	 * Validates a URL against protocol allowlists and length limits.
	 * Optional options: { webOnly: boolean } or a boolean flag.
	 */
	const isValidUrl = MPV.isValidUrl = function isValidUrl(urlString, options = {}) {
		if (!urlString || typeof urlString !== "string") return false;
		if (urlString.length > SECURITY_LIMITS.MAX_URL_LENGTH) return false;

		const webOnly = typeof options === "boolean" ? options : Boolean(options?.webOnly);
		const protocols = webOnly ? ALLOWED_WEB_PROTOCOLS : ALLOWED_PROTOCOLS;

		try {
			const url = new URL(urlString);
			return protocols.includes(url.protocol);
		} catch (e) {
			return protocols.some((p) => urlString.toLowerCase().startsWith(p));
		}
	}

	/**
	 * Validates a URL against SSRF attacks (private networks, cloud metadata, loopback)
	 * and malicious protocol smuggling.
	 * @param {string} urlString - URL to test.
	 * @param {object} [options] - Configuration { allowLocal: boolean, webOnly: boolean }.
	 * @returns {boolean}
	 */
	const isSafeUrl = MPV.isSafeUrl = function isSafeUrl(urlString, options = {}) {
		const allowLocal = Boolean(options.allowLocal);
		const webOnly = Boolean(options.webOnly);

		if (!isValidUrl(urlString, { webOnly })) return false;

		try {
			const parsed = new URL(urlString);
			const protocol = parsed.protocol.toLowerCase();

			if (protocol === "file:") {
				return allowLocal;
			}

			let hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
			if (!hostname) return allowLocal;

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

			// 1. Dotted IPv4 (including octal and hex octets)
			const ipv4Parts = hostname.split(".");
			if (ipv4Parts.length === 4 && ipv4Parts.every((p) => /^(0x[0-9a-f]+|0[0-7]*|\d+)$/i.test(p))) {
				try {
					const octets = ipv4Parts.map((p) => {
						if (p.toLowerCase().startsWith("0x")) return parseInt(p, 16);
						if (p.startsWith("0") && p.length > 1) return parseInt(p, 8);
						return parseInt(p, 10);
					});
					if (octets.every((n) => !isNaN(n) && n >= 0 && n <= 255)) {
						if (isPrivateIpv4(octets[0], octets[1], octets[2], octets[3])) return false;
					}
				} catch (e) {
					return false;
				}
			}

			// 2. Integer or Hex Dword IP literal (e.g., 2130706433 or 0x7f000001)
			if (/^\d+$/.test(hostname)) {
				const val = parseInt(hostname, 10);
				if (val >= 0 && val <= 0xffffffff) {
					const a = (val >>> 24) & 255;
					const b = (val >>> 16) & 255;
					const c = (val >>> 8) & 255;
					const d = val & 255;
					if (isPrivateIpv4(a, b, c, d)) return false;
				}
			} else if (/^0x[0-9a-f]+$/i.test(hostname)) {
				const val = parseInt(hostname, 16);
				if (val >= 0 && val <= 0xffffffff) {
					const a = (val >>> 24) & 255;
					const b = (val >>> 16) & 255;
					const c = (val >>> 8) & 255;
					const d = val & 255;
					if (isPrivateIpv4(a, b, c, d)) return false;
				}
			}

			// 3. IPv6 loopback, unspecified, and private ranges
			if (
				hostname === "::1" ||
				hostname === "::" ||
				hostname.startsWith("fe80:") ||
				hostname.startsWith("fc00:") ||
				hostname.startsWith("fd00:")
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
	const isSafeWebUrl = MPV.isSafeWebUrl = function isSafeWebUrl(urlString) {
		return isSafeUrl(urlString, { allowLocal: false, webOnly: true });
	}

})();