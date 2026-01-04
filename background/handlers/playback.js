// background/handlers/playback.js

let _storage;
let _broadcastLog;
let _broadcastToTabs;
let _callNativeHost;
let _debouncedSyncToNativeHostFile;

const MPV_PLAYLIST_COMPLETED_EXIT_CODE = 99;

class PlaybackQueue {
    constructor() {
        this.queue = [];
        this.isPlaying = false;
        this.isProcessingQueue = false;
        this.currentPlayingItem = null; // { urlItem, folderId, isLastInFolder }
    }

    /**
     * Sends a single URL item to the native host for playback.
     * This includes all necessary preferences and bypass script configuration.
     * @param {object} url_item The URL item object to play.
     * @param {string} folder_id The ID of the folder the item belongs to.
     * @param {object} globalPrefs The global UI preferences.
     * @returns {Promise<object>} The response from the native host.
     */
    async _playSingleUrlItem(url_item, folder_id, globalPrefs) {
        // Ensure the item has the latest granular preferences
        if (!url_item.settings) url_item.settings = {};
        url_item.settings.yt_use_cookies = globalPrefs.yt_use_cookies ?? true;
        url_item.settings.yt_mark_watched = globalPrefs.yt_mark_watched ?? true;
        url_item.settings.yt_ignore_config = globalPrefs.yt_ignore_config ?? true;
        url_item.settings.other_sites_use_cookies = globalPrefs.other_sites_use_cookies ?? true;

        return _callNativeHost({
            action: 'play',
            url_item: url_item,
            folderId: folder_id,
            geometry: globalPrefs.launch_geometry === 'custom' ? null : globalPrefs.launch_geometry,
            custom_width: globalPrefs.launch_geometry === 'custom' ? globalPrefs.custom_geometry_width : null,
            custom_height: globalPrefs.launch_geometry === 'custom' ? globalPrefs.custom_geometry_height : null,
            custom_mpv_flags: globalPrefs.custom_mpv_flags || '',
            automatic_mpv_flags: globalPrefs.automatic_mpv_flags || [],
            force_terminal: globalPrefs.force_terminal ?? false,
            clear_on_completion: globalPrefs.clear_on_completion ?? false,
            start_paused: false, // Default to not paused when playing sequentially
            bypassScripts: globalPrefs.bypassScripts || {}, // Pass bypass scripts config
            // Networking & Performance Sync
            disable_network_overrides: globalPrefs.disable_network_overrides ?? false,
            enable_cache: globalPrefs.enable_cache ?? true,
            http_persistence: globalPrefs.http_persistence || 'auto',
            demuxer_max_bytes: globalPrefs.demuxer_max_bytes || '1G',
            demuxer_max_back_bytes: globalPrefs.demuxer_max_back_bytes || '500M',
            cache_secs: globalPrefs.cache_secs || 500,
            demuxer_readahead_secs: globalPrefs.demuxer_readahead_secs || 500,
            stream_buffer_size: globalPrefs.stream_buffer_size || '10M',
            ytdlp_concurrent_fragments: globalPrefs.ytdlp_concurrent_fragments || 4,
            enable_reconnect: globalPrefs.enable_reconnect ?? true,
            reconnect_delay: globalPrefs.reconnect_delay || 4,
            mpv_decoder: globalPrefs.mpv_decoder || 'auto'
        });
    }

    /**
     * Processes the playback queue, either appending to an existing MPV instance
     * or launching a new one if MPV is not running or append fails.
     */
    async processQueue() {
        if (this.isProcessingQueue) return;
        this.isProcessingQueue = true;

        try {
            const data = await _storage.get();
            const globalPrefs = data.settings.ui_preferences.global;

            while (this.queue.length > 0) {
                // Peek at the next item
                const nextItem = this.queue[0];
                const { urlItem, folderId } = nextItem;

                if (this.isPlaying) {
                    // Try to append to the running session
                    _broadcastLog({ text: `[Background]: Appending to active session: ${urlItem.title || urlItem.url}`, type: 'info' });
                    try {
                        // Ensure the item has the latest granular preferences
                        if (!urlItem.settings) urlItem.settings = {};
                        urlItem.settings.yt_use_cookies = globalPrefs.yt_use_cookies ?? true;
                        urlItem.settings.yt_mark_watched = globalPrefs.yt_mark_watched ?? true;
                        urlItem.settings.yt_ignore_config = globalPrefs.yt_ignore_config ?? true;
                        urlItem.settings.other_sites_use_cookies = globalPrefs.other_sites_use_cookies ?? true;

                        const response = await _callNativeHost({
                            action: 'append',
                            url_item: urlItem,
                            folderId: folderId,
                            bypassScripts: globalPrefs.bypassScripts || {}
                        });

                        if (response.success) {
                            this.queue.shift(); // Successfully appended, remove from queue
                            this.currentPlayingItem = nextItem; // Update current item tracking
                            // Add a small delay to prevent flooding the IPC pipe
                            if (!response.skipped) {
                                await new Promise(resolve => setTimeout(resolve, 1000));
                            }
                            continue; // Process next item immediately
                        } else {
                            // Append failed (likely MPV closed), fall through to start new session
                            this.isPlaying = false;
                        }
                    } catch (e) {
                        this.isPlaying = false;
                    }
                }

                // Start a new session
                _broadcastLog({ text: `[Background]: Starting playback: ${urlItem.title || urlItem.url}`, type: 'info' });
                try {
                    const response = await this._playSingleUrlItem(urlItem, folderId, globalPrefs);
                    if (!response.success) {
                        throw new Error(response.error || "Failed to start playback session.");
                    }
                    this.isPlaying = true;
                    // Give MPV a moment to initialize IPC before we try to append subsequent items.
                    // This prevents race conditions where 'append' arrives before the IPC pipe is ready.
                    if (!response.skipped) {
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                    this.queue.shift(); // Successfully started, remove from queue
                    this.currentPlayingItem = nextItem;
                } catch (error) {
                    _broadcastLog({ text: `[Background]: Error playing item: ${error.message}`, type: 'error' });
                    this.queue.shift(); // Remove failed item to prevent infinite loop
                    this.isPlaying = false;
                }
            }
            
            if (this.queue.length === 0 && !this.isPlaying) {
                this.currentPlayingItem = null;
                _broadcastLog({ text: `[Background]: Playback queue finished.`, type: 'info' });
            }

        } finally {
            this.isProcessingQueue = false;
        }
    }
}

export const playbackQueueInstance = new PlaybackQueue(); // Create and export a single instance

/**
 * Checks if a specific folder is currently active in MPV.

 * @param {string} folderId The ID of the folder to check.
 * @returns {boolean} True if the folder is active and playing.
 */
export function isFolderActive(folderId) {
    return playbackQueueInstance.isPlaying && playbackQueueInstance.currentPlayingItem?.folderId === folderId;
}

export function init(dependencies) {
    _storage = dependencies.storage;
    _broadcastLog = dependencies.broadcastLog;
    _broadcastToTabs = dependencies.broadcastToTabs;
    _callNativeHost = dependencies.callNativeHost;
    _debouncedSyncToNativeHostFile = dependencies.debouncedSyncToNativeHostFile;
}

export async function handleMpvExited(data) {
    const { folderId, returnCode, reason } = data;
    if (!folderId) return;
    
    const displayReason = reason ? ` (Reason: ${reason})` : '';
    _broadcastLog({ text: `[Background]: MPV session for folder '${folderId}' has ended with exit code ${returnCode}${displayReason}.`, type: 'info' });

    playbackQueueInstance.isPlaying = false; // Reset isPlaying flag

    const storageData = await _storage.get();
    const globalPrefs = storageData.settings.ui_preferences.global;
    const shouldClear = globalPrefs.clear_on_completion ?? false;

    // MPV_PLAYLIST_COMPLETED_EXIT_CODE (99) indicates natural playlist completion via custom script.
    const isNaturalCompletion = (returnCode === MPV_PLAYLIST_COMPLETED_EXIT_CODE);

    if (isNaturalCompletion) {
        _broadcastLog({ text: `[Background]: Playlist for folder '${folderId}' finished naturally.`, type: 'info' });
    }

    // Only attempt to clear if the item that just finished was the last one in its folder/batch
    if (playbackQueueInstance.currentPlayingItem && playbackQueueInstance.currentPlayingItem.folderId === folderId && playbackQueueInstance.currentPlayingItem.isLastInFolder) {
        if (shouldClear) {
            if (isNaturalCompletion) {
                _broadcastLog({ text: `[Background]: Auto-clearing playlist for '${folderId}' as per settings.`, type: 'info' });
                
                // Perform the clearing in the extension's storage (Source of Truth)
                if (storageData.folders[folderId]) {
                    storageData.folders[folderId].playlist = [];
                    await _storage.set(storageData);
                    _debouncedSyncToNativeHostFile(); // Sync the empty playlist back to the disk
                    _broadcastToTabs({ 
                        action: 'render_playlist', 
                        folderId: folderId, 
                        playlist: [],
                        isFolderActive: false
                    });
                }
            } else {
                _broadcastLog({ text: `[Background]: MPV exited with code ${returnCode}. Playlist will not be cleared (requires natural completion code 99).`, type: 'info' });
            }
        }
    }
    
    // We don't need to trigger processQueue here because we drain the queue immediately.
    
    // ALWAYS broadcast a refresh to all tabs after an exit to ensure UI state (like active highlight) is updated.
    const finalData = await _storage.get();
    const folder = finalData.folders[folderId] || { playlist: [] };
    _broadcastToTabs({ 
        action: 'render_playlist', 
        folderId: folderId, 
        playlist: folder.playlist,
        last_played_id: folder.last_played_id,
        isFolderActive: false 
    });
}

export async function handleIsMpvRunning() {
    return _callNativeHost({ action: 'is_mpv_running' });
}

/**
 * Checks if MPV is currently playing a different folder and asks for confirmation if enabled.
 * @param {string} targetFolderId The ID of the folder we want to play.
 * @returns {Promise<boolean>} True if we should proceed with playback, false otherwise.
 */
async function checkAndConfirmFolderSwitch(targetFolderId) {
    try {
        const statusResponse = await handleIsMpvRunning();
        // Be explicit: only proceed freely if we are CERTAIN MPV is not running.
        // If statusResponse is malformed or false, we don't assume it's safe to skip confirmation if it was otherwise needed.
        if (statusResponse?.success === false || statusResponse?.is_running === false) return true;

        // Determine currently playing folder from native host or local state fallback
        const currentFolderId = statusResponse.folderId || playbackQueueInstance.currentPlayingItem?.folderId;
        
        if (currentFolderId && currentFolderId !== targetFolderId) {
            const data = await _storage.get();
            const shouldConfirm = data.settings.ui_preferences.global.confirm_folder_switch ?? true;

            if (shouldConfirm) {
                _broadcastLog({ text: `[Background]: Prompting user for folder switch from "${currentFolderId}" to "${targetFolderId}".`, type: 'info' });
                
                const confirmationPayload = {
                    action: 'show_popup_confirmation',
                    message: `MPV is currently playing folder "${currentFolderId}". Switch to "${targetFolderId}"?`
                };

                // 1. Try sending to popup first
                let response = await _sendMessageAsync(confirmationPayload);
                
                // 2. Fallback to active tab if popup didn't respond
                if (response === null) {
                    _broadcastLog({ text: `[Background]: Popup not available for confirmation. Falling back to active tab.`, type: 'info' });
                    const [activeTab] = await new Promise(resolve => chrome.tabs.query({ active: true, currentWindow: true }, resolve));
                    if (activeTab?.id) {
                        // Change action name for content script
                        confirmationPayload.action = 'show_confirmation';
                        response = await new Promise(resolve => {
                            chrome.tabs.sendMessage(activeTab.id, confirmationPayload, (res) => {
                                if (chrome.runtime.lastError) resolve(null);
                                else resolve(res);
                            });
                        });
                    }
                }
                
                const confirmed = !!response?.confirmed;
                if (!confirmed) {
                    _broadcastLog({ text: `[Background]: Folder switch to "${targetFolderId}" cancelled by user or prompt failed.`, type: 'info' });
                }
                return confirmed;
            }
        }
    } catch (e) {
        _broadcastLog({ text: `[Background]: Error during folder switch check: ${e.message}`, type: 'error' });
        return false; // Fail safe: don't switch if we can't determine status or prompt
    }
    return true;
}

// Internal helper for background-to-popup/tab messaging
const _sendMessageAsync = (payload) => new Promise((resolve) => {
    chrome.runtime.sendMessage(payload, (response) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(response);
    });
});

export async function handlePlay(request) {
    const { url_item, folderId, custom_mpv_flags, geometry, custom_width, custom_height, start_paused } = request;

    if (url_item) {
        if (folderId && !await checkAndConfirmFolderSwitch(folderId)) {
            return { success: true, message: "Folder switch cancelled by user." };
        }
        
        // If a single url_item is provided, use the direct playback flow (not via M3U)
        _broadcastLog({ text: `[Background]: Received 'play' request for single item: ${url_item.title || url_item.url}`, type: 'info' });
        
        const data = await _storage.get();
        const globalPrefs = data.settings.ui_preferences.global;

        if (!url_item.settings) url_item.settings = {};
        url_item.settings.yt_use_cookies = globalPrefs.yt_use_cookies ?? true;
        url_item.settings.yt_mark_watched = globalPrefs.yt_mark_watched ?? true;
        url_item.settings.yt_ignore_config = globalPrefs.yt_ignore_config ?? true;
        url_item.settings.other_sites_use_cookies = globalPrefs.other_sites_use_cookies ?? true;

        const response = await _callNativeHost({
            action: 'play',
            url_item: url_item,
            folderId: folderId,
            geometry: geometry || (globalPrefs.launch_geometry === 'custom' ? null : globalPrefs.launch_geometry),
            custom_width: custom_width || (globalPrefs.launch_geometry === 'custom' ? globalPrefs.custom_geometry_width : null),
            custom_height: custom_height || (globalPrefs.launch_geometry === 'custom' ? globalPrefs.custom_geometry_height : null),
            custom_mpv_flags: custom_mpv_flags || globalPrefs.custom_mpv_flags || '',
            automatic_mpv_flags: globalPrefs.automatic_mpv_flags || [],
            force_terminal: globalPrefs.force_terminal ?? false,
            clear_on_completion: request.clear_on_completion ?? (globalPrefs.clear_on_completion ?? false),
            start_paused: start_paused ?? false,
            bypassScripts: globalPrefs.bypassScripts || {},
            // Networking & Performance Sync
            disable_network_overrides: globalPrefs.disable_network_overrides ?? false,
            enable_cache: globalPrefs.enable_cache ?? true,
            http_persistence: globalPrefs.http_persistence || 'auto',
            demuxer_max_bytes: globalPrefs.demuxer_max_bytes || '1G',
            demuxer_max_back_bytes: globalPrefs.demuxer_max_back_bytes || '500M',
            cache_secs: globalPrefs.cache_secs || 500,
            demuxer_readahead_secs: globalPrefs.demuxer_readahead_secs || 500,
            stream_buffer_size: globalPrefs.stream_buffer_size || '10M',
            ytdlp_concurrent_fragments: globalPrefs.ytdlp_concurrent_fragments || 4,
            enable_reconnect: globalPrefs.enable_reconnect ?? true,
            reconnect_delay: globalPrefs.reconnect_delay || 4,
            mpv_decoder: globalPrefs.mpv_decoder || 'auto'
        });

        if (response.success) {
            playbackQueueInstance.isPlaying = true;
            playbackQueueInstance.currentPlayingItem = { urlItem: url_item, folderId: folderId, isLastInFolder: true };
        }
        return response;
    } else if (folderId) {
        const data = await _storage.get();
        const folder = data.folders[folderId];
        if (!folder || !folder.playlist || folder.playlist.length === 0) {
            return { success: false, error: `Playlist in folder "${folderId}" is empty.` };
        }

        _broadcastLog({ text: `[Background]: Preparing playback for playlist '${folderId}' (${folder.playlist.length} items).`, type: 'info' });
        
        // Ensure all items in the batch have the latest granular preferences
        const globalPrefs = data.settings.ui_preferences.global;
        const updatedPlaylist = folder.playlist.map(item => {
            if (!item.settings) item.settings = {};
            item.settings.yt_use_cookies = globalPrefs.yt_use_cookies ?? true;
            item.settings.yt_mark_watched = globalPrefs.yt_mark_watched ?? true;
            item.settings.yt_ignore_config = globalPrefs.yt_ignore_config ?? true;
            item.settings.other_sites_use_cookies = globalPrefs.other_sites_use_cookies ?? true;
            return item;
        });

        // Send the actual playlist items directly to preserve IDs and avoid anonymous M3U re-generation
        const m3u_data = { 
            type: "items", 
            value: updatedPlaylist 
        };
        const effective_folder_id = folderId;

        // Delegate to handlePlayM3U for folder playback
        return handlePlayM3U({ 
            m3u_data: m3u_data, 
            folderId: effective_folder_id,
            custom_mpv_flags: custom_mpv_flags,
            geometry: geometry,
            custom_width: custom_width,
            custom_height: custom_height,
            start_paused: start_paused,
            clear_on_completion: request.clear_on_completion
        });
    } else {
        return { success: false, error: 'No URL item or Folder ID provided to play.' };
    }
}

export async function handlePlayM3U(request) {
    const { m3u_data, folderId, custom_mpv_flags, geometry, custom_width, custom_height, start_paused, clear_on_completion } = request;

    if (folderId && !await checkAndConfirmFolderSwitch(folderId)) {
        return { success: true, message: "Folder switch cancelled by user." };
    }

    // Reset queue and playback state for a new 'play' request
    playbackQueueInstance.queue = [];
    playbackQueueInstance.isPlaying = false;
    playbackQueueInstance.isProcessingQueue = false;
    playbackQueueInstance.currentPlayingItem = null;

    const data = await _storage.get();
    const globalPrefs = data.settings.ui_preferences.global;

    _broadcastLog({ text: `[Background]: Sending 'play_m3u' command to native host for folder '${folderId}'.`, type: 'info' });

    const response = await _callNativeHost({
        action: 'play_m3u',
        m3u_data: m3u_data, // Can be type 'content', 'url', or 'path'
        folderId: folderId,
        geometry: geometry || (globalPrefs.launch_geometry === 'custom' ? null : globalPrefs.launch_geometry),
        custom_width: custom_width || (globalPrefs.launch_geometry === 'custom' ? globalPrefs.custom_geometry_width : null),
        custom_height: custom_height || (globalPrefs.launch_geometry === 'custom' ? globalPrefs.custom_geometry_height : null),
        custom_mpv_flags: custom_mpv_flags || globalPrefs.custom_mpv_flags || '',
        automatic_mpv_flags: globalPrefs.automatic_mpv_flags || [],
        force_terminal: globalPrefs.force_terminal ?? false,
        clear_on_completion: clear_on_completion ?? (globalPrefs.clear_on_completion ?? false),
        start_paused: start_paused ?? false,
        bypassScripts: globalPrefs.bypassScripts || {}, // Pass bypass scripts config (though less relevant now with dynamic analysis)
        // Networking & Performance Sync
        disable_network_overrides: globalPrefs.disable_network_overrides ?? false,
        enable_cache: globalPrefs.enable_cache ?? true,
        http_persistence: globalPrefs.http_persistence || 'auto',
        demuxer_max_bytes: globalPrefs.demuxer_max_bytes || '1G',
        demuxer_max_back_bytes: globalPrefs.demuxer_max_back_bytes || '500M',
        cache_secs: globalPrefs.cache_secs || 500,
        demuxer_readahead_secs: globalPrefs.demuxer_readahead_secs || 500,
        stream_buffer_size: globalPrefs.stream_buffer_size || '10M',
        ytdlp_concurrent_fragments: globalPrefs.ytdlp_concurrent_fragments || 4,
        enable_reconnect: globalPrefs.enable_reconnect ?? true,
        reconnect_delay: globalPrefs.reconnect_delay || 4,
        mpv_decoder: globalPrefs.mpv_decoder || 'auto'
    });

    if (response.success) {
        playbackQueueInstance.isPlaying = true;
        playbackQueueInstance.currentPlayingItem = { folderId: folderId, isLastInFolder: true }; // Mark as playing this folder

        // --- Smart Resume Sync ---
        // If the native host reordered the playlist (Smart Resume), we MUST update
        // our internal storage to match, otherwise our UI and subsequent actions will be out of sync.
        if (response.playlist_items && folderId) {
            _broadcastLog({ text: `[Background]: Syncing Smart Resume reordering for folder '${folderId}'.`, type: 'info' });
            const storageData = await _storage.get();
            if (storageData.folders[folderId]) {
                storageData.folders[folderId].playlist = response.playlist_items;
                // We also update the last_played_id immediately if it was returned
                if (response.playlist_items.length > 0) {
                    storageData.folders[folderId].last_played_id = response.playlist_items[0].id;
                }
                await _storage.set(storageData);
                // Note: We don't need to call debouncedSyncToNativeHostFile here 
                // because the native host is the one that just sent us this data.
                _broadcastToTabs({ action: 'render_playlist', folderId: folderId, playlist: response.playlist_items });
            }
        }

        return { success: true, message: `Playback initiated for playlist '${folderId}'.` };
    } else {
        return response;
    }
}

/**
 * Handles the 'update_last_played' message from the native host tracker.
 * Updates the extension's internal storage to keep it in sync with the active session.
 */
export async function handleUpdateLastPlayed(data) {
    const { folderId, itemId } = data;
    if (!folderId || !itemId) return;

    _broadcastLog({ text: `[Background]: Tracker reported last_played_id update for folder '${folderId}': ${itemId}`, type: 'info' });
    
    const storageData = await _storage.get();
    if (storageData.folders[folderId]) {
        storageData.folders[folderId].last_played_id = itemId;
        await _storage.set(storageData);
        
        // Broadcast the update so the UI highlights the new item immediately
        _broadcastToTabs({ 
            action: 'render_playlist', 
            folderId: folderId, 
            playlist: storageData.folders[folderId].playlist,
            last_played_id: itemId,
            isFolderActive: true
        });
    }
}

/**
 * Handles the 'update_item_resume_time' message from the native host tracker.
 * Updates the extension's internal storage with the latest playback timestamp.
 */
export async function handleUpdateItemResumeTime(data) {
    const { folderId, itemId, resumeTime } = data;
    if (!folderId || !itemId) return;

    const storageData = await _storage.get();
    if (storageData.folders[folderId]) {
        const folder = storageData.folders[folderId];
        for (let item of folder.playlist) {
            if (item.id === itemId) {
                item.resume_time = resumeTime;
                await _storage.set(storageData);
                break;
            }
        }
    }
}

export async function handleAppend(request) { // New 'append' action handler
    const { url_item, folderId } = request;
    if (!url_item) {
        return { success: false, error: 'No URL item provided to append.' };
    }

    // Push the single item to the queue
    playbackQueueInstance.queue.push({ urlItem: url_item, folderId: folderId, isLastInFolder: false }); // isLastInFolder will be set dynamically by _playSingleUrlItem or processQueue in future.

    _broadcastLog({ text: `[Background]: Received 'append' request for: ${url_item.title || url_item.url}`, type: 'info' });

    playbackQueueInstance.processQueue(); // Process the queue to append the item
    return { success: true, message: `Appended ${url_item.title || url_item.url} to queue` };
}

export async function handleCloseMpv() {
    return _callNativeHost({ action: 'close_mpv' });
}

export function getMpvPlaylistCompletedExitCode() {
    return MPV_PLAYLIST_COMPLETED_EXIT_CODE;
}

export function handleSessionRestored(request) {
    const result = request.result;
    if (!result) {
        _broadcastLog({ text: `[Background]: No active session found to restore.`, type: 'info' });
        return;
    }

    if (result.was_stale) {
        _broadcastLog({ text: `[Background]: Detected stale MPV session for folder '${result.folderId}'.`, type: 'info' });
        // Trigger the same cleanup logic as when MPV exits.
        handleMpvExited(result);
    } else {
        _broadcastLog({ text: `[Background]: Re-establishing connection to active MPV session for folder '${result.folderId}'...`, type: 'info' });
        
        // Update background state to match a fresh launch
        playbackQueueInstance.queue = [];
        playbackQueueInstance.isPlaying = true;
        playbackQueueInstance.isProcessingQueue = false;
        playbackQueueInstance.currentPlayingItem = { folderId: result.folderId, isLastInFolder: true };
        
        // Notify UI to show active highlight and provide feedback
        _storage.get().then(storageData => {
            const folder = storageData.folders[result.folderId];
            if (folder) {
                const folderName = folder.name || result.folderId;
                _broadcastLog({ text: `Reconnected to mpv playlist (${folderName})`, type: 'info' });

                const lastPlayedId = result.lastPlayedId || folder.last_played_id;
                
                // If the native host identified a different item, sync our storage
                if (result.lastPlayedId && result.lastPlayedId !== folder.last_played_id) {
                    folder.last_played_id = result.lastPlayedId;
                    _storage.set(storageData); // Save async
                }

                _broadcastToTabs({ 
                    action: 'render_playlist', 
                    folderId: result.folderId, 
                    playlist: folder.playlist,
                    last_played_id: lastPlayedId,
                    isFolderActive: true
                });
            }
        });
    }
}