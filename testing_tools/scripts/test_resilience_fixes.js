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

async function main() {
	await testSystemLoggerPersistRejectionSafety();
	await testPlaylistRendererClipboardFailureSafety();
	await testAniListUIFetchReleasesGenerationGuard();
	await testCoreServicesRetryAlarmOnImmediateSyncFailure();
	await testPlaybackCanonicalFolderAndEarlyClearCasing();
	console.log("All resilience fix tests passed!");
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error(err);
		process.exit(1);
	});
