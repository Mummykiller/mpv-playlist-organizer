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
					data: {
						videoId: "xyz98765432",
						entry: {
							title: "New Vid",
							currentTime: 5,
							url: "https://www.youtube.com/watch?v=xyz98765432",
							thumbnail: "https://i.ytimg.com/vi/xyz98765432/mqdefault.jpg",
							evilInjected: "drop-me",
						},
					},
				},
				source: dom.window,
				origin: dom.window.location.origin,
			})
		);
		await new Promise((r) => origSetTimeout(r, 20));
		assert.strictEqual(mock.localData.shinkuLibrary.xyz98765432.title, "New Vid");
		assert.strictEqual(
			mock.localData.shinkuLibrary.xyz98765432.evilInjected,
			undefined,
			"handleSaveToLibrary must strip non-allowlisted fields"
		);

		// Reject invalid videoId and unsafe javascript: URLs
		dom.window.dispatchEvent(
			new dom.window.MessageEvent("message", {
				data: {
					type: "SHINKU__saveToLibrary",
					data: { videoId: "../bad id!", entry: { title: "Bad" } },
				},
				source: dom.window,
				origin: dom.window.location.origin,
			})
		);
		dom.window.dispatchEvent(
			new dom.window.MessageEvent("message", {
				data: {
					type: "SHINKU__saveToLibrary",
					data: {
						videoId: "safeVid1234",
						entry: {
							title: "Unsafe URL Test",
							url: "javascript:alert(1)",
							thumbnail: "data:text/html,<script>alert(1)</script>",
						},
					},
				},
				source: dom.window,
				origin: dom.window.location.origin,
			})
		);
		await new Promise((r) => origSetTimeout(r, 20));
		assert.strictEqual(
			mock.localData.shinkuLibrary["../bad id!"],
			undefined,
			"handleSaveToLibrary must reject invalid videoId"
		);
		assert.strictEqual(mock.localData.shinkuLibrary.safeVid1234.title, "Unsafe URL Test");
		assert.strictEqual(
			mock.localData.shinkuLibrary.safeVid1234.url,
			undefined,
			"handleSaveToLibrary must reject javascript: url"
		);
		assert.strictEqual(
			mock.localData.shinkuLibrary.safeVid1234.thumbnail,
			undefined,
			"handleSaveToLibrary must reject non-http(s) thumbnail"
		);

		// mergeSettingsWithDefaults must filter FORBIDDEN_KEYS at category and inner key levels
		const poisoned = JSON.parse(
			'{"__proto__":{"polluted":true},"constructor":{"bad":1},"video-player-settings":{"pause":true,"constructor":"evil","prototype":"evil"},"custom-cat":{"__proto__":{"x":1},"ok":1}}'
		);
		await mock.chrome.storage.local.set({ shinkuExtensionSettings: poisoned });
		await new Promise((r) => origSetTimeout(r, 20));
		const updateMsg = [...postedMessages].reverse().find((m) => m.type === "SHINKU__updateUserSetting");
		assert.ok(updateMsg, "Storage change forwards sanitized settings");
		assert.strictEqual(Object.prototype.hasOwnProperty.call(updateMsg.data, "__proto__"), false);
		assert.strictEqual(Object.prototype.hasOwnProperty.call(updateMsg.data, "constructor"), false);
		assert.strictEqual(
			Object.prototype.hasOwnProperty.call(updateMsg.data["video-player-settings"], "constructor"),
			false
		);
		assert.strictEqual(
			Object.prototype.hasOwnProperty.call(updateMsg.data["video-player-settings"], "prototype"),
			false
		);
		assert.strictEqual(
			Object.prototype.hasOwnProperty.call(updateMsg.data["custom-cat"], "__proto__"),
			false
		);
		assert.strictEqual(updateMsg.data["custom-cat"].ok, 1);
		assert.strictEqual(({}).polluted, undefined, "Object.prototype must not be polluted");

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

		// Dominant icon is gated on playlist-manager master switch
		await mock.chrome.storage.local.set({
			shinkuExtensionSettings: {
				"playlist-manager": { "playlist-manager": false, "yt-dominant-on-youtube": true },
			},
		});
		await svc.syncTabActionIcon(44, "https://www.youtube.com/watch?v=abc");
		assert.strictEqual(
			iconCalls[2].path[16],
			"images/icon16.png",
			"Uses MPV icon when playlist-manager master is disabled"
		);
		assert.strictEqual(titleCalls[2].title, "MPV Playlist Organizer");
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

		// Dominant-on-YouTube is gated on playlist-manager master switch
		mock.localData.popupActiveExtTab = "mpv";
		mock.localData.shinkuExtensionSettings = {
			"playlist-manager": { "playlist-manager": false, "yt-dominant-on-youtube": true },
		};
		const manager4 = createYouTubeToolsManager({});
		await manager4.initialize();
		assert.strictEqual(
			manager4.getActiveExtTab(),
			"mpv",
			"Does not switch to YT tab when playlist-manager master is disabled"
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
			<div id="movie_player">
				<video id="main-player-vid"></video>
				<ytd-thumbnail id="player-non-endscreen-thumb"><a id="thumbnail" href="/watch?v=main0001"></a></ytd-thumbnail>
				<div class="ytp-fullscreen-grid">
					<div class="ytp-fullscreen-grid-stills-container">
						<a id="modern-endscreen-still" class="ytp-modern-videowall-still" href="/watch?v=end00001">
							<div class="ytp-modern-videowall-still-image"></div>
						</a>
						<div id="nested-endscreen-still" class="ytp-modern-videowall-still">
							<a href="/watch?v=end00003">
								<yt-thumbnail-view-model id="endscreen-modern-thumb"></yt-thumbnail-view-model>
							</a>
						</div>
					</div>
				</div>
				<div class="html5-endscreen">
					<div class="ytp-endscreen-content">
						<a id="classic-endscreen-still" class="ytp-videowall-still" href="/watch?v=end00002">
							<div class="ytp-videowall-still-image"></div>
						</a>
					</div>
				</div>
			</div>
			<ytd-video-preview><video id="inline-preview-vid"></video></ytd-video-preview>
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

		// Hover guard: must NOT attach to non-endscreen thumbnails inside #movie_player, MUST attach on normal thumbnails
		assert.strictEqual(
			doc.querySelectorAll("#player-non-endscreen-thumb .shinku-hover-shield").length,
			0,
			"Hover shield must not attach to non-endscreen thumbnails inside #movie_player"
		);
		const classicThumb = doc.getElementById("classic-thumb");
		const classicShield = classicThumb.querySelector(".shinku-hover-shield");
		assert.ok(classicShield, "Hover shield attached to classic ytd-thumbnail");
		assert.ok(doc.querySelector("#modern-thumb .shinku-hover-shield"), "Hover shield attached to yt-thumbnail-view-model");
		assert.strictEqual(
			doc.documentElement.classList.contains("shinku-hover-guard-locked"),
			true,
			"Hover guard lock class is set on documentElement while locked"
		);
		assert.ok(doc.getElementById("shinku-hover-guard-style"), "Hover guard lock style tag injected");

		// Verify hover & pointer/mousemove events are blocked while locked (except active drag with buttons !== 0)
		let thumbMouseoverCount = 0;
		let thumbMoveCount = 0;
		classicThumb.addEventListener("mouseover", () => {
			thumbMouseoverCount++;
		});
		classicThumb.addEventListener("mousemove", () => {
			thumbMoveCount++;
		});
		classicThumb.addEventListener("pointermove", () => {
			thumbMoveCount++;
		});
		classicShield.dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true }));
		assert.strictEqual(thumbMouseoverCount, 0, "mouseover blocked from reaching thumbnail while shield is active");
		classicShield.dispatchEvent(new dom.window.MouseEvent("mousemove", { bubbles: true, buttons: 0 }));
		classicShield.dispatchEvent(new dom.window.MouseEvent("pointermove", { bubbles: true, buttons: 0 }));
		assert.strictEqual(thumbMoveCount, 0, "mousemove/pointermove blocked when buttons === 0");
		classicShield.dispatchEvent(new dom.window.MouseEvent("mousemove", { bubbles: true, buttons: 1 }));
		assert.strictEqual(thumbMoveCount, 1, "mousemove allowed through when dragging (buttons === 1)");

		// Inline preview video play is paused while locked, main #movie_player video is never paused
		const inlineVid = doc.getElementById("inline-preview-vid");
		const mainVid = doc.getElementById("main-player-vid");
		let inlinePaused = false;
		let inlinePauseCount = 0;
		let mainPaused = false;
		let mainPauseCount = 0;
		Object.defineProperty(inlineVid, "paused", { get: () => inlinePaused, configurable: true });
		inlineVid.pause = () => {
			inlinePaused = true;
			inlinePauseCount++;
		};
		Object.defineProperty(mainVid, "paused", { get: () => mainPaused, configurable: true });
		mainVid.pause = () => {
			mainPaused = true;
			mainPauseCount++;
		};
		inlineVid.dispatchEvent(new dom.window.Event("play"));
		assert.ok(inlinePauseCount >= 1 && inlinePaused, "Inline preview video paused while guard is locked");
		mainVid.dispatchEvent(new dom.window.Event("play"));
		assert.strictEqual(mainPauseCount, 0, "Main #movie_player video is never paused by hover guard");

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
		assert.strictEqual(
			doc.documentElement.classList.contains("shinku-hover-guard-locked"),
			false,
			"Hover guard lock class removed after delay unlocks shield"
		);
		inlinePaused = false;
		inlinePauseCount = 0;
		inlineVid.dispatchEvent(new dom.window.Event("play"));
		assert.strictEqual(inlinePauseCount, 0, "Inline preview video allowed to play after delay unlocks");

		// Moving mouse elsewhere on the page restores the shield and lock state for future hovers
		doc.body.dispatchEvent(new dom.window.MouseEvent("mousemove", { bubbles: true }));
		assert.strictEqual(classicShield.style.display, "block", "Shield restored when pointer moves away");
		assert.strictEqual(classicShield.style.pointerEvents, "auto", "Shield pointerEvents restored when pointer moves away");
		assert.strictEqual(
			doc.documentElement.classList.contains("shinku-hover-guard-locked"),
			true,
			"Hover guard lock class restored when pointer moves away"
		);
		inlinePaused = false;
		inlinePauseCount = 0;
		inlineVid.dispatchEvent(new dom.window.Event("play"));
		assert.ok(inlinePauseCount >= 1 && inlinePaused, "Inline preview video paused again once re-locked");

		// Empty string or null hover-preview-delay must fall back to 3000ms (never 0ms)
		for (const badDelay of ["", null]) {
			settings["thumbnail-title-settings"]["hover-preview-delay"] = badDelay;
			dom.window.dispatchEvent(
				new dom.window.MessageEvent("message", {
					data: { type: "SHINKU__updateUserSetting", data: settings },
					source: dom.window,
					origin: dom.window.location.origin,
				})
			);
			classicShield.dispatchEvent(new dom.window.MouseEvent("mouseenter", { bubbles: false, clientX: 10, clientY: 20 }));
			await new Promise((r) => origSetTimeout(r, 40));
			assert.notStrictEqual(
				classicShield.style.display,
				"none",
				`hover-preview-delay=${JSON.stringify(badDelay)} must not unlock immediately (3000ms fallback)`
			);
			classicShield.dispatchEvent(new dom.window.MouseEvent("mouseleave", { bubbles: false }));
		}

		// Updating hover-preview-delay to a longer duration (0.12s = 120ms) is respected dynamically
		settings["thumbnail-title-settings"]["hover-preview-delay"] = 0.12;
		dom.window.dispatchEvent(
			new dom.window.MessageEvent("message", {
				data: { type: "SHINKU__updateUserSetting", data: settings },
				source: dom.window,
				origin: dom.window.location.origin,
			})
		);
		classicShield.dispatchEvent(new dom.window.MouseEvent("mouseenter", { bubbles: false, clientX: 10, clientY: 20 }));
		await new Promise((r) => origSetTimeout(r, 60));
		assert.notStrictEqual(classicShield.style.display, "none", "Shield stays locked at 60ms when delay is 120ms");
		await new Promise((r) => origSetTimeout(r, 100));
		assert.strictEqual(classicShield.style.display, "none", "Shield unlocks after full 120ms delay");
		doc.body.dispatchEvent(new dom.window.MouseEvent("mousemove", { bubbles: true }));

		// Restore 50ms test delay for subsequent endscreen assertions
		settings["thumbnail-title-settings"]["hover-preview-delay"] = 0.05;
		dom.window.dispatchEvent(
			new dom.window.MessageEvent("message", {
				data: { type: "SHINKU__updateUserSetting", data: settings },
				source: dom.window,
				origin: dom.window.location.origin,
			})
		);

		// End-of-video recommendation tiles overlaid inside #movie_player MUST be shielded
		const modernEndscreenStill = doc.getElementById("modern-endscreen-still");
		const modernEndscreenShield = modernEndscreenStill.querySelector(".shinku-hover-shield");
		assert.ok(modernEndscreenShield, "Hover shield attached to .ytp-modern-videowall-still");
		assert.ok(modernEndscreenShield.closest("a[href]"), "Endscreen shield stays inside anchor link");
		assert.strictEqual(modernEndscreenShield.style.zIndex, "100", "Endscreen shield sits above inner tile layers");

		let modernEndscreenMouseovers = 0;
		modernEndscreenStill.addEventListener("mouseover", () => {
			modernEndscreenMouseovers++;
		});
		modernEndscreenShield.dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true }));
		assert.strictEqual(modernEndscreenMouseovers, 0, "mouseover blocked on modern endscreen still before delay");

		modernEndscreenShield.dispatchEvent(
			new dom.window.MouseEvent("mouseenter", { bubbles: false, clientX: 25, clientY: 35 })
		);
		await new Promise((r) => origSetTimeout(r, 80));
		assert.strictEqual(modernEndscreenShield.style.display, "none", "Endscreen shield unlocks after hover delay");
		assert.strictEqual(modernEndscreenMouseovers, 1, "Synthetic mouseover dispatched once to endscreen still");

		doc.body.dispatchEvent(new dom.window.MouseEvent("mousemove", { bubbles: true }));
		assert.strictEqual(modernEndscreenShield.style.display, "block", "Endscreen shield restored when pointer moves away");
		assert.strictEqual(modernEndscreenShield.style.pointerEvents, "auto", "Endscreen shield pointerEvents restored");

		// Classic .ytp-videowall-still must also be shielded and block mouseover
		const classicEndscreenStill = doc.getElementById("classic-endscreen-still");
		const classicEndscreenShield = classicEndscreenStill.querySelector(".shinku-hover-shield");
		assert.ok(classicEndscreenShield, "Hover shield attached to .ytp-videowall-still");
		let classicEndscreenMouseovers = 0;
		classicEndscreenStill.addEventListener("mouseover", () => {
			classicEndscreenMouseovers++;
		});
		classicEndscreenShield.dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true }));
		assert.strictEqual(classicEndscreenMouseovers, 0, "mouseover blocked on classic videowall still");

		// Nested endscreen container wraps yt-thumbnail-view-model without double-shielding
		const nestedEndscreenStill = doc.getElementById("nested-endscreen-still");
		assert.strictEqual(
			nestedEndscreenStill.querySelectorAll(".shinku-hover-shield").length,
			1,
			"Nested endscreen still gets exactly 1 shield"
		);
		assert.ok(
			doc.querySelector("#endscreen-modern-thumb .shinku-hover-shield"),
			"Shield attaches to inner yt-thumbnail-view-model inside nested endscreen still"
		);

		// Lazy on-demand shielding blocks hover immediately before MutationObserver debounce fires
		const stillsContainer = doc.querySelector(".ytp-fullscreen-grid-stills-container");
		const lazyStill = doc.createElement("a");
		lazyStill.id = "lazy-endscreen-still";
		lazyStill.className = "ytp-modern-videowall-still";
		lazyStill.setAttribute("href", "/watch?v=end00004");
		const lazyImg = doc.createElement("div");
		lazyImg.className = "ytp-modern-videowall-still-image";
		lazyStill.appendChild(lazyImg);
		stillsContainer.appendChild(lazyStill);

		let lazyMouseovers = 0;
		lazyStill.addEventListener("mouseover", () => {
			lazyMouseovers++;
		});
		lazyImg.dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true }));
		assert.ok(
			lazyStill.querySelector(".shinku-hover-shield"),
			"Lazy endscreen still shielded synchronously on first hover event"
		);
		assert.strictEqual(lazyMouseovers, 0, "First mouseover blocked synchronously on newly injected endscreen still");

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
		assert.strictEqual(
			doc.documentElement.classList.contains("shinku-hover-guard-locked"),
			false,
			"Hover guard lock class removed when disabled"
		);
		assert.strictEqual(
			doc.getElementById("shinku-hover-guard-style"),
			null,
			"Hover guard lock style removed when disabled"
		);
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

async function testYtAuditBugFixes() {
	const dom = new JSDOM(
		`<!DOCTYPE html><html><body>
			<ytd-watch-flexy id="watch-flexy">
				<div id="full-bleed-container"></div>
				<div id="player">
					<div id="movie_player"><video class="html5-main-video"></video></div>
				</div>
			</ytd-watch-flexy>
			<ytd-shelf-renderer id="mix-shelf">
				<h2 id="title">Recommended</h2>
				<ytd-video-renderer id="shelf-bad-video">
					<span id="video-title">Blocked Keyword Video</span>
				</ytd-video-renderer>
				<ytd-video-renderer id="shelf-good-video">
					<span id="video-title">Safe Video</span>
				</ytd-video-renderer>
			</ytd-shelf-renderer>
			<ytd-thumbnail>
				<img id="webp-thumb" src="https://i.ytimg.com/vi_webp/vid99999999/hq720.webp?sqp=123" />
			</ytd-thumbnail>
		</body></html>`,
		{
			url: "https://www.youtube.com/watch?v=audit12345",
			runScripts: "outside-only",
		}
	);
	try {
		const win = dom.window;
		const doc = win.document;
		win.innerWidth = 1280;
		win.innerHeight = 720;

		const playerEl = doc.getElementById("player");
		const fullBleedEl = doc.getElementById("full-bleed-container");
		const watchFlexy = doc.getElementById("watch-flexy");

		playerEl.getBoundingClientRect = () => ({
			left: 24,
			top: 56,
			right: 874,
			bottom: 536,
			width: 850,
			height: 480,
		});
		fullBleedEl.getBoundingClientRect = () => ({
			left: 0,
			top: 56,
			right: 1280,
			bottom: 656,
			width: 1280,
			height: 600,
		});

		runScriptInDom(dom, "yt-tools/yt_defaults.js");
		const contentCode = fs.readFileSync(path.join(ROOT, "yt-tools/yt_content.js"), "utf8");
		const windowProxy = new Proxy(win, {
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
		const ctx = vm.createContext({
			window: windowProxy,
			document: doc,
			location: win.location,
			Element: win.Element,
			HTMLElement: win.HTMLElement,
			Node: win.Node,
			Event: win.Event,
			MouseEvent: win.MouseEvent,
			KeyboardEvent: win.KeyboardEvent,
			WheelEvent: win.WheelEvent,
			MutationObserver: win.MutationObserver,
			URL: win.URL,
			setTimeout: win.setTimeout,
			clearTimeout: win.clearTimeout,
			requestAnimationFrame: win.requestAnimationFrame || (() => 0),
			cancelAnimationFrame: win.cancelAnimationFrame || (() => {}),
			console,
		});
		vm.runInContext(contentCode, ctx, { filename: "yt-tools/yt_content.js" });

		const settings = JSON.parse(JSON.stringify(win.SHINKU_YT_DEFAULTS));
		settings["frame-removal-settings"]["blocked-keywords"] = "blocked keyword";
		settings["distraction-settings"]["hide-ai-summaries"] = true;
		settings["video-player-settings"]["cinema-mode"] = true;
		settings["thumbnail-title-settings"]["still-frame-thumbnails"] = true;

		win.dispatchEvent(
			new win.MessageEvent("message", {
				data: { type: "SHINKU__userSetting", data: settings },
				source: win,
				origin: win.location.origin,
			})
		);

		// 1. Cinema mode uses high-z fixed backdrop with clip-path cutout and no player zIndex mutation
		const backdrop = doc.getElementById("shinku-cinema-backdrop");
		assert.ok(backdrop, "Cinema backdrop created");
		assert.strictEqual(backdrop.style.zIndex, "2147483645");
		assert.ok(
			backdrop.style.clipPath.includes("24px 56px, 874px 56px, 874px 536px, 24px 536px"),
			"Cinema backdrop cuts out normal player rect"
		);
		assert.strictEqual(playerEl.style.zIndex, "", "Does not mutate player container z-index");

		// Toggling theater attribute moves #movie_player into #full-bleed-container and updates cutout
		fullBleedEl.appendChild(doc.getElementById("movie_player"));
		watchFlexy.setAttribute("theater", "");
		await new Promise((r) => win.setTimeout(r, 20));
		assert.ok(
			backdrop.style.clipPath.includes("0px 56px, 1280px 56px, 1280px 656px, 0px 656px"),
			"Cinema backdrop updates cutout for #full-bleed-container in theater mode"
		);

		// 2. hide-ai-summaries scopes Ask button selector
		const distractionStyle = doc.getElementById("shinku-distraction-style");
		assert.ok(distractionStyle, "Distraction style injected");
		assert.ok(
			distractionStyle.textContent.includes('ytd-watch-metadata button[aria-label*="Ask" i]') &&
				distractionStyle.textContent.includes('#actions button[aria-label*="Ask" i]'),
			"Ask button selector is scoped to watch metadata/action bar"
		);
		assert.ok(
			!/,\s*button\[aria-label\*="Ask" i\]/.test(distractionStyle.textContent),
			"No unscoped global Ask button selector"
		);

		// 3. still-frame-thumbnails handles /vi_webp/ and hq720
		const webpThumb = doc.getElementById("webp-thumb");
		assert.strictEqual(
			webpThumb.getAttribute("src"),
			"https://i.ytimg.com/vi/vid99999999/hq2.jpg",
			"Rewrites /vi_webp/.../hq720.webp to hq2.jpg"
		);

		// 4. blocked-keywords hides matching video inside shelf without hiding the shelf container
		assert.strictEqual(
			doc.getElementById("shelf-bad-video").style.display,
			"none",
			"Matching video inside shelf is hidden"
		);
		assert.strictEqual(
			doc.getElementById("shelf-good-video").style.display,
			"",
			"Non-matching video inside shelf remains visible"
		);
		assert.strictEqual(
			doc.getElementById("mix-shelf").style.display,
			"",
			"Shelf container itself is not hidden by blocked-keywords"
		);

		// Disabling cinema-mode and still-frame-thumbnails restores DOM cleanly
		settings["video-player-settings"]["cinema-mode"] = false;
		settings["thumbnail-title-settings"]["still-frame-thumbnails"] = false;
		win.dispatchEvent(
			new win.MessageEvent("message", {
				data: { type: "SHINKU__updateUserSetting", data: settings },
				source: win,
				origin: win.location.origin,
			})
		);
		assert.strictEqual(doc.getElementById("shinku-cinema-backdrop"), null, "Cinema backdrop removed");
		assert.strictEqual(
			webpThumb.getAttribute("src"),
			"https://i.ytimg.com/vi_webp/vid99999999/hq720.webp?sqp=123",
			"Original webp thumbnail src restored"
		);
	} finally {
		dom.window.close();
	}
}

async function testYtIntegrationAndRegressionFixes() {
	// 1. Progress bar / status badge zero childList churn, Shadow DOM hijackedSeek, shinkuWheelKey,
	//    hover shield inside <a>, drag mousemove pass-through, recycled SPA cards, disable teardown
	const dom = new JSDOM(
		`<!DOCTYPE html><html><head></head><body>
			<div id="movie_player">
				<video class="html5-main-video"></video>
				<div class="ytp-right-controls"></div>
			</div>
			<div id="mpv-shadow-host"></div>
			<ytd-rich-item-renderer id="recycled-card">
				<ytd-thumbnail id="recycled-thumb">
					<a id="thumbnail" href="/watch?v=oldVid11111"></a>
				</ytd-thumbnail>
				<h3 id="video-title">OLD CLICKBAIT TITLE!!!</h3>
			</ytd-rich-item-renderer>
			<ytd-rich-item-renderer id="watched-streamed-card">
				<div id="metadata-line">Streamed 2 days ago</div>
				<div id="progress" style="width: 95%"></div>
			</ytd-rich-item-renderer>
			<tp-yt-paper-dialog id="hidden-idle-dialog" style="display: none;" aria-hidden="true">
				<span>Continue watching?</span>
				<button id="confirm-button">Yes</button>
			</tp-yt-paper-dialog>
		</body></html>`,
		{ url: "https://www.youtube.com/watch?v=watch000001", runScripts: "outside-only" }
	);

	const timeouts = [];
	const origSetTimeout = dom.window.setTimeout.bind(dom.window);
	const origClearTimeout = dom.window.clearTimeout.bind(dom.window);
	dom.window.setTimeout = (fn, ms, ...args) => {
		const id = origSetTimeout(fn, ms, ...args);
		timeouts.push(id);
		return id;
	};

	const rafQueue = [];
	dom.window.requestAnimationFrame = (cb) => {
		rafQueue.push(cb);
		return rafQueue.length;
	};
	dom.window.cancelAnimationFrame = () => {};

	try {
		const win = dom.window;
		const doc = win.document;
		const player = doc.getElementById("movie_player");
		const video = doc.querySelector("video.html5-main-video");

		let currentRate = 1;
		let playVideoCount = 0;
		let pauseVideoCount = 0;
		const seekCalls = [];
		const audioTrackCalls = [];
		let resumeCount = 0;
		let audioCtxState = "suspended";

		player.getVideoData = () => ({ video_id: "watch000001" });
		player.setPlaybackRate = (r) => { currentRate = r; };
		player.playVideo = () => { playVideoCount++; };
		player.pauseVideo = () => { pauseVideoCount++; };
		player.seekTo = (t) => seekCalls.push(t);
		player.getAvailableAudioTracks = () => [
			{ id: "en-dub", name: "English (auto-dubbed)", isDefault: true },
			{ id: "ja-orig", name: "Japanese (original)", isDefault: false },
		];
		player.setAudioTrack = (tr) => audioTrackCalls.push(tr);

		Object.defineProperty(video, "readyState", { configurable: true, get: () => 2 });
		Object.defineProperty(video, "duration", { configurable: true, get: () => 200 });
		let curTime = 50;
		Object.defineProperty(video, "currentTime", {
			configurable: true,
			get: () => curTime,
			set: (v) => { curTime = v; },
		});
		let isPaused = true;
		Object.defineProperty(video, "paused", { configurable: true, get: () => isPaused });

		let hiddenDialogClicks = 0;
		doc.getElementById("confirm-button").addEventListener("click", () => { hiddenDialogClicks++; });

		class FakeAudioContext {
			constructor() { this.state = audioCtxState; this.destination = {}; }
			createMediaElementSource() { return { connect: () => {} }; }
			createGain() { return { gain: { value: 1 }, connect: () => {} }; }
			async resume() { resumeCount++; audioCtxState = "running"; this.state = "running"; }
		}

		const postedMessages = [];
		const origPostMessage = win.postMessage.bind(win);
		win.postMessage = (msg, origin) => {
			postedMessages.push(msg);
			return origPostMessage(msg, origin);
		};

		let assignedUrl = null;
		const locationProxy = new Proxy({}, {
			get(_t, prop) {
				if (prop === "assign") return (u) => { assignedUrl = u; };
				const v = Reflect.get(win.location, prop, win.location);
				return typeof v === "function" ? v.bind(win.location) : v;
			},
		});

		const windowProxy = new Proxy(win, {
			get(target, prop) {
				if (prop === "location") return locationProxy;
				if (prop === "window" || prop === "globalThis" || prop === "self") return windowProxy;
				if (prop === "AudioContext") return FakeAudioContext;
				if (prop === "addEventListener") {
					return (type, fn, opts) => {
						if (type !== "message") return target.addEventListener(type, fn, opts);
						return target.addEventListener(type, (ev) => {
							const wrapped = new Proxy(ev, {
								get(t, p) {
									if (p === "source") return windowProxy;
									const v = Reflect.get(t, p, t);
									return typeof v === "function" ? v.bind(t) : v;
								},
							});
							return fn.call(windowProxy, wrapped);
						}, opts);
					};
				}
				const val = Reflect.get(target, prop, target);
				return typeof val === "function" ? val.bind(target) : val;
			},
			set(target, prop, value) {
				return Reflect.set(target, prop, value, target);
			},
		});

		runScriptInDom(dom, "yt-tools/yt_defaults.js");
		const contentCode = fs.readFileSync(path.join(ROOT, "yt-tools/yt_content.js"), "utf8");
		const ctx = vm.createContext({
			window: windowProxy,
			globalThis: windowProxy,
			self: windowProxy,
			document: doc,
			URL: win.URL,
			MutationObserver: win.MutationObserver,
			MouseEvent: win.MouseEvent,
			KeyboardEvent: win.KeyboardEvent,
			WheelEvent: win.WheelEvent,
			Event: win.Event,
			setTimeout: win.setTimeout,
			clearTimeout: win.clearTimeout,
			setInterval: win.setInterval,
			clearInterval: win.clearInterval,
			requestAnimationFrame: win.requestAnimationFrame,
			cancelAnimationFrame: win.cancelAnimationFrame,
			AudioContext: FakeAudioContext,
			console,
		});
		vm.runInContext(contentCode, ctx, { filename: "yt-tools/yt_content.js" });

		// Simulate bridge ready & library
		win.dispatchEvent(new win.MessageEvent("message", {
			data: { type: "SHINKU__bridgeReady" },
			source: win,
			origin: win.location.origin,
		}));
		win.dispatchEvent(new win.MessageEvent("message", {
			data: {
				type: "SHINKU__Library",
				data: {
					watch000001: { id: "watch000001", videoId: "watch000001", currentTime: 30, updatedAt: 2000 },
					nextVid0002: { id: "nextVid0002", videoId: "nextVid0002", currentTime: 10, updatedAt: 1000 },
				},
			},
			source: win,
			origin: win.location.origin,
		}));

		const settings = JSON.parse(JSON.stringify(win.SHINKU_YT_DEFAULTS));
		settings["frame-removal-settings"]["streamed-removal"] = false;
		settings["frame-removal-settings"]["watched-removal"] = true;
		settings["video-player-settings"]["playback-speed"] = "2";
		settings["video-player-settings"]["disable-auto-dubbing"] = true;
		settings["video-player-settings"]["volume-boost-enable"] = true;
		settings["video-player-settings"]["prevent-idle-pause"] = true;
		settings["thumbnail-title-settings"]["clean-clickbait-titles"] = true;
		settings["playlist-manager"]["auto-next"] = true;

		win.dispatchEvent(new win.MessageEvent("message", {
			data: { type: "SHINKU__userSetting", data: settings },
			source: win,
			origin: win.location.origin,
		}));

		// 1. Progress bar rAF should produce 0 childList mutations when timestamp unchanged
		let childListMutations = 0;
		const obs = new win.MutationObserver((recs) => {
			for (const r of recs) {
				if (r.type === "childList") childListMutations++;
			}
		});
		obs.observe(doc.documentElement, { childList: true, subtree: true });
		for (let i = 0; i < 5 && rafQueue.length > 0; i++) {
			rafQueue.shift()();
		}
		await new Promise((r) => origSetTimeout(r, 15));
		// First frame updates "00:00 / 00:00" -> "00:50 / 03:20", remaining 4 frames must emit 0 childList mutations
		assert.ok(childListMutations <= 1, `Expected <=1 childList mutation across 5 frames, got ${childListMutations}`);
		obs.disconnect();

		// 2. Hover shield mounted inside <a> on classic thumbnail + local stacking + drag mousemove pass-through
		const recycledThumb = doc.getElementById("recycled-thumb");
		const shield = recycledThumb.querySelector(".shinku-hover-shield");
		assert.ok(shield, "Hover shield attached");
		assert.ok(shield.closest("a[href]"), "Hover shield sits inside <a> so native link context menus work");
		assert.strictEqual(recycledThumb.style.isolation, "isolate", "Thumbnail creates isolated stacking context");
		assert.strictEqual(shield.style.zIndex, "20", "Shield uses local zIndex instead of 2147483646");

		let docMouseMoves = 0;
		doc.addEventListener("mousemove", () => { docMouseMoves++; });
		shield.dispatchEvent(new win.MouseEvent("mousemove", { bubbles: true, cancelable: true, buttons: 0 }));
		assert.strictEqual(docMouseMoves, 0, "Idle mousemove over shield is blocked while locked");
		shield.dispatchEvent(new win.MouseEvent("mousemove", { bubbles: true, cancelable: true, buttons: 1 }));
		assert.strictEqual(docMouseMoves, 1, "mousemove reaches document-level Draggable/Resizable over shield when dragging (buttons: 1)");
		doc.body.classList.add("mpv-controller-dragging");
		shield.dispatchEvent(new win.MouseEvent("mousemove", { bubbles: true, cancelable: true, buttons: 0 }));
		doc.body.classList.remove("mpv-controller-dragging");
		assert.strictEqual(docMouseMoves, 2, "mousemove reaches document-level Draggable/Resizable over shield when drag class active");

		// 3. Shadow DOM hijackedSeek does not steal ArrowRight from focused Shadow DOM <select>
		seekCalls.length = 0; // ignore initial applyFastResume seek to 30s
		const shadowHost = doc.getElementById("mpv-shadow-host");
		const shadow = shadowHost.attachShadow({ mode: "open" });
		const shadowSelect = doc.createElement("select");
		shadow.appendChild(shadowSelect);
		shadowSelect.focus();
		const arrowEv = new win.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true, composed: true });
		shadowSelect.dispatchEvent(arrowEv);
		assert.strictEqual(arrowEv.defaultPrevented, false, "hijackedSeek must not intercept Shadow DOM select");
		assert.strictEqual(seekCalls.length, 0, "YouTube video must not seek when Shadow DOM select focused");

		// 4. disable-auto-dubbing prefers 'original' track over isDefault dubbed track
		assert.strictEqual(audioTrackCalls[0]?.id, "ja-orig", "Auto-dubbing switch prefers original track");

		// 5. applyAutoPause does not burn flag when already paused
		assert.strictEqual(pauseVideoCount, 0, "Auto-pause does not fire while video is already paused");
		isPaused = false;
		video.dispatchEvent(new win.Event("play"));
		assert.strictEqual(pauseVideoCount, 1, "Auto-pause fires when playback actually starts");

		// 6. prevent-idle-pause ignores hidden dialog
		assert.strictEqual(hiddenDialogClicks, 0, "Hidden idle dialog must not be clicked");
		assert.strictEqual(playVideoCount, 0, "Hidden idle dialog must not call playVideo");

		// 7. classifyFeedItem lets watched-removal hide 95%-watched streamed item when streamed-removal is false
		assert.strictEqual(
			doc.getElementById("watched-streamed-card").style.display,
			"none",
			"watched-removal not shadowed when streamed-removal is disabled"
		);

		// 8. Recycled SPA card updates clean-clickbait-titles and thumbnail bookmark videoId
		doc.querySelector("#recycled-card #video-title").textContent = "BRAND NEW RECYCLED TITLE!!!";
		doc.querySelector("#recycled-thumb a").setAttribute("href", "/watch?v=newVid22222");
		settings["thumbnail-title-settings"]["hover-preview-guard"] = true;
		win.dispatchEvent(new win.MessageEvent("message", {
			data: { type: "SHINKU__updateUserSetting", data: settings },
			source: win,
			origin: win.location.origin,
		}));
		assert.strictEqual(
			doc.querySelector("#recycled-card #video-title").textContent,
			"Brand New Recycled Title!",
			"Recycled card updates clickbait title"
		);
		assert.strictEqual(
			doc.querySelector("#recycled-thumb .shinku-thumb-bookmark-btn").dataset.shinkuVideoId,
			"newVid22222",
			"Recycled card updates thumbnail bookmark videoId"
		);

		// 9. auto-next waits for SHINKU__saveToLibraryAck when bridgeConnected is true
		video.dispatchEvent(new win.Event("ended"));
		assert.strictEqual(assignedUrl, null, "auto-next waits for saveToLibraryAck before navigating");
		const endSaveMsg = postedMessages.filter((m) => m.type === "SHINKU__saveToLibrary").pop();
		assert.ok(endSaveMsg?.data?.saveId, "auto-next attaches saveId for ack");
		win.dispatchEvent(new win.MessageEvent("message", {
			data: { type: "SHINKU__saveToLibraryAck", data: { saveId: endSaveMsg.data.saveId } },
			source: win,
			origin: win.location.origin,
		}));
		assert.strictEqual(
			assignedUrl,
			"https://www.youtube.com/watch?v=nextVid0002",
			"auto-next navigates once saveToLibraryAck arrives"
		);

		// 10. volume-boost-enable resumes suspended AudioContext on play even after disable,
		//     and SHINKU__toolsDisabled resets playbackRate to 1
		assert.strictEqual(video.playbackRate, 2, "Playback speed set to 2x before disable");
		settings["video-player-settings"]["volume-boost-enable"] = false;
		win.dispatchEvent(new win.MessageEvent("message", {
			data: { type: "SHINKU__updateUserSetting", data: settings },
			source: win,
			origin: win.location.origin,
		}));
		video.dispatchEvent(new win.Event("play"));
		await new Promise((r) => origSetTimeout(r, 10));
		assert.ok(resumeCount >= 1, "Suspended AudioContext resumed even after volume boost disabled");

		const recycledTitleEl = doc.querySelector("#recycled-card #video-title");
		recycledTitleEl.textContent = "Fresh Video After Recycle";

		win.dispatchEvent(new win.MessageEvent("message", {
			data: { type: "SHINKU__toolsDisabled" },
			source: win,
			origin: win.location.origin,
		}));
		assert.strictEqual(video.playbackRate, 1, "SHINKU__toolsDisabled resets video.playbackRate to 1");
		assert.strictEqual(currentRate, 1, "SHINKU__toolsDisabled resets player playback rate to 1");
		assert.strictEqual(
			recycledTitleEl.textContent,
			"Fresh Video After Recycle",
			"Recycled title must not revert to stale original on disable"
		);
		assert.strictEqual(recycledTitleEl.hasAttribute("data-shinku-orig-title"), false);
		assert.strictEqual(recycledTitleEl.hasAttribute("data-shinku-cleaned-title"), false);

		const msgCountBeforeBridgeReady = postedMessages.length;
		win.dispatchEvent(new win.MessageEvent("message", {
			data: { type: "SHINKU__bridgeReady" },
			source: win,
			origin: win.location.origin,
		}));
		assert.ok(
			postedMessages.slice(msgCountBeforeBridgeReady).some((m) => m.type === "SHINKU__requestSettings"),
			"SHINKU__bridgeReady requests settings while disabled"
		);
		win.dispatchEvent(new win.MessageEvent("message", {
			data: { type: "SHINKU__NEW_YOUTUBE_URL", videoId: "watch000001" },
			source: win,
			origin: win.location.origin,
		}));
		assert.strictEqual(video.playbackRate, 1, "SHINKU__bridgeReady must not re-enable disabled tools");
	} finally {
		for (const id of timeouts) origClearTimeout(id);
		dom.window.close();
	}

	// 11. Security & serialization checks in yt_tools_service.js + popup_youtube.js
	const mock = createChromeMock({
		shinkuYtToolsEnabled: false,
		shinkuLibrary: [
			{ id: "done1", videoId: "done1", title: "Done Item", done: true, doneAt: 123, currentTime: 50, duration: 50 },
		],
	});
	const origChrome = global.chrome;
	const origFetch = global.fetch;
	global.chrome = mock.chrome;
	global.fetch = async () => ({
		ok: true,
		async json() { return { title: "Safe Title", author_name: "Author" }; },
	});
	try {
		const svc = await import(pathToFileURL(path.join(ROOT, "background/yt_tools_service.js")).href);
		assert.strictEqual(svc.extractYouTubeVideoId("https://notyoutube.com/watch?v=dQw4w9WgXcQ"), null);
		assert.strictEqual(svc.extractYouTubeVideoId("https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ"), null);
		assert.strictEqual(svc.extractYouTubeVideoId("ftp://youtube.com/watch?v=dQw4w9WgXcQ"), null);
		assert.strictEqual(svc.extractYouTubeVideoId("https://www.youtube.com/watch?v=__proto__"), null);
		assert.strictEqual(svc.extractYouTubeVideoId("https://youtu.be/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");

		// Rapid ON -> OFF toggle serialization leaves 0 scripts registered
		const pOn = svc.setYtToolsEnabled(true);
		const pOff = svc.setYtToolsEnabled(false);
		await Promise.all([pOn, pOff]);
		assert.strictEqual(mock.localData.shinkuYtToolsEnabled, false);
		assert.strictEqual(mock.registeredScripts.length, 0, "Serialized toggle leaves 0 scripts registered");

		// Re-saving a Done item resets done: false and normalizes array shinkuLibrary cleanly
		await svc.handleSaveYouTubeLinkToLibrary("https://www.youtube.com/watch?v=done1", null);
		assert.strictEqual(Array.isArray(mock.localData.shinkuLibrary), false);
		assert.strictEqual(mock.localData.shinkuLibrary.done1.done, false, "Re-save resets done flag");
		assert.strictEqual(mock.localData.shinkuLibrary.done1.doneAt, null, "Re-save resets doneAt");

		// Concurrent saves don't clobber each other
		await Promise.all([
			svc.handleSaveYouTubeLinkToLibrary("https://www.youtube.com/watch?v=concurA", null),
			svc.handleSaveYouTubeLinkToLibrary("https://www.youtube.com/watch?v=concurB", null),
		]);
		assert.ok(mock.localData.shinkuLibrary.concurA && mock.localData.shinkuLibrary.concurB, "Concurrent saves preserved");
	} finally {
		global.chrome = origChrome;
		global.fetch = origFetch;
	}

	// 12. popup_youtube.js dominance on non-YT tab, serialized saves/deletes, Infinity/blank library resilience
	const popupDom = new JSDOM(
		`<!DOCTYPE html><html><body>
			<div id="popup-extension-tabs">
				<button class="ext-tab-btn active" data-ext-tab="mpv"></button>
				<button class="ext-tab-btn" data-ext-tab="yt"></button>
			</div>
			<div id="mini-controller-view"></div>
			<div id="folder-management-view"></div>
			<div id="youtube-tools-view" style="display:none">
				<input type="checkbox" id="yt-tools-master-enable" />
				<div id="yt-tools-disabled-notice" style="display:none"></div>
				<div id="yt-tools-library-panel">
					<div id="yt-library-list"></div>
					<div id="yt-library-empty"></div>
				</div>
				<div id="yt-tools-settings-panel" style="display:none">
					<div id="yt-frame-removal-settings"></div>
					<div id="yt-playlist-manager-settings"></div>
				</div>
			</div>
		</body></html>`,
		{ url: "https://example.invalid/popup.html", runScripts: "outside-only" }
	);
	const origWin2 = global.window;
	const origDoc2 = global.document;
	const origChrome2 = global.chrome;
	const origDefaults2 = global.SHINKU_YT_DEFAULTS;
	const origQualities2 = global.SHINKU_YT_QUALITIES;
	const origSchema2 = global.SHINKU_YT_UI_SCHEMA;

	const popupMock = createChromeMock({
		shinkuYtToolsEnabled: true,
		popupActiveExtTab: "yt",
		shinkuExtensionSettings: {
			"playlist-manager": { "playlist-manager": true, "yt-dominant-on-youtube": true },
			"frame-removal-settings": { "frame-removal": true, "shorts-removal": true, "live-removal": true },
		},
		shinkuLibrary: {
			v1: { id: "v1", title: "Vid 1", currentTime: 10, duration: 100, updatedAt: 200 },
			v2: { id: "v2", title: "Vid 2", currentTime: "Infinity", duration: "Infinity", updatedAt: 100 },
			"": { title: "Blank Key" },
			arrBad: ["corrupt"],
		},
	});
	// Add artificial async storage delay to exercise races
	const origSet = popupMock.chrome.storage.local.set;
	popupMock.chrome.storage.local.set = async (obj) => {
		await new Promise((r) => setTimeout(r, 15));
		return origSet(obj);
	};
	popupMock.chrome.tabs.query = async () => [{ id: 1, url: "https://example.com/" }];

	global.window = popupDom.window;
	global.document = popupDom.window.document;
	global.chrome = popupMock.chrome;
	try {
		runScriptInDom(popupDom, "yt-tools/yt_defaults.js");
		global.SHINKU_YT_DEFAULTS = popupDom.window.SHINKU_YT_DEFAULTS;
		global.SHINKU_YT_QUALITIES = popupDom.window.SHINKU_YT_QUALITIES;
		global.SHINKU_YT_UI_SCHEMA = popupDom.window.SHINKU_YT_UI_SCHEMA;

		const { createYouTubeToolsManager } = await import(
			pathToFileURL(path.join(ROOT, "popup/popup_youtube.js")).href
		);
		const mgr = createYouTubeToolsManager({});
		await mgr.initialize();

		// Dominant mode on non-YouTube tab opens MPV instead of trapping on YT tab
		assert.strictEqual(mgr.getActiveExtTab(), "mpv", "Dominant mode defaults to mpv on non-YouTube pages");
		// Corrupted entries ("" key, array value) filtered out; Infinity rendered safely as 0:00
		const cards = popupDom.window.document.querySelectorAll("#yt-library-list .yt-library-card");
		assert.strictEqual(cards.length, 2, "Only valid object entries rendered");
		assert.ok(
			!popupDom.window.document.getElementById("yt-library-list").textContent.includes("Infinity"),
			"Non-finite timestamp does not render Infinity:NaN:NaN"
		);

		// Concurrent library removes serialize properly without resurrecting v1
		const removeBtns = popupDom.window.document.querySelectorAll(".yt-lib-remove-btn");
		removeBtns[0].click();
		removeBtns[1].click();
		await new Promise((r) => setTimeout(r, 80));
		assert.strictEqual(Object.keys(popupMock.localData.shinkuLibrary).includes("v1"), false, "v1 deleted");
		assert.strictEqual(Object.keys(popupMock.localData.shinkuLibrary).includes("v2"), false, "v2 deleted");

		// Rapid settings toggles serialize properly without dropping intermediate change
		const cbShorts = popupDom.window.document.getElementById("yt-setting-shorts-removal");
		const cbLive = popupDom.window.document.getElementById("yt-setting-live-removal");
		cbShorts.checked = false;
		cbShorts.dispatchEvent(new popupDom.window.Event("change"));
		cbLive.checked = false;
		cbLive.dispatchEvent(new popupDom.window.Event("change"));
		await new Promise((r) => setTimeout(r, 80));
		assert.strictEqual(popupMock.localData.shinkuExtensionSettings["frame-removal-settings"]["shorts-removal"], false);
		assert.strictEqual(popupMock.localData.shinkuExtensionSettings["frame-removal-settings"]["live-removal"], false);

		// Number input saves on "input" immediately without requiring blur/"change", and does not clobber mid-typing out-of-range values
		const delayInput = popupDom.window.document.getElementById("yt-setting-hover-preview-delay");
		const boostInput = popupDom.window.document.getElementById("yt-setting-volume-boost-level");
		assert.ok(delayInput && boostInput, "Number inputs for hover-preview-delay and volume-boost-level rendered");
		delayInput.value = "5";
		delayInput.dispatchEvent(new popupDom.window.Event("input"));
		await new Promise((r) => setTimeout(r, 80));
		assert.strictEqual(
			popupMock.localData.shinkuExtensionSettings["thumbnail-title-settings"]["hover-preview-delay"],
			5,
			"hover-preview-delay saved immediately on input without blur"
		);
		const prevBoost = popupMock.localData.shinkuExtensionSettings["video-player-settings"]["volume-boost-level"];
		boostInput.value = "1";
		boostInput.dispatchEvent(new popupDom.window.Event("input"));
		await new Promise((r) => setTimeout(r, 40));
		assert.strictEqual(boostInput.value, "1", "Out-of-range intermediate input value not overwritten during typing");
		assert.strictEqual(
			popupMock.localData.shinkuExtensionSettings["video-player-settings"]["volume-boost-level"],
			prevBoost,
			"Out-of-range intermediate input value not saved to storage"
		);
	} finally {
		global.window = origWin2;
		global.document = origDoc2;
		global.chrome = origChrome2;
		global.SHINKU_YT_DEFAULTS = origDefaults2;
		global.SHINKU_YT_QUALITIES = origQualities2;
		global.SHINKU_YT_UI_SCHEMA = origSchema2;
		popupDom.window.close();
	}
}

async function main() {
	await testYtDefaults();
	await testYtBridge();
	await testYtContentGuardsAndSchema();
	await testYtFeedFilterAndHoverGuard();
	await testYtExtendedSettingsFeatures();
	await testYtAuditBugFixes();
	await testYtToolsService();
	await testPopupYoutube();
	await testYtIntegrationAndRegressionFixes();
	console.log("All YouTube Tools unit tests passed!");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
