// background/handler_factory.js

import { updateContextMenus } from "../utils/contextMenu.js";
import { debouncedSyncToNativeHostFile } from "./core_services.js";
import { broadcastLog, broadcastToTabs } from "./messaging.js";
import { storage } from "./storage_instance.js";
import { broadcastPlaylistState } from "./handlers/playback.js";

/**
 * Higher-order function to create standardized request handlers.
 * 
 * @param {Function} logic - The core action logic. Receives { request, sender, data, folderId }.
 * @param {Object} options - Configuration for side effects.
 * @returns {Function} - The async handler function.
 */
export function createHandler(logic, options = {}) {
	const {
		requireFolder = false,
		syncToNative = false,
		syncImmediate = false,
		broadcastFolders = false,
		broadcastPlaylist = false,
		updateMenus = false,
		successMessage = null
	} = options;

	return async (request, sender) => {
		try {
			const folderId = request.folderId || request.data?.folderId;
			if (requireFolder && !folderId) {
				return { success: false, error: "Missing folderId." };
			}

			// Context Setup: Fetch storage
			const data = await storage.get();

			// Execution: Run the specific logic
			// Logic should return { success, error, message, ...extra }
			// It can modify 'data' directly.
			const result = await logic({ request, sender, data, folderId });

			if (!result || result.success === false) {
				return result || { success: false, error: "Unknown error in handler logic." };
			}

			// Persistence: Auto-save if logic was successful
			await storage.set(data, folderId);

			// Side-Effects
			if (syncToNative) {
				debouncedSyncToNativeHostFile(folderId, syncImmediate);
			}

			if (updateMenus) {
				await updateContextMenus(storage).catch(e => 
					console.warn("[HandlerFactory] Failed to update context menus:", e)
				);
			}

			if (broadcastFolders) {
				broadcastToTabs({ 
					action: "foldersChanged", 
					foldersChanged: true, 
					folderId: result.folderId || folderId 
				});
			}

			if (broadcastPlaylist && folderId) {
				await broadcastPlaylistState(folderId);
			}

			if (successMessage || result.message) {
				broadcastLog({ 
					text: `[Background]: ${result.message || successMessage}`, 
					type: "info" 
				});
			}

			return { success: true, ...result };
		} catch (error) {
			const errorMsg = `Handler Error: ${error.message}`;
			console.error(`[HandlerFactory] ${errorMsg}`, error);
			broadcastLog({ text: `[Background]: ${errorMsg}`, type: "error" });
			return { success: false, error: errorMsg };
		}
	};
}
