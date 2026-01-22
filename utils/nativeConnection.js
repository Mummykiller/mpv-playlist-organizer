import { broadcastLog } from "../background/messaging.js";

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

// Internal listener registry
const eventListeners = {
	mpv_exited: [],
	update_last_played: [],
	update_item_resume_time: [],
	update_item_marked_as_watched: [],
	playback_status_changed: [],
	mpv_quitting: [],
	session_restored: [],
	log: [],
};

/**
 * Normalizes keys in an object from snake_case to camelCase where appropriate.
 * Ensures upper layers always see a consistent schema.
 */
function normalizePayload(data) {
	if (!data || typeof data !== "object") return data;
	
	const mapping = {
		folder_id: "folderId",
		is_running: "isRunning",
		is_paused: "isPaused",
		is_idle: "isIdle",
		last_played_id: "lastPlayedId",
		session_ids: "sessionIds",
		played_ids: "playedIds",
		playlist_items: "playlistItems"
	};

	const normalized = { ...data };
	for (const [snake, camel] of Object.entries(mapping)) {
		if (data[snake] !== undefined && data[camel] === undefined) {
			normalized[camel] = data[snake];
		}
	}
	return normalized;
}

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
		const normalizedData = normalizePayload(data);
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
			const normalizedResponse = normalizePayload(responseData);

			if (request_id && requestPromises[request_id]) {
				requestPromises[request_id].resolve(normalizedResponse);
				delete requestPromises[request_id];
				return;
			}
			if (normalizedResponse.action)
				dispatchNativeEvent(normalizedResponse.action, normalizedResponse);
			if (normalizedResponse.log) dispatchNativeEvent("log", normalizedResponse.log);
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
		return await new Promise((resolve, reject) => {
			const ensureConnectedAndSend = async () => {
				await connectToNativeHost();
				const requestId = `req_${requestIdCounter++}`;
				requestPromises[requestId] = { resolve, reject };
				const messageToSend = { ...message, request_id: requestId };
				try {
					nativePort.postMessage(messageToSend);
				} catch (e) {
					delete requestPromises[requestId];
					reject(new Error(`Failed to post message: ${e.message}`));
				}
			};
			ensureConnectedAndSend().catch(reject);
		});
	} catch (error) {
		const errorMessage = `Native Host Error (${message.action}): ${error.message}`;
		console.error(errorMessage);
		broadcastLog({ text: `[Background]: ${errorMessage}`, type: "error" });

		if (shouldThrow) throw error;
		return { success: false, error: errorMessage };
	}
}

export function injectDependencies() {}
