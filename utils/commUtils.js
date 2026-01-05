/**
 * Shared communication utilities for the MPV Playlist Organizer.
 * Global Namespace Version.
 */
window.MPV = window.MPV || {};

window.MPV.debounce = function(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func.apply(this, args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
};

window.MPV.sanitizeString = function(str, isFilename = false) {
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
};

window.MPV.sendMessageAsync = function(payload) {
    return new Promise((resolve, reject) => {
        if (typeof chrome === 'undefined' || !chrome.runtime?.id) {
            return reject(new Error("Extension context invalidated."));
        }
        chrome.runtime.sendMessage(payload, (response) => {
            if (chrome.runtime.lastError) {
                return reject(new Error(chrome.runtime.lastError.message));
            }
            resolve(response);
        });
    });
};

window.MPV.isYouTubeUrl = function(url) {
    if (!url || typeof url !== 'string') return false;
    return url.includes('youtube.com/') || url.includes('youtu.be/');
};

window.MPV.getYoutubeId = function(url) {
    if (!url) return null;
    const videoMatch = url.match(/(?:v=|\/v\/|embed\/|youtu\.be\/|\/shorts\/)([a-zA-Z0-9_-]{11})/);
    if (videoMatch) return videoMatch[1];
    const listMatch = url.match(/[?&]list=([a-zA-Z0-9_-]+)/);
    if (listMatch) return listMatch[1];
    return null;
};

window.MPV.normalizeYouTubeUrl = function(ytUrl) {
    if (!ytUrl || typeof ytUrl !== 'string') return ytUrl;
    try {
        const urlObj = new URL(ytUrl);
        const isStandard = urlObj.hostname.includes('youtube.com') && urlObj.pathname === '/watch';
        const isShort = urlObj.hostname.includes('youtu.be');
        
        if (isStandard || isShort) {
            urlObj.searchParams.delete('t');
            // Also strip list param if we want to treat video individually, but usually we keep playlist context.
            // For now, strictly stripping 't' as requested.
            return urlObj.toString();
        }
    } catch (e) {
        // Not a valid URL, return original
    }
    return ytUrl;
};

/**
 * Standardized Logger for unified output format.
 */
window.MPV.Logger = class Logger {
    constructor(tag = 'UI') {
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
};
