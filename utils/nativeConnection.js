const NATIVE_HOST_NAME = 'com.mpv_playlist_organizer.handler';

const ConnectionStatus = {
    DISCONNECTED: 'DISCONNECTED',
    CONNECTING: 'CONNECTING',
    CONNECTED: 'CONNECTED',
};

let nativePort = null;
let connectionStatus = ConnectionStatus.DISCONNECTED;
let requestPromises = {};
let requestIdCounter = 0;
let connectionPromise = null;

// Dependencies to be injected from background.js
let dependencies = {
    broadcastLog: () => {},
    handleMpvExited: () => {},
    handleUpdateLastPlayed: () => {},
};

/**
 * Injects dependencies from the main background script.
 * @param {object} deps - An object containing dependency functions.
 */
export function injectDependencies(deps) {
    dependencies.broadcastLog = deps.broadcastLog;
    dependencies.handleMpvExited = deps.handleMpvExited;
    dependencies.handleUpdateLastPlayed = deps.handleUpdateLastPlayed;
}

/**
 * Establishes a persistent connection to the native host.
 * @returns {Promise<void>} A promise that resolves when connected.
 */
function connectToNativeHost() {
    if (connectionPromise) {
        return connectionPromise;
    }

    connectionStatus = ConnectionStatus.CONNECTING;
    dependencies.broadcastLog({ text: `[Background]: Establishing connection to native host...`, type: 'info' });

    connectionPromise = new Promise((resolve, reject) => {
        nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);

        const onDisconnect = () => {
            const errorMessage = chrome.runtime.lastError ? chrome.runtime.lastError.message : "Native host disconnected.";
            console.error("Native host disconnected:", errorMessage);
            dependencies.broadcastLog({ text: `[Background]: Native host disconnected. It may need to be re-installed. Error: ${errorMessage}`, type: 'error' });

            for (const id in requestPromises) {
                requestPromises[id].reject(new Error(`Native host disconnected: ${errorMessage}`));
            }

            nativePort = null;
            connectionStatus = ConnectionStatus.DISCONNECTED;
            requestPromises = {};
            connectionPromise = null;
            reject(new Error(errorMessage));
        };

        nativePort.onDisconnect.addListener(onDisconnect);

        nativePort.onMessage.addListener((response) => {
            const { request_id, ...responseData } = response;
            if (request_id && requestPromises[request_id]) {
                requestPromises[request_id].resolve(responseData);
                delete requestPromises[request_id];
            } else if (responseData.action === 'mpv_exited') {
                dependencies.handleMpvExited(responseData);
            } else if (responseData.action === 'update_last_played') {
                dependencies.handleUpdateLastPlayed(responseData);
            } else if (responseData.action === 'update_item_resume_time') {
                dependencies.handleUpdateItemResumeTime(responseData);
            } else if (responseData.log) {
                dependencies.broadcastLog(responseData.log);
            } else if (responseData.action === 'session_restored' && responseData.result) {
                if (responseData.result.was_stale) {
                    dependencies.handleMpvExited(responseData.result);
                }
            } else {
                console.warn("Received message from native host without a matching request ID:", response);
            }
        });

        connectionStatus = ConnectionStatus.CONNECTED;
        dependencies.broadcastLog({ text: `[Background]: Successfully connected to native host.`, type: 'info' });
        resolve();
    });

    return connectionPromise;
}

/**
 * Sends a message to the native host, handling connection logic automatically.
 * @param {object} message - The message to send.
 * @returns {Promise<object>} A promise that resolves with the response.
 */
export async function callNativeHost(message) {
    return new Promise((resolve, reject) => {
        const ensureConnectedAndSend = async () => {
            await connectToNativeHost();
            const requestId = `req_${requestIdCounter++}`;
            requestPromises[requestId] = { resolve, reject };
            const messageToSend = { ...message, request_id: requestId };
            try {
                nativePort.postMessage(messageToSend);
            } catch (e) {
                reject(new Error(`Failed to send message to native host. It may have disconnected. Error: ${e.message}`));
                delete requestPromises[requestId];
            }
        };
        ensureConnectedAndSend().catch(reject);
    }).catch(error => {
        const errorMessage = `Could not communicate with native host. It might be disconnected or not installed. Error: ${error.message}`;
        console.error(errorMessage);
        dependencies.broadcastLog({ text: `[Background]: ${errorMessage}`, type: 'error' });
        return { success: false, error: errorMessage };
    });
}