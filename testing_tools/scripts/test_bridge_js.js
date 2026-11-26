const assert = require("node:assert").strict;
const path = require("node:path");

/**
 * Mock Environment for loading the namespaced global files.
 */
global.window = { MPV_INTERNAL: {} };
global.chrome = { runtime: { id: "test" } };

// Load the generated commUtils.js
const commUtilsPath = path.join(__dirname, "../../utils/commUtils.js");
require(commUtilsPath);

const {
	normalizeKeys,
	isYouTubeUrl,
	getYoutubeId,
	normalizeYouTubeUrl,
	sanitizeString,
	isExtensionReloadError,
	debounce,
	DOMAIN_SPECIFIC_KEYS
} = global.window.MPV_INTERNAL;

async function runTests() {
	console.log("Running JS Normalization & Utility Tests (commUtils)...");

	// 1. snake_case to camelCase (Success Case)
	const pyMsg = {
		status: "success",
		payload: {
			action: "playback_status_changed",
			folder_id: "Default",
			is_paused: true,
			session_ids: ["1", "2"],
			// Verify Whitelist preservation
			request_id: "req_123",
			url: "https://example.com"
		}
	};

	const normalized = normalizeKeys(pyMsg);
	
	assert.strictEqual(normalized.status, "success");
	assert.strictEqual(normalized.payload.action, "playback_status_changed"); // Values remain snake_case
	assert.strictEqual(normalized.payload.folderId, "Default");
	assert.strictEqual(normalized.payload.isPaused, true);
	assert.deepStrictEqual(normalized.payload.sessionIds, ["1", "2"]);
	
	// Whitelist Check: request_id and url should remain as-is
	assert.strictEqual(normalized.payload.request_id, "req_123");
	assert.strictEqual(normalized.payload.url, "https://example.com");
	console.log("  [OK] snake_case -> camelCase");

	// 2. Nested objects, arrays, and primitive edge cases
	const nested = {
		top_level: {
			nested_key: [
				{ item_one: 1, m3u8: "stream.m3u8" },
				{ item_two: 2, mp4: "video.mp4" }
			],
			null_field: null,
			bool_flag: false,
			numeric_val: 42,
			kebab_case_test: "converted",
			"kebab-case-key": "also_converted"
		}
	};
	const normalizedNested = normalizeKeys(nested);
	assert.strictEqual(normalizedNested.topLevel.nestedKey[0].itemOne, 1);
	assert.strictEqual(normalizedNested.topLevel.nestedKey[0].m3u8, "stream.m3u8"); // Whitelisted
	assert.strictEqual(normalizedNested.topLevel.nestedKey[1].itemTwo, 2);
	assert.strictEqual(normalizedNested.topLevel.nestedKey[1].mp4, "video.mp4"); // Whitelisted
	assert.strictEqual(normalizedNested.topLevel.nullField, null);
	assert.strictEqual(normalizedNested.topLevel.boolFlag, false);
	assert.strictEqual(normalizedNested.topLevel.numericVal, 42);
	assert.strictEqual(normalizedNested.topLevel.kebabCaseKey, "also_converted");
	console.log("  [OK] Nested normalization with whitelists & primitives");

	// 3. Null, undefined, and non-object inputs
	assert.strictEqual(normalizeKeys(null), null);
	assert.strictEqual(normalizeKeys(undefined), undefined);
	assert.strictEqual(normalizeKeys("string_test"), "string_test");
	assert.strictEqual(normalizeKeys(123), 123);
	console.log("  [OK] Non-object input passthrough");

	// 4. YouTube URL Detection
	assert.strictEqual(isYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), true);
	assert.strictEqual(isYouTubeUrl("https://youtu.be/dQw4w9WgXcQ"), true);
	assert.strictEqual(isYouTubeUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ"), true);
	assert.strictEqual(isYouTubeUrl("https://vimeo.com/123456"), false);
	assert.strictEqual(isYouTubeUrl(""), false);
	assert.strictEqual(isYouTubeUrl(null), false);
	assert.strictEqual(isYouTubeUrl(undefined), false);
	console.log("  [OK] isYouTubeUrl detection");

	// 5. YouTube ID Extraction
	assert.strictEqual(getYoutubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
	assert.strictEqual(getYoutubeId("https://youtu.be/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
	assert.strictEqual(getYoutubeId("https://www.youtube.com/embed/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
	assert.strictEqual(getYoutubeId("https://www.youtube.com/shorts/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
	assert.strictEqual(getYoutubeId("https://www.youtube.com/playlist?list=PL12345ABCDE"), "PL12345ABCDE");
	assert.strictEqual(getYoutubeId("https://example.com/video.mp4"), null);
	assert.strictEqual(getYoutubeId(""), null);
	assert.strictEqual(getYoutubeId(null), null);
	console.log("  [OK] getYoutubeId extraction");

	// 6. YouTube URL Normalization (Timestamp and tracking removal)
	const rawYt = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&index=5&ab_channel=Artist&attr_tag=xyz";
	const cleanYt = normalizeYouTubeUrl(rawYt);
	assert.ok(!cleanYt.includes("t=42s"), "Timestamp 't' should be stripped");
	assert.ok(!cleanYt.includes("index=5"), "Parameter 'index' should be stripped");
	assert.ok(!cleanYt.includes("ab_channel"), "Parameter 'ab_channel' should be stripped");
	assert.ok(!cleanYt.includes("attr_tag"), "Parameter 'attr_tag' should be stripped");
	assert.ok(cleanYt.includes("v=dQw4w9WgXcQ"), "Video ID 'v' must be preserved");

	const rawShort = "https://youtu.be/dQw4w9WgXcQ?t=100&start=100";
	const cleanShort = normalizeYouTubeUrl(rawShort);
	assert.ok(!cleanShort.includes("t=100"));
	assert.ok(!cleanShort.includes("start=100"));

	// Non-YouTube URL remains untouched
	const nonYt = "https://example.com/stream?t=42";
	assert.strictEqual(normalizeYouTubeUrl(nonYt), nonYt);
	console.log("  [OK] normalizeYouTubeUrl tracking removal");

	// 7. String Sanitization
	// Title mode (isFilename = false): removes quotes and newlines, preserves colons/slashes
	const dirtyTitle = '  "My Favorite Video: Episode 1" `special` \n\t  ';
	const cleanTitle = sanitizeString(dirtyTitle, false);
	assert.strictEqual(cleanTitle, "My Favorite Video: Episode 1 special");

	// Filename mode (isFilename = true): strict filesystem filtering
	const dirtyFilename = '  My/Illegal:File*Name?"With<Special>Chars|And$Var;&`\n.mp4  ';
	const cleanFilename = sanitizeString(dirtyFilename, true);
	assert.strictEqual(cleanFilename, "MyIllegalFileNameWithSpecialCharsAndVar.mp4");
	console.log("  [OK] sanitizeString (title & filename modes)");

	// 8. Extension Reload Error Detection
	assert.strictEqual(isExtensionReloadError("Extension context invalidated."), true);
	assert.strictEqual(isExtensionReloadError("Error: Could not establish connection. Receiving end does not exist."), true);
	assert.strictEqual(isExtensionReloadError("The message channel closed before a response was received."), true);
	assert.strictEqual(isExtensionReloadError(new Error("Extension context invalidated.")), true);
	assert.strictEqual(isExtensionReloadError("SyntaxError: Unexpected token"), false);
	assert.strictEqual(isExtensionReloadError(null), false);
	console.log("  [OK] isExtensionReloadError detection");

	// 9. Domain-Specific Keys Contract
	assert.ok(Array.isArray(DOMAIN_SPECIFIC_KEYS), "DOMAIN_SPECIFIC_KEYS should be an array");
	assert.ok(DOMAIN_SPECIFIC_KEYS.includes("minimized"));
	assert.ok(DOMAIN_SPECIFIC_KEYS.includes("mode"));
	assert.ok(DOMAIN_SPECIFIC_KEYS.includes("position"));
	assert.ok(DOMAIN_SPECIFIC_KEYS.includes("pinned"));
	console.log("  [OK] DOMAIN_SPECIFIC_KEYS contract");

	// 10. Debounce utility
	let counter = 0;
	let lastArg = "";
	const debouncedFn = debounce((val) => {
		counter++;
		lastArg = val;
	}, 20);

	debouncedFn("call1");
	debouncedFn("call2");
	debouncedFn("call3");
	assert.strictEqual(counter, 0, "Debounced function should not execute immediately");

	await new Promise((r) => setTimeout(r, 40));
	assert.strictEqual(counter, 1, "Debounced function should execute exactly once");
	assert.strictEqual(lastArg, "call3", "Debounced function should receive the latest arguments");
	console.log("  [OK] debounce execution timing");

	// 11. StorageManager cache invalidation on write failure & withLock serialization
	const { pathToFileURL } = require("node:url");
	const storageStore = {};
	let failNextSet = false;
	global.chrome.storage = {
		local: {
			get: async (keys) => {
				if (keys === null) return { ...storageStore };
				const list = Array.isArray(keys) ? keys : [keys];
				const out = {};
				for (const k of list) {
					if (Object.hasOwn(storageStore, k)) out[k] = structuredClone(storageStore[k]);
				}
				return out;
			},
			set: async (obj) => {
				if (failNextSet) {
					failNextSet = false;
					throw new Error("Simulated quota error");
				}
				for (const [k, v] of Object.entries(obj)) {
					storageStore[k] = structuredClone(v);
				}
			},
			remove: async (keys) => {
				const list = Array.isArray(keys) ? keys : [keys];
				for (const k of list) delete storageStore[k];
			},
		},
	};
	const storageMod = await import(pathToFileURL(path.join(__dirname, "../../utils/storageManager.js")).href);
	const sm = new storageMod.StorageManager("mpv_legacy", null);
	const initialData = sm._getDefaultData();
	await sm.set(initialData);
	assert.ok(sm._cache !== null, "Cache should be populated after successful set");

	failNextSet = true;
	await assert.rejects(
		() => sm.set({ ...initialData, folders: { ...initialData.folders, Extra: { playlist: [], lastPlayedId: null } } }),
		/Simulated quota error/,
	);
	assert.strictEqual(sm._cache, null, "Cache must be invalidated to null on write failure");

	const orderLog = [];
	const p1 = sm.withLock(async () => {
		orderLog.push("start-1");
		const d = await sm.get(true);
		await new Promise((r) => setTimeout(r, 15));
		d.folders.Default.playlist.push({ id: "i1", url: "https://example.com/1", title: "1" });
		await sm.set(d, "Default");
		orderLog.push("end-1");
		return "r1";
	});
	const p2 = sm.withLock(async () => {
		orderLog.push("start-2");
		const d = await sm.get(true);
		d.folders.Default.playlist.push({ id: "i2", url: "https://example.com/2", title: "2" });
		await sm.set(d, "Default");
		orderLog.push("end-2");
		return "r2";
	});
	const [r1, r2] = await Promise.all([p1, p2]);
	assert.strictEqual(r1, "r1");
	assert.strictEqual(r2, "r2");
	assert.deepStrictEqual(orderLog, ["start-1", "end-1", "start-2", "end-2"], "withLock must serialize concurrent RMW operations");
	const afterLock = await sm.get(true);
	assert.strictEqual(afterLock.folders.Default.playlist.length, 2, "Serialized RMW must preserve both items");
	await assert.rejects(() => sm.withLock(async () => { throw new Error("boom"); }), /boom/);
	const afterErr = await sm.withLock(async () => "recovered");
	assert.strictEqual(afterErr, "recovered", "withLock queue must recover after a rejected callback");
	console.log("  [OK] StorageManager cache invalidation & withLock serialization");

	// 12. PlaybackStateManager iframe guard & re-injection destroy()
	const psmPath = path.join(__dirname, "../../utils/PlaybackStateManager.js");
	const storageListeners = new Set();
	const msgListeners = new Set();
	global.chrome.storage.onChanged = {
		addListener: (fn) => storageListeners.add(fn),
		removeListener: (fn) => storageListeners.delete(fn),
	};
	global.chrome.runtime.onMessage = {
		addListener: (fn) => msgListeners.add(fn),
		removeListener: (fn) => msgListeners.delete(fn),
	};

	// 12a. Iframe: should NOT instantiate singleton
	const iframeWin = { MPV_INTERNAL: {} };
	iframeWin.self = iframeWin;
	iframeWin.top = {};
	global.window = iframeWin;
	delete require.cache[require.resolve(psmPath)];
	require(psmPath);
	assert.strictEqual(iframeWin.MPV_INTERNAL.playbackStateManager, undefined, "PlaybackStateManager must not instantiate in iframes");
	assert.strictEqual(storageListeners.size, 0, "Iframe must not attach storage listeners");

	// 12b. Top frame: should instantiate, and re-injection must destroy() old instance
	const topWin = { MPV_INTERNAL: {} };
	topWin.self = topWin;
	topWin.top = topWin;
	global.window = topWin;
	delete require.cache[require.resolve(psmPath)];
	require(psmPath);
	const firstInstance = topWin.MPV_INTERNAL.playbackStateManager;
	assert.ok(firstInstance, "PlaybackStateManager should instantiate in top frame");
	assert.strictEqual(storageListeners.size, 1);
	assert.strictEqual(msgListeners.size, 1);

	delete require.cache[require.resolve(psmPath)];
	require(psmPath);
	const secondInstance = topWin.MPV_INTERNAL.playbackStateManager;
	assert.notStrictEqual(secondInstance, firstInstance);
	assert.strictEqual(firstInstance._isDestroyed, true, "Previous singleton must be destroyed on re-injection");
	assert.strictEqual(storageListeners.size, 1, "Re-injection must not leak storage listeners");
	assert.strictEqual(msgListeners.size, 1, "Re-injection must not leak message listeners");
	secondInstance.destroy();
	console.log("  [OK] PlaybackStateManager top-frame guard & re-injection cleanup");

	// 13. broadcastLog error messages must not persist back to native host
	global.chrome.runtime.sendMessage = async () => {};
	global.chrome.tabs = {
		query: async () => [],
		sendMessage: async () => {},
	};
	const { logger: sysLogger } = await import(pathToFileURL(path.join(__dirname, "../../utils/SystemLogger.module.js")).href);
	const persistedPayloads = [];
	sysLogger.buffer = [];
	sysLogger.setNativeSender(async (payload) => {
		persistedPayloads.push(payload);
	});
	const { broadcastLog } = await import(pathToFileURL(path.join(__dirname, "../../background/messaging.js")).href);
	await broadcastLog({ text: "Simulated disconnect error", type: "error" });
	assert.strictEqual(persistedPayloads.length, 0, "broadcastLog error must use persist:false to avoid reconnect storm");
	console.log("  [OK] broadcastLog error does not trigger persist loop");

	// 14. import_export prototype pollution & folder key sanitization/64-char cap
	global.chrome.alarms = { create: () => {}, clear: async () => true };
	global.chrome.contextMenus = { removeAll: async () => {}, create: () => {} };
	const { handleImportFromFile } = await import(pathToFileURL(path.join(__dirname, "../../background/handlers/import_export.js")).href);
	const { nativeLink } = await import(pathToFileURL(path.join(__dirname, "../../utils/nativeLink.js")).href);
	const { storage: bgStorage } = await import(pathToFileURL(path.join(__dirname, "../../background/storage_instance.js")).href);
	const origNativeCall = nativeLink.call.bind(nativeLink);
	const origGet = bgStorage.get.bind(bgStorage);
	const origSet = bgStorage.set.bind(bgStorage);
	try {
		const mockData = sm._getDefaultData();
		const longKey = "A".repeat(80);
		const longKeyExisting = "A".repeat(64);
		mockData.folders[longKeyExisting] = { playlist: [], lastPlayedId: null };
		mockData.folderOrder.push(longKeyExisting);

		bgStorage.get = async () => mockData;
		bgStorage.set = async () => {};
		nativeLink.call = async (action) => {
			if (action === "import_from_file") {
				return {
					success: true,
					data: JSON.stringify({
						folders: {
							__proto__: { playlist: [{ url: "https://example.com/bad", title: "Bad" }] },
							constructor: { playlist: [{ url: "https://example.com/bad2", title: "Bad2" }] },
							prototype: { playlist: [{ url: "https://example.com/bad3", title: "Bad3" }] },
							[longKey]: { playlist: [{ url: "https://example.com/good", title: "Good" }] },
						},
					}),
				};
			}
			return { success: true };
		};

		const importRes = await handleImportFromFile({ filename: "backup.json" }, {});
		assert.strictEqual(importRes.success, true);
		assert.strictEqual(({}).polluted, undefined);
		assert.ok(!Object.hasOwn(mockData.folders, "__proto__"));
		assert.ok(!Object.hasOwn(mockData.folders, "constructor"));
		assert.ok(!Object.hasOwn(mockData.folders, "prototype"));
		const importedKeys = Object.keys(mockData.folders).filter((k) => k.startsWith("AAA"));
		assert.strictEqual(importedKeys.length, 2, "Long key should collide safely with suffix");
		for (const k of importedKeys) {
			assert.ok(k.length <= 64, `Folder ID '${k}' exceeded 64 characters (${k.length})`);
		}
	} finally {
		nativeLink.call = origNativeCall;
		bgStorage.get = origGet;
		bgStorage.set = origSet;
	}
	console.log("  [OK] import_export prototype-pollution filtering & 64-char folder ID limit");

	// 15. StorageManager.get() returns a deep clone so failed mutations never corrupt _cache
	const clonedA = await sm.get();
	clonedA.folders.Default.playlist.push({ id: "corrupt", url: "https://evil.example/x", title: "Corrupt" });
	const clonedB = await sm.get();
	assert.strictEqual(
		clonedB.folders.Default.playlist.some((i) => i.id === "corrupt"),
		false,
		"Mutating object returned by StorageManager.get() must not corrupt internal _cache",
	);
	console.log("  [OK] StorageManager.get() deep-clone cache isolation");

	// 16. createHandler serializes concurrent non-manualPersistence RMW mutations via withLock
	const { createHandler } = await import(pathToFileURL(path.join(__dirname, "../../background/handler_factory.js")).href);
	const factoryOrder = [];
	const origBgGet = bgStorage.get.bind(bgStorage);
	const origBgSet = bgStorage.set.bind(bgStorage);
	try {
		const factoryData = sm._getDefaultData();
		bgStorage.get = async () => structuredClone(factoryData);
		bgStorage.set = async (nextData) => {
			Object.assign(factoryData, structuredClone(nextData));
		};
		const slowMutator = createHandler(async ({ request, data }) => {
			factoryOrder.push(`start-${request.tag}`);
			await new Promise((r) => setTimeout(r, request.delayMs));
			data.folders.Default.playlist.push({ id: request.tag, url: `https://example.com/${request.tag}`, title: request.tag });
			factoryOrder.push(`end-${request.tag}`);
			return { success: true };
		});
		await Promise.all([
			slowMutator({ tag: "a", delayMs: 20 }, {}),
			slowMutator({ tag: "b", delayMs: 0 }, {}),
		]);
		assert.deepStrictEqual(factoryOrder, ["start-a", "end-a", "start-b", "end-b"]);
		assert.strictEqual(factoryData.folders.Default.playlist.length, 2);
	} finally {
		bgStorage.get = origBgGet;
		bgStorage.set = origBgSet;
	}
	console.log("  [OK] createHandler serializes auto-persisted RMW with storage.withLock");

	// 17. promptUserConfirmation bounds waits with a timeout when popup/tab never responds
	const commMod = await import(pathToFileURL(path.join(__dirname, "../../utils/commUtils.module.js")).href);
	const origSendMsg = global.chrome.runtime.sendMessage;
	const origTabs = global.chrome.tabs;
	try {
		global.chrome.runtime.lastError = null;
		global.chrome.runtime.sendMessage = (_msg, _cb) => {
			// Intentionally never invoke cb to simulate unresponsive popup
		};
		global.chrome.tabs = {
			query: async () => [{ id: 77 }],
			sendMessage: (_tabId, _msg, _cb) => {
				// Intentionally never invoke cb to simulate unresponsive tab
			},
		};
		const startMs = Date.now();
		const confirmed = await commMod.promptUserConfirmation("Confirm?", 77, true, 30);
		const elapsedMs = Date.now() - startMs;
		assert.strictEqual(confirmed, true, "Timed-out confirmation must fall back to defaultOnUnreachable");
		assert.ok(elapsedMs < 1000, `promptUserConfirmation should time out promptly, took ${elapsedMs}ms`);
	} finally {
		global.chrome.runtime.sendMessage = origSendMsg;
		global.chrome.tabs = origTabs;
	}
	console.log("  [OK] promptUserConfirmation bounded timeout");

	// 18. MessageBridge.send() resolves instead of hanging when destroyed in-flight
	const mbPath = path.join(__dirname, "../../utils/MessageBridge.js");
	global.window = { MPV_INTERNAL: { isExtensionReloadError: () => false } };
	delete require.cache[require.resolve(mbPath)];
	require(mbPath);
	let capturedCb = null;
	const origMbSend = global.chrome.runtime.sendMessage;
	try {
		global.chrome.runtime.sendMessage = (_payload, cb) => {
			capturedCb = cb;
		};
		const bridge = new global.window.MPV_INTERNAL.MessageBridge();
		const sendPromise = bridge.send("ping");
		bridge.destroy();
		capturedCb({ success: true });
		const res = await sendPromise;
		assert.strictEqual(res.success, false);
		assert.strictEqual(res.error, "Bridge destroyed");
	} finally {
		global.chrome.runtime.sendMessage = origMbSend;
	}
	console.log("  [OK] MessageBridge.send() resolves cleanly when destroyed in-flight");

	// 19. nativeConnection preserves raw URL keys in data for get_metadata_cache
	const nativeMod = await import(`${pathToFileURL(path.join(__dirname, "../../utils/nativeConnection.module.js")).href}?meta=${Date.now()}`);
	const origConnectNative = global.chrome.runtime.connectNative;
	try {
		const messageListeners = [];
		const mockPort = {
			onDisconnect: { addListener: () => {} },
			onMessage: { addListener: (fn) => messageListeners.push(fn) },
			postMessage: (msg) => {
				queueMicrotask(() => {
					if (msg.action === "restore_session") {
						messageListeners.forEach((fn) => fn({ request_id: msg.request_id, status: "ok" }));
					} else if (msg.action === "get_metadata_cache") {
						messageListeners.forEach((fn) =>
							fn({
								request_id: msg.request_id,
								success: true,
								data: {
									"https://example.com/my_video_1": { title: "Raw Key" },
								},
							}),
						);
					}
				});
			},
			disconnect: () => {},
		};
		global.chrome.runtime.connectNative = () => mockPort;
		const metaRes = await nativeMod.callNativeHost({ action: "get_metadata_cache", shard: "0" });
		assert.strictEqual(metaRes.success, true);
		assert.ok(
			Object.hasOwn(metaRes.data, "https://example.com/my_video_1"),
			"get_metadata_cache must preserve snake_case/URL keys inside data",
		);
	} finally {
		global.chrome.runtime.connectNative = origConnectNative;
	}
	console.log("  [OK] callNativeHost preserves verbatim data keys for get_metadata_cache");

	// 20. bridge_contract.js validateContract rejects unknown actions & SETTINGS_FIELDS on non-playback actions
	const { validateContract } = require("./bridge_contract");

	const unknownRes = validateContract({ action: "completely_unknown_action", request_id: "req_u1" });
	assert.strictEqual(unknownRes.valid, false, "validateContract must reject unknown actions even with only base keys");
	assert.ok(unknownRes.error?.includes("completely_unknown_action"), "Error should name the unknown action");

	const protoActionRes = validateContract({ action: "toString", request_id: "req_u2" });
	assert.strictEqual(protoActionRes.valid, false, "validateContract must reject Object.prototype keys as action names");

	const settingsOnLog = validateContract({
		action: "log_event",
		level: "INFO",
		message: "test",
		ytdl_quality: "best",
	});
	assert.strictEqual(settingsOnLog.valid, false, "log_event must reject SETTINGS_FIELDS keys like ytdl_quality");
	assert.ok(settingsOnLog.error?.includes("ytdl_quality"), "Error should mention rejected settings key");

	const settingsOnService = validateContract({
		action: "get_anilist_releases",
		days: 7,
		mpv_decoder: "auto",
	});
	assert.strictEqual(settingsOnService.valid, false, "get_anilist_releases must reject SETTINGS_FIELDS keys like mpv_decoder");

	const settingsOnPlayback = validateContract({
		action: "play",
		folder_id: "Default",
		ytdl_quality: "best",
	});
	assert.strictEqual(settingsOnPlayback.valid, true, "PlaybackRequest actions must still accept SETTINGS_FIELDS keys");
	console.log("  [OK] validateContract rejects unknown actions and SETTINGS_FIELDS on non-playback actions");

	console.log("\nALL JS BRIDGE PROTOCOL & UTILITY TESTS PASSED! ✨");
}

runTests().catch((err) => {
	console.error("\nTEST FAILED! ❌");
	console.error(err);
	process.exit(1);
});
