/**
 * Manages the creation and updates of the browser's context menus.
 */

const CONTEXTS = ["link", "video", "audio", "page"];
const PARENT_MENU_ID = "add-to-mpv-parent";
const YOUTUBE_PLAYLIST_MENU_ID = "add-youtube-playlist-parent";
const SHINKU_YT_LIBRARY_MENU_ID = "shinku-yt-save-library";

async function createShinkuYtContextMenu() {
	const { shinkuYtToolsEnabled } = await chrome.storage.local.get("shinkuYtToolsEnabled");
	if (shinkuYtToolsEnabled) {
		chrome.contextMenus.create({
			id: SHINKU_YT_LIBRARY_MENU_ID,
			title: "Save to Shinku YT Library",
			contexts: ["link", "page"],
			documentUrlPatterns: ["*://*.youtube.com/*"],
		});
	}
}

let _menuUpdateQueue = Promise.resolve();

/**
 * Creates or updates all context menus based on the current folder data.
 * Serialized through a module-level promise queue so concurrent calls cannot race.
 *
 * @param {import('./storageManager.js').StorageManager} storage - The initialized storage manager instance.
 */
export function updateContextMenus(storage) {
	const next = _menuUpdateQueue.then(() => _performUpdateContextMenus(storage));
	_menuUpdateQueue = next.catch(() => {});
	return next;
}

async function _performUpdateContextMenus(storage) {
	// Remove all existing context menus for this extension to ensure a clean slate.
	await chrome.contextMenus.removeAll();

	const data = await storage.get();
	const folderIds = data.folderOrder || Object.keys(data.folders);

	// If there are no folders, create a disabled placeholder item.
	if (folderIds.length === 0) {
		chrome.contextMenus.create({
			id: "no-folders-available",
			title: "No MPV folders available",
			enabled: false,
			contexts: CONTEXTS,
		});
		await createShinkuYtContextMenu();
		return;
	}

	const lastUsedFolderId = data.settings.lastUsedFolderId;
	const oneClickAdd =
		data.settings.uiPreferences?.global?.oneClickAdd ?? false;

	// If One-Click Add is enabled, create top-level shortcut items for the last used folder.
	if (oneClickAdd && lastUsedFolderId && folderIds.includes(lastUsedFolderId)) {
		chrome.contextMenus.create({
			id: "add-to-last-used",
			title: `Add to MPV (${lastUsedFolderId})`,
			contexts: CONTEXTS,
		});
		chrome.contextMenus.create({
			id: "add-playlist-to-last-used",
			title: `Add Playlist to MPV (${lastUsedFolderId})`,
			contexts: ["link"],
			targetUrlPatterns: ["*://*.youtube.com/playlist?list=*"],
		});
	}

	// Create the main parent menu item.
	chrome.contextMenus.create({
		id: PARENT_MENU_ID,
		title: "Add to MPV Folder",
		contexts: CONTEXTS,
	});

	// Create a separate parent menu for YouTube playlists.
	chrome.contextMenus.create({
		id: YOUTUBE_PLAYLIST_MENU_ID,
		title: "Add Playlist to MPV Folder",
		contexts: ["link"],
		targetUrlPatterns: ["*://*.youtube.com/playlist?list=*"],
	});

	// Reorder folders to place the last used one at the top for convenience.
	let orderedFolderIds = [...folderIds];
	if (lastUsedFolderId && orderedFolderIds.includes(lastUsedFolderId)) {
		orderedFolderIds = orderedFolderIds.filter((id) => id !== lastUsedFolderId);
		orderedFolderIds.unshift(lastUsedFolderId);
	}

	// Create a child menu item for each folder under both parent menus.
	orderedFolderIds.forEach((id) => {
		// Add to the main "Add to MPV Folder" menu.
		chrome.contextMenus.create({
			id: `add-to-folder-${id}`,
			parentId: PARENT_MENU_ID,
			title: id,
			contexts: CONTEXTS,
		});

		// Add to the "Add Playlist to MPV Folder" menu.
		chrome.contextMenus.create({
			id: `add-playlist-to-folder-${id}`,
			parentId: YOUTUBE_PLAYLIST_MENU_ID,
			title: id,
			contexts: ["link"],
		});
	});

	// Optional "Save to Shinku YT Library" menu item when YouTube Tools is enabled
	await createShinkuYtContextMenu();
}
