const assert = require("node:assert").strict;
const { JSDOM } = require("jsdom");

/**
 * Setup JSDOM for realistic Browser environment simulation.
 */
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
	url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
	referrer: "https://www.google.com",
	contentType: "text/html",
	includeNodeLocations: true,
	storageQuota: 10000000
});

global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.Node = dom.window.Node;
global.Element = dom.window.Element;
global.MutationObserver = dom.window.MutationObserver;
global.requestAnimationFrame = (cb) => setTimeout(cb, 0);
global.cancelAnimationFrame = (id) => clearTimeout(id);

// Add missing browser globals needed by the app
global.window.matchMedia = global.window.matchMedia || function() {
    return {
        matches: false,
        addListener: function() {},
        removeListener: function() {}
    };
};

/**
 * Mock Chrome Extension API (Not provided by JSDOM)
 */
let mockRuntimeSendMessageHook = null;
let mockTabsSendMessageHook = null;

global.chrome = {
	runtime: {
		id: "test-extension-id",
		getURL: (path) => `chrome-extension://test-extension-id/${path}`,
		sendMessage: (payload, callback) => {
			if (mockRuntimeSendMessageHook) {
				return mockRuntimeSendMessageHook(payload, callback);
			}
			if (payload.action === "ping") {
				callback({ success: true });
			} else if (payload.action === "get_playback_status") {
				callback({ status: "playing", folderId: "Default" });
			} else if (payload.action === "get_all_folder_ids") {
				callback({ success: true, folderIds: ["Default", "Anime"], lastUsedFolderId: "Default" });
			} else {
				callback({ success: true, ...payload });
			}
		},
		onMessage: {
			addListener: () => {},
			removeListener: () => {}
		},
		lastError: null
	},
	tabs: {
		query: (queryInfo, callback) => {
			const tabs = [{ id: 123, active: true }];
			if (typeof callback === "function") {
				callback(tabs);
			}
			return Promise.resolve(tabs);
		},
		sendMessage: (tabId, payload, callback) => {
			if (mockTabsSendMessageHook) {
				return mockTabsSendMessageHook(tabId, payload, callback);
			}
			if (typeof callback === "function") {
				callback({ success: true });
			}
			return Promise.resolve({ success: true });
		}
	},
	storage: {
		local: {
			get: (keys, callback) => {
				const res = {
					folderIds: ["Default", "Anime"],
					lastUsedFolderId: "Default",
					folders: {
						"Default": { name: "Default", items: [] },
						"Anime": { name: "Anime", items: [] }
					}
				};
				if (typeof callback === "function") {
					callback(res);
				} else {
					return Promise.resolve(res);
				}
			},
			set: (data, callback) => {
				if (typeof callback === "function") {
					callback();
				} else {
					return Promise.resolve();
				}
			}
		},
		onChanged: {
			addListener: () => {},
			removeListener: () => {}
		}
	}
};

// Mock getBoundingClientRect (JSDOM returns all 0s by default)
global.Element.prototype.getBoundingClientRect = function() {
    return {
        top: 0,
        left: 0,
        width: 100,
        height: 100,
        right: 100,
        bottom: 100,
        x: 0,
        y: 0
    };
};

// Initialize Namespaces
global.window.MPV_INTERNAL = {};
global.window.MPV_SECURITY = {};

// Load modular files (already namespaced by generate_js.py)
require("../../utils/SystemLogger.js");
require("../../utils/commUtils.js");
require("../../utils/domUtils.js");
require("../../utils/security.js");
require("../../utils/anilist_renderer.js");
require("../../utils/MpvInterface.js");
require("../../utils/MessageBridge.js");
require("../../utils/ContentState.js");
require("../../utils/PlaybackStateManager.js");
require("../../utils/NavigationObserver.js");
require("../../utils/UIManager.js");
require("../../utils/Draggable.js");
require("../../utils/Resizable.js");
require("../../utils/PlaylistUI.js");
require("../../utils/PageScraper.js");
require("../../utils/AniListUI.js");
require("../../utils/MpvController.js");

const MPV = global.window.MPV_INTERNAL;
const SECURITY = global.window.MPV_SECURITY;

/**
 * --- REALISTIC TESTS ---
 */

function testTranspilationIntegrity() {
	console.log("Testing ES-module to Global Transpilation Integrity...");
	
	// 1. commUtils exports
	assert.strictEqual(typeof MPV.promptUserConfirmation, "function", "promptUserConfirmation must be exported");
	assert.strictEqual(typeof MPV.normalizeKeys, "function", "normalizeKeys must be exported");
	assert.strictEqual(typeof MPV.sanitizeString, "function", "sanitizeString must be exported");
	assert.strictEqual(typeof MPV.isYouTubeUrl, "function", "isYouTubeUrl must be exported");
	assert.strictEqual(typeof MPV.getYoutubeId, "function", "getYoutubeId must be exported");
	assert.strictEqual(typeof MPV.normalizeYouTubeUrl, "function", "normalizeYouTubeUrl must be exported");
	assert.strictEqual(typeof MPV.debounce, "function", "debounce must be exported");
	assert.strictEqual(typeof MPV.sendMessageAsync, "function", "sendMessageAsync must be exported");
	assert.strictEqual(typeof MPV.isExtensionReloadError, "function", "isExtensionReloadError must be exported");
	assert.strictEqual(typeof MPV.getActiveTab, "function", "getActiveTab must be exported");
	assert.ok(Array.isArray(MPV.DOMAIN_SPECIFIC_KEYS), "DOMAIN_SPECIFIC_KEYS must be an array");

	// 2. SystemLogger exports
	assert.ok(MPV.logger, "logger instance must be exported");
	assert.strictEqual(typeof MPV.logger.setLevel, "function");
	assert.strictEqual(typeof MPV.logger.error, "function");
	assert.ok(MPV.LogLevel, "LogLevel enum must be exported");
	assert.strictEqual(MPV.LogLevel.ERROR, 3);

	// 3. MpvInterface exports
	assert.strictEqual(typeof MPV.MpvInterface, "function", "MpvInterface class must be exported");
	assert.strictEqual(typeof MPV.MpvInterface.play, "function", "MpvInterface.play static method must exist");
	assert.strictEqual(typeof MPV.MpvInterface.closeMpv, "function", "MpvInterface.closeMpv static method must exist");

	// 4. AniListRenderer & domUtils
	assert.strictEqual(typeof MPV.AniListRenderer, "function", "AniListRenderer class must be exported");
	assert.ok(MPV.domUtils, "domUtils object must be exported");
	assert.strictEqual(typeof MPV.domUtils.getPlayButtonVisual, "function");

	// 5. MPV_SECURITY exports
	assert.strictEqual(typeof SECURITY.isValidUrl, "function", "isValidUrl must be exported in MPV_SECURITY");
	assert.ok(Array.isArray(SECURITY.ALLOWED_PROTOCOLS), "ALLOWED_PROTOCOLS must be exported");
	assert.ok(SECURITY.SECURITY_LIMITS, "SECURITY_LIMITS must be exported");
	assert.strictEqual(SECURITY.SECURITY_LIMITS.MAX_TITLE_LENGTH, 512);
	assert.strictEqual(SECURITY.SECURITY_LIMITS.MAX_URL_LENGTH, 4096);

	console.log("  [OK] ES-module to Global Transpilation Integrity");
}

async function testPromptUserConfirmation() {
	console.log("Testing promptUserConfirmation logic...");

	// Case 1: Open popup receives and confirms
	mockRuntimeSendMessageHook = (payload, callback) => {
		assert.strictEqual(payload.action, "show_popup_confirmation");
		assert.strictEqual(payload.message, "Delete playlist?");
		global.chrome.runtime.lastError = null;
		callback({ confirmed: true });
	};
	let confirmed = await MPV.promptUserConfirmation("Delete playlist?");
	assert.strictEqual(confirmed, true, "Should resolve true when popup confirms");

	// Case 2: Open popup receives and cancels
	mockRuntimeSendMessageHook = (payload, callback) => {
		global.chrome.runtime.lastError = null;
		callback({ confirmed: false });
	};
	confirmed = await MPV.promptUserConfirmation("Delete playlist?");
	assert.strictEqual(confirmed, false, "Should resolve false when popup cancels");

	// Case 3: Popup is closed (lastError), fallback to active tab
	mockRuntimeSendMessageHook = (payload, callback) => {
		global.chrome.runtime.lastError = { message: "Could not establish connection. Receiving end does not exist." };
		callback(undefined);
	};
	let tabReceivedMessage = false;
	mockTabsSendMessageHook = (tabId, payload, callback) => {
		assert.strictEqual(tabId, 123, "Should message the active tab from getActiveTab()");
		assert.strictEqual(payload.action, "show_confirmation");
		assert.strictEqual(payload.message, "Fallback question");
		tabReceivedMessage = true;
		global.chrome.runtime.lastError = null;
		callback({ confirmed: true });
	};
	confirmed = await MPV.promptUserConfirmation("Fallback question");
	assert.strictEqual(tabReceivedMessage, true, "Active tab should have been messaged");
	assert.strictEqual(confirmed, true, "Should resolve true when tab confirms");

	// Case 4: Popup closed, fallback with preferredTabId
	let preferredTabReceived = false;
	mockTabsSendMessageHook = (tabId, payload, callback) => {
		assert.strictEqual(tabId, 999, "Should message specified preferredTabId");
		preferredTabReceived = true;
		global.chrome.runtime.lastError = null;
		callback({ confirmed: true });
	};
	confirmed = await MPV.promptUserConfirmation("Preferred tab question", 999);
	assert.strictEqual(preferredTabReceived, true);
	assert.strictEqual(confirmed, true);

	// Case 5: Both popup and tab unreachable -> defaultOnUnreachable fallback
	mockTabsSendMessageHook = (tabId, payload, callback) => {
		global.chrome.runtime.lastError = { message: "Frame was removed." };
		callback(undefined);
	};
	const defaultFalse = await MPV.promptUserConfirmation("Unreachable test", null, false);
	assert.strictEqual(defaultFalse, false, "Should return defaultOnUnreachable (false)");

	const defaultTrue = await MPV.promptUserConfirmation("Unreachable test", null, true);
	assert.strictEqual(defaultTrue, true, "Should return defaultOnUnreachable (true)");

	// Reset hooks
	mockRuntimeSendMessageHook = null;
	mockTabsSendMessageHook = null;
	global.chrome.runtime.lastError = null;
	console.log("  [OK] promptUserConfirmation (Popup & Tab Fallback)");
}

async function testMpvInterfaceComponent() {
	console.log("Testing MpvInterface component...");
	
	// Missing folderId should reject immediately
	await assert.rejects(
		async () => { await MPV.MpvInterface.play(""); },
		/Folder ID is required for playback/
	);

	// Valid playback command
	let sentAction = null;
	mockRuntimeSendMessageHook = (payload, callback) => {
		sentAction = payload.action;
		callback({ success: true, isRunning: true, isPaused: false });
	};

	const playRes = await MPV.MpvInterface.play("Default", { startPaused: false });
	assert.strictEqual(sentAction, "play");
	assert.strictEqual(playRes.success, true);
	assert.strictEqual(MPV.playbackStateManager.state.isRunning, true);

	// Close command
	const closeRes = await MPV.MpvInterface.closeMpv("Default");
	assert.strictEqual(sentAction, "close_mpv");
	assert.strictEqual(closeRes.success, true);
	assert.strictEqual(MPV.playbackStateManager.state.isClosing, true);

	mockRuntimeSendMessageHook = null;
	console.log("  [OK] MpvInterface Logic");
}

async function testSecurityComponent() {
	console.log("Testing Security component...");
	assert.strictEqual(SECURITY.isValidUrl("https://youtube.com/watch?v=abc"), true);
	assert.strictEqual(SECURITY.isValidUrl("http://localhost:8000/stream"), true);
	assert.strictEqual(SECURITY.isValidUrl("file:///home/user/video.mkv"), true);
	assert.strictEqual(SECURITY.isValidUrl("rtmp://live.stream/channel"), true);
	assert.strictEqual(SECURITY.isValidUrl("udp://127.0.0.1:1234"), true);

	// Dangerous or disallowed protocols
	assert.strictEqual(SECURITY.isValidUrl("javascript:alert(1)"), false);
	assert.strictEqual(SECURITY.isValidUrl("data:text/html,<h1>bad</h1>"), false);
	assert.strictEqual(SECURITY.isValidUrl("blob:https://example.com/uuid"), false);
	assert.strictEqual(SECURITY.isValidUrl("chrome-extension://id/popup.html"), false);

	// Overly long URL
	const hugeUrl = "https://example.com/" + "a".repeat(5000);
	assert.strictEqual(SECURITY.isValidUrl(hugeUrl), false);
	console.log("  [OK] Security Protocol Validation");
}

async function testMessageBridge() {
	console.log("Testing MessageBridge...");
	const bridge = new MPV.MessageBridge({ environment: "content" });
	const response = await bridge.send("test_action", "FolderA", { key: "val" });
	
	assert.strictEqual(response.success, true);
	assert.strictEqual(response.folderId, "FolderA");
	assert.strictEqual(response.key, "val");
	console.log("  [OK] MessageBridge Logic");
}

function testContentState() {
	console.log("Testing ContentState...");
	let updateCalled = false;
	const state = new MPV.ContentState({
		onUpdate: (s) => {
			updateCalled = true;
			assert.strictEqual(s.currentFolderId, "NewFolder");
		}
	});

	state.update({ currentFolderId: "NewFolder" });
	assert.strictEqual(updateCalled, true);
	assert.strictEqual(state.state.currentFolderId, "NewFolder");
	console.log("  [OK] ContentState Logic");
}

function testPlaybackStateManager() {
	console.log("Testing PlaybackStateManager...");
	const manager = MPV.playbackStateManager;
	// Clean reset
	manager.update({ isRunning: false, isClosing: false, isLaunching: false, isAppending: false, isPaused: false, isIdle: false });
	let lastStatus = null;

	manager.subscribe((state) => {
		lastStatus = state.status;
	});

	manager.update({ isRunning: true, isPaused: false, isIdle: false, isClosing: false });
	assert.strictEqual(lastStatus, "playing");

	manager.update({ isPaused: true });
	assert.strictEqual(lastStatus, "paused");

	manager.update({ isRunning: false });
	assert.strictEqual(lastStatus, "stopped");
	console.log("  [OK] PlaybackStateManager Logic");
}

function testPageScraperWithInjection() {
	console.log("Testing PageScraper (Real DOM Injection)...");
	
	// Mimic a YouTube page structure
	document.body.innerHTML = `
		<div id="container">
			<h1 class="title style-scope ytd-video-primary-info-renderer">
				<yt-formatted-string class="style-scope ytd-video-primary-info-renderer">
					Injected Video Title
				</yt-formatted-string>
			</h1>
		</div>
	`;
	document.title = "Injected Video Title - YouTube";

	const scraper = new MPV.PageScraper();
	const details = scraper.scrapePageDetails("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
	
	assert.ok(details.title.includes("Injected Video Title"), `Title was: ${details.title}`);
	assert.strictEqual(details.url, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
	console.log("  [OK] PageScraper (Real DOM Detection)");
}

async function testMpvControllerInit() {
	console.log("Testing MpvController Initialization...");
	const controller = new MPV.MpvController();
	
	await controller.init();
	
	assert.ok(controller.bridge, "Bridge should be initialized");
	assert.ok(controller.state, "State should be initialized");
	
	// Check if UI was actually injected into the real JSDOM document
	const host = document.getElementById("m3u8-controller-host");
	assert.ok(host, "UIManager should have injected the host element into JSDOM");
	
	controller.teardown();
	console.log("  [OK] MpvController (Full Lifecycle)");
}

(async () => {
	try {
		testTranspilationIntegrity();
		await testPromptUserConfirmation();
		await testMpvInterfaceComponent();
		await testSecurityComponent();
		await testMessageBridge();
		testContentState();
		testPlaybackStateManager();
		testPageScraperWithInjection();
		await testMpvControllerInit();
		console.log("\nALL MODULAR COMPONENT TESTS PASSED (JSDOM)! 📦✨");
	} catch (err) {
		console.error("\nTEST FAILED! ❌");
		console.error(err);
		process.exit(1);
	}
})();
