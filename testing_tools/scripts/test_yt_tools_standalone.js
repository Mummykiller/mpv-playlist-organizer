/**
 * End-to-end verification tests for the exported standalone YouTube Tools extension
 * in `yt-tools-standalone/`.
 */
const assert = require("node:assert").strict;
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "../..");
const STANDALONE_DIR = path.join(ROOT, "yt-tools-standalone");

function ensureStandaloneExported() {
	execFileSync("python3", [path.join(ROOT, "yt-tools/export_standalone.py")], {
		cwd: ROOT,
		stdio: "pipe",
	});
}

function createChromeMock(initialLocal = {}) {
	const localData = { ...initialLocal };
	const storageListeners = [];
	const runtimeMessageListeners = [];
	const installedListeners = [];
	const startupListeners = [];
	const contextMenuClickedListeners = [];
	const registeredScripts = [];
	const contextMenus = [];

	return {
		localData,
		registeredScripts,
		contextMenus,
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
				onInstalled: {
					addListener(fn) {
						installedListeners.push(fn);
					},
				},
				onStartup: {
					addListener(fn) {
						startupListeners.push(fn);
					},
				},
				onMessage: {
					addListener(fn) {
						runtimeMessageListeners.push(fn);
					},
				},
				async sendMessage(msg) {
					return new Promise((resolve) => {
						let handled = false;
						for (const fn of runtimeMessageListeners) {
							const res = fn(msg, {}, (resp) => {
								handled = true;
								resolve(resp);
							});
							if (res === true) handled = true;
						}
						if (!handled) resolve({ success: true });
					});
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
			contextMenus: {
				removeAll(cb) {
					contextMenus.length = 0;
					if (typeof cb === "function") cb();
				},
				create(item) {
					contextMenus.push(item);
				},
				onClicked: {
					addListener(fn) {
						contextMenuClickedListeners.push(fn);
					},
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
		async triggerInstalled() {
			for (const fn of installedListeners) await fn();
			await new Promise((r) => setTimeout(r, 20));
		},
		async triggerContextMenuClick(info, tab) {
			for (const fn of contextMenuClickedListeners) await fn(info, tab);
			await new Promise((r) => setTimeout(r, 20));
		},
	};
}

async function testManifestAndFiles() {
	const manifestPath = path.join(STANDALONE_DIR, "manifest.json");
	assert.ok(fs.existsSync(manifestPath), "manifest.json exists");
	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

	assert.strictEqual(manifest.manifest_version, 3, "Manifest V3");
	assert.strictEqual(manifest.background?.service_worker, "background.js");
	assert.strictEqual(manifest.action?.default_popup, "popup.html");

	for (const rel of [
		"background.js",
		"background/yt_tools_service.js",
		"popup.html",
		"popup.js",
		"popup.css",
		"popup/popup_youtube.js",
		"yt-tools/yt_defaults.js",
		"yt-tools/yt_bridge.js",
		"yt-tools/yt_content.js",
		...Object.values(manifest.icons || {}),
	]) {
		assert.ok(fs.existsSync(path.join(STANDALONE_DIR, rel)), `Standalone file exists: ${rel}`);
	}

	// Verify dedicated YouTube Tools icons are present and exported
	for (const size of [16, 32, 48, 128]) {
		const srcIcon = path.join(ROOT, `yt-tools/icons/icon${size}.png`);
		const dstIcon = path.join(STANDALONE_DIR, `images/icon${size}.png`);
		assert.ok(fs.existsSync(srcIcon), `Dedicated icon exists: yt-tools/icons/icon${size}.png`);
		assert.deepStrictEqual(
			fs.readFileSync(dstIcon),
			fs.readFileSync(srcIcon),
			`Exported icon${size}.png matches yt-tools/icons/icon${size}.png`
		);
	}

	const serviceText = fs.readFileSync(
		path.join(STANDALONE_DIR, "background/yt_tools_service.js"),
		"utf8"
	);
	assert.ok(
		!serviceText.includes("SystemLogger.module.js"),
		"Standalone service has no SystemLogger import"
	);
}

async function testStandaloneBackground() {
	const mock = createChromeMock();
	const origChrome = global.chrome;
	const origFetch = global.fetch;

	global.chrome = mock.chrome;
	global.fetch = async () => ({
		ok: true,
		async json() {
			return { title: "Standalone Test Video", author_name: "Test Author" };
		},
	});

	try {
		await import(
			`${pathToFileURL(path.join(STANDALONE_DIR, "background.js")).href}?t=${Date.now()}`
		);

		await mock.triggerInstalled();
		assert.strictEqual(
			mock.localData.shinkuYtToolsEnabled,
			true,
			"Standalone extension defaults shinkuYtToolsEnabled to true on install"
		);
		assert.strictEqual(mock.registeredScripts.length, 2, "Registers BRIDGE and MAIN scripts");
		assert.strictEqual(mock.contextMenus.length, 1, "Creates Save to Shinku YT Library context menu");

		const getRes = await mock.chrome.runtime.sendMessage({ action: "get_yt_tools_enabled" });
		assert.strictEqual(getRes.enabled, true);

		const disableRes = await mock.chrome.runtime.sendMessage({
			action: "set_yt_tools_enabled",
			enabled: false,
		});
		assert.strictEqual(disableRes.enabled, false);
		assert.strictEqual(mock.registeredScripts.length, 0, "Unregisters scripts when disabled");
		assert.strictEqual(mock.contextMenus.length, 0, "Removes context menu when disabled");

		const enableRes = await mock.chrome.runtime.sendMessage({
			action: "set_yt_tools_enabled",
			enabled: true,
		});
		assert.strictEqual(enableRes.enabled, true);
		assert.strictEqual(mock.registeredScripts.length, 2, "Re-registers scripts when enabled");
		assert.strictEqual(mock.contextMenus.length, 1, "Re-creates context menu when enabled");

		await mock.triggerContextMenuClick(
			{ menuItemId: "shinku-yt-save-library", linkUrl: "https://www.youtube.com/watch?v=abc12345678" },
			{ id: 1, url: "https://www.youtube.com/" }
		);
		assert.ok(mock.localData.shinkuLibrary?.abc12345678, "Context menu click saves to shinkuLibrary");
		assert.strictEqual(mock.localData.shinkuLibrary.abc12345678.title, "Standalone Test Video");
	} finally {
		global.chrome = origChrome;
		global.fetch = origFetch;
	}
}

async function testStandalonePopup() {
	const html = fs.readFileSync(path.join(STANDALONE_DIR, "popup.html"), "utf8");
	const dom = new JSDOM(html, { url: "https://extension.local/popup.html", runScripts: "outside-only" });

	const mock = createChromeMock({
		shinkuYtToolsEnabled: true,
		shinkuLibrary: {
			vid00000001: {
				id: "vid00000001",
				videoId: "vid00000001",
				title: "Saved Standalone Video",
				uploader: "Channel A",
				currentTime: 30,
				duration: 120,
				updatedAt: 1000,
			},
		},
	});

	const origWindow = global.window;
	const origDocument = global.document;
	const origChrome = global.chrome;
	const origDefaults = global.SHINKU_YT_DEFAULTS;
	const origQualities = global.SHINKU_YT_QUALITIES;
	const origSchema = global.SHINKU_YT_UI_SCHEMA;

	global.window = dom.window;
	global.document = dom.window.document;
	global.chrome = mock.chrome;

	try {
		const defaultsCode = fs.readFileSync(path.join(STANDALONE_DIR, "yt-tools/yt_defaults.js"), "utf8");
		vm.runInContext(defaultsCode, dom.getInternalVMContext(), { filename: "yt-tools/yt_defaults.js" });
		global.SHINKU_YT_DEFAULTS = dom.window.SHINKU_YT_DEFAULTS;
		global.SHINKU_YT_QUALITIES = dom.window.SHINKU_YT_QUALITIES;
		global.SHINKU_YT_UI_SCHEMA = dom.window.SHINKU_YT_UI_SCHEMA;

		const { createYouTubeToolsManager } = await import(
			`${pathToFileURL(path.join(STANDALONE_DIR, "popup/popup_youtube.js")).href}?t=${Date.now()}`
		);
		const manager = createYouTubeToolsManager({
			showStatus: (msg) => {
				const bar = document.getElementById("yt-status-bar");
				if (bar) bar.textContent = msg;
			},
		});
		await manager.initialize();

		assert.strictEqual(document.getElementById("yt-tools-master-enable").checked, true);
		assert.strictEqual(document.querySelectorAll("#yt-library-list .yt-library-card").length, 1);
		assert.ok(document.getElementById("yt-setting-hover-preview-guard"), "Hover guard setting rendered");
		assert.ok(document.getElementById("yt-setting-hover-preview-delay"), "Hover delay setting rendered");
		assert.ok(document.getElementById("yt-setting-playables-removal"), "Playables setting rendered");
		assert.ok(document.getElementById("yt-setting-hide-comments"), "Distraction setting rendered");
		assert.ok(document.getElementById("yt-setting-clean-clickbait-titles"), "Thumbnail/title setting rendered");
		for (const groupId of [
			"yt-frame-removal-settings",
			"yt-distraction-settings",
			"yt-video-player-settings",
			"yt-thumbnail-title-settings",
			"yt-playlist-manager-settings",
		]) {
			const groupEl = document.getElementById(groupId);
			assert.ok(groupEl && groupEl.children.length > 0, `Category container populated: ${groupId}`);
		}
		assert.strictEqual(
			document.getElementById("yt-setting-yt-dominant-on-youtube"),
			null,
			"Main-extension-only dominant setting is hidden in standalone popup"
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

async function testStandaloneContentScripts() {
	const dom = new JSDOM(
		`<!DOCTYPE html><html><body>
			<ytd-rich-item-renderer>
				<ytd-thumbnail id="thumb"><a id="thumbnail" href="/watch?v=test01"></a></ytd-thumbnail>
			</ytd-rich-item-renderer>
		</body></html>`,
		{ url: "https://www.youtube.com/", runScripts: "outside-only" }
	);
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
		const defaultsCode = fs.readFileSync(path.join(STANDALONE_DIR, "yt-tools/yt_defaults.js"), "utf8");
		const contentCode = fs.readFileSync(path.join(STANDALONE_DIR, "yt-tools/yt_content.js"), "utf8");
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
		vm.runInContext(defaultsCode, ctx, { filename: "yt-tools/yt_defaults.js" });
		vm.runInContext(contentCode, ctx, { filename: "yt-tools/yt_content.js" });

		dom.window.dispatchEvent(
			new dom.window.MessageEvent("message", {
				data: { type: "SHINKU__userSetting", data: dom.window.SHINKU_YT_DEFAULTS },
				source: dom.window,
				origin: dom.window.location.origin,
			})
		);

		assert.ok(
			dom.window.document.querySelector("#thumb .shinku-hover-shield"),
			"Standalone yt_content.js attaches hover shield"
		);
	} finally {
		dom.window.close();
	}
}

async function testPortToMainScript() {
	const dryOut = execFileSync(
		"python3",
		[path.join(ROOT, "yt-tools/port_to_main.py"), "--dry-run"],
		{ cwd: ROOT, encoding: "utf8" }
	);
	assert.ok(dryOut.length > 0, "port_to_main.py --dry-run produces output");

	execFileSync("python3", [path.join(ROOT, "yt-tools/port_to_main.py")], {
		cwd: ROOT,
		stdio: "pipe",
	});

	const mainService = fs.readFileSync(
		path.join(ROOT, "background/yt_tools_service.js"),
		"utf8"
	);
	assert.ok(
		mainService.includes('import { logger } from "../utils/SystemLogger.module.js";'),
		"port_to_main.py preserves SystemLogger import in main background/yt_tools_service.js"
	);
	assert.ok(
		!mainService.includes("const logger = console;"),
		"port_to_main.py does not leave standalone console logger in main service"
	);
}

async function main() {
	ensureStandaloneExported();
	await testManifestAndFiles();
	await testStandaloneBackground();
	await testStandalonePopup();
	await testStandaloneContentScripts();
	await testPortToMainScript();
	console.log("All Standalone YouTube Tools tests passed!");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
