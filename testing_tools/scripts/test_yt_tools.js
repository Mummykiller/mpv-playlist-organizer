/**
 * Unit tests for Shinku's YouTube Tools sub-extension:
 * 1. yt-tools/yt_defaults.js
 * 2. yt-tools/yt_bridge.js
 * 3. yt-tools/yt_content.js
 * 4. background/yt_tools_service.js
 * 5. popup/popup_youtube.js
 */
const assert = require("node:assert").strict;
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "../..");

function createChromeMock(initialLocal = {}) {
	const localData = { ...initialLocal };
	const storageListeners = [];
	const runtimeListeners = [];
	const registeredScripts = [];

	return {
		localData,
		storageListeners,
		runtimeListeners,
		registeredScripts,
		chrome: {
			storage: {
				local: {
					async get(keys) {
						if (Array.isArray(keys)) {
							const out = {};
							for (const k of keys) {
								if (Object.prototype.hasOwnProperty.call(localData, k)) {
									out[k] = localData[k];
								}
							}
							return out;
						}
						if (typeof keys === "string") {
							return Object.prototype.hasOwnProperty.call(localData, keys)
								? { [keys]: localData[keys] }
								: {};
						}
						return { ...localData };
					},
					async set(obj) {
						const changes = {};
						for (const [k, v] of Object.entries(obj)) {
							changes[k] = { oldValue: localData[k], newValue: v };
							localData[k] = v;
						}
						for (const fn of storageListeners) {
							fn(changes, "local");
						}
					},
				},
				onChanged: {
					addListener(fn) {
						storageListeners.push(fn);
					},
				},
			},
			runtime: {
				onMessage: {
					addListener(fn) {
						runtimeListeners.push(fn);
					},
				},
				async sendMessage() {
					return { success: true };
				},
			},
			scripting: {
				async getRegisteredContentScripts({ ids } = {}) {
					if (!Array.isArray(ids)) return [...registeredScripts];
					return registeredScripts.filter((s) => ids.includes(s.id));
				},
				async registerContentScripts(scripts) {
					registeredScripts.push(...scripts);
				},
				async unregisterContentScripts({ ids } = {}) {
					for (let i = registeredScripts.length - 1; i >= 0; i--) {
						if (!ids || ids.includes(registeredScripts[i].id)) {
							registeredScripts.splice(i, 1);
						}
					}
				},
				async executeScript() {
					return [];
				},
			},
			tabs: {
				async query() {
					return [];
				},
				async sendMessage() {
					return { success: true };
				},
				create() {},
			},
		},
	};
}

function runScriptInDom(dom, relPath, extraGlobals = {}) {
	const code = fs.readFileSync(path.join(ROOT, relPath), "utf8");
	const ctx = dom.getInternalVMContext();
	Object.assign(ctx, extraGlobals);
	vm.runInContext(code, ctx, { filename: relPath });
}

async function testYtDefaults() {
	const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
		url: "https://www.youtube.com/",
		runScripts: "outside-only",
	});
	try {
		runScriptInDom(dom, "yt-tools/yt_defaults.js");
		const win = dom.window;
		assert.ok(win.SHINKU_YT_DEFAULTS, "SHINKU_YT_DEFAULTS should be defined");
		assert.ok(win.SHINKU_YT_DEFAULTS["frame-removal-settings"], "frame-removal-settings present");
		assert.strictEqual(win.SHINKU_YT_DEFAULTS["frame-removal-settings"]["playables-removal"], true);
		assert.ok(win.SHINKU_YT_DEFAULTS["distraction-settings"], "distraction-settings present");
		assert.strictEqual(win.SHINKU_YT_DEFAULTS["distraction-settings"]["distraction-master"], true);
		assert.ok(win.SHINKU_YT_DEFAULTS["video-player-settings"], "video-player-settings present");
		assert.ok(win.SHINKU_YT_DEFAULTS["thumbnail-title-settings"], "thumbnail-title-settings present");
		assert.strictEqual(win.SHINKU_YT_DEFAULTS["thumbnail-title-settings"]["hover-preview-guard"], true);
		assert.strictEqual(win.SHINKU_YT_DEFAULTS["thumbnail-title-settings"]["hover-preview-delay"], 3);
		assert.ok(win.SHINKU_YT_DEFAULTS["playlist-manager"], "playlist-manager present");
		assert.ok(Array.isArray(win.SHINKU_YT_QUALITIES) && win.SHINKU_YT_QUALITIES.length > 0);
		assert.ok(Array.isArray(win.SHINKU_YT_SPEEDS) && win.SHINKU_YT_SPEEDS.length > 0);
		assert.ok(Array.isArray(win.SHINKU_YT_CODECS) && win.SHINKU_YT_CODECS.length > 0);
		assert.ok(Array.isArray(win.SHINKU_YT_UI_SCHEMA) && win.SHINKU_YT_UI_SCHEMA.length === 5);
	} finally {
		dom.window.close();
	}
}

async function testYtBridge() {
	const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
		url: "https://www.youtube.com/watch?v=abc12345678",
		runScripts: "outside-only",
	});
	const intervals = [];
	const timeouts = [];
	const mock = createChromeMock({
		shinkuExtensionSettings: {
			"video-player-settings": { pause: false },
		},
		shinkuLibrary: {
			abc12345678: { id: "abc12345678", videoId: "abc12345678", currentTime: 12 },
		},
	});

	const postedMessages = [];
	const origPostMessage = dom.window.postMessage.bind(dom.window);
	dom.window.postMessage = (msg, targetOrigin) => {
		postedMessages.push(msg);
		return origPostMessage(msg, targetOrigin);
	};

	const origSetInterval = dom.window.setInterval.bind(dom.window);
	const origClearInterval = dom.window.clearInterval.bind(dom.window);
	const origSetTimeout = dom.window.setTimeout.bind(dom.window);
	const origClearTimeout = dom.window.clearTimeout.bind(dom.window);

	dom.window.setInterval = (fn, ms, ...args) => {
		const id = origSetInterval(fn, ms, ...args);
		intervals.push(id);
		return id;
	};
	dom.window.setTimeout = (fn, ms, ...args) => {
		const id = origSetTimeout(fn, ms, ...args);
		timeouts.push(id);
		return id;
	};

	try {
		runScriptInDom(dom, "yt-tools/yt_defaults.js");
		runScriptInDom(dom, "yt-tools/yt_bridge.js", { chrome: mock.chrome });

		await new Promise((r) => origSetTimeout(r, 30));

		// Merged defaults should have been persisted
		assert.strictEqual(
			mock.localData.shinkuExtensionSettings["video-player-settings"].pause,
			false,
			"User override preserved"
		);
		assert.strictEqual(
			mock.localData.shinkuExtensionSettings["video-player-settings"]["quality-selection"],
			"hd1080",
			"Default key merged"
		);
		assert.ok(
			postedMessages.some((m) => m.type === "SHINKU__bridgeReady"),
			"Bridge announces readiness"
		);
		assert.ok(
			postedMessages.some((m) => m.type === "SHINKU__userSetting"),
			"Bridge posts initial settings"
		);

		// Request library
		dom.window.dispatchEvent(
			new dom.window.MessageEvent("message", {
				data: { type: "SHINKU__requestLibrary" },
				source: dom.window,
				origin: dom.window.location.origin,
			})
		);
		await new Promise((r) => origSetTimeout(r, 20));
		const libMsg = postedMessages.find((m) => m.type === "SHINKU__Library");
		assert.ok(libMsg && libMsg.data.abc12345678, "Bridge returns shinkuLibrary");

		// Save to library & remove
		dom.window.dispatchEvent(
			new dom.window.MessageEvent("message", {
				data: {
					type: "SHINKU__saveToLibrary",
					data: { videoId: "xyz98765432", entry: { title: "New Vid", currentTime: 5 } },
				},
				source: dom.window,
				origin: dom.window.location.origin,
			})
		);
		await new Promise((r) => origSetTimeout(r, 20));
		assert.strictEqual(mock.localData.shinkuLibrary.xyz98765432.title, "New Vid");

		// Runtime message shinku_yt_save_current_video
		let sentResp = null;
		for (const listener of mock.runtimeListeners) {
			listener({ action: "shinku_yt_save_current_video" }, {}, (r) => {
				sentResp = r;
			});
		}
		assert.strictEqual(sentResp?.success, true);
		assert.ok(postedMessages.some((m) => m.type === "SHINKU__saveCurrentVideo"));

		// Storage change forwarding
		await mock.chrome.storage.local.set({ shinkuYtToolsEnabled: false });
		assert.ok(postedMessages.some((m) => m.type === "SHINKU__toolsDisabled"));

		// SPA navigation to /live/<id>
		dom.reconfigure({ url: "https://www.youtube.com/live/liveVid12345" });
		dom.window.dispatchEvent(new dom.window.Event("yt-navigate-finish"));
		const navMsg = postedMessages.find((m) => m.type === "SHINKU__NEW_YOUTUBE_URL");
		assert.ok(navMsg, "SPA navigation posts SHINKU__NEW_YOUTUBE_URL");
		assert.strictEqual(navMsg.videoId, "liveVid12345");
	} finally {
		for (const id of intervals) origClearInterval(id);
		for (const id of timeouts) origClearTimeout(id);
		dom.window.close();
	}
}

async function testYtContentGuardsAndSchema() {
	const dom = new JSDOM(
		`<!DOCTYPE html><html><body>
			<div id="movie_player">
				<video class="html5-main-video"></video>
				<div class="ytp-right-controls"></div>
			</div>
			<h1 class="ytd-watch-metadata"><yt-formatted-string>Test Video Title</yt-formatted-string></h1>
			<ytd-watch-metadata><div id="channel-name"><a>Test Channel</a></div></ytd-watch-metadata>
		</body></html>`,
		{
			url: "https://www.youtube.com/live/live1234567",
			runScripts: "outside-only",
		}
	);

	const timeouts = [];
	const origSetTimeout = dom.window.setTimeout.bind(dom.window);
	const origClearTimeout = dom.window.clearTimeout.bind(dom.window);
	dom.window.setTimeout = (fn, ms, ...args) => {
		const id = origSetTimeout(fn, ms, ...args);
		timeouts.push(id);
		return id;
	};
	dom.window.requestAnimationFrame = () => 1;
	dom.window.cancelAnimationFrame = () => {};

	const postedMessages = [];
	const origPostMessage = dom.window.postMessage.bind(dom.window);
	dom.window.postMessage = (msg, targetOrigin) => {
		postedMessages.push(msg);
		return origPostMessage(msg, targetOrigin);
	};

	const player = dom.window.document.getElementById("movie_player");
	const video = dom.window.document.querySelector("video.html5-main-video");

	let currentPlayerVideoId = "staleOldId1";
	const qualityCalls = [];
	const seekCalls = [];
	let pauseCalled = false;

	player.getVideoData = () => ({ video_id: currentPlayerVideoId });
	player.setPlaybackQualityRange = (q) => qualityCalls.push(q);
	player.setPlaybackQuality = () => {};
	player.seekTo = (t) => seekCalls.push(t);
	player.pauseVideo = () => {
		pauseCalled = true;
	};
	player.getPlayerState = () => 1;

	Object.defineProperty(video, "readyState", { configurable: true, get: () => currentReadyState });
	Object.defineProperty(video, "duration", { configurable: true, get: () => 200 });
	Object.defineProperty(video, "currentTime", { configurable: true, get: () => 45, set: () => {} });
	Object.defineProperty(video, "paused", { configurable: true, get: () => false });
	let currentReadyState = 0;

	let assignedUrl = null;
	const locationProxy = new Proxy(
		{},
		{
			get(_target, prop) {
				if (prop === "assign") {
					return (u) => {
						assignedUrl = u;
					};
				}
				const val = Reflect.get(dom.window.location, prop, dom.window.location);
				return typeof val === "function" ? val.bind(dom.window.location) : val;
			},
		}
	);
	const windowProxy = new Proxy(dom.window, {
		get(target, prop) {
			if (prop === "location") return locationProxy;
			if (prop === "window" || prop === "globalThis" || prop === "self") return windowProxy;
			if (prop === "addEventListener") {
				return (type, fn, opts) => {
					if (type !== "message") return target.addEventListener(type, fn, opts);
					return target.addEventListener(
						type,
						(ev) => {
							const wrapped = new Proxy(ev, {
								get(t, p) {
									if (p === "source") return windowProxy;
									const v = Reflect.get(t, p, t);
									return typeof v === "function" ? v.bind(t) : v;
								},
							});
							return fn.call(windowProxy, wrapped);
						},
						opts
					);
				};
			}
			const val = Reflect.get(target, prop, target);
			return typeof val === "function" ? val.bind(target) : val;
		},
		set(target, prop, value) {
			return Reflect.set(target, prop, value, target);
		},
	});

	try {
		runScriptInDom(dom, "yt-tools/yt_defaults.js");
		const contentCode = fs.readFileSync(path.join(ROOT, "yt-tools/yt_content.js"), "utf8");
		const contentCtx = vm.createContext({
			window: windowProxy,
			globalThis: windowProxy,
			self: windowProxy,
			document: dom.window.document,
			URL: dom.window.URL,
			MutationObserver: dom.window.MutationObserver,
			setTimeout: dom.window.setTimeout,
			clearTimeout: dom.window.clearTimeout,
			requestAnimationFrame: dom.window.requestAnimationFrame,
			cancelAnimationFrame: dom.window.cancelAnimationFrame,
			console,
		});
		vm.runInContext(contentCode, contentCtx, { filename: "yt-tools/yt_content.js" });

		const defaults = dom.window.SHINKU_YT_DEFAULTS;
		// Send library with saved timestamp and multiple entries for sorting test
		dom.window.dispatchEvent(
			new dom.window.MessageEvent("message", {
				data: {
					type: "SHINKU__Library",
					data: {
						live1234567: { id: "live1234567", videoId: "live1234567", currentTime: 50, updatedAt: 2000 },
						olderVid001: { id: "olderVid001", videoId: "olderVid001", currentTime: 10, updatedAt: 1000 },
						newestVid02: { id: "newestVid02", videoId: "newestVid02", currentTime: 20, updatedAt: 3000 },
					},
				},
				source: dom.window,
				origin: dom.window.location.origin,
			})
		);

		// First userSetting triggers initWatchPage(0) while player.getVideoData().video_id is stale
		dom.window.dispatchEvent(
			new dom.window.MessageEvent("message", {
				data: { type: "SHINKU__userSetting", data: defaults },
				source: dom.window,
				origin: dom.window.location.origin,
			})
		);

		assert.strictEqual(qualityCalls.length, 0, "Stale player video_id must block applyQualityLock");
		assert.strictEqual(seekCalls.length, 0, "Stale player video_id must block applyFastResume");
		assert.strictEqual(pauseCalled, false, "Stale player video_id must block applyAutoPause");

		// Now player updates video_id, but readyState is still 0
		currentPlayerVideoId = "live1234567";
		await new Promise((r) => origSetTimeout(r, 270));
		assert.strictEqual(qualityCalls.length, 0, "readyState < 1 must defer applyQualityLock");
		assert.strictEqual(seekCalls.length, 0, "readyState < 1 must defer applyFastResume");
		assert.strictEqual(pauseCalled, false, "readyState < 1 must defer applyAutoPause");
		// /live/<id> isWatchPage() should have created the plus button
		assert.ok(
			dom.window.document.getElementById("Shinku-plus-button"),
			"isWatchPage() includes /live/<id> and renders bookmark button"
		);

		// Trigger loadedmetadata with readyState >= 1
		currentReadyState = 1;
		video.dispatchEvent(new dom.window.Event("loadedmetadata"));
		assert.deepStrictEqual(qualityCalls, ["hd1080"], "Quality lock applied once metadata ready");
		assert.deepStrictEqual(seekCalls, [50], "Fast resume applied once metadata ready");

		// Test bookmarkVideo() canonical schema
		dom.window.dispatchEvent(
			new dom.window.MessageEvent("message", {
				data: { type: "SHINKU__saveCurrentVideo" },
				source: dom.window,
				origin: dom.window.location.origin,
			})
		);
		const saveMsg = postedMessages.find((m) => m.type === "SHINKU__saveToLibrary");
		assert.ok(saveMsg && saveMsg.data && saveMsg.data.entry, "bookmarkVideo posts SHINKU__saveToLibrary");
		const entry = saveMsg.data.entry;
		assert.strictEqual(entry.id, "live1234567");
		assert.strictEqual(entry.videoId, "live1234567");
		assert.strictEqual(entry.title, "Test Video Title");
		assert.strictEqual(entry.channel, "Test Channel");
		assert.strictEqual(entry.uploader, "Test Channel");
		assert.strictEqual(entry.thumbnail, "https://i.ytimg.com/vi/live1234567/mqdefault.jpg");
		assert.strictEqual(entry.url, "https://www.youtube.com/live/live1234567");
		assert.strictEqual(entry.currentTime, 45);
		assert.strictEqual(entry.duration, 200);
		assert.strictEqual(typeof entry.updatedAt, "number");

		// Test decoupled auto-next (auto-update-library: false, auto-next: true) + updatedAt descending sort
		const customSettings = JSON.parse(JSON.stringify(defaults));
		customSettings["playlist-manager"]["auto-update-library"] = false;
		customSettings["playlist-manager"]["auto-next"] = true;
		dom.window.dispatchEvent(
			new dom.window.MessageEvent("message", {
				data: { type: "SHINKU__updateUserSetting", data: customSettings },
				source: dom.window,
				origin: dom.window.location.origin,
			})
		);

		video.dispatchEvent(new dom.window.Event("ended"));
		// Sorted descending by updatedAt: [live1234567 (just bookmarked -> newest), newestVid02 (3000), olderVid001 (1000)]
		// Next after live1234567 is newestVid02
		assert.strictEqual(
			assignedUrl,
			"https://www.youtube.com/watch?v=newestVid02",
			"handleVideoEnded picks next video sorted by updatedAt descending"
		);
	} finally {
		for (const id of timeouts) origClearTimeout(id);
		dom.window.close();
	}
}

async function testYtToolsService() {
	const mock = createChromeMock({ shinkuYtToolsEnabled: true });
	const origChrome = global.chrome;
	const origFetch = global.fetch;

	global.chrome = mock.chrome;
	global.fetch = async () => ({
		ok: true,
		async json() {
			return { title: "Fetched Title", author_name: "Fetched Channel" };
		},
	});

	try {
		const svc = await import(pathToFileURL(path.join(ROOT, "background/yt_tools_service.js")).href);

		// extractYouTubeVideoId
		assert.strictEqual(svc.extractYouTubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
		assert.strictEqual(svc.extractYouTubeVideoId("https://youtu.be/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
		assert.strictEqual(svc.extractYouTubeVideoId("https://www.youtube.com/shorts/shortId1234"), "shortId1234");
		assert.strictEqual(svc.extractYouTubeVideoId("https://www.youtube.com/live/liveId12345"), "liveId12345");
		assert.strictEqual(svc.extractYouTubeVideoId("https://example.com/watch?v=123"), null);

		// syncYtToolsRegistration scopes matches to youtube.com only
		const enabled = await svc.syncYtToolsRegistration();
		assert.strictEqual(enabled, true);
		assert.strictEqual(mock.registeredScripts.length, 2);
		for (const script of mock.registeredScripts) {
			assert.deepStrictEqual(script.matches, ["*://*.youtube.com/*"]);
		}

		// handleSaveYouTubeLinkToLibrary writes canonical superset schema
		const res = await svc.handleSaveYouTubeLinkToLibrary("https://www.youtube.com/watch?v=vid12345678", null);
		assert.deepStrictEqual(res, { success: true, videoId: "vid12345678" });
		const saved = mock.localData.shinkuLibrary.vid12345678;
		assert.strictEqual(saved.id, "vid12345678");
		assert.strictEqual(saved.videoId, "vid12345678");
		assert.strictEqual(saved.title, "Fetched Title");
		assert.strictEqual(saved.channel, "Fetched Channel");
		assert.strictEqual(saved.uploader, "Fetched Channel");
		assert.strictEqual(saved.thumbnail, "https://i.ytimg.com/vi/vid12345678/mqdefault.jpg");
		assert.strictEqual(saved.url, "https://www.youtube.com/watch?v=vid12345678");
		assert.strictEqual(saved.currentTime, 0);
		assert.strictEqual(saved.duration, 0);
		assert.strictEqual(typeof saved.updatedAt, "number");

		// syncTabActionIcon switches icon when yt-dominant-on-youtube is enabled
		const iconCalls = [];
		const titleCalls = [];
		mock.chrome.action = {
			async setIcon(arg) {
				iconCalls.push(arg);
			},
			async setTitle(arg) {
				titleCalls.push(arg);
			},
		};
		await mock.chrome.storage.local.set({
			shinkuExtensionSettings: {
				"playlist-manager": { "yt-dominant-on-youtube": true },
			},
		});
		await svc.syncTabActionIcon(42, "https://www.youtube.com/watch?v=abc");
		assert.strictEqual(iconCalls[0].tabId, 42);
		assert.strictEqual(iconCalls[0].path[16], "yt-tools/icons/icon16.png", "Uses YT icon on youtube.com when dominant");
		assert.strictEqual(titleCalls[0].title, "Shinku's YouTube Tools");

		await svc.syncTabActionIcon(43, "https://example.com/");
		assert.strictEqual(iconCalls[1].path[16], "images/icon16.png", "Uses MPV icon on non-YouTube pages");
		assert.strictEqual(titleCalls[1].title, "MPV Playlist Organizer");
	} finally {
		global.chrome = origChrome;
		global.fetch = origFetch;
	}
}

async function testPopupYoutube() {
	const dom = new JSDOM(
		`<!DOCTYPE html><html><body>
			<div id="popup-extension-tabs">
				<button class="ext-tab-btn active" data-ext-tab="mpv"></button>
				<button class="ext-tab-btn" data-ext-tab="yt"></button>
			</div>
			<span id="yt-tools-status-dot"></span>
			<div id="mini-controller-view"></div>
			<div id="folder-management-view"></div>
			<div id="youtube-tools-view" style="display:none">
				<input type="checkbox" id="yt-tools-master-enable" />
				<div id="yt-tools-disabled-notice"></div>
				<button class="yt-subview-btn active" data-yt-subview="library"></button>
				<button class="yt-subview-btn" data-yt-subview="settings"></button>
				<div id="yt-tools-library-panel">
					<div id="yt-library-list"></div>
					<div id="yt-library-empty"></div>
				</div>
				<div id="yt-tools-settings-panel" style="display:none">
					<div id="yt-video-player-settings"></div>
					<div id="yt-frame-removal-settings"></div>
					<div id="yt-playlist-manager-settings"></div>
				</div>
			</div>
		</body></html>`,
		{ url: "https://example.invalid/popup.html", runScripts: "outside-only" }
	);

	const origWindow = global.window;
	const origDocument = global.document;
	const origChrome = global.chrome;
	const origDefaults = global.SHINKU_YT_DEFAULTS;
	const origQualities = global.SHINKU_YT_QUALITIES;
	const origSchema = global.SHINKU_YT_UI_SCHEMA;

	const mock = createChromeMock({
		shinkuYtToolsEnabled: false,
		shinkuExtensionSettings: {
			"video-player-settings": {
				"video-settings": true,
				"seek-override": 10,
			},
		},
		shinkuLibrary: {},
	});

	let sendMessageResult = { success: false, error: "Bridge error" };
	mock.chrome.runtime.sendMessage = async () => sendMessageResult;

	global.window = dom.window;
	global.document = dom.window.document;
	global.chrome = mock.chrome;

	try {
		runScriptInDom(dom, "yt-tools/yt_defaults.js");
		global.SHINKU_YT_DEFAULTS = dom.window.SHINKU_YT_DEFAULTS;
		global.SHINKU_YT_QUALITIES = dom.window.SHINKU_YT_QUALITIES;
		// Test object-schema branch with groupId, controls, and masterKey
		global.SHINKU_YT_UI_SCHEMA = {
			"video-player-settings": {
				id: "video-player-settings",
				title: "Video Player Settings",
				masterKey: "video-settings",
				controls: [
					{ key: "seek-override", label: "Seek Seconds", type: "number", min: 1, max: 300 },
					{ key: "pause", label: "Auto-Pause", type: "toggle" },
				],
			},
		};

		const { createYouTubeToolsManager } = await import(
			pathToFileURL(path.join(ROOT, "popup/popup_youtube.js")).href
		);

		const statusCalls = [];
		const manager = createYouTubeToolsManager({
			showStatus: (msg, isErr) => statusCalls.push({ msg, isErr }),
		});
		await manager.initialize();

		const seekInput = document.getElementById("yt-setting-seek-override");
		assert.ok(seekInput, "Object-schema controls rendered");
		assert.ok(document.getElementById("yt-setting-video-settings"), "Object-schema masterKey auto-inserted");
		assert.strictEqual(seekInput.value, "10");

		// Clicking section header collapse button minimizes children without disabling master toggle
		const vpGroup = document.getElementById("yt-video-player-settings");
		const collapseBtn = vpGroup.querySelector(".yt-settings-collapse-btn");
		const childrenEl = vpGroup.querySelector(".yt-settings-children");
		assert.ok(collapseBtn && childrenEl, "Header collapse button and children container rendered");
		assert.strictEqual(childrenEl.classList.contains("collapsed"), false);
		collapseBtn.click();
		assert.strictEqual(childrenEl.classList.contains("collapsed"), true, "Header click minimizes section");
		assert.strictEqual(
			document.getElementById("yt-setting-video-settings").checked,
			true,
			"Minimizing section does not disable master toggle"
		);
		collapseBtn.click();
		assert.strictEqual(childrenEl.classList.contains("collapsed"), false, "Header click expands section again");

		// Empty number input restores previous value instead of saving 0
		seekInput.value = "";
		seekInput.dispatchEvent(new dom.window.Event("change"));
		assert.strictEqual(seekInput.value, "10", "Empty number input restores previous value");
		assert.strictEqual(
			mock.localData.shinkuExtensionSettings["video-player-settings"]["seek-override"],
			10,
			"Empty number input does not overwrite stored value with 0"
		);

		// Out-of-range number input clamps to max
		seekInput.value = "999";
		seekInput.dispatchEvent(new dom.window.Event("change"));
		assert.strictEqual(seekInput.value, "300", "Number input clamps to max");
		assert.strictEqual(mock.localData.shinkuExtensionSettings["video-player-settings"]["seek-override"], 300);

		// In-place storage.onChanged preserves DOM node identity and focus
		seekInput.focus();
		assert.strictEqual(document.activeElement, seekInput);
		seekInput.value = "42"; // user mid-edit value
		await mock.chrome.storage.local.set({
			shinkuExtensionSettings: {
				"video-player-settings": {
					"video-settings": true,
					"seek-override": 15,
					pause: false,
				},
			},
		});
		assert.strictEqual(
			document.getElementById("yt-setting-seek-override"),
			seekInput,
			"storage.onChanged updates in-place without recreating DOM nodes"
		);
		assert.strictEqual(seekInput.value, "42", "Focused input value preserved on storage.onChanged");
		assert.strictEqual(
			document.getElementById("yt-setting-pause").checked,
			false,
			"Unfocused control updated in-place on storage.onChanged"
		);

		// Master toggle reverts UI on set_yt_tools_enabled failure
		const masterCb = document.getElementById("yt-tools-master-enable");
		assert.strictEqual(masterCb.checked, false);
		masterCb.checked = true;
		masterCb.dispatchEvent(new dom.window.Event("change"));
		await new Promise((r) => setTimeout(r, 20));
		assert.strictEqual(masterCb.checked, false, "Master toggle reverted on failure");
		assert.ok(statusCalls.some((s) => s.isErr && s.msg.includes("Bridge error")));

		// Done subfolder: splits done videos, supports Clear Selected and Clear Folder
		await mock.chrome.storage.local.set({
			shinkuLibrary: {
				active1: { id: "active1", title: "Active Video", currentTime: 12, duration: 100, updatedAt: 300 },
				done1: { id: "done1", title: "Done One", currentTime: 90, duration: 90, done: true, doneAt: 200 },
				done2: { id: "done2", title: "Done Two", currentTime: 50, duration: 50, done: true, doneAt: 100 },
			},
		});

		const activeCards = document.querySelectorAll("#yt-library-list .yt-library-card");
		assert.strictEqual(activeCards.length, 1, "Active list only shows non-done videos");

		const doneFolder = document.getElementById("yt-library-done-folder");
		assert.ok(doneFolder && doneFolder.style.display !== "none", "Done subfolder is visible");
		assert.strictEqual(doneFolder.querySelector(".yt-done-folder-count").textContent, "2");

		// Expand Done subfolder
		doneFolder.querySelector(".yt-done-folder-header").click();
		const doneCheckboxes = doneFolder.querySelectorAll(".yt-done-select-checkbox");
		assert.strictEqual(doneCheckboxes.length, 2, "Done subfolder lists both done videos");

		const clearSelectedBtn = document.getElementById("yt-done-clear-selected");
		assert.strictEqual(clearSelectedBtn.disabled, true, "Clear Selected disabled when nothing selected");

		// Select first done video and clear selected
		doneCheckboxes[0].checked = true;
		doneCheckboxes[0].dispatchEvent(new dom.window.Event("change"));
		assert.strictEqual(clearSelectedBtn.disabled, false, "Clear Selected enabled when item selected");
		clearSelectedBtn.click();
		await new Promise((r) => setTimeout(r, 20));

		assert.strictEqual(mock.localData.shinkuLibrary.done1, undefined, "Selected done video removed");
		assert.ok(mock.localData.shinkuLibrary.done2, "Unselected done video preserved");
		assert.ok(mock.localData.shinkuLibrary.active1, "Active video preserved");

		// Clear entire Done folder
		document.getElementById("yt-done-clear-all").click();
		await new Promise((r) => setTimeout(r, 20));

		assert.strictEqual(mock.localData.shinkuLibrary.done2, undefined, "All done videos cleared");
		assert.ok(mock.localData.shinkuLibrary.active1, "Active video still preserved after Clear Folder");
		assert.strictEqual(doneFolder.style.display, "none", "Done subfolder hidden when empty");

		// Switching top-level tab & subview persists and restores on next initialize()
		manager.switchExtTab("yt");
		manager.switchSubview("settings");
		await new Promise((r) => setTimeout(r, 20));
		assert.strictEqual(mock.localData.popupActiveExtTab, "yt");
		assert.strictEqual(mock.localData.popupYtSubview, "settings");

		const manager2 = createYouTubeToolsManager({});
		await manager2.initialize();
		assert.strictEqual(manager2.getActiveExtTab(), "yt", "Restores last active top-level tab");
		assert.strictEqual(
			document.getElementById("yt-tools-settings-panel").style.display,
			"flex",
			"Restores last active YT subview"
		);

		// Dominant-on-YouTube setting overrides popupActiveExtTab="mpv" on YouTube tabs
		mock.localData.shinkuYtToolsEnabled = true;
		mock.localData.popupActiveExtTab = "mpv";
		mock.localData.shinkuExtensionSettings = {
			"playlist-manager": { "yt-dominant-on-youtube": true },
		};
		mock.chrome.tabs.query = async () => [{ id: 9, url: "https://www.youtube.com/watch?v=xyz" }];
		const manager3 = createYouTubeToolsManager({});
		await manager3.initialize();
		assert.strictEqual(
			manager3.getActiveExtTab(),
			"yt",
			"Opens YT tab automatically on YouTube when yt-dominant-on-youtube is enabled"
		);
	} finally {
		global.window = origWindow;
		global.document = origDocument;
		global.chrome = origChrome;
		global.SHINKU_YT_DEFAULTS = origDefaults;
		global.SHINKU_YT_QUALITIES = origQualities;
		global.SHINKU_YT_UI_SCHEMA = origSchema;
		dom.window.close();
	}
}

async function testYtFeedFilterAndHoverGuard() {
	const dom = new JSDOM(
		`<!DOCTYPE html><html><body>
			<div id="movie_player"><ytd-thumbnail><a id="thumbnail" href="/watch?v=main0001"></a></ytd-thumbnail></div>
			<ytd-rich-section-renderer id="playables-section">
				<ytd-rich-shelf-renderer><h2 id="title">YouTube Playables</h2></ytd-rich-shelf-renderer>
			</ytd-rich-section-renderer>
			<ytd-rich-item-renderer id="playable-card">
				<ytd-mini-game-card-view-model><a href="/playables/123">Game</a></ytd-mini-game-card-view-model>
			</ytd-rich-item-renderer>
			<grid-shelf-view-model id="shorts-grid-shelf">
				<yt-shelf-header-layout><h2>Shorts</h2></yt-shelf-header-layout>
			</grid-shelf-view-model>
			<yt-lockup-view-model id="lockup-live">
				<yt-thumbnail-view-model><yt-thumbnail-badge-view-model>LIVE</yt-thumbnail-badge-view-model></yt-thumbnail-view-model>
			</yt-lockup-view-model>
			<yt-lockup-view-model id="lockup-streamed">
				<yt-content-metadata-view-model>Streamed 2 days ago</yt-content-metadata-view-model>
			</yt-lockup-view-model>
			<yt-lockup-view-model id="lockup-normal">
				<a class="yt-lockup-view-model__content-image" href="/watch?v=normal01">
					<yt-thumbnail-view-model id="modern-thumb"><img alt="" /></yt-thumbnail-view-model>
				</a>
				<yt-content-metadata-view-model>10K views • 1 day ago</yt-content-metadata-view-model>
			</yt-lockup-view-model>
			<ytd-rich-item-renderer id="classic-normal">
				<ytd-thumbnail id="classic-thumb">
					<a id="thumbnail" href="/watch?v=classic1"></a>
				</ytd-thumbnail>
			</ytd-rich-item-renderer>
		</body></html>`,
		{
			url: "https://www.youtube.com/",
			runScripts: "outside-only",
		}
	);

	const timeouts = [];
	const origSetTimeout = dom.window.setTimeout.bind(dom.window);
	const origClearTimeout = dom.window.clearTimeout.bind(dom.window);
	dom.window.setTimeout = (fn, ms, ...args) => {
		const id = origSetTimeout(fn, ms, ...args);
		timeouts.push(id);
		return id;
	};
	dom.window.requestAnimationFrame = () => 1;
	dom.window.cancelAnimationFrame = () => {};

	const windowProxy = new Proxy(dom.window, {
		get(target, prop) {
			if (prop === "window" || prop === "globalThis" || prop === "self") return windowProxy;
			if (prop === "addEventListener") {
				return (type, fn, opts) => {
					if (type !== "message") return target.addEventListener(type, fn, opts);
					return target.addEventListener(
						type,
						(ev) => {
							const wrapped = new Proxy(ev, {
								get(t, p) {
									if (p === "source") return windowProxy;
									const v = Reflect.get(t, p, t);
									return typeof v === "function" ? v.bind(t) : v;
								},
							});
							return fn.call(windowProxy, wrapped);
						},
						opts
					);
				};
			}
			const val = Reflect.get(target, prop, target);
			return typeof val === "function" ? val.bind(target) : val;
		},
		set(target, prop, value) {
			return Reflect.set(target, prop, value, target);
		},
	});

	try {
		runScriptInDom(dom, "yt-tools/yt_defaults.js");
		const contentCode = fs.readFileSync(path.join(ROOT, "yt-tools/yt_content.js"), "utf8");
		const contentCtx = vm.createContext({
			window: windowProxy,
			globalThis: windowProxy,
			self: windowProxy,
			document: dom.window.document,
			URL: dom.window.URL,
			MutationObserver: dom.window.MutationObserver,
			setTimeout: dom.window.setTimeout,
			clearTimeout: dom.window.clearTimeout,
			requestAnimationFrame: dom.window.requestAnimationFrame,
			cancelAnimationFrame: dom.window.cancelAnimationFrame,
			console,
		});
		vm.runInContext(contentCode, contentCtx, { filename: "yt-tools/yt_content.js" });

		const settings = JSON.parse(JSON.stringify(dom.window.SHINKU_YT_DEFAULTS));
		settings["thumbnail-title-settings"]["hover-preview-delay"] = 0.05; // 50ms for fast test

		dom.window.dispatchEvent(
			new dom.window.MessageEvent("message", {
				data: { type: "SHINKU__userSetting", data: settings },
				source: dom.window,
				origin: dom.window.location.origin,
			})
		);

		const doc = dom.window.document;
		assert.strictEqual(doc.getElementById("playables-section").style.display, "none", "Playables shelf hidden");
		assert.strictEqual(doc.getElementById("playable-card").style.display, "none", "Playable card hidden");
		assert.strictEqual(doc.getElementById("shorts-grid-shelf").style.display, "none", "Grid Shorts shelf hidden");
		assert.strictEqual(doc.getElementById("lockup-live").style.display, "none", "Modern lockup live hidden");
		assert.strictEqual(doc.getElementById("lockup-streamed").style.display, "none", "Modern lockup streamed hidden");
		assert.strictEqual(doc.getElementById("lockup-normal").style.display, "", "Normal lockup remains visible");

		// Hover guard: must NOT attach inside #movie_player, MUST attach on normal thumbnails
		assert.strictEqual(
			doc.querySelectorAll("#movie_player .shinku-hover-shield").length,
			0,
			"Hover shield must not attach inside #movie_player"
		);
		const classicThumb = doc.getElementById("classic-thumb");
		const classicShield = classicThumb.querySelector(".shinku-hover-shield");
		assert.ok(classicShield, "Hover shield attached to classic ytd-thumbnail");
		assert.ok(doc.querySelector("#modern-thumb .shinku-hover-shield"), "Hover shield attached to yt-thumbnail-view-model");

		// Verify hover events are blocked from bubbling to classicThumb while locked
		let thumbMouseoverCount = 0;
		classicThumb.addEventListener("mouseover", () => {
			thumbMouseoverCount++;
		});
		classicShield.dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true }));
		assert.strictEqual(thumbMouseoverCount, 0, "mouseover blocked from reaching thumbnail while shield is active");

		// Leaving before delay cancels timer and keeps shield active
		classicShield.dispatchEvent(new dom.window.MouseEvent("mouseenter", { bubbles: false }));
		await new Promise((r) => origSetTimeout(r, 15));
		classicShield.dispatchEvent(new dom.window.MouseEvent("mouseleave", { bubbles: false }));
		await new Promise((r) => origSetTimeout(r, 60));
		assert.notStrictEqual(classicShield.style.display, "none", "Shield stays active if mouse leaves before delay");

		// Hovering for full delay unlocks shield and dispatches synthetic mouseover to underlying thumbnail
		classicShield.dispatchEvent(new dom.window.MouseEvent("mouseenter", { bubbles: false, clientX: 10, clientY: 20 }));
		await new Promise((r) => origSetTimeout(r, 80));
		assert.strictEqual(classicShield.style.display, "none", "Shield hidden after hover delay");
		assert.strictEqual(classicShield.style.pointerEvents, "none", "Shield pointerEvents disabled after hover delay");
		assert.ok(thumbMouseoverCount > 0, "Synthetic mouseover dispatched to thumbnail after delay");

		// Moving mouse elsewhere on the page restores the shield for future hovers
		doc.body.dispatchEvent(new dom.window.MouseEvent("mousemove", { bubbles: true }));
		assert.strictEqual(classicShield.style.display, "block", "Shield restored when pointer moves away");
		assert.strictEqual(classicShield.style.pointerEvents, "auto", "Shield pointerEvents restored when pointer moves away");

		// Turning off hover-preview-guard removes all shields
		settings["thumbnail-title-settings"]["hover-preview-guard"] = false;
		dom.window.dispatchEvent(
			new dom.window.MessageEvent("message", {
				data: { type: "SHINKU__updateUserSetting", data: settings },
				source: dom.window,
				origin: dom.window.location.origin,
			})
		);
		assert.strictEqual(doc.querySelectorAll(".shinku-hover-shield").length, 0, "All shields removed when disabled");
	} finally {
		for (const id of timeouts) origClearTimeout(id);
		dom.window.close();
	}
}

async function testYtExtendedSettingsFeatures() {
	const dom = new JSDOM(
		`<!DOCTYPE html><html><head></head><body>
			<a id="logo" href="/">YouTube</a>
			<ytd-watch-flexy></ytd-watch-flexy>
			<div id="movie_player">
				<video class="html5-main-video"></video>
				<button class="ytp-size-button"></button>
				<button class="ytp-autonav-toggle-button" aria-checked="true"></button>
				<div class="ytp-right-controls"></div>
			</div>
			<ytd-rich-item-renderer id="mix-card">
				<a href="/watch?v=mix1&start_radio=1">Mix</a>
			</ytd-rich-item-renderer>
			<ytd-rich-item-renderer id="members-card">
				<div class="badge-style-type-members-only">Members only</div>
			</ytd-rich-item-renderer>
			<ytd-backstage-post-thread-renderer id="post-card">Poll</ytd-backstage-post-thread-renderer>
			<ytd-shelf-renderer id="search-filler-shelf"><h2 id="title">People also watched</h2></ytd-shelf-renderer>
			<ytd-statement-banner-renderer id="news-banner">Breaking News</ytd-statement-banner-renderer>
			<ytd-rich-item-renderer id="watched-card">
				<ytd-thumbnail-overlay-resume-playback-renderer><div id="progress" style="width: 95%"></div></ytd-thumbnail-overlay-resume-playback-renderer>
			</ytd-rich-item-renderer>
			<ytd-rich-item-renderer id="keyword-card">
				<ytd-thumbnail id="kw-thumb">
					<a id="thumbnail" href="/watch?v=kw123456789&si=track123&pp=abc">
						<img id="kw-img" src="https://i.ytimg.com/vi/kw123456789/hqdefault.jpg" />
					</a>
				</ytd-thumbnail>
				<h3 id="video-title">INSANE Spoiler REVIEW!!!</h3>
			</ytd-rich-item-renderer>
		</body></html>`,
		{
			url: "https://www.youtube.com/watch?v=watch123456",
			runScripts: "outside-only",
		}
	);

	dom.window.requestAnimationFrame = () => 1;
	dom.window.cancelAnimationFrame = () => {};

	const postedMessages = [];
	const origPostMessage = dom.window.postMessage.bind(dom.window);
	dom.window.postMessage = (msg, targetOrigin) => {
		postedMessages.push(msg);
		return origPostMessage(msg, targetOrigin);
	};

	const player = dom.window.document.getElementById("movie_player");
	const video = dom.window.document.querySelector("video.html5-main-video");
	const sizeBtn = dom.window.document.querySelector(".ytp-size-button");
	const autonavBtn = dom.window.document.querySelector(".ytp-autonav-toggle-button");

	let rateSet = null;
	let theaterClicked = false;
	let autonavClicked = false;

	player.getVideoData = () => ({ video_id: "watch123456" });
	player.setPlaybackRate = (r) => {
		rateSet = r;
	};
	sizeBtn.addEventListener("click", () => {
		theaterClicked = true;
	});
	autonavBtn.addEventListener("click", () => {
		autonavClicked = true;
		autonavBtn.setAttribute("aria-checked", "false");
	});
	Object.defineProperty(video, "readyState", { configurable: true, get: () => 2 });
	Object.defineProperty(video, "duration", { configurable: true, get: () => 120 });

	const windowProxy = new Proxy(dom.window, {
		get(target, prop) {
			if (prop === "window" || prop === "globalThis" || prop === "self") return windowProxy;
			if (prop === "addEventListener") {
				return (type, fn, opts) => {
					if (type !== "message") return target.addEventListener(type, fn, opts);
					return target.addEventListener(
						type,
						(ev) =>
							fn.call(
								windowProxy,
								new Proxy(ev, {
									get(t, p) {
										if (p === "source") return windowProxy;
										const v = Reflect.get(t, p, t);
										return typeof v === "function" ? v.bind(t) : v;
									},
								})
							),
						opts
					);
				};
			}
			const val = Reflect.get(target, prop, target);
			return typeof val === "function" ? val.bind(target) : val;
		},
		set(target, prop, value) {
			return Reflect.set(target, prop, value, target);
		},
	});

	try {
		runScriptInDom(dom, "yt-tools/yt_defaults.js");
		const contentCode = fs.readFileSync(path.join(ROOT, "yt-tools/yt_content.js"), "utf8");
		const ctx = vm.createContext({
			window: windowProxy,
			globalThis: windowProxy,
			self: windowProxy,
			document: dom.window.document,
			URL: dom.window.URL,
			MutationObserver: dom.window.MutationObserver,
			setTimeout: dom.window.setTimeout,
			clearTimeout: dom.window.clearTimeout,
			requestAnimationFrame: dom.window.requestAnimationFrame,
			cancelAnimationFrame: dom.window.cancelAnimationFrame,
			console,
		});
		vm.runInContext(contentCode, ctx, { filename: "yt-tools/yt_content.js" });

		const settings = JSON.parse(JSON.stringify(dom.window.SHINKU_YT_DEFAULTS));
		settings["frame-removal-settings"]["mixes-removal"] = true;
		settings["frame-removal-settings"]["members-removal"] = true;
		settings["frame-removal-settings"]["posts-removal"] = true;
		settings["frame-removal-settings"]["watched-removal"] = true;
		settings["frame-removal-settings"]["search-filler-removal"] = true;
		settings["frame-removal-settings"]["news-movies-removal"] = true;
		settings["frame-removal-settings"]["blocked-keywords"] = "spoiler";
		settings["distraction-settings"]["hide-comments"] = true;
		settings["distraction-settings"]["hide-related-sidebar"] = true;
		settings["distraction-settings"]["redirect-home-to-subs"] = true;
		settings["video-player-settings"]["playback-speed"] = "1.5";
		settings["video-player-settings"]["auto-theater"] = true;
		settings["video-player-settings"]["disable-native-autoplay"] = true;
		settings["video-player-settings"]["disable-ambient-mode"] = true;
		settings["video-player-settings"]["cinema-mode"] = true;
		settings["video-player-settings"]["screenshot-btn"] = true;
		settings["video-player-settings"]["loop-btn"] = true;
		settings["video-player-settings"]["shift-scroll-speed"] = true;
		settings["video-player-settings"]["hide-endscreens"] = true;
		settings["thumbnail-title-settings"]["clean-clickbait-titles"] = true;
		settings["thumbnail-title-settings"]["still-frame-thumbnails"] = true;
		settings["thumbnail-title-settings"]["hide-social-counts"] = true;
		settings["thumbnail-title-settings"]["strip-tracking-params"] = true;
		settings["playlist-manager"]["thumbnail-bookmark-btn"] = true;

		dom.window.dispatchEvent(
			new dom.window.MessageEvent("message", {
				data: { type: "SHINKU__userSetting", data: settings },
				source: dom.window,
				origin: dom.window.location.origin,
			})
		);

		const doc = dom.window.document;
		assert.strictEqual(doc.getElementById("mix-card").style.display, "none", "Mix card hidden");
		assert.strictEqual(doc.getElementById("members-card").style.display, "none", "Members-only card hidden");
		assert.strictEqual(doc.getElementById("post-card").style.display, "none", "Community post hidden");
		assert.strictEqual(doc.getElementById("search-filler-shelf").style.display, "none", "Search filler shelf hidden");
		assert.strictEqual(doc.getElementById("news-banner").style.display, "none", "News banner hidden");
		assert.strictEqual(doc.getElementById("watched-card").style.display, "none", "90%+ watched card hidden");
		assert.strictEqual(doc.getElementById("keyword-card").style.display, "none", "Blocked keyword card hidden");

		assert.ok(doc.getElementById("shinku-distraction-style"), "Distraction stylesheet injected");
		assert.strictEqual(doc.getElementById("logo").getAttribute("href"), "/feed/subscriptions", "Logo redirected to subscriptions");

		assert.strictEqual(rateSet, 1.5, "Playback speed applied");
		assert.strictEqual(video.playbackRate, 1.5, "Video playbackRate set");
		assert.strictEqual(theaterClicked, true, "Auto-theater clicked size button");
		assert.strictEqual(autonavClicked, true, "Disable native autoplay clicked autonav button");
		assert.ok(doc.getElementById("shinku-hide-endscreens-style"), "Hide-endscreens style injected");
		assert.ok(doc.getElementById("shinku-player-comfort-style"), "Player comfort style injected");
		assert.ok(doc.getElementById("shinku-cinema-backdrop"), "Cinema backdrop injected");
		assert.ok(doc.getElementById("shinku-screenshot-button"), "Screenshot button injected");
		const loopBtn = doc.getElementById("shinku-loop-button");
		assert.ok(loopBtn, "Loop button injected");
		loopBtn.click();
		assert.strictEqual(video.loop, true, "Loop button toggles video.loop");

		// Shift + Wheel adjusts playback speed
		player.dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY: -100, shiftKey: true, bubbles: true, cancelable: true }));
		assert.strictEqual(video.playbackRate, 1.75, "Shift+scroll increases playbackRate");

		// Thumbnail, Title & Link transforms
		assert.strictEqual(doc.getElementById("video-title").textContent, "Insane Spoiler Review!", "Clickbait title cleaned");
		assert.strictEqual(
			doc.getElementById("kw-img").getAttribute("src"),
			"https://i.ytimg.com/vi/kw123456789/hq2.jpg",
			"Thumbnail replaced with video still"
		);
		assert.ok(!doc.getElementById("thumbnail").getAttribute("href").includes("si="), "Tracking params stripped");
		assert.ok(doc.getElementById("shinku-thumbnail-style"), "Thumbnail social-counts style injected");

		// Clearing blocked-keywords restores keyword-hidden item
		settings["frame-removal-settings"]["blocked-keywords"] = "";
		// Turning off overarching category masters cleanly disables everything inside each submenu
		settings["distraction-settings"]["distraction-master"] = false;
		settings["video-player-settings"]["video-settings"] = false;
		settings["thumbnail-title-settings"]["thumbnail-master"] = false;
		dom.window.dispatchEvent(
			new dom.window.MessageEvent("message", {
				data: { type: "SHINKU__updateUserSetting", data: settings },
				source: dom.window,
				origin: dom.window.location.origin,
			})
		);
		assert.strictEqual(doc.getElementById("keyword-card").style.display, "", "Keyword card restored when cleared");
		assert.strictEqual(doc.getElementById("shinku-distraction-style"), null, "Distraction style removed when master off");
		assert.strictEqual(doc.getElementById("logo").getAttribute("href"), "/", "Logo href restored when distraction master off");
		assert.strictEqual(doc.getElementById("shinku-cinema-backdrop"), null, "Cinema backdrop removed when player master off");
		assert.strictEqual(doc.getElementById("shinku-screenshot-button"), null, "Screenshot button removed when player master off");
		assert.strictEqual(doc.getElementById("shinku-loop-button"), null, "Loop button removed when player master off");
		assert.strictEqual(video.loop, false, "video.loop reset when player master off");
		assert.strictEqual(doc.getElementById("shinku-thumbnail-style"), null, "Thumbnail style removed when thumbnail master off");
		assert.strictEqual(doc.getElementById("video-title").textContent, "INSANE Spoiler REVIEW!!!", "Original title restored when thumbnail master off");
		assert.strictEqual(
			doc.getElementById("kw-img").getAttribute("src"),
			"https://i.ytimg.com/vi/kw123456789/hqdefault.jpg",
			"Original thumbnail src restored when thumbnail master off"
		);
		assert.ok(doc.getElementById("thumbnail").getAttribute("href").includes("si=track123"), "Original link restored when thumbnail master off");
		assert.strictEqual(doc.querySelectorAll(".shinku-hover-shield").length, 0, "Hover shields removed when thumbnail master off");

		// Thumbnail bookmark (+) button saves and removes video
		const thumbBtn = doc.querySelector("#kw-thumb .shinku-thumb-bookmark-btn");
		assert.ok(thumbBtn, "Thumbnail bookmark (+) button attached");
		assert.strictEqual(thumbBtn.textContent, "+");
		thumbBtn.click();
		assert.strictEqual(thumbBtn.textContent, "✓", "Clicking + marks video saved");
		assert.ok(
			postedMessages.some((m) => m.type === "SHINKU__saveToLibrary" && m.data?.videoId === "kw123456789"),
			"Posts SHINKU__saveToLibrary for thumbnail bookmark"
		);
		thumbBtn.click();
		assert.strictEqual(thumbBtn.textContent, "+", "Clicking ✓ removes video");
	} finally {
		dom.window.close();
	}
}

async function main() {
	await testYtDefaults();
	await testYtBridge();
	await testYtContentGuardsAndSchema();
	await testYtFeedFilterAndHoverGuard();
	await testYtExtendedSettingsFeatures();
	await testYtToolsService();
	await testPopupYoutube();
	console.log("All YouTube Tools unit tests passed!");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
