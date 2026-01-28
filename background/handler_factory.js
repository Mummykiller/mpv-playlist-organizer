// background/handler_factory.js

import { updateContextMenus } from "../utils/contextMenu.js";
import { debouncedSyncToNativeHostFile } from "./core_services.js";
import { broadcastLog, broadcastToTabs } from "./messaging.js";
import { storage } from "./storage_instance.js";
import { broadcastPlaylistState } from "./ui_broadcaster.js";

function normalizeRequest(data) {
	if (!data || typeof data !== "object") return data;
	
	if (Array.isArray(data)) {
		return data.map(normalizeRequest);
	}

	const snakeToCamel = (str) => {
		if (str === "request_id") return "request_id";
		return str.replace(/([-_][a-z])/g, (group) =>
			group.toUpperCase().replace("-", "").replace("_", "")
		);
	};

	const normalized = {};
	for (const key in data) {
		if (Object.prototype.hasOwnProperty.call(data, key)) {
			const camelKey = snakeToCamel(key);
			normalized[camelKey] = normalizeRequest(data[key]);
		}
	}
	return normalized;
}

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
		successMessage = null,
		manualPersistence = false,
		onBefore = null,
		onSuccess = null,
		onError = null,
		onFinally = null
	} = options;

	return async (rawRequest = {}, sender = {}) => {
		const request = normalizeRequest(rawRequest);
		const context = { 
			request: request, 
			sender: sender || {}, 
			folderId: request?.folderId || request?.data?.folderId 
		};
		
		try {
			if (requireFolder && !context.folderId) {
				return { success: false, error: "Missing folderId." };
			}

			// Hook: Before Logic (e.g., for optimistic UI updates)
			if (onBefore) await onBefore(context);

			// Context Setup: Fetch storage
			const data = await storage.get();
			context.data = data;
			context.storage = storage;

			// Execution: Run the specific logic
			const result = await logic(context);

			if (!result || result.success === false) {
				const failResult = result || { success: false, error: "Unknown error in handler logic." };
				if (onError) await onError(failResult, context);
				return failResult;
			}

			// Persistence: Auto-save if logic was successful and not manual
			if (!manualPersistence) {
				await storage.set(data, context.folderId);
			}

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
					action: "foldersChanged", 
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

			if (successMessage || result.message) {
				broadcastLog({ 
					text: `[Background]: ${result.message || successMessage}`, 
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
		} finally {
			if (onFinally) await onFinally(context);
		}
	};
}