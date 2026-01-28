// utils/item_processor.js

import { sanitizeString, normalizeYouTubeUrl } from "./commUtils.module.js";

/**
 * Generates a unique ID for playlist items.
 */
export function generateItemId() {
	if (typeof crypto !== "undefined" && crypto.randomUUID) {
		return crypto.randomUUID();
	}
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		const v = c === "x" ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
}

/**
 * Processes a single raw item (string or object) into a standardized playlist item.
 * 
 * @param {string|Object} rawItem - The item to process.
 * @param {Object} options - Configuration for processing.
 * @returns {Object|null} - The standardized item or null if invalid.
 */
export function processPlaylistItem(rawItem, options = {}) {
	const {
		preserveTitle = true,
		preserveResumeTime = true,
		forceNewId = false
	} = options;

	if (!rawItem) return null;

	let url = "";
	let title = "";
	let id = forceNewId ? null : (rawItem.id || null);
	let settings = rawItem.settings || {};
	let resumeTime = preserveResumeTime ? rawItem.resumeTime : undefined;
    let markedAsWatched = rawItem.markedAsWatched;

	if (typeof rawItem === "string") {
		url = rawItem;
		title = rawItem;
	} else if (typeof rawItem === "object" && rawItem.url) {
		url = rawItem.url;
		title = preserveTitle ? (rawItem.title || rawItem.url) : rawItem.url;
	} else {
		return null;
	}

	const sanitizedUrl = sanitizeString(url);
	const normalizedUrl = normalizeYouTubeUrl(sanitizedUrl);
	const sanitizedTitle = sanitizeString(title);

	return {
		url: normalizedUrl,
		title: sanitizedTitle,
		id: id || generateItemId(),
		settings: settings,
		...(resumeTime !== undefined && { resumeTime: resumeTime }),
        ...(markedAsWatched !== undefined && { markedAsWatched: markedAsWatched })
	};
}

/**
 * Processes an array of raw items into standardized playlist items.
 */
export function processPlaylist(playlist, options = {}) {
	if (!Array.isArray(playlist)) return [];
	return playlist
		.map(item => processPlaylistItem(item, options))
		.filter(item => item !== null);
}
