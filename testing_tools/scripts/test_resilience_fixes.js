/**
 * Unit tests for resilience and coverage fixes:
 * 1. SystemLogger._persist rejection safety
 * 2. PlaylistRenderer clipboard writeText rejection safety
 * 3. AniListUI.fetchReleases generation guard against stale out-of-order renders
 * 4. core_services.debouncedSyncToNativeHostFile retry alarm on immediate sync failure
 * 5. playback.js canonical folder ID & earlyClearsInProgress case normalization
 */
const assert = require("node:assert").strict;
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "../..");

async function testSystemLoggerPersistRejectionSafety() {
	global.navigator = { userAgent: "NodeJS-Test", platform: "Linux" };
	global.window = global.window || { MPV_INTERNAL: {} };
	global.window.MPV_INTERNAL = global.window.MPV_INTERNAL || {};

	// Silence console during test
	const origErr = console.error;
	console.error = () => {};
	try {
		require(path.join(ROOT, "utils/SystemLogger.js"));
		const { logger } = global.window.MPV_INTERNAL;

		let unhandled = false;
		const onUnhandled = () => { unhandled = true; };
		process.on("unhandledRejection", onUnhandled);

		const prevSender = logger.nativeSender;
		logger.isPersisting = false;
		logger.setNativeSender(() => Promise.reject(new Error("native bridge down")));
		logger._persist("ERROR", "Boom", "TestCtx", "");

		await new Promise((r) => setTimeout(r, 30));
		process.off("unhandledRejection", onUnhandled);
		logger.setNativeSender(prevSender);

		assert.strictEqual(unhandled, false, "SystemLogger._persist must not cause unhandledRejection");
		assert.strictEqual(logger.isPersisting, false, "SystemLogger.isPersisting must reset after rejection");
	} finally {
		console.error = origErr;
	}
}

async function testPlaylistRendererClipboardFailureSafety() {
	const dom = new JSDOM('<!DOCTYPE html><html><body><div id="list"></div></body></html>');
	global.window = dom.window;
	global.document = dom.window.document;
	global.Node = dom.window.Node;
	global.Element = dom.window.Element;
	global.navigator = {
		clipboard: {
			writeText: () => Promise.reject(new Error("Clipboard permission denied")),
		},
	};

	window.MPV_INTERNAL = window.MPV_INTERNAL || {};
	window.MPV_INTERNAL.logger = { debug: () => {} };
	require(path.join(ROOT, "utils/domUtils.js"));
	const { PlaylistRenderer } = await import(pathToFileURL(path.join(ROOT, "utils/PlaylistRenderer.js")).href);

	const container = document.getElementById("list");
	const renderer = new PlaylistRenderer(
		container,
		{ enableDblclickCopy: true },
		{}
	);

	let unhandled = false;
	const onUnhandled = () => { unhandled = true; };
	process.on("unhandledRejection", onUnhandled);

	renderer.render({
		playlist: [{ id: "ep1", title: "Episode 1", url: "https://example.com/1" }],
		isActive: false,
	});

	const titleSpan = container.querySelector(".list-item-title") || container.querySelector(".list-item");
	assert.ok(titleSpan, "Rendered item element should exist");
	titleSpan.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true }));

	await new Promise((r) => setTimeout(r, 30));
	process.off("unhandledRejection", onUnhandled);

	assert.strictEqual(unhandled, false, "Clipboard rejection in PlaylistRenderer must be caught");
}

async function testAniListUIFetchReleasesGenerationGuard() {
	const dom = new JSDOM(`<!DOCTYPE html><html><body>
		<div id="panel">
			<button id="btn-anilist-prev"></button>
			<button id="btn-anilist-next"></button>
			<button id="btn-anilist-today">Today</button>
			<div id="anilist-releases-container"></div>
		</div>
	</body></html>`);
	global.window = dom.window;
	global.document = dom.window.document;
	window.MPV_INTERNAL = window.MPV_INTERNAL || {};

	const renderedCalls = [];
	let resolveFirst;
	let resolveSecond;
	let callCount = 0;

	window.MPV_INTERNAL.AniListRenderer = {
		fetchReleases: () => {
			callCount++;
			if (callCount === 1) {
				return new Promise((r) => { resolveFirst = r; });
			}
			return new Promise((r) => { resolveSecond = r; });
		},
		render: (_container, releases, daysOffset) => {
			renderedCalls.push({ releases, daysOffset });
		},
	};

	require(path.join(ROOT, "utils/AniListUI.js"));
	const ui = new window.MPV_INTERNAL.AniListUI(
		{ checkContext: () => true },
		{
			anilistPanelHost: document.getElementById("panel"),
			anilistShadowRoot: document,
			shadowRoot: document,
		}
	);

	const p1 = ui.fetchReleases(false, -1);
	const p2 = ui.fetchReleases(false, 1);

	// Resolve newer request first, then stale older request
	resolveSecond([{ title: "Newer" }]);
	await p2;
	resolveFirst([{ title: "Stale" }]);
	await p1;

	assert.strictEqual(renderedCalls.length, 1, "Only the latest fetchReleases generation should render");
	assert.deepStrictEqual(renderedCalls[0], { releases: [{ title: "Newer" }], daysOffset: 1 });
}

async function testCoreServicesRetryAlarmOnImmediateSyncFailure() {
	const alarmsCreated = [];
	const alarmsCleared = [];
	const storageMap = {};

	global.chrome = {
		runtime: {
			id: "test-ext-id",
			sendMessage: async () => ({}),
			onMessage: { addListener: () => {} },
			onConnect: { addListener: () => {} },
		},
		tabs: {
			query: async () => [],
		},
		storage: {
			local: {
				get: async (keys) => {
					if (typeof keys === "string") return { [keys]: storageMap[keys] };
					return { ...storageMap };
				},
				set: async (obj) => { Object.assign(storageMap, obj); },
				remove: async (k) => { delete storageMap[k]; },
			},
			session: {
				get: async () => ({}),
				set: async () => {},
				remove: async () => {},
			},
			onChanged: { addListener: () => {} },
		},
		alarms: {
			create: (name, opts) => { alarmsCreated.push({ name, opts }); },
			clear: (name) => { alarmsCleared.push(name); },
		},
	};

	const origErr = console.error;
	console.error = () => {};
	try {
		const { nativeLink } = await import(pathToFileURL(path.join(ROOT, "utils/nativeLink.js")).href);
		const origSyncToFile = nativeLink.syncToFile.bind(nativeLink);
		nativeLink.syncToFile = async () => {
			throw new Error("Simulated native host disconnect");
		};

		const coreServices = await import(pathToFileURL(path.join(ROOT, "background/core_services.js")).href);
		coreServices.debouncedSyncToNativeHostFile("Anime", true);

		// Wait for async sync queue & catch block
		await new Promise((r) => setTimeout(r, 40));
		nativeLink.syncToFile = origSyncToFile;

		assert.strictEqual(
			alarmsCreated.some((a) => a.name === "sync-to-native-host"),
			true,
			"Failed immediate sync must schedule sync-to-native-host retry alarm"
		);
	} finally {
		console.error = origErr;
	}
}

async function testPlaybackCanonicalFolderAndEarlyClearCasing() {
	const storageData = {
		folders: {
			Anime: {
				name: "Anime",
				playlist: [{ id: "item1", title: "Ep 1", url: "https://example.com/ep1" }],
			},
		},
		settings: {
			uiPreferences: {
				global: {
					clearOnItemFinish: true,
					clearOnCompletion: "confirm",
				},
			},
		},
	};

	global.chrome = {
		...global.chrome,
		runtime: {
			id: "test-ext-id",
			sendMessage: async () => ({}),
			onMessage: { addListener: () => {} },
		},
		tabs: {
			query: async () => [],
		},
		storage: {
			local: {
				get: async (key) => (key === "mpv_playback_cache" ? { mpv_playback_cache: null } : {}),
				set: async () => {},
				remove: async () => {},
			},
			session: {
				get: async () => ({}),
				set: async () => {},
				remove: async () => {},
			},
			onChanged: { addListener: () => {} },
		},
	};

	const { storage } = await import(pathToFileURL(path.join(ROOT, "background/storage_instance.js")).href);
	storage.get = async () => storageData;
	storage.set = async () => {};

	const { playbackManager } = await import(pathToFileURL(path.join(ROOT, "background/playback_manager.js")).href);
	const playbackHandlers = await import(pathToFileURL(path.join(ROOT, "background/handlers/playback.js")).href);

	// 1. Trigger item_natural_completion with lowercase "anime" when folder is "Anime"
	await playbackHandlers.handleItemNaturalCompletion({
		folderId: "anime",
		itemId: "item1",
	});

	assert.strictEqual(
		playbackManager.earlyClearsInProgress.has("anime"),
		true,
		"earlyClearsInProgress should store normalized lowercase folderId"
	);

	// 2. Trigger mpv_exited with "Anime" (different casing) -> should find and clear it
	await playbackHandlers.handleMpvExited({
		folderId: "Anime",
		returnCode: 0,
	});

	assert.strictEqual(
		playbackManager.earlyClearsInProgress.has("anime"),
		false,
		"handleMpvExited should match and clear earlyClearsInProgress case-insensitively"
	);
}

async function testCrossSideMpvYouTubeRegressionFixes() {
	// 1. commUtils strict YouTube URL checks + /live/ + &si=/&pp= normalization
	const comm = await import(pathToFileURL(path.join(ROOT, "utils/commUtils.module.js")).href);
	assert.strictEqual(comm.isYouTubeUrl("https://notyoutube.com/watch?v=dQw4w9WgXcQ"), false);
	assert.strictEqual(comm.isYouTubeUrl("https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ"), false);
	assert.strictEqual(comm.isYouTubeUrl("https://www.youtube.com/live/dQw4w9WgXcQ"), true);
	assert.strictEqual(comm.getYoutubeId("https://www.youtube.com/live/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
	assert.strictEqual(comm.getYoutubeId("https://www.youtube.com/watch?prev=badbad12345&v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
	assert.strictEqual(
		comm.normalizeYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&si=track1&pp=abc&feature=share"),
		"https://www.youtube.com/watch?v=dQw4w9WgXcQ"
	);
	assert.strictEqual(
		comm.normalizeYouTubeUrl("https://www.youtube.com/live/dQw4w9WgXcQ?t=60&si=track9"),
		"https://www.youtube.com/live/dQw4w9WgXcQ"
	);

	// 2. ControllerView Shadow DOM editable guard & shinkuWheelKey guard
	const dom = new JSDOM('<!DOCTYPE html><html><body><div id="movie_player"></div><div id="host"></div></body></html>', {
		url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
	});
	global.window = dom.window;
	global.document = dom.window.document;
	window.MPV_INTERNAL = window.MPV_INTERNAL || {};
	require(path.join(ROOT, "utils/commUtils.js"));
	require(path.join(ROOT, "utils/ControllerView.js"));

	const sentCommands = [];
	const view = new window.MPV_INTERNAL.ControllerView({
		state: {
			state: {
				detectedUrl: null,
				kbAddPlaylist: "Shift+A",
				kbSwitchPlaylist: "Shift+Tab",
				kbToggleController: "ArrowUp",
			},
		},
		ui: { shadowRoot: null },
		pageScraper: { scrapePageDetails: (u) => ({ url: u, title: "Scraped" }) },
		sendCommandToBackground: (action, fid, payload) => sentCommands.push({ action, fid, payload }),
		bridge: { send: (action) => sentCommands.push({ action }) },
	});

	const shadow = document.getElementById("host").attachShadow({ mode: "open" });
	const select = document.createElement("select");
	shadow.appendChild(select);
	select.focus();
	view.handleGlobalKeydown(new dom.window.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true, composed: true }));
	assert.strictEqual(sentCommands.length, 0, "handleGlobalKeydown must not fire inside Shadow DOM select");

	const player = document.getElementById("movie_player");
	player.dataset.shinkuWheelKey = "1";
	view.handleGlobalKeydown(new dom.window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
	delete player.dataset.shinkuWheelKey;
	assert.strictEqual(sentCommands.length, 0, "handleGlobalKeydown must ignore shinkuWheelKey synthetic events");
	assert.strictEqual(view.getEffectiveAddUrl(), "https://www.youtube.com/watch?v=dQw4w9WgXcQ");

	// 3. core_services cold-start pendingFullSync preservation
	let resolveGet;
	const sessionState = {
		mpv_pending_sync_state: { pendingFullSync: true, pendingSyncFolders: ["OldFolder"] },
	};
	global.chrome = {
		runtime: { id: "test-ext-id", sendMessage: async () => ({}), onMessage: { addListener: () => {} } },
		tabs: { query: async () => [] },
		storage: {
			local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
			session: {
				get: () => new Promise((r) => { resolveGet = () => r({ ...sessionState }); }),
				set: async (obj) => { Object.assign(sessionState, obj); },
				remove: async (k) => { delete sessionState[k]; },
			},
			onChanged: { addListener: () => {} },
		},
		alarms: { create: () => {}, clear: () => {} },
	};
	const coreServices = await import(`${pathToFileURL(path.join(ROOT, "background/core_services.js")).href}?coldstart=${Date.now()}`);
	coreServices.debouncedSyncToNativeHostFile("NewFolder", false);
	resolveGet();
	await new Promise((r) => setTimeout(r, 30));
	assert.strictEqual(sessionState.mpv_pending_sync_state.pendingFullSync, true, "Cold-start pendingFullSync preserved");
	assert.ok(sessionState.mpv_pending_sync_state.pendingSyncFolders.includes("OldFolder"));
	assert.ok(sessionState.mpv_pending_sync_state.pendingSyncFolders.includes("NewFolder"));
}

async function testSleepWakeStalePlaybackReconciliation() {
	const localStore = {
		mpv_playback_cache: {
			folderId: "Anime",
			isRunning: true,
			isLaunching: false,
			timestamp: Date.now() - 60000,
		},
		active_playback_state: {
			folderId: "Anime",
			isRunning: true,
			isLaunching: false,
			sessionIds: ["item1"],
		},
	};
	const sessionStore = {};
	const storageData = {
		folders: {
			Anime: {
				name: "Anime",
				playlist: [{ id: "item1", url: "https://example.com/1", title: "Ep 1" }],
			},
		},
		settings: { uiPreferences: { global: {} } },
	};

	global.chrome = {
		...global.chrome,
		runtime: {
			id: "test-ext-id",
			sendMessage: async () => ({}),
			onMessage: { addListener: () => {} },
		},
		tabs: {
			query: async () => [],
		},
		storage: {
			local: {
				get: async (keys) => {
					if (typeof keys === "string") return { [keys]: localStore[keys] };
					if (Array.isArray(keys)) {
						const out = {};
						for (const k of keys) out[k] = localStore[k];
						return out;
					}
					return { ...localStore };
				},
				set: async (obj) => {
					Object.assign(localStore, obj);
				},
				remove: async (key) => {
					delete localStore[key];
				},
			},
			session: {
				get: async () => ({ ...sessionStore }),
				set: async (obj) => {
					Object.assign(sessionStore, obj);
				},
				remove: async (key) => {
					delete sessionStore[key];
				},
			},
			onChanged: { addListener: () => {} },
		},
	};

	const { storage } = await import(pathToFileURL(path.join(ROOT, "background/storage_instance.js")).href);
	storage.get = async () => storageData;
	storage.set = async () => {};

	const { playbackManager } = await import(pathToFileURL(path.join(ROOT, "background/playback_manager.js")).href);
	const { nativeLink } = await import(pathToFileURL(path.join(ROOT, "utils/nativeLink.js")).href);
	const { getVisualPlaybackState } = await import(pathToFileURL(path.join(ROOT, "background/ui_broadcaster.js")).href);
	const playbackHandlers = await import(pathToFileURL(path.join(ROOT, "background/handlers/playback.js")).href);

	const origIsMpvRunning = nativeLink.isMpvRunning;
	const origGetPlaybackStatus = nativeLink.getPlaybackStatus;

	const seedStaleState = () => {
		localStore.mpv_playback_cache = {
			folderId: "Anime",
			isRunning: true,
			isLaunching: false,
			timestamp: Date.now() - 60000,
		};
		localStore.active_playback_state = {
			folderId: "Anime",
			isRunning: true,
			isLaunching: false,
			sessionIds: ["item1"],
		};
		playbackManager.syncCache = localStore.mpv_playback_cache;
		const session = playbackManager.getSession("Anime");
		session.isPlaying = true;
		return session;
	};

	try {
		// 1. handleSessionRestored with no active session must clear stale sleep/wake state
		const s1 = seedStaleState();
		await playbackHandlers.handleSessionRestored({ action: "session_restored", result: null });
		assert.strictEqual(s1.isPlaying, false, "handleSessionRestored(null) must clear session.isPlaying");
		assert.strictEqual(localStore.mpv_playback_cache, undefined, "handleSessionRestored(null) must remove stale mpv_playback_cache");
		assert.strictEqual(localStore.active_playback_state.isRunning, false, "handleSessionRestored(null) must clear active_playback_state.isRunning");

		// 2. getVisualPlaybackState must honor authoritative native isRunning:false over stale session.isPlaying
		const s2 = seedStaleState();
		nativeLink.getPlaybackStatus = async () => ({ success: true, isRunning: false, isPaused: false });
		const visual = await getVisualPlaybackState("Anime", storageData.folders.Anime.playlist);
		assert.strictEqual(visual.isActive, false, "getVisualPlaybackState must not override native isRunning:false with stale session");
		assert.strictEqual(s2.isPlaying, false, "getVisualPlaybackState must clear stale session.isPlaying");
		assert.strictEqual(localStore.mpv_playback_cache, undefined, "getVisualPlaybackState must clear stale mpv_playback_cache");

		// 3. handleIsMpvRunning must query native host instead of blindly returning stale cache
		const s3 = seedStaleState();
		let nativeQueried = false;
		nativeLink.isMpvRunning = async () => {
			nativeQueried = true;
			return { success: true, isRunning: false, folderId: null };
		};
		const runningRes = await playbackHandlers.handleIsMpvRunning({}, {});
		assert.strictEqual(nativeQueried, true, "handleIsMpvRunning must query nativeLink.isMpvRunning");
		assert.strictEqual(runningRes.isRunning, false, "handleIsMpvRunning must return false when native host says not running");
		assert.strictEqual(s3.isPlaying, false, "handleIsMpvRunning must clear stale session.isPlaying");
		assert.strictEqual(localStore.mpv_playback_cache, undefined, "handleIsMpvRunning must remove stale mpv_playback_cache");

		// 4. handlePlaybackHealthChanged("dead") must clear mpv_playback_cache and session.isPlaying
		const s4 = seedStaleState();
		await playbackHandlers.handlePlaybackHealthChanged({ folderId: "Anime", health: "dead" });
		assert.strictEqual(s4.isPlaying, false, "health=dead must clear session.isPlaying");
		assert.strictEqual(localStore.mpv_playback_cache, undefined, "health=dead must remove mpv_playback_cache");
		assert.strictEqual(localStore.active_playback_state.isRunning, false, "health=dead must set active_playback_state.isRunning=false");
	} finally {
		nativeLink.isMpvRunning = origIsMpvRunning;
		nativeLink.getPlaybackStatus = origGetPlaybackStatus;
	}
}

async function main() {
	await testSystemLoggerPersistRejectionSafety();
	await testPlaylistRendererClipboardFailureSafety();
	await testAniListUIFetchReleasesGenerationGuard();
	await testCoreServicesRetryAlarmOnImmediateSyncFailure();
	await testPlaybackCanonicalFolderAndEarlyClearCasing();
	await testCrossSideMpvYouTubeRegressionFixes();
	await testSleepWakeStalePlaybackReconciliation();
	console.log("All resilience fix tests passed!");
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error(err);
		process.exit(1);
	});
