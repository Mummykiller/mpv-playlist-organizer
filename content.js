/**
 * content.js
 * Entry Point for the MPV Playlist Organizer.
 * Namespaced Global version.
 */

(function () {
    'use strict';

    if (window.mpvControllerInitialized) return;
    window.mpvControllerInitialized = true;

    const MPV = window.MPV_INTERNAL;

    if (!MPV || !MPV.MpvController) {
        console.error("[MPV] Critical Error: MpvController class not found.");
        return;
    }

    const controller = new MPV.MpvController();
    window.mpvControllerInstance = controller; 
    
    const isScannerWindow = new URL(window.location.href).searchParams.get('mpv_playlist_scanner') === 'true';

    if (!isScannerWindow) {
        controller.init();
    } else {
        chrome.runtime.onMessage.addListener((req, sender, send) => controller.handleMessage(req, sender, send));
    }

})();