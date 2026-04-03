/**
 * @class MpvInterface
 * Unified bridge for playback commands and playlist management.
 * Handles background communication, optimistic UI updates, and data refreshing.
 */
import { sendMessageAsync } from "./commUtils.module.js";

export class MpvInterface {
	/**
	 * Sends a playback command (play/toggle/append).
	 * @param {string} folderId
	 * @param {object} options { urlItem, playlistStartId, playNewInstance }
	 * @returns {Promise<object>} Background response
	 */
	static async play(folderId, options = {}) {
		if (!folderId) throw new Error("Folder ID is required for playback.");

		const MPV = window.MPV_INTERNAL;
		
		// Determine if this is a simple toggle or a fresh launch
		const pbState = MPV.playbackStateManager.state;
		const isRunning = pbState.isRunning;
		const isLaunching = pbState.isLaunching;
		const needsAppend = pbState.needsAppend;
		
		// Optimistic "Loading" state
		const isToggle = isRunning && !isLaunching && !needsAppend && !options.playNewInstance && !options.urlItem;
		if (!isToggle) {
			if (needsAppend && isRunning && !options.playNewInstance) {
				MPV.playbackStateManager.setAppending(folderId);
			} else {
				MPV.playbackStateManager.setLoading(folderId);
			}
		}

		try {
			const response = await sendMessageAsync({
				action: "play",
				folderId,
				...options
			});

			if (response?.success) {
				MPV.playbackStateManager.update({
					folderId: folderId,
					isRunning: response.isRunning ?? true,
					isPaused: response.isPaused,
					needsAppend: response.needsAppend,
					lastPlayedId: response.lastPlayedId,
					isLaunching: false, // Clear optimistic launch flag on response
					isAppending: false  // Clear optimistic append flag on response
				});
			} else {
				// Rollback loading state on failure
				MPV.playbackStateManager.update({ 
					isRunning: isRunning,
					isLaunching: false,
					isAppending: false
				});
			}
			return response;
		} catch (error) {
			MPV.playbackStateManager.update({ 
				isRunning: isRunning,
				isLaunching: false,
				isAppending: false
			});
			throw error;
		}
	}

	/**
	 * Closes the active MPV instance.
	 */
	static async closeMpv() {
		const MPV = window.MPV_INTERNAL;
		try {
			const response = await sendMessageAsync({ action: "close_mpv" });
			if (response?.success) {
				MPV.playbackStateManager.update({ isClosing: true });
			}
			return response;
		} catch (error) {
			throw error;
		}
	}

	/**
	 * Adds a URL to a folder.
	 * @param {string} folderId
	 * @param {object} data { url, title }
	 * @param {object} extra { tabId, tab, ... }
	 * @returns {Promise<object>}
	 */
	static async add(folderId, data, extra = {}) {
		if (!folderId) throw new Error("Folder ID is required.");
		return await sendMessageAsync({
			action: "add",
			folderId,
			data,
			...extra
		});
	}

	/**
	 * Clears all items from a folder.
	 * @param {string} folderId
	 */
	static async clear(folderId) {
		if (!folderId) throw new Error("Folder ID is required.");
		return await sendMessageAsync({ action: "clear", folderId });
	}

	/**
	 * Removes a specific item from a folder.
	 * @param {string} folderId
	 * @param {object} itemData { index, id }
	 */
	static async removeItem(folderId, itemData) {
		if (!folderId) throw new Error("Folder ID is required.");
		return await sendMessageAsync({
			action: "remove_item",
			folderId,
			data: itemData
		});
	}

	/**
	 * Saves a new order for the playlist.
	 * @param {string} folderId
	 * @param {Array} order Array of items in new order
	 */
	static async setPlaylistOrder(folderId, order) {
		if (!folderId) throw new Error("Folder ID is required.");
		return await sendMessageAsync({
			action: "set_playlist_order",
			folderId,
			data: { order }
		});
	}

	/**
	 * Sends a live reorder request to MPV.
	 * @param {string} folderId 
	 * @param {string[]} itemIds Array of IDs in the new order.
	 */
	static async reorderLive(folderId, itemIds) {
		if (!folderId) throw new Error("Folder ID is required.");
		return await sendMessageAsync({
			action: "reorder_live",
			folderId,
			newOrder: itemIds
		});
	}

	/**
	 * Updates the marked_as_watched status (YouTube sync).
	 */
	static async updateMarkedAsWatched(folderId, itemId, isMarked) {
		return await sendMessageAsync({
			action: "update_item_marked_as_watched",
			folderId,
			itemId,
			markedAsWatched: isMarked
		});
	}
}
