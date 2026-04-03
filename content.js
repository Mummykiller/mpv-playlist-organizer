/**
 * content.js
 * Entry Point for the MPV Playlist Organizer.
 * Namespaced Global version.
 */

(() => {
	if (window.mpvControllerInitialized) return;
	window.mpvControllerInitialized = true;

	const MPV = window.MPV_INTERNAL;

	if (!MPV || !MPV.MpvController) {
		console.error("[MPV] Critical Error: MpvController class not found.");
		return;
	}

	const isScannerWindow =
		new URL(window.location.href).searchParams.get("mpv_playlist_scanner") ===
		"true";

	// 1. Initialize site-specific automations (Runs in ALL frames)
	if (MPV.Janitor) {
		new MPV.Janitor();
	}

	// 2. Initialize Main Controller (Top frame only, or scanner)
	if (window.top === window.self) {
		const controller = new MPV.MpvController();
		window.mpvControllerInstance = controller;

		if (!isScannerWindow) {
			controller.init();
		} else {
			chrome.runtime.onMessage.addListener((req, sender, send) =>
				controller.handleMessage(req, sender, send),
			);
		}
	}
})();
