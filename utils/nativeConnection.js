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
    handleUpdateItemResumeTime: () => {},
    handleSessionRestored: () => {},
};

/**
 * Injects dependencies from the main background script.
 * @param {object} deps - An object containing dependency functions.
 */
export function injectDependencies(deps) {
    dependencies.broadcastLog = deps.broadcastLog;
    dependencies.handleMpvExited = deps.handleMpvExited;
    dependencies.handleUpdateLastPlayed = deps.handleUpdateLastPlayed;
    dependencies.handleUpdateItemResumeTime = deps.handleUpdateItemResumeTime;
    dependencies.handleSessionRestored = deps.handleSessionRestored;
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
            const lastError = chrome.runtime.lastError ? chrome.runtime.lastError.message : "Native host disconnected.";
            let friendlyError = lastError;

            // Provide more helpful messages for common installation/permission issues.
            if (lastError.includes("Access denied")) {
                friendlyError = "Access denied. Please ensure the installer.py script has been run to register the native host.";
            } else if (lastError.includes("Specified native messaging host not found")) {
                friendlyError = "Native host not found. Please run installer.py to register the extension with your system.";
            }

            console.error("Native host disconnected:", lastError);
            dependencies.broadcastLog({ 
                text: `[Background]: Fatal Connection Error: ${friendlyError}`, 
                type: 'error' 
            });

            for (const id in requestPromises) {
                requestPromises[id].reject(new Error(friendlyError));
            }

            // Explicitly reject the main connection promise if it exists and is still pending
            if (connectionPromise && connectionStatus === ConnectionStatus.CONNECTING) {
                // We can't directly reject the promise from outside, 
                // but the current structure of connectToNativeHost 
                // uses the reject function passed into the Promise constructor.
                // Since onDisconnect is defined INSIDE that constructor, it has access to 'reject'.
                reject(new Error(friendlyError));
            }

            nativePort = null;
            connectionStatus = ConnectionStatus.DISCONNECTED;
            requestPromises = {};
            connectionPromise = null;
        };

        nativePort.onDisconnect.addListener(onDisconnect);

        nativePort.onMessage.addListener((response) => {
            const { request_id, ...responseData } = response;
            
            // 1. Handle tracked requests (including the restoration handshake)
            if (request_id && requestPromises[request_id]) {
                requestPromises[request_id].resolve(responseData);
                delete requestPromises[request_id];
                return; // Stop here; responses to requests shouldn't trigger unsolicited action handlers
            }
            
            // 2. Handle unsolicited actions from the native host
            if (responseData.action === 'mpv_exited') {
                dependencies.handleMpvExited(responseData);
            } else if (responseData.action === 'update_last_played') {
                dependencies.handleUpdateLastPlayed(responseData);
            } else if (responseData.action === 'update_item_resume_time') {
                dependencies.handleUpdateItemResumeTime(responseData);
            } else if (responseData.log) {
                dependencies.broadcastLog(responseData.log);
            } else if (responseData.action === 'session_restored') {
                // This is now only for truly unsolicited restoration signals (rare)
                dependencies.handleSessionRestored(responseData);
            } else if (request_id === undefined) {
                console.warn("Received unexpected message from native host:", response);
            }
        });

        connectionStatus = ConnectionStatus.CONNECTED;
        dependencies.broadcastLog({ text: `[Background]: Successfully connected to native host.`, type: 'info' });
        
        // Trigger session restoration immediately upon connection
        // We use a manual request_id to track this specific internal request
        const restoreRequestId = `internal_restore_${Date.now()}`;
        requestPromises[restoreRequestId] = {
            resolve: (responseData) => {
                dependencies.broadcastLog({ text: `[Background]: Session restoration handshake completed.`, type: 'info' });
                if (responseData.action === 'session_restored') {
                    dependencies.handleSessionRestored(responseData);
                }
                resolve(); // Now resolve the main connection promise
            },
            reject: (err) => {
                // If we are still in the process of connecting, this means the initial handshake failed.
                // We should reject the main connection promise in this case.
                if (connectionStatus === ConnectionStatus.CONNECTING) {
                    dependencies.broadcastLog({ text: `[Background]: Session restoration handshake failed: ${err.message}`, type: 'error' });
                    reject(err);
                } else {
                    // If we were already CONNECTED, just log it.
                    dependencies.broadcastLog({ text: `[Background]: Session restoration handshake failed: ${err.message}`, type: 'error' });
                }
            }
        };

        dependencies.broadcastLog({ text: `[Background]: Sending session restoration handshake...`, type: 'info' });
        nativePort.postMessage({ action: 'restore_session', request_id: restoreRequestId });
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