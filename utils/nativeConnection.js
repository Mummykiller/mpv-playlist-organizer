// AUTO-GENERATED from nativeConnection.module.js. DO NOT EDIT MANUALLY.
window.MPV_INTERNAL = window.MPV_INTERNAL || {};
(() => {
	const MPV = window.MPV_INTERNAL;
	const isValidUrl = window.MPV_SECURITY.isValidUrl;
	const isSafeUrl = window.MPV_SECURITY.isSafeUrl;
	const normalizeKeys = window.MPV_INTERNAL.normalizeKeys;
	const logger = window.MPV_INTERNAL.logger;

	const NATIVE_HOST_NAME = "com.mpv_playlist_organizer.handler";

	let logBroadcaster = null;

	/**
	 * Registers the log broadcaster callback used to forward native connection logs to UI tabs.
	 * @param {Function|null} fn
	 */
	const setLogBroadcaster = MPV.setLogBroadcaster = function setLogBroadcaster(fn) {
		logBroadcaster = typeof fn === "function" ? fn : null;
	}

	function emitLog(payload) {
		try {
			logBroadcaster?.(payload);
		} catch (e) {
			logger.debug(`[NativeConn] Log broadcaster failed: ${e?.message}`);
		}
	}

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
		update_item_title: [],
		playback_status_changed: [],
		playback_health_changed: [],
		item_natural_completion: [],
		mpv_quitting: [],
		session_restored: [],
		task_update: [],
		ytdlp_update_check: [],
		log: [],
	};

	/**
	 * Registers a listener for unsolicited native host events.
	 */
	const addNativeListener = MPV.addNativeListener = function addNativeListener(action, callback) {
		if (!eventListeners[action]) {
			eventListeners[action] = [];
		}
		eventListeners[action].push(callback);
	}

	/**
	 * Dispatches an event to registered listeners.
	 */
	function dispatchNativeEvent(action, data) {
		if (eventListeners[action]) {
			const normalizedData = normalizeKeys(data);
			eventListeners[action].forEach((cb) => {
				try {
					cb(normalizedData);
				} catch (e) {
					console.error(`Error in native listener for ${action}:`, e);
					logger.error(`Error in native listener for '${action}': ${e?.message || e}`, { persist: false, stack: e?.stack });
				}
			});
		}
	}

	/**
	 * Establishes a persistent connection to the native host.
	 */
	function connectToNativeHost() {
		if (connectionPromise) return connectionPromise;

		connectionStatus = ConnectionStatus.CONNECTING;
		emitLog({
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

				emitLog({
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
				const pendingRequest = request_id ? requestPromises[request_id] : null;
				let normalizedResponse;
				if (pendingRequest?.preserveDataKeys && "data" in responseData) {
					const { data: rawData, ...rest } = responseData;
					normalizedResponse = {
						...normalizeKeys(rest),
						data: rawData,
					};
				} else {
					normalizedResponse = normalizeKeys(responseData);
				}

				if (request_id && pendingRequest) {
					if (normalizedResponse.log) {
						dispatchNativeEvent("log", {
							action: "log",
							log: normalizedResponse.log,
							...(typeof normalizedResponse.log === "object" && normalizedResponse.log !== null
								? normalizedResponse.log
								: {}),
						});
					}
					pendingRequest.resolve(normalizedResponse);
					delete requestPromises[request_id];
					return;
				}
				if (normalizedResponse.action)
					dispatchNativeEvent(normalizedResponse.action, normalizedResponse);

				if (normalizedResponse.log) {
					dispatchNativeEvent("log", {
						action: "log",
						log: normalizedResponse.log,
						...(typeof normalizedResponse.log === "object" && normalizedResponse.log !== null
							? normalizedResponse.log
							: {}),
					});
				}
			});

			emitLog({
				text: `[Background]: Native port opened, awaiting session handshake...`,
				type: "info",
			});

			const restoreRequestId = `internal_restore_${Date.now()}`;
			const handshakeTimer = setTimeout(() => {
				if (requestPromises[restoreRequestId]) {
					delete requestPromises[restoreRequestId];
					const err = new Error("Native host handshake timed out after 30s.");
					emitLog({
						text: `[Background]: Session restoration failed: ${err.message}`,
						type: "error",
					});
					if (connectionStatus === ConnectionStatus.CONNECTING) {
						connectionStatus = ConnectionStatus.DISCONNECTED;
						connectionPromise = null;
						if (nativePort) {
							try {
								nativePort.disconnect();
							} catch (e) {
								logger.debug(`[NativeConn] Error disconnecting timed-out port: ${e?.message}`);
							}
							nativePort = null;
						}
						reject(err);
					}
				}
			}, 30000);

			requestPromises[restoreRequestId] = {
				resolve: (responseData) => {
					clearTimeout(handshakeTimer);
					connectionStatus = ConnectionStatus.CONNECTED;
					emitLog({
						text: `[Background]: Session restoration handshake completed.`,
						type: "info",
					});

					// Synchronize Log Level
					const syncedLogLevel = responseData.logLevel || responseData.log_level;
					if (syncedLogLevel) {
						logger.setLevel(syncedLogLevel);
						logger.info(`Log level synced to ${syncedLogLevel}`);
					}

					if (responseData.action === "session_restored")
						dispatchNativeEvent("session_restored", responseData);
					resolve();
				},
				reject: (err) => {
					clearTimeout(handshakeTimer);
					connectionPromise = null;
					connectionStatus = ConnectionStatus.DISCONNECTED;
					emitLog({
						text: `[Background]: Session restoration failed: ${err.message}`,
						type: "error",
					});
					reject(err);
				},
			};

			nativePort.postMessage({
				action: "restore_session",
				request_id: restoreRequestId,
			});
		});

		return connectionPromise;
	}

	const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

	/**
	 * Validates URLs before sending to the native host:
	 * - Enforces protocol allowlist & length via isValidUrl
	 * - Enforces SSRF protection via isSafeUrl(..., { allowLocal: true }) for http:/https: targets
	 * - Permits explicit local/stream schemes (file:, udp:, rtsp:, rtmp:, mms:) via isValidUrl
	 */
	function isAllowedNativeUrl(target) {
		if (!target) return false;
		if (Array.isArray(target)) {
			if (target.length === 0) return true;
			return target.every((item) => {
				const u = typeof item === "string" ? item : (item && typeof item === "object" ? item.url : null);
				return typeof u === "string" && isAllowedNativeUrl(u);
			});
		}
		if (!isValidUrl(target)) return false;
		return isSafeUrl(target, { allowLocal: true });
	}

	/**
	 * Sends a message to the native host, handling connection logic automatically.
	 * @param {object} message - The message to send.
	 * @param {boolean} [shouldThrow=false] - Whether to throw errors or return failure object.
	 * @returns {Promise<object>} A promise that resolves with the response.
	 */
	const callNativeHost = MPV.callNativeHost = async function callNativeHost(message, shouldThrow = false) {
		try {
			// --- Pre-Validation Security Gate ---
			// Check for URLs in the message and validate them
			if (message.url && !isAllowedNativeUrl(message.url)) {
				throw new Error(`Security Block: Unsafe URL protocol or target.`);
			}
			if (message.urlItem?.url && !isAllowedNativeUrl(message.urlItem.url)) {
				throw new Error(`Security Block: Unsafe URL in item.`);
			}
			if (message.urls && !isAllowedNativeUrl(message.urls)) {
				throw new Error(`Security Block: Unsafe URL in batch urls.`);
			}
			if (message.urlItems && !isAllowedNativeUrl(message.urlItems)) {
				throw new Error(`Security Block: Unsafe URL in batch urlItems.`);
			}
			if (message.playlist && !isAllowedNativeUrl(message.playlist)) {
				throw new Error(`Security Block: Unsafe URL in playlist.`);
			}
			if (message.m3uData?.type === "items" && Array.isArray(message.m3uData.value) && !isAllowedNativeUrl(message.m3uData.value)) {
				throw new Error(`Security Block: Unsafe URL in m3uData items.`);
			}

			return await new Promise((resolve, reject) => {
				const ensureConnectedAndSend = async () => {
					await connectToNativeHost();
					const requestId = message.request_id || `req_${requestIdCounter++}`;

					// Wrap the execution in the logger context
					await logger.runWithContext(requestId, async () => {
						let timer = null;
						const cleanup = () => {
							if (timer) {
								clearTimeout(timer);
								timer = null;
							}
							delete requestPromises[requestId];
						};

						timer = setTimeout(() => {
							cleanup();
							reject(new Error(`Native host request timed out after ${DEFAULT_REQUEST_TIMEOUT_MS / 1000}s (${message.action || "unknown"}).`));
						}, DEFAULT_REQUEST_TIMEOUT_MS);

						requestPromises[requestId] = {
							preserveDataKeys:
								message.action === "import_from_file" ||
								message.action === "get_metadata_cache",
							resolve: (data) => {
								cleanup();
								resolve(data);
							},
							reject: (err) => {
								cleanup();
								reject(err);
							},
						};

						const messageToSend = { ...message, request_id: requestId };
						try {
							nativePort.postMessage(messageToSend);
						} catch (e) {
							cleanup();
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
				emitLog({ text: `[Background]: ${errorMessage}`, type: "error" });
			}

			if (shouldThrow) throw error;
			return { success: false, error: errorMessage };
		}
	}

})();