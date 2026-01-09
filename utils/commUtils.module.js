/**
 * Shared communication utilities for the MPV Playlist Organizer.
 * ES Module version for Background/Module contexts.
 *
 * !!! SYNC WARNING !!!
 * This file duplicates logic from 'utils/commUtils.js'.
 * Any changes made here MUST be replicated in that file to ensure
 * consistent behavior between Content Scripts and the Background Service Worker.
 */

export function debounce(func, wait) {
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

export const sendMessageAsync = (payload) => new Promise((resolve, reject) => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.id) {
        return reject(new Error("Extension context invalidated."));
    }
    chrome.runtime.sendMessage(payload, (response) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve(response);
    });
});

/**
 * Sanitizes strings for safe use in filenames or OSD titles.
 * @param {string} str The string to sanitize.
 * @param {boolean} isFilename If true, applies strict filesystem-safe filtering.
 */
export function sanitizeString(str, isFilename = false) {
    if (typeof str !== 'string') return str;
    if (isFilename) {
        // Strict filtering for filenames (strips / \ : * ? " < > | $ ; & ` and newlines)
        return str.replace(/[\\/:*?"<>|$;&`\n\r\t]/g, '').trim();
    } else {
        // Minimal filtering for Titles/URLs (strips " ` and newlines)
        return str.replace(/["`\n\r\t]/g, '').trim();
    }
}

export function isYouTubeUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return url.includes('youtube.com/') || url.includes('youtu.be/');
}

export function getYoutubeId(url) {
    if (!url) return null;
    const videoMatch = url.match(/(?:v=|\/v\/|embed\/|youtu\.be\/|\/shorts\/)([a-zA-Z0-9_-]{11})/);
    if (videoMatch) return videoMatch[1];
    const listMatch = url.match(/[?&]list=([a-zA-Z0-9_-]+)/);
    if (listMatch) return listMatch[1];
    return null;
}

/**
 * Normalizes YouTube URLs by removing timestamps and other tracking parameters.
 */
export function normalizeYouTubeUrl(ytUrl) {
    if (!ytUrl || typeof ytUrl !== 'string') return ytUrl;
    try {
        const urlObj = new URL(ytUrl);
        const host = urlObj.hostname;
        const path = urlObj.pathname;

        const isStandard = host.includes('youtube.com') && path === '/watch';
        const isShorts = host.includes('youtube.com') && path.startsWith('/shorts/');
        const isShortLink = host.includes('youtu.be');
        
        if (isStandard || isShortLink || isShorts) {
            // Strip timestamps and index/shuffle parameters that break resume/deduplication logic
            ['t', 'index', 'start', 'ab_channel', 'attr_tag'].forEach(p => urlObj.searchParams.delete(p));
            return urlObj.toString();
        }
    } catch (e) {}
    return ytUrl;
}

export class Logger {
    constructor(tag = 'BG') {
        this.tag = tag;
    }
    _format(msg) {
        const time = new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
        return `[${time}] [${this.tag}]: ${msg}`;
    }
    info(msg) { console.log(this._format(msg)); }
    warn(msg) { console.warn(this._format(msg)); }
    error(msg) { console.error(this._format(msg)); }
    debug(msg) { console.debug(this._format(msg)); }
}
