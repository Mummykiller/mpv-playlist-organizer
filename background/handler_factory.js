// background/handler_factory.js

import { updateContextMenus } from "../utils/contextMenu.js";
import { debouncedSyncToNativeHostFile } from "./core_services.js";
import { broadcastLog, broadcastToTabs } from "./messaging.js";
import { storage } from "./storage_instance.js";
import { broadcastPlaylistState } from "./ui_broadcaster.js";
import { normalizeKeys } from "../utils/commUtils.module.js";

/**
 * Higher-order function to create standardized request handlers.
 * 
 * @param {Function} logic - The core action logic. Receives context object.
 * @param {Object} options - Configuration for side effects and hooks.
 * @returns {Function} - The async handler function.
 */
export function createHandler(logic, options = {}) {
	const {
		requireFolder = false,
		syncToNative = false,
		syncImmediate = false,
		broadcastFolders = false,
		broadcastPlaylist = false,
		broadcastPreferences = false,
		updateMenus = false,
		manualPersistence = false,
		onSuccess = null,
		onError = null
	} = options;

	return async (rawRequest = {}, sender = {}) => {
		const request = normalizeKeys(rawRequest);
		const context = { 
			request: request, 
			sender: sender || {}, 
			folderId: request?.folderId || request?.data?.folderId 
		};
		
		try {
			if (requireFolder && !context.folderId) {
				return { success: false, error: "Missing folderId." };
			}

			const runCore = async () => {
				// Context Setup: Fetch storage
				const data = await storage.get();
				context.data = data;
				context.storage = storage;

				// Execution: Run the specific logic
				const result = await logic(context);

				if (!result || result.success === false) {
					return {
						ok: false,
						result: result || { success: false, error: "Unknown error in handler logic." },
					};
				}

				// Persistence: Auto-save if logic was successful and not manual
				if (!manualPersistence) {
					await storage.set(context.data, context.folderId);
				}

				return { ok: true, result };
			};

			const outcome =
				!manualPersistence && typeof storage.withLock === "function"
					? await storage.withLock(runCore)
					: await runCore();

			if (!outcome.ok) {
				if (onError) await onError(outcome.result, context);
				return outcome.result;
			}
			const result = outcome.result;

			// Side-Effects
			if (syncToNative) {
				debouncedSyncToNativeHostFile(context.folderId, syncImmediate);
			}

			if (updateMenus) {
				await updateContextMenus(storage).catch(e => 
					console.warn("[HandlerFactory] Failed to update context menus:", e)
				);
			}

			if (broadcastFolders) {
				broadcastToTabs({ 
					action: "folders_changed", 
					foldersChanged: true, 
					folderId: result.folderId || context.folderId 
				});
			}

			if (broadcastPlaylist && (result.folderId || context.folderId)) {
				await broadcastPlaylistState(result.folderId || context.folderId);
			}

			if (broadcastPreferences) {
				broadcastToTabs({ action: "preferences_changed" });
			}

			if (result.message) {
				broadcastLog({ 
					text: `[Background]: ${result.message}`, 
					type: "info" 
				});
			}

			// Hook: Success
			if (onSuccess) await onSuccess(result, context);

			return { success: true, ...result };
		} catch (error) {
			const errorMsg = `Handler Error: ${error.message}`;
			console.error(`[HandlerFactory] ${errorMsg}`, error);
			const errorResult = { success: false, error: errorMsg };
			
			broadcastLog({ text: `[Background]: ${errorMsg}`, type: "error" });
			
			if (onError) await onError(errorResult, context);
			
			return errorResult;
		}
	};
}