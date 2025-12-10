/**
 * Manages the creation and updates of the browser's context menus.
 */

const CONTEXTS = ["link", "video", "audio", "page"];
const PARENT_MENU_ID = "add-to-mpv-parent";
const YOUTUBE_PLAYLIST_MENU_ID = 'add-youtube-playlist-parent';

/**
 * Creates or updates all context menus based on the current folder data.
 * It creates a main menu item "Add to MPV Folder" and a specific one for YouTube playlists.
 * The most recently used folder is placed at the top of the list for quick access.
 *
 * @param {import('./storageManager.js').StorageManager} storage - The initialized storage manager instance.
 */
export async function updateContextMenus(storage) {
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
        return;
    }

    const lastUsedFolderId = data.settings.last_used_folder_id;

    // Create the main parent menu item.
    chrome.contextMenus.create({
        id: PARENT_MENU_ID,
        title: "Add to MPV Folder",
        contexts: CONTEXTS,
    });

    // Create a separate parent menu for YouTube playlists.
    chrome.contextMenus.create({
        id: YOUTUBE_PLAYLIST_MENU_ID,
        title: 'Add Playlist to MPV Folder',
        contexts: ['link'],
        targetUrlPatterns: ["*://*.youtube.com/playlist?list=*"]
    });

    // Reorder folders to place the last used one at the top for convenience.
    let orderedFolderIds = [...folderIds];
    if (lastUsedFolderId && orderedFolderIds.includes(lastUsedFolderId)) {
        orderedFolderIds = orderedFolderIds.filter(id => id !== lastUsedFolderId);
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
}