/* ------------------------------------------------------------------
 * PageScraper.js
 * Logic for scraping page details to generate clean, user-friendly titles.
 * ------------------------------------------------------------------*/

class PageScraper {
    /**
     * @param {string[]} [initialFilterWords=[]] - A list of words to filter from titles.
     */
    constructor(initialFilterWords = []) {
        this.scraperFilterWords = initialFilterWords;
    }

    /**
     * Updates the list of words to filter from scraped titles.
     * @param {string[]} words - The new list of filter words.
     */
    updateFilterWords(words) {
        this.scraperFilterWords = words;
    }

    /**
     * Scrapes the page for episode details to create a user-friendly title.
     * @param {string|null} detectedUrl - The URL of the detected stream/video.
     * @returns {{url: string, title: string}} An object with the detected URL and a formatted title.
     */
    scrapePageDetails(detectedUrl) {
        if (!detectedUrl) return { url: null, title: document.title };
        // --- AI GUARD: YOUTUBE-SPECIFIC LOGIC ---
        // This block now contains high-priority scraping logic specifically for a YouTube
        // video watch page (`/watch`). It runs before the generic scrapers to provide a
        // clean title from the DOM, preventing the less reliable generic scrapers from
        // producing a messy title. This is the primary method for the on-page "Add" button.
        if (window.location.hostname.includes('youtube.com')) {
            // Only run the detailed scraper if we are on a video watch page.
            // Otherwise, we fall back to the generic logic to avoid loops on the homepage.
            if (window.location.pathname === '/watch') {
            const titleSelectors = [
                'h1.ytd-watch-metadata yt-formatted-string.ytd-video-primary-info-renderer', // Standard video
                '#title > h1 > yt-formatted-string', // Alternate standard video
                '#title-text', // YouTube Shorts
                'meta[property="og:title"]' // Fallback to OpenGraph meta tag
            ];
            const channelSelectors = [
                '#owner-name a', // Standard video
                '#channel-name a', // Alternate standard video
                'ytd-channel-name a', // Another alternate
                '.ytd-channel-name', // Shorts channel name
                'meta[property="og:site_name"]' // Fallback to OpenGraph meta tag
            ];

            // Helper to find the first matching element and get its content.
            const findFirst = (selectors, attribute = 'textContent') => {
                for (const selector of selectors) {
                    const el = document.querySelector(selector);
                    if (el) return (el[attribute] || el.content || '').trim();
                }
                return null;
            };

            let videoTitle = findFirst(titleSelectors, 'content') || document.title;
            const channelName = findFirst(channelSelectors);
            // Clean up the title: remove notification counts like "(1) " and the " - YouTube" suffix.
            videoTitle = videoTitle.replace(/^\(\d+\)\s*/, '').replace(/\s-\sYouTube$/, '').trim();

            return { url: detectedUrl, title: channelName ? `${channelName} - ${videoTitle}` : videoTitle };
            }
        }
        // --- END AI GUARD ---

        let title = document.title;
        let season = null;
        let episode = null;
        const matchedStrings = new Set(); // Store the exact text that was matched

        // Regex patterns to find season and episode numbers
        const patterns = [
            /s(?:eason)?\s*(\d+)\s*e(?:pisode)?\s*(\d+(?:\.\d+)?)/i, // S01E01, S01E12.5
            /(\d+)x(\d+(?:\.\d+)?)/i, // 1x01, 1x12.5
            /(?:(\d+)(?:st|nd|rd|th)\s+season)|s(?:eason)?\.?\s*(\d+)/i, // 2nd season, season 2, s2, s.2
            /e(?:p(?:isode)?)?\.?\s*(\d+(?:\.\d+)?)/i, // EP 01, Episode 1, e1, ep. 1, ep 12.5
        ];

        const findDetails = (text) => {
            if (!text) return;
            // Prioritize combined SxE patterns first
            for (const pattern of [patterns[0], patterns[1]]) {
                const match = text.match(pattern);
                if (match && match.length === 3) {
                    if (!season) { season = parseFloat(match[1]); matchedStrings.add(match[0]); }
                    if (!episode) { episode = parseFloat(match[2]); matchedStrings.add(match[0]); }
                    return; // Found both, we're done with this text
                }
            }
            // If not found, look for season and episode independently
            const seasonMatch = text.match(patterns[2]);
            if (seasonMatch) {
                if (!season && (seasonMatch[1] || seasonMatch[2])) {
                    season = parseFloat(seasonMatch[1] || seasonMatch[2]); // Group 1 for "2nd", Group 2 for "s2"
                    matchedStrings.add(seasonMatch[0]);
                }
            }
            const episodeMatch = text.match(patterns[3]);
            if (episodeMatch) {
                if (!episode) { episode = parseFloat(episodeMatch[1]); matchedStrings.add(episodeMatch[0]); }
            }
        };

        // --- Scraper Strategy ---

        // STEP 1: Check the URL hash. This is the highest priority source as it's
        // an unambiguous indicator of the current episode on sites like anikai.to.
        const urlHash = window.location.hash;
        if (urlHash && !episode) {
            const hashMatch = urlHash.match(/ep(?:isode)?=?(\d+)/i);
            if (hashMatch && hashMatch[1]) {
                episode = parseFloat(hashMatch[1]);
            }
        }

        // STEP 2: Look for an "active" or "selected" element in an episode list.
        // This is the next most reliable source, as it's a strong visual cue.
        if (!episode) {
            findDetails(document.querySelector('[class*="active"] a, [class*="selected"] a, a[class*="active"], a[class*="selected"]')?.textContent);
        }

        // STEP 3: Find the cleanest possible "main title" from the page content.
        // An <h1> is the best candidate, as it's usually cleaner than the document.title.
        let mainAnimeTitle = '';
        const h1Element = document.querySelector('h1');
        if (h1Element) {
            // Prioritize a link with a title attribute inside the h1, as it's often the cleanest.
            const h1Link = h1Element.querySelector('a[title]');
            if (h1Link && h1Link.title) {
                mainAnimeTitle = h1Link.title.trim();
            } else {
                // Fallback: Clone the h1, remove screen-reader-only spans, then get text.
                const h1Clone = h1Element.cloneNode(true);
                h1Clone.querySelectorAll('.sr-only, [style*="display: none"], [style*="visibility: hidden"]').forEach(el => el.remove());
                mainAnimeTitle = h1Clone.textContent.trim();
            }
        } else { // Fallback if no h1 is found at all.
            const titleCandidate = document.querySelector('h2, a[title]'); // Check h2 or any link with a title
            if (titleCandidate) mainAnimeTitle = (titleCandidate.title || titleCandidate.textContent).trim();
        }

        // STEP 4: Scan for season/episode numbers. We check both the document.title and the
        // main title we found, as the information can be in different places.
        findDetails(title);
        findDetails(mainAnimeTitle);

        // STEP 5: If details are still missing, perform a broader search on the page
        // in other common heading and class-named elements.
        if (!season || !episode) {
            const candidateSelectors = [
                'h1', 'h2', 'h3',
                '[class*="episode"]', '[id*="episode"]'
            ];
            const candidates = document.querySelectorAll(candidateSelectors.join(', '));
            for (const candidate of candidates) {
                findDetails(candidate.textContent);
                if (season && episode) break;
            }
        }

        // STEP 6: Finalize the title.
        // Prioritize the mainAnimeTitle from h1 if it exists, as it's the most reliable.
        // Otherwise, fall back to the document.title.
        let cleanTitle = mainAnimeTitle || title;

        // Surgically remove the exact text that was matched for season/episode
        // (e.g., "Season 2", "Ep. 01") to avoid leaving fragments.
        for (const matchedString of matchedStrings) {
            cleanTitle = cleanTitle.replace(new RegExp(matchedString.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '');
        }
        
        // Now, remove all words from the built-in and user-defined filter lists.
        // This is done *after* choosing the title source to clean up both cases.
        const junkRegex = new RegExp(`(^|\\s)(${this.scraperFilterWords.join('|')})(\\s|$)`, 'gi');
        cleanTitle = cleanTitle.replace(junkRegex, ' ');
        
        // Final cleanup: remove leftover episode numbers, extra symbols, and whitespace.
        if (episode) cleanTitle = cleanTitle.replace(new RegExp(`\\b${episode}\\b`, 'g'), '');
        cleanTitle = cleanTitle.replace(/\s\.\d+\s/g, ' '); // Remove leftover decimals like " .5 "
        // Only remove hyphens, pipes, or colons that are used as separators (surrounded by spaces).
        // This preserves them when they are part of the actual title.
        cleanTitle = cleanTitle.replace(/\s*[-|:]\s*$/, '').replace(/\s+/g, ' ').trim();

        const episodePrefix = season ? `s${season}e${episode}` : (episode ? `e${episode}` : '');
        return { url: detectedUrl, title: episodePrefix ? `${episodePrefix} - ${cleanTitle}`.trim() : cleanTitle };
    }
}