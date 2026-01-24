// utils/InputProcessor.js
// Dual-mode version for Content Scripts and Modules

(function() {
    const root = typeof globalThis !== "undefined" ? globalThis : (typeof self !== "undefined" ? self : window);
    root.MPV_INTERNAL = root.MPV_INTERNAL || {};
    const MPV = root.MPV_INTERNAL;
    
    MPV.normalizeItem = function(input, titleFallback = null) {
        let item = {};

        if (typeof input === "string") {
            item = {
                url: input,
                title: titleFallback || input,
            };
        } else if (typeof input === "object" && input !== null) {
            item = { ...input };
            if (!item.title && titleFallback) item.title = titleFallback;
        } else {
            throw new Error("Invalid input type for normalizeItem.");
        }

        // 1. Sanitize and Normalize URL (Using global functions from commUtils.js)
        const sanitize = MPV.sanitizeString || root.sanitizeString;
        const normalize = MPV.normalizeYouTubeUrl || root.normalizeYouTubeUrl;

        if (sanitize) item.url = sanitize(item.url || "");
        if (normalize) item.url = normalize(item.url);

        // 2. Sanitize Title
        if (sanitize) item.title = sanitize(item.title || item.url);
        if (item.title && item.title.length > 255) {
            item.title = item.title.substring(0, 252) + "...";
        }

        // 3. Ensure ID
        if (!item.id) {
            item.id = typeof crypto !== "undefined" && crypto.randomUUID
                ? crypto.randomUUID()
                : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
                        const r = (Math.random() * 16) | 0;
                        const v = c === "x" ? r : (r & 0x3) | 0x8;
                        return v.toString(16);
                    });
        }

        // 4. Ensure Settings
        if (!item.settings) {
            item.settings = {};
        }

        return item;
    };

    MPV.validateFolderName = function(name) {
        if (!name || typeof name !== "string") return { valid: false, error: "Empty name." };
        
        const sanitize = MPV.sanitizeString || root.sanitizeString;
        const sanitized = sanitize ? sanitize(name, true) : name;
        if (!sanitized) return { valid: false, error: "Invalid name after sanitization." };
        
        if (sanitized.length > 64) return { valid: false, error: "Name too long (max 64)." };
        
        return { valid: true, sanitized };
    };
})();

// Export for module environments
const MPV = typeof globalThis !== "undefined" ? globalThis.MPV_INTERNAL : (typeof self !== "undefined" ? self.MPV_INTERNAL : window.MPV_INTERNAL);
export const normalizeItem = MPV.normalizeItem;
export const validateFolderName = MPV.validateFolderName;