/**
 * Shared communication utilities for the MPV Playlist Organizer.
 * Namespaced Global version for maximum compatibility.
 */
window.MPV_INTERNAL = window.MPV_INTERNAL || {};

(function() {
    'use strict';

    const MPV = window.MPV_INTERNAL;

    MPV.debounce = function(func, wait) {
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

    MPV.sendMessageAsync = (payload) => new Promise((resolve, reject) => {
        if (typeof chrome === 'undefined' || !chrome.runtime?.id) {
            return reject(new Error("Extension context invalidated."));
        }
        chrome.runtime.sendMessage(payload, (response) => {
            if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
            resolve(response);
        });
    });

    MPV.sanitizeString = function(str, isFilename = false) {
        if (typeof str !== 'string') return str;
        if (isFilename) {
            return str.replace(/["\/:*?<>|$;&`\n\r\t]/g, '').trim();
        } else {
            return str.replace(/["`\n\r\t]/g, '').trim();
        }
    };

    MPV.isYouTubeUrl = function(url) {
        if (!url || typeof url !== 'string') return false;
        return url.includes('youtube.com/') || url.includes('youtu.be/');
    };

    MPV.getYoutubeId = function(url) {
        if (!url) return null;
        const videoMatch = url.match(/(?:v=|\/v\/|embed\/|youtu\.be\/|\/shorts\/)([a-zA-Z0-9_-]{11})/);
        if (videoMatch) return videoMatch[1];
        const listMatch = url.match(/[?&]list=([a-zA-Z0-9_-]+)/);
        if (listMatch) return listMatch[1];
        return null;
    };

    MPV.normalizeYouTubeUrl = function(ytUrl) {
        if (!ytUrl || typeof ytUrl !== 'string') return ytUrl;
        try {
            const urlObj = new URL(ytUrl);
            const isStandard = urlObj.hostname.includes('youtube.com') && urlObj.pathname === '/watch';
            const isShorts = urlObj.hostname.includes('youtube.com') && urlObj.pathname.startsWith('/shorts/');
            const isShortLink = urlObj.hostname.includes('youtu.be');
            
            if (isStandard || isShortLink || isShorts) {
                urlObj.searchParams.delete('t');
                return urlObj.toString();
            }
        } catch (e) {}
        return ytUrl;
    };

    MPV.Logger = class Logger {
        constructor(tag = 'MPV') {
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

})();
