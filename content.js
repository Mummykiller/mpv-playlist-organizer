/**
 * content.js
 * Entry Point for the MPV Playlist Organizer.
 * Initializes the MpvController coordinator.
 */

(function () {
    'use strict';

    const MAX_RETRIES = 20;
    const RETRY_INTERVAL = 50;

    window.mpvStartInitialization = (retryCount = 0) => {
        const MPV = window.MPV || {};
        
        // Basic check to ensure dependencies and the controller class are loaded
        // We also check for commUtils availability via normalizeYouTubeUrl to be safe
        if (!MPV.MessageBridge || !MPV.MpvController || typeof MPV.normalizeYouTubeUrl !== 'function') {
            if (retryCount < MAX_RETRIES) {
                setTimeout(() => window.mpvStartInitialization(retryCount + 1), RETRY_INTERVAL);
            } else {
                console.error("[MPV] Initialization aborted: Required window.MPV utilities or MpvController class not found after retries.");
            }
            return;
        }

        // Prevent double initialization
        if (window.mpvControllerInitialized) return;

        const controller = new MPV.MpvController();
        window.mpvControllerInstance = controller; // Store globally for debugging
        
        controller.init();
    };

    // Ignition: Start initialization once the DOM is ready (or immediately if already ready)
    const isScannerWindow = new URL(window.location.href).searchParams.get('mpv_playlist_scanner') === 'true';

    if (!isScannerWindow) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => window.mpvStartInitialization());
        } else {
            window.mpvStartInitialization();
        }
    } else {
        // Scanner windows only need the message listener for scraping, no full UI
        const MPV = window.MPV || {};
        if (MPV.MpvController) {
            const controller = new MPV.MpvController();
            chrome.runtime.onMessage.addListener((req, sender, send) => controller.handleMessage(req, sender, send));
        }
    }

})();
