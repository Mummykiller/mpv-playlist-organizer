/**
 * content.js
 * Entry Point for the MPV Playlist Organizer.
 * Namespaced Global version.
 */

(() => {
	if (window.mpvControllerInitialized) return;
	window.mpvControllerInitialized = true;

	try {
		const MPV = window.MPV_INTERNAL || {};

		if (!MPV.MpvController) {
			console.error("[MPV] Critical Error: MpvController class not found.");
			MPV.logger?.error?.("[ContentScript] Critical Error: MpvController class not found on page.", { persist: true });
			chrome.runtime?.sendMessage?.({
				action: "log_browser_error",
				context: "ContentScript",
				message: "Critical Error: MpvController class not found on page.",
				stack: ""
			}).catch?.((err) => {
				MPV.logger?.debug?.(`[ContentScript] Failed to send missing controller error: ${err?.message}`);
			});
			MPV.domUtils?.showNotificationBanner?.("MPV Playlist Organizer: Initialization failed (controller missing).", { isError: true });
			return;
		}

		const isScannerWindow =
			new URL(window.location.href).searchParams.get("mpv_playlist_scanner") ===
			"true";

		// 1. Initialize site-specific automations (Runs in ALL frames)
		if (MPV.Janitor) {
			try {
				new MPV.Janitor();
			} catch (janitorErr) {
				MPV.logger?.warn?.(`[ContentScript] Janitor initialization failed: ${janitorErr.message}`, { data: janitorErr });
			}
		}

		// 2. Initialize Main Controller (Top frame only, or scanner)
		if (window.top === window.self) {
			const controller = new MPV.MpvController();
			window.mpvControllerInstance = controller;

			if (!isScannerWindow) {
				try {
					controller.init();
				} catch (initErr) {
					console.error("[MPV Content Script] controller.init() failed:", initErr);
					MPV.logger?.error?.(`[ContentScript] controller.init() failed: ${initErr.message}`, { persist: true, stack: initErr.stack });
					chrome.runtime?.sendMessage?.({
						action: "log_browser_error",
						context: "ContentScript",
						message: `controller.init() failed: ${initErr.message}`,
						stack: initErr.stack || ""
					}).catch?.((sendErr) => {
						MPV.logger?.debug?.(`[ContentScript] Failed to send init error to background: ${sendErr?.message}`);
					});
					MPV.domUtils?.showNotificationBanner?.("MPV Playlist Organizer: Initialization failed on this page.", { isError: true });
				}
			} else {
				chrome.runtime.onMessage.addListener((req, sender, send) => {
					try {
						return controller.handleMessage(req, sender, send);
					} catch (msgErr) {
						console.error("[MPV Content Script] scanner handleMessage failed:", msgErr);
						MPV.logger?.error?.(`[ContentScript] scanner handleMessage failed: ${msgErr.message}`, { persist: true, stack: msgErr.stack });
						if (send) send({ success: false, error: msgErr.message });
					}
				});
			}
		}
	} catch (e) {
		console.error("[MPV Content Script] Init failed:", e);
		try {
			const MPV = window.MPV_INTERNAL || {};
			MPV.logger?.error?.(`[ContentScript] Init failed: ${e.message}`, { persist: true, stack: e.stack });
			chrome.runtime?.sendMessage?.({
				action: "log_browser_error",
				context: "ContentScript",
				message: `Init failed: ${e.message}`,
				stack: e.stack || ""
			}).catch?.((err) => {
				MPV.logger?.debug?.(`[ContentScript] Failed to send init error to background: ${err?.message}`);
			});
			MPV.domUtils?.showNotificationBanner?.("MPV Playlist Organizer encountered an error initializing on this page.", { isError: true });
		} catch (err) {
			const MPV = window.MPV_INTERNAL;
			MPV?.logger?.debug?.(`[ContentScript] Fallback error handler exception: ${err?.message}`);
		}
	}
})();
