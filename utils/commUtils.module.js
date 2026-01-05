/**
 * Shared communication utilities for the MPV Playlist Organizer.
 * ES Module version for Background Service Worker.
 */

export function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
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

export function sanitizeString(str, isFilename = false) {
    if (typeof str !== 'string') return str;
    
    if (isFilename) {
        // Strict blacklist for folder names / filenames: / \ : * ? " < > | $ ; & `
        // Also remove newlines and tabs.
        return str.replace(/["\/:*?<>|$;&`\n\r\t]/g, '').trim();
    } else {
        // Minimal destruction for URLs/Titles. 
        // Only remove characters that are strictly illegal in M3U or break our JSON/logging.
        // Quotes and backticks are removed as they are the primary injection risks.
        // Preserves functional characters like &, ?, =, ;, and $ for URLs.
        return str.replace(/["\`\n\r\t]/g, '').trim();
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

export function normalizeYouTubeUrl(ytUrl) {
    if (!ytUrl || typeof ytUrl !== 'string') return ytUrl;
    try {
        const urlObj = new URL(ytUrl);
        if (urlObj.hostname.includes('youtube.com') && urlObj.pathname === '/watch') {
            urlObj.searchParams.delete('t');
            return urlObj.toString();
        }
    } catch (e) {
        // Not a valid URL, return original
    }
    return ytUrl;
}
