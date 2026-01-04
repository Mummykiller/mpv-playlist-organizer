/**
 * Unified sanitization logic for URLs, Titles, and Filenames.
 * This ensures consistency across content scripts, background handlers, and the popup.
 */

/**
 * Sanitizes a string to be safe for use in M3U files, internal storage, or as a filename.
 * @param {string} str The string to sanitize.
 * @param {boolean} isFilename Whether to apply strict filename sanitization rules.
 * @returns {string} The sanitized string.
 */
export function sanitizeString(str, isFilename = false) {
    if (typeof str !== 'string') return str;
    
    if (isFilename) {
        // Strict blacklist for folder names / filenames: / \ : * ? " < > | $ ; & `
        // Also remove newlines and tabs. This matches Layer 2 & 3 of the Sanitization Plan.
        return str.replace(/["\/:*?<>|$;&`\n\r\t]/g, '').trim();
    } else {
        // Minimal destruction for URLs/Titles. 
        // Only strip characters that break M3U files or our internal JSON logging.
        // Quotes and backticks are removed as they are the primary injection risks.
        // Preserves functional characters like &, ?, =, ;, and $ for URLs.
        return str.replace(/["\`\n\r\t]/g, '').trim();
    }
}

