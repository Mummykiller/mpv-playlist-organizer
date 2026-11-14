/**
 * @class PageScraper
 * Handles extraction of clean titles and URLs from various web pages.
 * Includes intelligent season/episode detection and site-specific rules.
 */
window.MPV_INTERNAL = window.MPV_INTERNAL || {};

(() => {
	const MPV = window.MPV_INTERNAL;

	MPV.PageScraper = class PageScraper {
		constructor() {
			this.builtInWords = [
				"watch",
				"online",
				"free",
				"episode",
				"season",
				"full",
				"hd",
				"eng sub",
				"subbed",
				"dubbed",
				"animepahe",
			];
			this.filterWords = [...this.builtInWords];
		}

		updateFilterWords(words) {
			if (Array.isArray(words)) {
				// Merge user words with built-ins, removing duplicates
				this.filterWords = [...new Set([...this.builtInWords, ...words])];
			}
		}

		/**
		 * Checks if a title is likely a provisional/fallback title (e.g., URL or "Loading...").
		 * @param {string} title - The title to check.
		 * @param {string} url - The URL to compare against.
		 * @param {object} [options] - Optional hints about how the title was extracted.
		 * @param {boolean} [options.hasStructuredTitle] - True if extracted from an h1, episode marker, or video title selector.
		 * @returns {boolean}
		 */
		isTitleProvisional(title, url, options = {}) {
			if (!title || !url) return true;
			const cleanTitle = title.trim();
			const cleanUrl = url.trim();

			// 1. Empty, single-char, or punctuation-only placeholder
			if (cleanTitle.length < 2 || !/[\p{L}\p{N}]/u.test(cleanTitle)) return true;

			// 2. Title is just the URL
			if (cleanTitle === cleanUrl) return true;

			// 3. Title is a known "loading" or generic placeholder
			const provisionalPatterns = [
				/^loading\.{0,3}$/i,
				/^connecting\.{0,3}$/i,
				/^please wait\.{0,3}$/i,
				/^untitled$/i,
				/^youtube$/i, // Generic YouTube title before video metadata loads
				/^animeheaven\.me$/i, // Generic site title
				/^animepahe$/i,
				/^gogoanime$/i,
			];
			if (provisionalPatterns.some((p) => p.test(cleanTitle))) return true;

			// 4. Title is identical to the site name (Case-insensitive)
			try {
				const hostname = window.location.hostname.replace(/^www\./, "");
				if (cleanTitle.toLowerCase() === hostname.toLowerCase()) return true;
			} catch (e) {
				console.debug("[PageScraper] Failed to check hostname for provisional title:", e);
			}

			// 5. Trust structured titles (h1 / episode / video selector) once placeholder/URL checks pass
			if (options?.hasStructuredTitle) return false;

			return false;
		}

		/**
		 * Generates a unique fingerprint for the current episode view.
		 * Used to detect internal navigation on static-URL sites like AnimeHeaven.
		 * @returns {string|null}
		 */
		getEpisodeFingerprint() {
			const hostname = window.location.hostname;
			
			// 1. AnimeHeaven Logic
			if (hostname.includes("animeheaven.me")) {
				// Try to find the active episode in the sidebar/list
				const activeEp = document.querySelector(".ep.active, .episode.active, [class*='active'] .num");
				if (activeEp) return `animeheaven-${activeEp.textContent.trim()}`;
			}

			// 2. Generic Logic: Use the H1 or a specific episode indicator
			const h1 = document.querySelector("h1");
			if (h1) return `h1-${h1.textContent.trim()}`;

			return document.title;
		}

		/**
		 * Scrapes the page for the best possible title and URL.
		 * Automatically isolates web scraping to valid HTTP/HTTPS schemes.
		 * @param {string} url - The URL to scrape details for.
		 * @returns {object} { url, title, isProvisional, fingerprint }
		 */
		scrapePageDetails(url) {
			const isWebUrl = (u) => {
				if (!u || typeof u !== "string") return false;
				if (typeof window !== "undefined" && window.MPV_SECURITY && typeof window.MPV_SECURITY.isValidWebUrl === "function") {
					return window.MPV_SECURITY.isValidWebUrl(u);
				}
				const lower = u.trim().toLowerCase();
				return lower.startsWith("http://") || lower.startsWith("https://");
			};

			if (!url || !isWebUrl(url)) {
				return { url: null, title: document.title, isProvisional: true, fingerprint: this.getEpisodeFingerprint() };
			}

			const fingerprint = this.getEpisodeFingerprint();

			const hostname = window.location.hostname;

			// --- 1. Specialized YouTube Logic ---
			if (hostname.includes("youtube.com")) {
				if (window.location.pathname.includes("/playlist")) {
					return { url: url, title: null, isProvisional: true };
				}

				const titleSelectors = [
					"h1.ytd-watch-metadata yt-formatted-string.ytd-video-primary-info-renderer",
					"#title > h1 > yt-formatted-string",
					"#title-text",
					".ytp-title-link",
					'meta[property="og:title"]',
				];
				const channelSelectors = [
					"#owner-name a",
					"#channel-name a",
					"ytd-channel-name a",
					".ytd-channel-name",
					'meta[property="og:site_name"]',
				];

				const findFirst = (selectors, attribute = "textContent") => {
					for (const selector of selectors) {
						const el = document.querySelector(selector);
						if (!el) continue;
						const rawVal =
							el.tagName === "META"
								? el.content ?? el.getAttribute?.("content") ?? ""
								: el[attribute] ?? el.textContent ?? el.content ?? "";
						const val = String(rawVal).trim();
						if (val) return val;
					}
					return null;
				};

				const extractedVideoTitle = findFirst(titleSelectors);
				let videoTitle = extractedVideoTitle || document.title;
				const channelName = findFirst(channelSelectors);

				// Only strip leading notification counts in parentheses, e.g., "(1) Video Title"
				videoTitle = videoTitle
					.replace(/^\(\d+\)\s*/, "")
					.replace(/\s-\sYouTube$/, "")
					.trim();
				const resultUrl = MPV.sanitizeString(url);
				const resultTitle = MPV.sanitizeString(channelName ? `${channelName} - ${videoTitle}` : videoTitle);
				return {
					url: resultUrl,
					title: resultTitle,
					isProvisional: this.isTitleProvisional(resultTitle, resultUrl, {
						hasStructuredTitle: Boolean(extractedVideoTitle),
					}),
					fingerprint: fingerprint
				};
			}

			// --- 2. Generic Multi-Step Scraper Strategy (Non-YouTube) ---
			const title = document.title;
			let season = null;
			let episode = null;
			const matchedStrings = new Set();

			const patterns = [
				/s(?:eason)?\s*(\d+)\s*e(?:pisode)?\s*(\d+(?:\.\d+)?)/i,
				/(\d+)x(\d+(?:\.\d+)?)/i,
				/(?:(\d+)(?:st|nd|rd|th)\s+season)|s(?:eason)?\.?\s*(\d+)/i,
				/e(?:p(?:isode)?)?\.?\s*(\d+(?:\.\d+)?)/i,
			];

			const findDetails = (text) => {
				if (!text) return;
				for (const pattern of [patterns[0], patterns[1]]) {
					const match = text.match(pattern);
					if (match && match.length === 3) {
						if (!season) {
							season = parseFloat(match[1]);
							matchedStrings.add(match[0]);
						}
						if (!episode) {
							episode = parseFloat(match[2]);
							matchedStrings.add(match[0]);
						}
						return;
					}
				}
				const seasonMatch = text.match(patterns[2]);
				if (seasonMatch && !season) {
					season = parseFloat(seasonMatch[1] || seasonMatch[2]);
					matchedStrings.add(seasonMatch[0]);
				}
				const episodeMatch = text.match(patterns[3]);
				if (episodeMatch && !episode) {
					episode = parseFloat(episodeMatch[1]);
					matchedStrings.add(episodeMatch[0]);
				}
			};

			const urlHash = window.location.hash;
			if (urlHash) {
				const hashMatch = urlHash.match(/ep(?:isode)?=?(\d+)/i);
				if (hashMatch) episode = parseFloat(hashMatch[1]);
			}

			if (!episode) {
				const activeEl = document.querySelector(
					'[class*="active"] a, [class*="selected"] a, a[class*="active"], a[class*="selected"]',
				);
				if (activeEl) findDetails(activeEl.textContent);
			}

			let mainPageTitle = "";
			const h1Element = document.querySelector("h1");
			if (h1Element) {
				const h1Link = h1Element.querySelector("a[title]");
				if (h1Link && h1Link.title) {
					mainPageTitle = h1Link.title.trim();
				} else {
					const h1Clone = h1Element.cloneNode(true);
					h1Clone
						.querySelectorAll(
							'.sr-only, [style*="display: none"], [style*="visibility: hidden"]',
						)
						.forEach((el) => el.remove());
					mainPageTitle = h1Clone.textContent.trim();
				}
			}

			findDetails(title);
			findDetails(mainPageTitle);

			if (!season || !episode) {
				const candidates = document.querySelectorAll(
					'h1, h2, h3, [class*="episode"], [id*="episode"]',
				);
				for (const cand of candidates) {
					findDetails(cand.textContent);
					if (season && episode) break;
				}
			}

			let cleanTitle = mainPageTitle || title;

			for (const matchedString of matchedStrings) {
				cleanTitle = cleanTitle.replace(
					new RegExp(matchedString.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
					"",
				);
			}

			const escapedFilterWords = this.filterWords
				.map((w) => String(w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
				.filter(Boolean);
			if (escapedFilterWords.length > 0) {
				const junkRegex = new RegExp(
					`(^|\\s)(${escapedFilterWords.join("|")})(\\s|$)`,
					"gi",
				);
				cleanTitle = cleanTitle.replace(junkRegex, " ");
			}

			cleanTitle = cleanTitle.replace(/\s\.\d+\s/g, " ");
			cleanTitle = cleanTitle
				.replace(/\s*[-|:]\s*$/, "")
				.replace(/\s+/g, " ")
				.trim();

			const episodePrefix = season
				? `s${season}e${episode}`
				: episode
					? `e${episode}`
					: "";
			const finalTitle = episodePrefix
				? `${episodePrefix} - ${cleanTitle}`.trim()
				: cleanTitle;

			const resultTitle = finalTitle || url;
			const sanitizedUrl = MPV.sanitizeString(url);
			const sanitizedTitle = MPV.sanitizeString(resultTitle);

			return {
				url: sanitizedUrl,
				title: sanitizedTitle,
				isProvisional: this.isTitleProvisional(sanitizedTitle, sanitizedUrl, {
					hasStructuredTitle: Boolean(mainPageTitle || episodePrefix),
				}),
				fingerprint: fingerprint
			};
		}
	};
})();
