import { broadcastLog } from "../background/messaging.js";
import * as security from "./security.module.js";
import { normalizeKeys } from "./commUtils.module.js";
import { logger } from "./SystemLogger.module.js";

const NATIVE_HOST_NAME = "com.mpv_playlist_organizer.handler";

const ConnectionStatus = {
	DISCONNECTED: "DISCONNECTED",
	CONNECTING: "CONNECTING",
	CONNECTED: "CONNECTED",
};

let nativePort = null;
let connectionStatus = ConnectionStatus.DISCONNECTED;
let requestPromises = {};
let requestIdCounter = 0;
let connectionPromise = null;

// Inject the sender into the logger immediately.
// The logger buffers internally if the connection isn't ready.
logger.setNativeSender((msg) => callNativeHost(msg));

// Internal listener registry
const eventListeners = {
	mpv_exited: [],
	update_last_played: [],
	update_item_resume_time: [],
	update_item_marked_as_watched: [],
	playback_status_changed: [],
	item_natural_completion: [],
	mpv_quitting: [],
	session_restored: [],
	log: [],
};

/**
 * Registers a listener for unsolicited native host events.
 */
export function addNativeListener(action, callback) {
	if (eventListeners[action]) {
		eventListeners[action].push(callback);
	}
}

/**
 * Dispatches an event to registered listeners.
 */
function dispatchNativeEvent(action, data) {
	if (eventListeners[action]) {
		const normalizedData = normalizeKeys(data);
		eventListeners[action].forEach((cb) => {
			cb(normalizedData);
		});
	}
}

/**
 * Establishes a persistent connection to the native host.
 */
function connectToNativeHost() {
	if (connectionPromise) return connectionPromise;

	connectionStatus = ConnectionStatus.CONNECTING;
	broadcastLog({
		text: `[Background]: Establishing connection to native host...`,
		type: "info",
	});

	connectionPromise = new Promise((resolve, reject) => {
		nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);

		const onDisconnect = () => {
			const lastError = chrome.runtime.lastError
				? chrome.runtime.lastError.message
				: "Native host disconnected.";
			let friendlyError = lastError;

			if (lastError.includes("Access denied")) {
				friendlyError = "Access denied. Please run installer.py.";
			} else if (
				lastError.includes("Specified native messaging host not found")
			) {
				friendlyError = "Native host not found. Please run installer.py.";
			}

			console.error("Native host disconnected:", lastError);
			logger.error(`Native host disconnected: ${friendlyError}`, { persist: false });
			
			broadcastLog({
				text: `[Background]: Fatal Connection Error: ${friendlyError}`,
				type: "error",
			});

			for (const id in requestPromises) {
				requestPromises[id].reject(new Error(friendlyError));
			}

			if (connectionStatus === ConnectionStatus.CONNECTING)
				reject(new Error(friendlyError));

			nativePort = null;
			connectionStatus = ConnectionStatus.DISCONNECTED;
			requestPromises = {};
			connectionPromise = null;
		};

		nativePort.onDisconnect.addListener(onDisconnect);

		nativePort.onMessage.addListener((response) => {
			const { request_id, ...responseData } = response;
			const normalizedResponse = normalizeKeys(responseData);

			if (request_id && requestPromises[request_id]) {
				requestPromises[request_id].resolve(normalizedResponse);
				delete requestPromises[request_id];
				return;
			}
			if (normalizedResponse.action)
				dispatchNativeEvent(normalizedResponse.action, normalizedResponse);
			
			if (normalizedResponse.log) {
				dispatchNativeEvent("log", { action: "log", log: normalizedResponse.log });
			}
		});

		connectionStatus = ConnectionStatus.CONNECTED;
		broadcastLog({
			text: `[Background]: Successfully connected to native host.`,
			type: "info",
		});

		const restoreRequestId = `internal_restore_${Date.now()}`;
		requestPromises[restoreRequestId] = {
			resolve: (responseData) => {
				broadcastLog({
					text: `[Background]: Session restoration handshake completed.`,
					type: "info",
				});
				
				// Synchronize Log Level
				if (responseData.log_level) {
					logger.setLevel(responseData.log_level);
					logger.info(`Log level synced to ${responseData.log_level}`);
				}

				if (responseData.action === "session_restored")
					dispatchNativeEvent("session_restored", responseData);
				resolve();
			},
			reject: (err) => {
				broadcastLog({
					text: `[Background]: Session restoration failed: ${err.message}`,
					type: "error",
				});
				if (connectionStatus === ConnectionStatus.CONNECTING) reject(err);
			},
		};

		nativePort.postMessage({
			action: "restore_session",
			request_id: restoreRequestId,
		});
	});

	return connectionPromise;
}

/**
 * Sends a message to the native host, handling connection logic automatically.
 * @param {object} message - The message to send.
 * @param {boolean} [shouldThrow=false] - Whether to throw errors or return failure object.
 * @returns {Promise<object>} A promise that resolves with the response.
 */
export async function callNativeHost(message, shouldThrow = false) {
	try {
		// --- Pre-Validation Security Gate ---
		// Check for URLs in the message and validate them
		if (message.url && !security.isValidUrl(message.url)) {
			throw new Error(`Security Block: Unsafe URL protocol or length.`);
		}
		if (message.urlItem?.url && !security.isValidUrl(message.urlItem.url)) {
			throw new Error(`Security Block: Unsafe URL in item.`);
		}

		return await new Promise((resolve, reject) => {
			const ensureConnectedAndSend = async () => {
				await connectToNativeHost();
				const requestId = message.request_id || `req_${requestIdCounter++}`;
				
				// Wrap the execution in the logger context
				await logger.runWithContext(requestId, async () => {
					requestPromises[requestId] = { resolve, reject };
					const messageToSend = { ...message, request_id: requestId };
					try {
						nativePort.postMessage(messageToSend);
					} catch (e) {
						delete requestPromises[requestId];
						reject(new Error(`Failed to post message: ${e.message}`));
					}
				});
			};
			ensureConnectedAndSend().catch(reject);
		});
	} catch (error) {
		const errorMessage = `Native Host Error (${message.action}): ${error.message}`;
		console.error(errorMessage);
		
		// Avoid infinite loops if the logger itself triggers this
		if (message.action !== "log_event") {
			logger.error(errorMessage, { persist: false });
			broadcastLog({ text: `[Background]: ${errorMessage}`, type: "error" });
		}

		if (shouldThrow) throw error;
		return { success: false, error: errorMessage };
	}
}

export function injectDependencies() {}
