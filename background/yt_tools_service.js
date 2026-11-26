/**
 * Manages the optional, isolated "Shinku's YouTube Tools" sub-extension.
 * Disabled by default; dynamically registers/unregisters MAIN & ISOLATED
 * content scripts via chrome.scripting without modifying manifest.json.
 */

import { logger } from "../utils/SystemLogger.module.js";

const YT_TOOLS_MATCHES = ["*://*.youtube.com/*"];
const YT_BRIDGE_SCRIPT_ID = "shinku-yt-bridge";
const YT_MAIN_SCRIPT_ID = "shinku-yt-main";
export const YT_LIBRARY_MENU_ID = "shinku-yt-save-library";
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const VALID_VIDEO_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

const MPV_ACTION_ICONS = {
	16: "images/icon16.png",
	32: "images/icon32.png",
	48: "images/icon48.png",
	128: "images/icon128.png",
};

const YT_ACTION_ICONS = {
	16: "yt-tools/icons/icon16.png",
	32: "yt-tools/icons/icon32.png",
	48: "yt-tools/icons/icon48.png",
	128: "yt-tools/icons/icon128.png",
};

let actionIconSyncInitialized = false;
let registrationQueue = Promise.resolve();
let libraryWriteQueue = Promise.resolve();

function isValidVideoId(id) {
	return typeof id === "string" && VALID_VIDEO_ID_RE.test(id) && !FORBIDDEN_KEYS.has(id);
}

function isYouTubeUrl(urlStr) {
	if (!urlStr || typeof urlStr !== "string") return false;
	try {
		const parsed = new URL(urlStr);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
		const host = parsed.hostname.toLowerCase();
		return host === "youtube.com" || host.endsWith(".youtube.com");
	} catch (_err) {
		return false;
	}
}

async function getDominantIconState() {
	const { shinkuYtToolsEnabled, shinkuExtensionSettings } = await chrome.storage.local.get([
		"shinkuYtToolsEnabled",
		"shinkuExtensionSettings",
	]);
	const enabled = Boolean(shinkuYtToolsEnabled);
	const playlistManager = shinkuExtensionSettings?.["playlist-manager"];
	const categoryEnabled = playlistManager?.["playlist-manager"] !== false;
	const dominant = Boolean(playlistManager?.["yt-dominant-on-youtube"]);
	return enabled && categoryEnabled && dominant;
}

export async function syncTabActionIcon(tabId, url, dominantOverride = null) {
	if (!tabId || !chrome?.action?.setIcon) return;
	try {
		const dominantEnabled = dominantOverride === null ? await getDominantIconState() : Boolean(dominantOverride);
		const isDominant = dominantEnabled && isYouTubeUrl(url);
		await chrome.action.setIcon({
			tabId,
			path: isDominant ? YT_ACTION_ICONS : MPV_ACTION_ICONS,
		});
		if (chrome.action.setTitle) {
			await chrome.action.setTitle({
				tabId,
				title: isDominant ? "Shinku's YouTube Tools" : "MPV Playlist Organizer",
			});
		}
	} catch (e) {
		logger.debug(`[YT Tools] syncTabActionIcon skipped for tab ${tabId}: ${e?.message}`);
	}
}

export async function syncAllTabActionIcons() {
	if (!chrome?.tabs?.query || !chrome?.action?.setIcon) return;
	try {
		const dominantState = await getDominantIconState();
		const tabs = await chrome.tabs.query({});
		for (const tab of tabs) {
			if (tab?.id) {
				await syncTabActionIcon(tab.id, tab.url || tab.pendingUrl || "", dominantState);
			}
		}
	} catch (e) {
		logger.debug(`[YT Tools] syncAllTabActionIcons skipped: ${e?.message}`);
	}
}

export function initYtToolsActionIconSync() {
	if (actionIconSyncInitialized) return;
	actionIconSyncInitialized = true;

	if (chrome?.storage?.onChanged) {
		chrome.storage.onChanged.addListener((changes, areaName) => {
			if (areaName !== "local") return;
			if (changes.shinkuYtToolsEnabled || changes.shinkuExtensionSettings) {
				syncAllTabActionIcons().catch((e) =>
					logger.debug(`[YT Tools] storage icon sync skipped: ${e?.message}`)
				);
			}
		});
	}

	if (chrome?.tabs?.onUpdated) {
		chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
			if (changeInfo.url || changeInfo.status === "loading" || changeInfo.status === "complete") {
				syncTabActionIcon(tabId, changeInfo.url || tab?.url || tab?.pendingUrl || "");
			}
		});
	}

	if (chrome?.tabs?.onActivated && chrome?.tabs?.get) {
		chrome.tabs.onActivated.addListener(async ({ tabId }) => {
			try {
				const tab = await chrome.tabs.get(tabId);
				await syncTabActionIcon(tabId, tab?.url || tab?.pendingUrl || "");
			} catch (e) {
				logger.debug(`[YT Tools] onActivated icon sync skipped: ${e?.message}`);
			}
		});
	}

	if (chrome?.tabs?.onReplaced && chrome?.tabs?.get) {
		chrome.tabs.onReplaced.addListener(async (addedTabId) => {
			try {
				const tab = await chrome.tabs.get(addedTabId);
				await syncTabActionIcon(addedTabId, tab?.url || tab?.pendingUrl || "");
			} catch (e) {
				logger.debug(`[YT Tools] onReplaced icon sync skipped: ${e?.message}`);
			}
		});
	}

	syncAllTabActionIcons().catch((e) =>
		logger.debug(`[YT Tools] initial icon sync skipped: ${e?.message}`)
	);
}

/**
 * Extracts a YouTube video ID from standard watch, shorts, live, embed, or youtu.be URLs.
 * @param {string} urlStr
 * @returns {string|null}
 */
export function extractYouTubeVideoId(urlStr) {
	if (!urlStr || typeof urlStr !== "string") return null;
	try {
		const url = new URL(urlStr);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		const host = url.hostname.toLowerCase();
		let candidate = null;
		if (host === "youtu.be") {
			const parts = url.pathname.slice(1).split("/").filter(Boolean);
			if (parts[0] === "watch") {
				candidate = url.searchParams.get("v");
			} else {
				candidate = parts[0] || null;
			}
		} else if (host === "youtube.com" || host.endsWith(".youtube.com")) {
			const v = url.searchParams.get("v");
			if (v) {
				candidate = v;
			} else {
				const parts = url.pathname.split("/").filter(Boolean);
				if (parts.length >= 2 && ["shorts", "live", "embed"].includes(parts[0])) {
					candidate = parts[1];
				}
			}
		}
		return isValidVideoId(candidate) ? candidate : null;
	} catch {
		return null;
	}
}

/**
 * Registers or unregisters the YouTube Tools dynamic content scripts
 * based on `shinkuYtToolsEnabled` in chrome.storage.local.
 * Serialized to prevent concurrent enable/disable races.
 * @returns {Promise<boolean>} Current enabled state
 */
export function syncYtToolsRegistration() {
	const nextTask = registrationQueue.then(() => _performSyncYtToolsRegistration());
	registrationQueue = nextTask.catch(() => {});
	return nextTask;
}

async function _performSyncYtToolsRegistration() {
	if (!chrome?.scripting?.registerContentScripts) {
		return false;
	}
	const { shinkuYtToolsEnabled } = await chrome.storage.local.get("shinkuYtToolsEnabled");
	const enabled = Boolean(shinkuYtToolsEnabled);

	const targetIds = [YT_BRIDGE_SCRIPT_ID, YT_MAIN_SCRIPT_ID];
	let existingIds = [];
	try {
		const existing = await chrome.scripting.getRegisteredContentScripts({ ids: targetIds });
		existingIds = existing.map((s) => s.id);
	} catch (e) {
		logger.debug(`[YT Tools] getRegisteredContentScripts check failed: ${e?.message}`);
	}

	if (enabled) {
		if (existingIds.length > 0) {
			await chrome.scripting
				.unregisterContentScripts({ ids: existingIds })
				.catch((e) => logger.debug(`[YT Tools] unregisterContentScripts skipped: ${e?.message}`));
		}
		await chrome.scripting.registerContentScripts([
			{
				id: YT_BRIDGE_SCRIPT_ID,
				matches: YT_TOOLS_MATCHES,
				js: ["yt-tools/yt_defaults.js", "yt-tools/yt_bridge.js"],
				runAt: "document_start",
				world: "ISOLATED",
				persistAcrossSessions: true,
			},
			{
				id: YT_MAIN_SCRIPT_ID,
				matches: YT_TOOLS_MATCHES,
				js: ["yt-tools/yt_content.js"],
				runAt: "document_start",
				world: "MAIN",
				persistAcrossSessions: true,
			},
		]);
		logger.info("[YT Tools] Dynamic content scripts registered.");
		await injectIntoOpenMatchingTabs();
	} else if (existingIds.length > 0) {
		await chrome.scripting.unregisterContentScripts({ ids: existingIds });
		logger.info("[YT Tools] Dynamic content scripts unregistered.");
	}

	await syncAllTabActionIcons();
	return enabled;
}

async function injectIntoOpenMatchingTabs() {
	if (!chrome?.tabs?.query || !chrome?.scripting?.executeScript) {
		return;
	}
	try {
		const tabs = await chrome.tabs.query({ url: YT_TOOLS_MATCHES });
		for (const tab of tabs) {
			if (!tab.id) continue;
			await chrome.scripting
				.executeScript({
					target: { tabId: tab.id },
					files: ["yt-tools/yt_defaults.js", "yt-tools/yt_bridge.js"],
					world: "ISOLATED",
				})
				.catch((e) => logger.debug(`[YT Tools] ISOLATED inject skipped for tab ${tab.id}: ${e?.message}`));
			await chrome.scripting
				.executeScript({
					target: { tabId: tab.id },
					files: ["yt-tools/yt_content.js"],
					world: "MAIN",
				})
				.catch((e) => logger.debug(`[YT Tools] MAIN inject skipped for tab ${tab.id}: ${e?.message}`));
		}
	} catch (e) {
		logger.debug(`[YT Tools] Live tab injection skipped: ${e?.message}`);
	}
}

/**
 * Enables or disables YouTube Tools, updates script registration, and
 * injects into already-open matching tabs when enabled.
 * @param {boolean} enabled
 * @returns {Promise<{success: boolean, enabled: boolean}>}
 */
export async function setYtToolsEnabled(enabled) {
	const flag = Boolean(enabled);
	await chrome.storage.local.set({ shinkuYtToolsEnabled: flag });
	await syncYtToolsRegistration();

	return { success: true, enabled: flag };
}

function normalizeLibraryDictionary(rawLibrary) {
	const out = {};
	if (Array.isArray(rawLibrary)) {
		for (const item of rawLibrary) {
			if (!item || typeof item !== "object") continue;
			const vid = String(item.id || item.videoId || "");
			if (!isValidVideoId(vid)) continue;
			out[vid] = { ...item, id: vid, videoId: vid };
		}
		return out;
	}
	if (rawLibrary && typeof rawLibrary === "object") {
		for (const [k, item] of Object.entries(rawLibrary)) {
			if (FORBIDDEN_KEYS.has(k) || !item || typeof item !== "object" || Array.isArray(item)) continue;
			const vid = String(item.id || item.videoId || k);
			if (!isValidVideoId(vid)) continue;
			out[k] = item;
		}
	}
	return out;
}

/**
 * Saves a YouTube video (from a right-click link or current watch page)
 * into `shinkuLibrary` in chrome.storage.local.
 * @param {string} targetUrl
 * @param {chrome.tabs.Tab} tab
 */
export async function handleSaveYouTubeLinkToLibrary(targetUrl, tab) {
	const videoId = extractYouTubeVideoId(targetUrl);
	if (!videoId) return { success: false, error: "Not a YouTube video URL" };

	// If right-clicked on the currently playing watch page, let yt_content.js capture exact currentTime/duration
	const tabVideoId = tab?.url ? extractYouTubeVideoId(tab.url) : null;
	if (tab?.id && tabVideoId === videoId) {
		try {
			const resp = await chrome.tabs.sendMessage(tab.id, { action: "shinku_yt_save_current_video" });
			if (resp && resp.success === true && resp.saved !== false && (!resp.videoId || resp.videoId === videoId)) {
				return { success: true, videoId };
			}
		} catch (e) {
			logger.debug(`[YT Tools] Active tab save message failed, falling back to oEmbed: ${e?.message}`);
		}
	}

	let title = `YouTube Video (${videoId})`;
	let uploader = "YouTube";
	try {
		const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`)}&format=json`;
		const resp = await fetch(oembedUrl, { signal: AbortSignal.timeout(5000) });
		if (resp.ok) {
			const meta = await resp.json();
			if (meta?.title) title = meta.title;
			if (meta?.author_name) uploader = meta.author_name;
		}
	} catch (e) {
		logger.debug(`[YT Tools] oEmbed fetch failed for ${videoId}: ${e?.message}`);
	}

	const writePromise = libraryWriteQueue.then(async () => {
		const { shinkuLibrary } = await chrome.storage.local.get("shinkuLibrary");
		const library = normalizeLibraryDictionary(shinkuLibrary);
		const existing =
			Object.prototype.hasOwnProperty.call(library, videoId) &&
			library[videoId] &&
			typeof library[videoId] === "object"
				? library[videoId]
				: {};
		library[videoId] = {
			...existing,
			id: videoId,
			videoId,
			title,
			channel: uploader,
			uploader,
			thumbnail: `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/mqdefault.jpg`,
			url: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
			currentTime: existing.currentTime || 0,
			duration: existing.duration || 0,
			done: false,
			doneAt: null,
			updatedAt: Date.now(),
		};
		await chrome.storage.local.set({ shinkuLibrary: library });
	});
	libraryWriteQueue = writePromise.catch(() => {});
	await writePromise;
	return { success: true, videoId };
}
