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
require("../../utils/nativeConnection.js");
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
require("../../utils/ControllerTimers.js");
require("../../utils/ControllerActions.js");
require("../../utils/ControllerView.js");
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

	// Malformed URLs where new URL() throws must return false (no loose prefix match)
	assert.strictEqual(SECURITY.isValidUrl("http://"), false);
	assert.strictEqual(SECURITY.isValidUrl("https://"), false);
	assert.strictEqual(SECURITY.isValidUrl("https://[::ffff:invalid/"), false);

	// Batch URL and URL Item validation
	assert.strictEqual(SECURITY.isValidUrl(["https://youtube.com/watch?v=abc", "http://example.com/video.mp4"]), true);
	assert.strictEqual(SECURITY.isValidUrl(["https://youtube.com/watch?v=abc", "javascript:alert(1)"]), false);
	assert.strictEqual(SECURITY.isValidUrl([{ url: "https://youtube.com/watch?v=abc" }, { url: "http://example.com/video.mp4" }]), true);
	assert.strictEqual(SECURITY.isValidUrl([{ url: "https://youtube.com/watch?v=abc" }, { url: "data:bad" }]), false);
	assert.strictEqual(typeof SECURITY.areValidUrls, "function", "areValidUrls must be exported");
	assert.strictEqual(SECURITY.areValidUrls([{ url: "https://youtube.com/watch?v=abc" }]), true);
	assert.strictEqual(SECURITY.areValidUrls([{ url: "javascript:bad" }]), false);

	// Overly long URL
	const hugeUrl = "https://example.com/" + "a".repeat(5000);
	assert.strictEqual(SECURITY.isValidUrl(hugeUrl), false);

	// Web protocol isolation
	assert.ok(Array.isArray(SECURITY.ALLOWED_WEB_PROTOCOLS), "ALLOWED_WEB_PROTOCOLS must be array");
	assert.strictEqual(SECURITY.isValidWebUrl("https://youtube.com/watch?v=abc"), true);
	assert.strictEqual(SECURITY.isValidWebUrl("http://example.com/video.mp4"), true);
	assert.strictEqual(SECURITY.isValidWebUrl("file:///home/user/video.mkv"), false);
	assert.strictEqual(SECURITY.isValidWebUrl("rtmp://live.stream/channel"), false);
	assert.strictEqual(SECURITY.isValidWebUrl("udp://127.0.0.1:1234"), false);

	// SSRF & Obfuscated IP Protection
	assert.strictEqual(SECURITY.isSafeUrl("https://google.com"), true);
	assert.strictEqual(SECURITY.isSafeUrl("http://localhost:8080"), false);
	assert.strictEqual(SECURITY.isSafeUrl("http://127.0.0.1:8080"), false);
	assert.strictEqual(SECURITY.isSafeUrl("http://192.168.1.1/stream"), false);
	assert.strictEqual(SECURITY.isSafeUrl("http://10.0.0.1/video"), false);
	assert.strictEqual(SECURITY.isSafeUrl("http://169.254.169.254/latest/meta-data"), false);
	assert.strictEqual(SECURITY.isSafeUrl("http://2130706433/admin"), false);
	assert.strictEqual(SECURITY.isSafeUrl("http://0177.0.0.1/admin"), false);
	assert.strictEqual(SECURITY.isSafeUrl("http://0x7f000001/admin"), false);
	assert.strictEqual(SECURITY.isSafeUrl("http://2852039166/metadata"), false);
	assert.strictEqual(SECURITY.isSafeUrl("http://[::1]/status"), false);
	assert.strictEqual(SECURITY.isSafeUrl("http://[fe80::1]/test"), false);
	assert.strictEqual(SECURITY.isSafeUrl("http://[::ffff:127.0.0.1]/test"), false);
	assert.strictEqual(SECURITY.isSafeUrl("file:///home/user/video.mkv", { allowLocal: true }), true);
	assert.strictEqual(SECURITY.isSafeUrl("file:///home/user/video.mkv", { allowLocal: false }), false);

	assert.strictEqual(SECURITY.isSafeWebUrl("https://youtube.com/watch?v=abc"), true);
	assert.strictEqual(SECURITY.isSafeWebUrl("http://127.0.0.1"), false);
	assert.strictEqual(SECURITY.isSafeWebUrl("file:///home/user/video.mkv"), false);

	console.log("  [OK] Security Protocol Validation & SSRF Isolation");
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

function testPageScraperProvisionalTitles() {
	console.log("Testing PageScraper.isTitleProvisional...");
	const scraper = new MPV.PageScraper();
	const url = "https://example.com/watch/1";

	assert.strictEqual(scraper.isTitleProvisional("", url), true);
	assert.strictEqual(scraper.isTitleProvisional(url, url), true);
	assert.strictEqual(scraper.isTitleProvisional("Loading...", url), true);
	assert.strictEqual(scraper.isTitleProvisional("YouTube", url), true);
	assert.strictEqual(scraper.isTitleProvisional("...", url), true);
	assert.strictEqual(scraper.isTitleProvisional("x", url), true);

	// Legitimate short titles and structured h1 titles must NOT be provisional
	assert.strictEqual(scraper.isTitleProvisional("Nana", url), false);
	assert.strictEqual(scraper.isTitleProvisional("Up", url), false);
	assert.strictEqual(scraper.isTitleProvisional("K-On", url), false);
	assert.strictEqual(
		scraper.isTitleProvisional("Ergo", url, { hasStructuredTitle: true }),
		false,
	);
	console.log("  [OK] PageScraper.isTitleProvisional");
}

async function testWaitForAccurateDetailsThrottlingAndGuards() {
	console.log("Testing ControllerView.waitForAccurateDetails throttling & guards...");
	const scraper = new MPV.PageScraper();
	let scrapeCalls = 0;
	let mockDetails = { url: window.location.href, title: "Loading...", isProvisional: true, fingerprint: "fp-1" };
	const view = new MPV.ControllerView({
		pageScraper: {
			scrapePageDetails: () => {
				scrapeCalls++;
				return { ...mockDetails };
			},
		},
	});

	// 1. originPageUrl mismatch aborts immediately
	const mismatch = await view.waitForAccurateDetails(
		window.location.href,
		500,
		"https://other-site.example/video",
	);
	assert.strictEqual(mismatch.isProvisional, true);
	assert.strictEqual(scrapeCalls, 0);

	// 2. Throttled MutationObserver coalesces rapid DOM mutations
	const testRoot = document.createElement("div");
	document.body.appendChild(testRoot);
	const waitPromise = view.waitForAccurateDetails(window.location.href, 600, window.location.href);

	// Burst of 10 rapid mutations within a few ms
	for (let i = 0; i < 10; i++) {
		const span = document.createElement("span");
		span.textContent = `mut-${i}`;
		testRoot.appendChild(span);
	}
	await new Promise((r) => setTimeout(r, 20));
	const callsAfterBurst = scrapeCalls;
	assert.ok(
		callsAfterBurst <= 3,
		`Expected throttled scrapePageDetails calls <= 3 after burst, got ${callsAfterBurst}`,
	);

	// Now simulate the real title appearing
	mockDetails = { url: window.location.href, title: "Final Video Title", isProvisional: false, fingerprint: "fp-1" };
	const finalSpan = document.createElement("span");
	finalSpan.textContent = "final";
	testRoot.appendChild(finalSpan);

	const resolved = await waitPromise;
	assert.strictEqual(resolved.title, "Final Video Title");
	assert.strictEqual(resolved.isProvisional, false);

	// 3. Static-URL SPA fingerprint change resolves immediately
	mockDetails = { url: window.location.href, title: "Loading...", isProvisional: true, fingerprint: "ep-1" };
	const fpPromise = view.waitForAccurateDetails(window.location.href, 600, window.location.href);
	await new Promise((r) => setTimeout(r, 120));
	mockDetails = { url: window.location.href, title: "Episode 2", isProvisional: true, fingerprint: "ep-2" };
	const fpSpan = document.createElement("span");
	fpSpan.textContent = "ep2";
	testRoot.appendChild(fpSpan);
	const fpResolved = await fpPromise;
	assert.strictEqual(fpResolved.fingerprint, "ep-2");

	testRoot.remove();
	void scraper;
	console.log("  [OK] ControllerView.waitForAccurateDetails throttling & guards");
}

async function testMpvControllerInit() {
	console.log("Testing MpvController Initialization...");
	const controller = new MPV.MpvController();

	let registeredMessageListener = null;
	const origOnMessage = global.chrome.runtime.onMessage;
	global.chrome.runtime.onMessage = {
		addListener: (fn) => { registeredMessageListener = fn; },
		removeListener: (fn) => {
			if (registeredMessageListener === fn) registeredMessageListener = null;
		}
	};

	try {
		// Verify ping works BEFORE get_ui_preferences resolves
		let resolvePrefs = null;
		mockRuntimeSendMessageHook = (payload, callback) => {
			if (payload.action === "get_ui_preferences") {
				resolvePrefs = () => callback({ success: true, preferences: {} });
				return;
			}
			callback({ success: true, ...payload });
		};

		const initPromise = controller.init();
		assert.strictEqual(typeof registeredMessageListener, "function", "messageListener must be registered before get_ui_preferences resolves");

		let pingResponse = null;
		registeredMessageListener({ action: "ping" }, {}, (res) => { pingResponse = res; });
		assert.deepStrictEqual(pingResponse, { success: true }, "ping must succeed while get_ui_preferences is pending");

		resolvePrefs();
		mockRuntimeSendMessageHook = null;
		await initPromise;

		assert.ok(controller.bridge, "Bridge should be initialized");
		assert.ok(controller.state, "State should be initialized");

		// Verify Object.hasOwn guards on actionMap and interfaceMap
		let protoResp = "untouched";
		controller.handleMessage({ action: "toString" }, {}, (res) => { protoResp = res; });
		assert.strictEqual(protoResp, "untouched", "handleMessage must ignore Object.prototype properties");

		let sentViaBridge = null;
		const origBridgeSend = controller.bridge.send.bind(controller.bridge);
		controller.bridge.send = (action) => {
			sentViaBridge = action;
			return Promise.resolve({ success: true });
		};
		await controller.actions.sendCommandToBackground("toString", "Default");
		assert.strictEqual(sentViaBridge, "toString", "sendCommandToBackground must not treat Object.prototype keys as interfaceMap actions");
		controller.bridge.send = origBridgeSend;

		// Check if UI was actually injected into the real JSDOM document
		const host = document.getElementById("m3u8-controller-host");
		assert.ok(host, "UIManager should have injected the host element into JSDOM");

		// Verify detected_url_changed updates state without echoing report_detected_url
		const sentActions = [];
		const origBridgeSend2 = controller.bridge.send.bind(controller.bridge);
		controller.bridge.send = (action, ...rest) => {
			sentActions.push(action);
			return Promise.resolve({ success: true });
		};
		controller.tabId = 42;
		registeredMessageListener(
			{ action: "detected_url_changed", tabId: 42, url: "https://cdn.example/video.m3u8" },
			{},
			() => {},
		);
		assert.strictEqual(controller.state.state.detectedUrl, "https://cdn.example/video.m3u8");
		assert.strictEqual(
			sentActions.filter((a) => a === "report_detected_url").length,
			0,
			"detected_url_changed must not echo report_detected_url",
		);
		controller.bridge.send = origBridgeSend2;

		// Verify scrape_and_get_details forwards timeoutMs (defaulting to 1500)
		let passedTimeout = null;
		const origWait = controller.waitForAccurateDetails.bind(controller);
		controller.waitForAccurateDetails = async (url, timeoutMs) => {
			passedTimeout = timeoutMs;
			return { url, title: "T", isProvisional: false };
		};
		await new Promise((res) =>
			registeredMessageListener(
				{ action: "scrape_and_get_details", detectedUrl: "https://cdn.example/video.m3u8" },
				{},
				res,
			),
		);
		assert.strictEqual(passedTimeout, 1500);
		await new Promise((res) =>
			registeredMessageListener(
				{ action: "scrape_and_get_details", detectedUrl: "https://cdn.example/video.m3u8", timeoutMs: 1200 },
				{},
				res,
			),
		);
		assert.strictEqual(passedTimeout, 1200);
		controller.waitForAccurateDetails = origWait;

		controller.teardown();
		assert.strictEqual(registeredMessageListener, null, "teardown() must remove messageListener");
	} finally {
		mockRuntimeSendMessageHook = null;
		global.chrome.runtime.onMessage = origOnMessage;
	}
	console.log("  [OK] MpvController (Full Lifecycle & Ping Race)");
}

async function testDraggableComponent() {
	console.log("Testing Draggable Component (Movement threshold & click suppression)...");

	const container = document.createElement("div");
	const handle = document.createElement("button");
	container.appendChild(handle);
	document.body.appendChild(container);

	let dragEndCalled = false;
	let dragEndPos = null;
	const draggable = new MPV.Draggable(container, handle, {
		dragButton: 0,
		onDragEnd: (e, pos) => {
			dragEndCalled = true;
			dragEndPos = pos;
		}
	});

	// 1. Click without moving (< 3px): should NOT trigger dragEnd
	handle.dispatchEvent(new window.MouseEvent("mousedown", { button: 0, clientX: 100, clientY: 100 }));
	document.dispatchEvent(new window.MouseEvent("mousemove", { clientX: 101, clientY: 101 }));
	document.dispatchEvent(new window.MouseEvent("mouseup", { clientX: 101, clientY: 101 }));
	assert.strictEqual(dragEndCalled, false, "Clicking with < 3px movement should not trigger onDragEnd");

	// Click event should fire normally without being suppressed
	let clickFired = false;
	const onClick = () => { clickFired = true; };
	handle.addEventListener("click", onClick);
	handle.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
	assert.strictEqual(clickFired, true, "Click event without drag should fire");
	handle.removeEventListener("click", onClick);

	// 2. Drag with movement (> 3px): should trigger dragEnd and suppress click
	let suppressedClickFired = false;
	const onSuppressedClick = () => { suppressedClickFired = true; };
	handle.addEventListener("click", onSuppressedClick);

	handle.dispatchEvent(new window.MouseEvent("mousedown", { button: 0, clientX: 100, clientY: 100 }));
	document.dispatchEvent(new window.MouseEvent("mousemove", { clientX: 150, clientY: 150 }));
	document.dispatchEvent(new window.MouseEvent("mouseup", { clientX: 150, clientY: 150 }));

	assert.strictEqual(dragEndCalled, true, "Dragging > 3px should trigger onDragEnd");
	assert.ok(dragEndPos, "onDragEnd should receive computed pos");

	// Dispatch click immediately after mouseup (as browser does)
	handle.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
	assert.strictEqual(suppressedClickFired, false, "Click event after drag should be suppressed");
	handle.removeEventListener("click", onSuppressedClick);

	draggable.destroy();
	container.remove();

	// 3. Right-click drag (dragButton: 2)
	const minContainer = document.createElement("div");
	const minHandle = document.createElement("button");
	minContainer.appendChild(minHandle);
	document.body.appendChild(minContainer);

	let rightDragEndCalled = false;
	const rightDraggable = new MPV.Draggable(minContainer, minHandle, {
		dragButton: 2,
		onDragEnd: () => { rightDragEndCalled = true; }
	});

	const cmEvent = new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
	minHandle.dispatchEvent(cmEvent);
	assert.strictEqual(cmEvent.defaultPrevented, true, "Context menu on right-click draggable should be prevented");

	minHandle.dispatchEvent(new window.MouseEvent("mousedown", { button: 2, clientX: 50, clientY: 50 }));
	document.dispatchEvent(new window.MouseEvent("mousemove", { clientX: 120, clientY: 80 }));
	document.dispatchEvent(new window.MouseEvent("mouseup", { button: 2, clientX: 120, clientY: 80 }));

	assert.strictEqual(rightDragEndCalled, true, "Right-click drag should trigger onDragEnd");

	let rightClickSuppressed = false;
	minHandle.addEventListener("click", () => { rightClickSuppressed = true; });
	minHandle.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
	assert.strictEqual(rightClickSuppressed, false, "Click after right-drag should be suppressed");

	rightDraggable.destroy();
	minContainer.remove();

	console.log("  [OK] Draggable (Threshold & Click Suppression)");
}

async function testNativeConnection() {
	console.log("Testing NativeConnection (Timeouts, Listener Isolation, LogBroadcaster)...");

	assert.strictEqual(typeof MPV.setLogBroadcaster, "function", "setLogBroadcaster must be exported");
	assert.strictEqual(typeof MPV.addNativeListener, "function", "addNativeListener must be exported");
	assert.strictEqual(typeof MPV.callNativeHost, "function", "callNativeHost must be exported");

	const origConnectNative = global.chrome.runtime.connectNative;
	const origSetTimeout = global.setTimeout;
	const origClearTimeout = global.clearTimeout;
	const origConsoleError = console.error;

	let activePort = null;
	let autoCompleteHandshake = false;
	const scheduledTimers = new Map();
	const clearedTimerIds = new Set();
	let nextTimerId = 1;

	global.setTimeout = (fn, ms, ...args) => {
		const id = nextTimerId++;
		scheduledTimers.set(id, { fn, ms, args });
		return id;
	};
	global.clearTimeout = (id) => {
		clearedTimerIds.add(id);
		scheduledTimers.delete(id);
	};

	global.chrome.runtime.connectNative = () => {
		const messageListeners = [];
		const disconnectListeners = [];
		let disconnected = false;
		activePort = {
			onMessage: { addListener: (cb) => messageListeners.push(cb) },
			onDisconnect: { addListener: (cb) => disconnectListeners.push(cb) },
			postMessage: (msg) => {
				if (autoCompleteHandshake && msg.action === "restore_session") {
					for (const cb of messageListeners) {
						cb({ request_id: msg.request_id, action: "session_restored", success: true });
					}
				}
			},
			disconnect: () => {
				disconnected = true;
			},
			isDisconnected: () => disconnected,
			emitMessage: (payload) => {
				for (const cb of messageListeners) cb(payload);
			},
			emitDisconnect: () => {
				for (const cb of disconnectListeners) cb();
			},
		};
		return activePort;
	};

	try {
		// 1. setLogBroadcaster injection & error isolation
		const capturedLogs = [];
		MPV.setLogBroadcaster((payload) => capturedLogs.push(payload));

		// 2. 30s handshake timeout cleanup
		autoCompleteHandshake = false;
		const handshakeFailPromise = MPV.callNativeHost({ action: "ping" }, true);
		const timedOutPort = activePort;
		const handshakeEntry = Array.from(scheduledTimers.entries()).find(([, t]) => t.ms === 30000);
		assert.ok(handshakeEntry, "Handshake should schedule a 30s timeout");
		const [handshakeTimerId, handshakeTimer] = handshakeEntry;
		scheduledTimers.delete(handshakeTimerId);
		handshakeTimer.fn(...handshakeTimer.args);

		assert.strictEqual(timedOutPort.isDisconnected(), true, "Timed-out port should be disconnected");
		await assert.rejects(
			handshakeFailPromise,
			/Native host handshake timed out after 30s/,
			"Handshake timeout should reject callNativeHost"
		);
		// Reset any background log_event connection attempt triggered by logger.error
		if (activePort && activePort !== timedOutPort) {
			activePort.emitDisconnect();
			await Promise.resolve();
		}
		assert.ok(
			capturedLogs.some((l) => l.text && l.text.includes("Establishing connection to native host")),
			"setLogBroadcaster should receive connection logs"
		);
		assert.ok(
			capturedLogs.some((l) => l.text && l.text.includes("Session restoration failed")),
			"setLogBroadcaster should receive handshake timeout error log"
		);

		// Verify throwing/null logBroadcaster does not break execution
		MPV.setLogBroadcaster(() => {
			throw new Error("broadcaster crash");
		});
		autoCompleteHandshake = true;

		// 3. 30s request timeout cleanup
		scheduledTimers.clear();
		clearedTimerIds.clear();
		const reqTimeoutPromise = MPV.callNativeHost({ action: "get_status" }, true);
		// Allow microtasks for connectToNativeHost() to resolve and schedule request timer
		await Promise.resolve();
		await Promise.resolve();

		const reqEntry = Array.from(scheduledTimers.entries()).find(([, t]) => t.ms === 30000);
		assert.ok(reqEntry, "callNativeHost should schedule a 30s request timeout");
		const [reqTimerId, reqTimer] = reqEntry;
		scheduledTimers.delete(reqTimerId);
		reqTimer.fn(...reqTimer.args);

		await assert.rejects(
			reqTimeoutPromise,
			/Native host request timed out after 30s \(get_status\)/,
			"Request timeout should reject with action name"
		);

		// 4. Throwing listener isolation in dispatchNativeEvent
		MPV.setLogBroadcaster(null);
		let throwingCalled = false;
		let healthyPayload = null;
		MPV.addNativeListener("task_update", () => {
			throwingCalled = true;
			throw new Error("listener boom");
		});
		MPV.addNativeListener("task_update", (data) => {
			healthyPayload = data;
		});

		console.error = () => {};
		activePort.emitMessage({ action: "task_update", task_id: "task-42" });
		console.error = origConsoleError;

		assert.strictEqual(throwingCalled, true, "Throwing listener should have been invoked");
		assert.ok(healthyPayload, "Healthy listener should still be invoked after throwing listener");
		assert.strictEqual(healthyPayload.taskId, "task-42", "Event payload keys should be normalized");

		// 5. session_restored does not leak stale isPaused across messages
		const restoredPayloads = [];
		MPV.addNativeListener("session_restored", (data) => {
			restoredPayloads.push(data);
		});
		activePort.emitMessage({ action: "session_restored", is_paused: true });
		activePort.emitMessage({ action: "session_restored" });
		assert.strictEqual(restoredPayloads.length, 2);
		assert.strictEqual(restoredPayloads[0].isPaused, true);
		assert.strictEqual(restoredPayloads[1].isPaused, undefined, "session_restored must not carry over stale isPaused when omitted");
	} finally {
		console.error = origConsoleError;
		global.chrome.runtime.connectNative = origConnectNative;
		global.setTimeout = origSetTimeout;
		global.clearTimeout = origClearTimeout;
		MPV.setLogBroadcaster(null);
	}

	console.log("  [OK] NativeConnection (Timeouts, Listener Isolation, LogBroadcaster)");
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
		testPageScraperProvisionalTitles();
		await testWaitForAccurateDetailsThrottlingAndGuards();
		await testMpvControllerInit();
		await testDraggableComponent();
		await testNativeConnection();
		console.log("\nALL MODULAR COMPONENT TESTS PASSED (JSDOM)! 📦✨");
	} catch (err) {
		console.error("\nTEST FAILED! ❌");
		console.error(err);
		process.exit(1);
	}
})();
