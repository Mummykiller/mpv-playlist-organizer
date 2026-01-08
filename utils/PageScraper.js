/**
 * @class PageScraper
 * Handles extraction of clean titles and URLs from various web pages.
 * Includes intelligent season/episode detection and site-specific rules.
 */
window.MPV_INTERNAL = window.MPV_INTERNAL || {};

(function() {
    'use strict';

    const MPV = window.MPV_INTERNAL;

    MPV.PageScraper = class PageScraper {
        constructor() {
            this.filterWords = ['watch', 'online', 'free', 'episode', 'season', 'full', 'hd', 'eng sub', 'subbed', 'dubbed', 'animepahe'];
        }

        updateFilterWords(words) {
            if (Array.isArray(words)) this.filterWords = words;
        }

        /**
         * Scrapes the page for the best possible title and URL.
         * @param {string} url - The URL to scrape details for.
         * @returns {object} { url, title }
         */
        scrapePageDetails(url) {
            if (!url) return { url: null, title: document.title };

            const hostname = window.location.hostname;

            // --- 1. Specialized YouTube Logic ---
            if (hostname.includes('youtube.com')) {
                if (window.location.pathname.includes('/playlist')) {
                    return { url: url, title: null };
                }
                
                const titleSelectors = [
                    'h1.ytd-watch-metadata yt-formatted-string.ytd-video-primary-info-renderer',
                    '#title > h1 > yt-formatted-string',
                    '#title-text',
                    '.ytp-title-link',
                    'meta[property="og:title"]'
                ];
                const channelSelectors = [
                    '#owner-name a',
                    '#channel-name a',
                    'ytd-channel-name a',
                    '.ytd-channel-name',
                    'meta[property="og:site_name"]'
                ];

                const findFirst = (selectors, attribute = 'textContent') => {
                    for (const selector of selectors) {
                        const el = document.querySelector(selector);
                        if (el) return (el[attribute] || el.content || '').trim();
                    }
                    return null;
                };

                let videoTitle = findFirst(titleSelectors, 'content') || document.title;
                const channelName = findFirst(channelSelectors);
                
                // Only strip leading notification counts in parentheses, e.g., "(1) Video Title"
                videoTitle = videoTitle.replace(/^\(\d+\)\s*/, '').replace(/\s-\sYouTube$/, '').trim();
                return { url: url, title: channelName ? `${channelName} - ${videoTitle}` : videoTitle };
            }

            // --- 2. Generic Multi-Step Scraper Strategy (Non-YouTube) ---
            let title = document.title;
            let season = null;
            let episode = null;
            const matchedStrings = new Set();

            const patterns = [
                /s(?:eason)?\s*(\d+)\s*e(?:pisode)?\s*(\d+(?:\.\d+)?)/i,
                /(\d+)x(\d+(?:\.\d+)?)/i,
                /(?:(\d+)(?:st|nd|rd|th)\s+season)|s(?:eason)?\.?\s*(\d+)/i,
                /e(?:p(?:isode)?)?\.?\s*(\d+(?:\.\d+)?)/i
            ];

            const findDetails = (text) => {
                if (!text) return;
                for (const pattern of [patterns[0], patterns[1]]) {
                    const match = text.match(pattern);
                    if (match && match.length === 3) {
                        if (!season) { season = parseFloat(match[1]); matchedStrings.add(match[0]); }
                        if (!episode) { episode = parseFloat(match[2]); matchedStrings.add(match[0]); }
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
                const activeEl = document.querySelector('[class*="active"] a, [class*="selected"] a, a[class*="active"], a[class*="selected"]');
                if (activeEl) findDetails(activeEl.textContent);
            }

            let mainPageTitle = '';
            const h1Element = document.querySelector('h1');
            if (h1Element) {
                const h1Link = h1Element.querySelector('a[title]');
                if (h1Link && h1Link.title) {
                    mainPageTitle = h1Link.title.trim();
                } else {
                    const h1Clone = h1Element.cloneNode(true);
                    h1Clone.querySelectorAll('.sr-only, [style*="display: none"], [style*="visibility: hidden"]').forEach(el => el.remove());
                    mainPageTitle = h1Clone.textContent.trim();
                }
            }

            findDetails(title);
            findDetails(mainPageTitle);

            if (!season || !episode) {
                const candidates = document.querySelectorAll('h1, h2, h3, [class*="episode"], [id*="episode"]');
                for (const cand of candidates) {
                    findDetails(cand.textContent);
                    if (season && episode) break;
                }
            }

            let cleanTitle = mainPageTitle || title;

            for (const matchedString of matchedStrings) {
                cleanTitle = cleanTitle.replace(new RegExp(matchedString.replace(/[.*+?^${}()|[\\]/g, '\\$&'), 'gi'), '');
            }

            const junkRegex = new RegExp(`(^|\\s)(${this.filterWords.join('|')})(\\s|$)`, 'gi');
            cleanTitle = cleanTitle.replace(junkRegex, ' ');

            if (episode) cleanTitle = cleanTitle.replace(new RegExp(`\\b${episode}\\b`, 'g'), '');
            cleanTitle = cleanTitle.replace(/\s\.\d+\s/g, ' '); 
            cleanTitle = cleanTitle.replace(/\s*[-|:]\s*$/, '').replace(/\s+/g, ' ').trim();

            const episodePrefix = season ? `s${season}e${episode}` : (episode ? `e${episode}` : '');
            const finalTitle = episodePrefix ? `${episodePrefix} - ${cleanTitle}`.trim() : cleanTitle;

            const resultTitle = finalTitle || url;
            return { 
                url: MPV.sanitizeString(url), 
                title: MPV.sanitizeString(resultTitle) 
            };
        }
    };
})();
