// background/handlers/playback.js

let _storage;
let _broadcastLog;
let _broadcastToTabs;
let _callNativeHost;
let _resyncDataFromNativeHostFile;
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
        return _callNativeHost({
            action: 'play',
            url_item: url_item,
            folderId: folder_id,
            geometry: globalPrefs.launch_geometry === 'custom' ? null : globalPrefs.launch_geometry,
            custom_width: globalPrefs.launch_geometry === 'custom' ? globalPrefs.custom_geometry_width : null,
            custom_height: globalPrefs.launch_geometry === 'custom' ? globalPrefs.custom_geometry_height : null,
            custom_mpv_flags: globalPrefs.custom_mpv_flags || '',
            automatic_mpv_flags: globalPrefs.automatic_mpv_flags || [],
            clear_on_completion: globalPrefs.clear_on_completion ?? false,
            start_paused: false, // Default to not paused when playing sequentially
            bypassScripts: globalPrefs.bypassScripts || {} // Pass bypass scripts config
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
                        const response = await _callNativeHost({
                            action: 'append',
                            url_item: urlItem,
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

const playbackQueueInstance = new PlaybackQueue(); // Create a single instance

export function init(dependencies) {
    _storage = dependencies.storage;
    _broadcastLog = dependencies.broadcastLog;
    _broadcastToTabs = dependencies.broadcastToTabs;
    _callNativeHost = dependencies.callNativeHost;
    _resyncDataFromNativeHostFile = dependencies.resyncDataFromNativeHostFile;
    _debouncedSyncToNativeHostFile = dependencies.debouncedSyncToNativeHostFile;
}

export async function handleMpvExited(data) {
    const { folderId, returnCode } = data;
    if (!folderId) return;
    
    _broadcastLog({ text: `[Background]: MPV session for folder '${folderId}' has ended with exit code ${returnCode}.`, type: 'info' });

    playbackQueueInstance.isPlaying = false; // Reset isPlaying flag

    const storageData = await _storage.get();
    const globalPrefs = storageData.settings.ui_preferences.global;
    const shouldClear = globalPrefs.clear_on_completion ?? false;

    _broadcastLog({ text: `[Background]: 'Clear on Completion' setting is ${shouldClear ? 'ENABLED' : 'DISABLED'}.`, type: 'info' });

    // Only attempt to clear if the item that just finished was the last one in its folder/batch
    if (playbackQueueInstance.currentPlayingItem && playbackQueueInstance.currentPlayingItem.folderId === folderId && playbackQueueInstance.currentPlayingItem.isLastInFolder) {
        if (shouldClear) {
            // MPV_PLAYLIST_COMPLETED_EXIT_CODE (99) indicates natural playlist completion via custom script.
            if (returnCode === MPV_PLAYLIST_COMPLETED_EXIT_CODE) {
                const completionType = 'naturally completed (custom exit code 99)';
                _broadcastLog({ text: `[Background]: MPV session for folder '${folderId}' ${completionType}. Auto-clearing playlist as per settings.`, type: 'info' });
            } else {
                // If the user quits manually (e.g., 'q') or MPV exits with any other code,
                // we assume it's not a natural completion for clearing purposes.
                _broadcastLog({ text: `[Background]: MPV exited with code ${returnCode}. Playlist for '${folderId}' will not be cleared. (Requires exit code ${MPV_PLAYLIST_COMPLETED_EXIT_CODE} for clearing)`, type: 'info' });
            }
        } else {
            _broadcastLog({ text: `[Background]: Playlist for '${folderId}' will not be cleared because the setting is disabled.`, type: 'info' });
        }
    }
    
    // After all potential clearing, always resync the browser's storage
    // from the native host's folders.json to ensure consistency.
    await _resyncDataFromNativeHostFile();

    // We don't need to trigger processQueue here because we drain the queue immediately.
    // However, if the user adds items *after* MPV exits, processQueue will be triggered by the 'play' action.
}

export async function handleIsMpvRunning() {
    return _callNativeHost({ action: 'is_mpv_running' });
}

export async function handlePlay(request) { // This will now accept a single url_item to play immediately
    const { url_item, folderId } = request;

    // Reset queue and playback state for a new 'play' request
    playbackQueueInstance.queue = [];
    playbackQueueInstance.isPlaying = false;
    playbackQueueInstance.isProcessingQueue = false;
    playbackQueueInstance.currentPlayingItem = null;

    if (url_item) {
        // Push the single item to the queue
        playbackQueueInstance.queue.push({ urlItem: url_item, folderId: folderId, isLastInFolder: false });
        _broadcastLog({ text: `[Background]: Received 'play' request for: ${url_item.title || url_item.url}`, type: 'info' });
        playbackQueueInstance.processQueue();
        return { success: true, message: `Playing ${url_item.title || url_item.url}` };
    } else if (folderId) {
        // Fallback: Play the entire folder if no specific item is provided
        const data = await _storage.get();
        const folder = data.folders[folderId];
        if (!folder || !folder.playlist || folder.playlist.length === 0) {
            return { success: false, error: `Playlist in folder "${folderId}" is empty.` };
        }
        
        _broadcastLog({ text: `[Background]: Sending playlist '${folderId}' (${folder.playlist.length} items) to MPV.`, type: 'info' });
        
        const globalPrefs = data.settings.ui_preferences.global;
        const response = await _callNativeHost({
            action: 'play_batch',
            playlist: folder.playlist,
            folderId: folderId,
            geometry: globalPrefs.launch_geometry === 'custom' ? null : globalPrefs.launch_geometry,
            custom_width: globalPrefs.launch_geometry === 'custom' ? globalPrefs.custom_geometry_width : null,
            custom_height: globalPrefs.launch_geometry === 'custom' ? globalPrefs.custom_geometry_height : null,
            custom_mpv_flags: globalPrefs.custom_mpv_flags || '',
            automatic_mpv_flags: globalPrefs.automatic_mpv_flags || [],
            clear_on_completion: globalPrefs.clear_on_completion ?? false,
            start_paused: false,
            bypassScripts: globalPrefs.bypassScripts || {}
        });

        if (response.success) {
            playbackQueueInstance.isPlaying = true;
            // Set currentPlayingItem to the last item so "Clear on Completion" works if MPV exits after this batch.
            playbackQueueInstance.currentPlayingItem = { 
                urlItem: folder.playlist[folder.playlist.length - 1], 
                folderId: folderId, 
                isLastInFolder: true 
            };
            // Resync immediately so the UI gets the IDs assigned by the native host.
            // This ensures live reordering works even for items that didn't have IDs before playing.
            _resyncDataFromNativeHostFile();
            return { success: true, message: `Playing playlist '${folderId}'` };
        } else {
            return response;
        }
    } else {
        return { success: false, error: 'No URL item or Folder ID provided to play.' };
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
    if (request.result?.was_stale) {
        _broadcastLog({ text: `[Background]: Detected stale MPV session for folder '${request.result.folderId}'.`, type: 'info' });
        // Trigger the same cleanup logic as when MPV exits.
        handleMpvExited(request.result);
    }
}