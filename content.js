/**
 * content.js
 * Entry Point for the MPV Playlist Organizer.
 * Initializes the MpvController coordinator.
 */

(function () {
    'use strict';

    const MPV = window.MPV || {};

    // Prevent double initialization
    if (window.mpvControllerInitialized) return;

    // In MV3, scripts in manifest.json are executed in order.
    // Since content.js is last, all dependencies are guaranteed to be present.
    if (!MPV.MpvController) {
        console.error("[MPV] Critical Error: MpvController class not found. Injection order might be corrupted.");
        return;
    }

    const controller = new MPV.MpvController();
    window.mpvControllerInstance = controller; // Store globally for debugging
    
    // Check if we are in a scanner window
    const isScannerWindow = new URL(window.location.href).searchParams.get('mpv_playlist_scanner') === 'true';

    if (!isScannerWindow) {
        controller.init();
    } else {
        // Scanner windows only need the message listener for scraping, no full UI
        chrome.runtime.onMessage.addListener((req, sender, send) => controller.handleMessage(req, sender, send));
    }

})();
