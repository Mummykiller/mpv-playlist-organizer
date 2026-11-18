/**
 * content.js
 * Entry Point for the MPV Playlist Organizer.
 * Namespaced Global version.
 */

function safeGetExtId() {
	try {
		return chrome?.runtime?.id || "";
	} catch (e) {
		return "";
	}
}

function safeSendMessage(message) {
	try {
		if (!chrome?.runtime?.id || !chrome.runtime.sendMessage) return;
		const res = chrome.runtime.sendMessage(message);
		if (res && typeof res.catch === "function") {
			return res.catch(() => {});
		}
	} catch (e) {
		console.debug("[MPV Content] safeSendMessage ignored:", e?.message || e);
	}
}

// Global error listeners for unhandled content script errors (forward to browser_errors.log)
window.addEventListener("error", (event) => {
	const filename = event.filename || "";
	const stack = event.error?.stack || "";
	const extId = safeGetExtId();
	if (
		(extId && (filename.includes(extId) || stack.includes(extId))) ||
		filename.includes("mpv-playlist-organizer")
	) {
		const err = event.error;
		const msg = err ? (err.message || String(err)) : (event.message || "Unknown error");
		safeSendMessage({
			action: "log_browser_error",
			context: "ContentScript",
			message: msg,
			stack: err?.stack || ""
		});
	}
});

window.addEventListener("unhandledrejection", (event) => {
	const reason = event.reason;
	const stack = reason?.stack || "";
	const extId = safeGetExtId();
	if ((extId && stack.includes(extId)) || stack.includes("mpv-playlist-organizer")) {
		const msg = reason ? (reason.message || String(reason)) : String(reason);
		safeSendMessage({
			action: "log_browser_error",
			context: "ContentScript",
			message: msg,
			stack
		});
	}
});

(() => {
	if (window.mpvControllerInitialized) return;
	window.mpvControllerInitialized = true;

	try {
		const MPV = window.MPV_INTERNAL || {};

		// Wire up logger persistence so MPV.logger.error() anywhere in content scripts
		// automatically forwards to background -> native host -> browser_errors.log
		if (MPV.logger && !MPV.logger.nativeSender) {
			MPV.logger.setNativeSender((payload) => {
				return safeSendMessage({
					action: "log_browser_error",
					context: payload.context || "ContentScript",
					message: payload.message,
					stack: payload.stack || ""
				});
			});
		}

		if (!MPV.MpvController) {
			console.error("[MPV] Critical Error: MpvController class not found.");
			MPV.logger?.error?.("[ContentScript] Critical Error: MpvController class not found on page.", { persist: true });
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

		// Invariant: Never render or mount the controller inside an iframe
		let isTopFrame = false;
		try {
			isTopFrame = window.top === window.self;
		} catch (e) {
			isTopFrame = false;
		}

		if (!isTopFrame) {
			return; // Exit sub-frames immediately: no controller or UI in iframes
		}

		// 2. Initialize Main Controller (Top frame only, or scanner)
		const controller = new MPV.MpvController();
		window.mpvControllerInstance = controller;

		if (!isScannerWindow) {
			try {
				controller.init();
			} catch (initErr) {
				console.error("[MPV Content Script] controller.init() failed:", initErr);
				MPV.logger?.error?.(`[ContentScript] controller.init() failed: ${initErr.message}`, { persist: true, stack: initErr.stack });
				MPV.domUtils?.showNotificationBanner?.("MPV Playlist Organizer: Initialization failed on this page.", { isError: true });
			}
		} else if (safeGetExtId() && chrome.runtime?.onMessage) {
			try {
				chrome.runtime.onMessage.addListener((req, sender, send) => {
					try {
						return controller.handleMessage(req, sender, send);
					} catch (msgErr) {
						console.error("[MPV Content Script] scanner handleMessage failed:", msgErr);
						MPV.logger?.error?.(`[ContentScript] scanner handleMessage failed: ${msgErr.message}`, { persist: true, stack: msgErr.stack });
						if (send) send({ success: false, error: msgErr.message });
					}
				});
			} catch (e) {
				console.debug("[MPV Content] scanner listener registration failed:", e?.message || e);
			}
		}
	} catch (e) {
		console.error("[MPV Content Script] Init failed:", e);
		try {
			const MPV = window.MPV_INTERNAL || {};
			MPV.logger?.error?.(`[ContentScript] Init failed: ${e.message}`, { persist: true, stack: e.stack });
			MPV.domUtils?.showNotificationBanner?.("MPV Playlist Organizer encountered an error initializing on this page.", { isError: true });
		} catch (err) {
			const MPV = window.MPV_INTERNAL;
			MPV?.logger?.debug?.(`[ContentScript] Fallback error handler exception: ${err?.message}`);
		}
	}
})();
