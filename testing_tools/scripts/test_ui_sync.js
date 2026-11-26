const assert = require("node:assert").strict;
const { JSDOM } = require("jsdom");

function createMockNativePort() {
    const messageListeners = [];
    const disconnectListeners = [];
    return {
        onMessage: { addListener: (fn) => { messageListeners.push(fn); } },
        onDisconnect: { addListener: (fn) => { disconnectListeners.push(fn); } },
        postMessage: (msg) => {
            queueMicrotask(() => {
                const reply = { success: true };
                if (msg && msg.request_id !== undefined) reply.request_id = msg.request_id;
                if (msg && msg.action === "handshake") reply.action = "handshake_ack";
                for (const fn of messageListeners) fn(reply);
            });
        },
        disconnect: () => {
            for (const fn of disconnectListeners) fn();
        },
    };
}

/**
 * Setup JSDOM environments for two separate controllers: Popup and ContentScript.
 */
function createControllerEnv(url) {
    const dom = new JSDOM('<!DOCTYPE html><html><body><div id="playlist-container"></div><select id="folder-select"></select><select id="compact-folder-select"></select><div id="quick-actions-bar"></div></body></html>', {
        url: url,
        contentType: "text/html",
    });
    
    const env = {
        window: dom.window,
        document: dom.window.document,
        chrome: {
            runtime: {
                sendMessage: (payload, callback) => {
                    // Mock background response
                    if (callback) callback({ success: true, ...payload });
                },
                onMessage: {
                    addListener: (listener) => { env.messageListener = listener; },
                    removeListener: () => {}
                },
                connect: () => ({ onMessage: { addListener: () => {} } }),
                connectNative: () => createMockNativePort()
            },
            contextMenus: {
                create: () => {},
                removeAll: (cb) => { if (typeof cb === "function") cb(); },
                onClicked: { addListener: () => {} }
            },
            storage: {
                local: {
                    get: (keys, cb) => cb({}),
                    set: (data, cb) => {
                        if (cb) cb();
                        // Trigger onChanged for all listeners
                        const changes = {};
                        for (const key in data) {
                            changes[key] = { newValue: data[key] };
                        }
                        globalListeners.forEach(l => l(changes, "local"));
                    }
                },
                onChanged: {
                    addListener: (l) => { globalListeners.add(l); }
                }
            },
            alarms: {
        create: () => {},
        clear: () => Promise.resolve(true)
    },
    tabs: {
                query: (q, cb) => cb([{ id: 1 }])
            }
        }
    };

    // Polyfills for JSDOM
    env.window.chrome = env.chrome;
    env.window.navigator.clipboard = {
        writeText: () => Promise.resolve()
    };
    try {
        void env.window.localStorage;
    } catch {
        const store = new Map();
        Object.defineProperty(env.window, "localStorage", {
            configurable: true,
            value: {
                getItem: (k) => (store.has(String(k)) ? store.get(String(k)) : null),
                setItem: (k, v) => { store.set(String(k), String(v)); },
                removeItem: (k) => { store.delete(String(k)); },
                clear: () => { store.clear(); },
                get length() { return store.size; },
                key: (i) => Array.from(store.keys())[i] ?? null,
            },
        });
    }

    return env;
}

const globalListeners = new Set();

// Setup a base chrome mock for global scope during require
global.chrome = {
    storage: {
        onChanged: {
            addListener: (l) => { globalListeners.add(l); }
        },
        local: {
            get: (keys, cb) => {
                const data = { active_playback_state: { folderId: "Default", isRunning: false } };
                if (typeof cb === 'function') {
                    cb(data);
                    return;
                }
                return Promise.resolve(data);
            },
            set: (data, cb) => {
                if (typeof cb === 'function') cb();
                const changes = {};
                for (const key in data) {
                    changes[key] = { newValue: data[key] };
                }
                globalListeners.forEach(l => l(changes, "local"));
                return Promise.resolve();
            },
            remove: (keys, cb) => {
                if (typeof cb === 'function') cb();
                return Promise.resolve();
            }
        }
    },
    alarms: {
        create: () => {},
        clear: () => Promise.resolve(true)
    },
    tabs: {
        query: (q, cb) => {
            if (typeof cb === 'function') cb([]);
            return Promise.resolve([]);
        },
        sendMessage: (id, msg, cb) => {
            if (typeof cb === 'function') cb();
            return Promise.resolve();
        }
    },
    runtime: {
        sendMessage: (msg, cb) => {
            const res = { success: true, css: "" };
            if (typeof cb === "function") cb(res);
            return Promise.resolve(res);
        },
        onMessage: { addListener: () => {} },
        connect: () => ({ onMessage: { addListener: () => {} } }),
        connectNative: () => createMockNativePort()
    },
    contextMenus: {
        create: () => {},
        removeAll: (cb) => { if (typeof cb === "function") cb(); },
        onClicked: { addListener: () => {} }
    }
};

const domForRequire = new JSDOM('<!DOCTYPE html><html><body></body></html>');
global.window = { chrome: global.chrome }; 
global.document = domForRequire.window.document;
global.Node = domForRequire.window.Node;
global.Element = domForRequire.window.Element;
global.window.MPV_INTERNAL = {};
const MPV = global.window.MPV_INTERNAL;

// Mock required internal utilities
MPV.domUtils = {
    formatTitle: (span, item) => { span.textContent = item.title; },
    updateItemDelta: (div, delta) => { if (delta.watched) div.classList.add("item-watched"); },
    createPlaylistItemElement: (item) => {
        const div = document.createElement("div");
        div.className = "list-item";
        div.dataset.id = item.id;
        div.textContent = item.title || item.url || "";
        return div;
    }
};

// Load required scripts
require("../../utils/commUtils.js");
require("../../utils/PlaybackStateManager.js");
require("../../utils/PlaylistUI.js");
require("../../utils/ControllerTimers.js");

MPV.playbackStateManager = global.window.MPV_INTERNAL.playbackStateManager;

async function testUiSync() {
    globalListeners.clear();
    console.log("🚀 Starting UI Sync Test (Popup <-> ContentScript)...");

    const popupEnv = createControllerEnv("chrome-extension://id/popup.html");
    const contentEnv = createControllerEnv("https://example.com");

    // Mock controllers
    const mockController = (env) => ({
        state: { state: { settings: { enableActiveItemHighlight: true, showWatchedStatusGui: true } }, update: () => {} },
        checkContext: () => true,
        sendCommandToBackground: (action, folderId, data) => {
            console.log(`  [Mock] Sending ${action} to background from ${env.window.location.href}`);
            // Simulate background processing and broadcasting
            if (action === "remove_item") {
                const itemId = data.data.id;
                // Simulate storage update which triggers onChanged
                const pbState = { 
                    folderId, 
                    isRunning: true, 
                    completedIds: [itemId], // Optimistic "Staged" removal
                    timestamp: Date.now() 
                };
                env.chrome.storage.local.set({ active_playback_state: pbState });
            }
            return Promise.resolve({ success: true });
        },
        updateAddButtonState: () => {},
        addLogEntry: () => {}
    });

    const popupUI = new MPV.PlaylistUI(mockController(popupEnv), { shadowRoot: popupEnv.document });
    const contentUI = new MPV.PlaylistUI(mockController(contentEnv), { shadowRoot: contentEnv.document });

    // Link the shadowRoot correctly for the test
    popupUI.fullContainer = popupEnv.document.getElementById("playlist-container");
    popupUI.folderSelect = popupEnv.document.getElementById("folder-select");
    popupUI.compactFolderSelect = popupEnv.document.getElementById("compact-folder-select");

    contentUI.fullContainer = contentEnv.document.getElementById("playlist-container");
    contentUI.folderSelect = contentEnv.document.getElementById("folder-select");
    contentUI.compactFolderSelect = contentEnv.document.getElementById("compact-folder-select");

    const testPlaylist = [
        { id: "item-1", title: "Item 1", url: "url-1" },
        { id: "item-2", title: "Item 2", url: "url-2" }
    ];

    // --- Step 1: Initial Render ---
    console.log("Step 1: Initial Render on both sides.");
    popupUI.render(testPlaylist, null, true);
    contentUI.render(testPlaylist, null, true);

    assert.strictEqual(popupEnv.document.querySelectorAll(".list-item").length, 2);
    assert.strictEqual(contentEnv.document.querySelectorAll(".list-item").length, 2);

    // --- Step 2: Setup Storage Listeners (Mirrors popup.js logic) ---
    const setupStorageListener = (ui, env) => {
        env.chrome.storage.onChanged.addListener((changes) => {
            if (changes.active_playback_state) {
                const newState = changes.active_playback_state.newValue;
                console.log(`  [Event] ${env.window.location.href} detected storage change!`);
                ui.render(testPlaylist, newState.lastPlayedId, true, newState.completedIds);
            }
        });
    };

    setupStorageListener(popupUI, popupEnv);
    setupStorageListener(contentUI, contentEnv);

    // --- Step 3: Remove from Popup -> Sync to Content ---
    console.log("Step 2: Removing 'item-1' from Popup...");
    
    // Simulate clicking remove on popup
    const removeBtn = popupEnv.document.querySelector('.list-item[data-id="item-1"] .btn-remove-item');
    
    // Trigger the click handler logic manually (since JSDOM event bubbling might need help)
    popupUI.controller.sendCommandToBackground("remove_item", "Default", { data: { index: 0, id: "item-1" } });

    // Check if ContentScript reflected the change
    console.log("  Waiting for ContentScript to sync...");
    await new Promise(r => setTimeout(r, 50));

    const contentItems = contentEnv.document.querySelectorAll(".list-item");
    assert.strictEqual(contentItems.length, 1, "ContentScript should have hidden the removed item.");
    assert.strictEqual(contentItems[0].dataset.id, "item-2");
    console.log("  ✅ ContentScript synced with Popup removal.");

    // --- Step 4: Reset and Test Reverse (Content -> Popup) ---
    console.log("Step 3: Resetting and testing reverse (Content -> Popup)...");
    contentEnv.chrome.storage.local.set({ active_playback_state: { folderId: "Default", completedIds: [] } });
    await new Promise(r => setTimeout(r, 10));

    contentUI.controller.sendCommandToBackground("remove_item", "Default", { data: { index: 1, id: "item-2" } });
    
    console.log("  Waiting for Popup to sync...");
    await new Promise(r => setTimeout(r, 50));

    const popupItems = popupEnv.document.querySelectorAll(".list-item");
    assert.strictEqual(popupItems.length, 1, "Popup should have hidden the removed item.");
    assert.strictEqual(popupItems[0].dataset.id, "item-1");
    console.log("  ✅ Popup synced with ContentScript removal.");

    // Clear storage listeners registered for Steps 1-3 before moving on
    globalListeners.clear();

    // --- Step 5: Play/Pause vs Queue Visual State Transitions ---
    console.log("Step 4: Testing Play/Pause <-> Queue state transitions...");
    require("../../utils/domUtils.js");
    const domUtils = global.window.MPV_INTERNAL.domUtils;

    // A: Stopped -> Play visual
    const visualStopped = domUtils.getPlayButtonVisual({ isActive: false, needsAppend: false });
    assert.strictEqual(visualStopped.stateKey, "play");
    assert.strictEqual(visualStopped.title, "Play Playlist");
    assert.strictEqual(visualStopped.isPlaying, false);

    // B: Active playing without pending items -> Pause visual
    const visualPlaying = domUtils.getPlayButtonVisual({ isActive: true, needsAppend: false });
    assert.strictEqual(visualPlaying.stateKey, "pause");
    assert.strictEqual(visualPlaying.title, "Play/Pause Playlist");
    assert.strictEqual(visualPlaying.isPlaying, true);

    // C: Active playing with newly added unqueued items -> Queue visual
    const visualQueue = domUtils.getPlayButtonVisual({ isActive: true, needsAppend: true });
    assert.strictEqual(visualQueue.stateKey, "queue");
    assert.strictEqual(visualQueue.title, "Queue to Playlist");
    assert.strictEqual(visualQueue.isPlaying, true);

    // D: Unified PlaybackStateManager state synchronization
    MPV.playbackStateManager.update({
        folderId: "Default",
        isRunning: true,
        needsAppend: true,
        isPaused: false
    });
    assert.strictEqual(MPV.playbackStateManager.state.needsAppend, true);
    assert.strictEqual(MPV.playbackStateManager.state.status, "playing");

    // After clicking queue to append, needsAppend becomes false and state transitions back to pause
    MPV.playbackStateManager.update({
        folderId: "Default",
        isRunning: true,
        needsAppend: false,
        isPaused: false
    });
    assert.strictEqual(MPV.playbackStateManager.state.needsAppend, false);
    assert.strictEqual(MPV.playbackStateManager.state.status, "playing");
    console.log("  ✅ Play/Pause and Queue state transitions verified.");

    // --- Step 5: Folder switching and State Isolation ---
    console.log("Step 5: Verifying playback state isolation across folders.");
    // "default" is currently running in MPV
    MPV.playbackStateManager.update({
        folderId: "default",
        isRunning: true,
        sessionIds: ["item-1"],
        needsAppend: false
    });
    assert.strictEqual(MPV.playbackStateManager.state.isRunning, true);
    assert.strictEqual(MPV.playbackStateManager.state.folderId, "default");

    // Case-insensitive folder matching check
    const isMatchingCasing = (runningFolder, viewedFolder) => 
        runningFolder && viewedFolder && runningFolder.toLowerCase() === viewedFolder.toLowerCase();
    assert.strictEqual(isMatchingCasing(MPV.playbackStateManager.state.folderId, "Default"), true);
    assert.strictEqual(isMatchingCasing(MPV.playbackStateManager.state.folderId, "anime"), false);

    // Simulated subscriber for inactive folder "anime":
    // It should evaluate to inactive without altering PlaybackStateManager
    const animeIsActive = isMatchingCasing(MPV.playbackStateManager.state.folderId, "anime");
    assert.strictEqual(animeIsActive, false);
    // Global manager state remains intact
    assert.strictEqual(MPV.playbackStateManager.state.isRunning, true);
    assert.strictEqual(MPV.playbackStateManager.state.folderId, "default");
    console.log("  ✅ Folder state isolation and case-insensitivity verified.");

    // --- Step 6: Settings Schema Validation ---
    console.log("Step 6: Testing Settings Schema Validation (OptionsManager)...");
    const { OptionsManager } = await import("../../utils/settings.js");
    
    // Set up a mock settings container in popupEnv document
    const settingsContainer = popupEnv.document.createElement("div");
    settingsContainer.id = "test-settings-root";
    settingsContainer.innerHTML = `
        <select id="geometry-select">
            <option value="auto">Auto</option>
            <option value="custom" selected>Custom</option>
            <option value="top-right">Top Right</option>
        </select>
        <input type="text" id="custom-width" value="1920" />
        <input type="text" id="custom-height" value="1080" />
        <select id="mpv-decoder-select">
            <option value="auto">auto</option>
            <option value="auto-safe">auto-safe</option>
        </select>
        <input type="checkbox" id="force-terminal-checkbox" checked />
        <input type="checkbox" id="show-play-new-button-checkbox" />
        <input type="text" id="scanner-timeout-input" value="75" />
        <input type="checkbox" id="confirm-clear-playlist-checkbox" checked />
        <input type="checkbox" id="yt-mark-watched-checkbox" checked />
        <select id="clear-scope-select">
            <option value="current">Current</option>
            <option value="all">All</option>
        </select>
        <div id="mpv-flags-list-container">
            <div class="filter-pill" data-flag="--fs"></div>
            <div class="filter-pill disabled" data-flag="--volume=50"></div>
        </div>
        <div id="automatic-mpv-flags-list-container">
            <div class="filter-pill" data-flag="--hwdec=auto" title="Hardware Decoding"></div>
        </div>
    `;
    popupEnv.document.body.appendChild(settingsContainer);

    // Temporarily point global document/window/localStorage to popupEnv for OptionsManager
    const savedDoc = global.document;
    const savedWin = global.window;
    const savedLocalStorageDesc = Object.getOwnPropertyDescriptor(global, "localStorage");
    global.document = popupEnv.document;
    global.window = popupEnv.window;
    Object.defineProperty(global, "localStorage", {
        configurable: true,
        writable: true,
        value: popupEnv.window.localStorage,
    });

    let savedPreferences = null;
    try {
        const optionsManager = new OptionsManager({
            sendMessageAsync: (msg) => {
                if (msg.action === "set_ui_preferences") {
                    savedPreferences = msg.preferences;
                    return Promise.resolve({ success: true });
                }
                return Promise.resolve({ success: true });
            },
            showStatus: () => {},
            fetchAniListReleases: () => Promise.resolve()
        });

        // Verify preferenceMappings definition contains valid structure
        assert.ok(Array.isArray(optionsManager.preferenceMappings), "preferenceMappings should be an array");
        assert.ok(optionsManager.preferenceMappings.length >= 20, "Should have mapped numerous preference controls");
        for (const mapping of optionsManager.preferenceMappings) {
            assert.ok(mapping.key, "Each mapping must define key");
            assert.ok(mapping.elementId, `Mapping for ${mapping.key} must define elementId`);
            assert.ok(["checkbox", "select", "input", "color", "slider", "custom"].includes(mapping.type), `Mapping ${mapping.key} has invalid type ${mapping.type}`);
        }

        optionsManager.saveAllPreferences();
        await new Promise(r => setTimeout(r, 20));

        assert.ok(savedPreferences, "saveAllPreferences should dispatch preferences");
        assert.strictEqual(savedPreferences.launchGeometry, "custom");
        assert.strictEqual(savedPreferences.customGeometryWidth, "1920");
        assert.strictEqual(savedPreferences.customGeometryHeight, "1080");
        assert.strictEqual(savedPreferences.mpvDecoder, "auto");
        assert.strictEqual(savedPreferences.forceTerminal, true);
        assert.strictEqual(savedPreferences.showPlayNewButton, false);
        assert.strictEqual(savedPreferences.clearScope, "current");
        assert.strictEqual(savedPreferences.ytMarkWatched, true);
        assert.strictEqual(savedPreferences.confirmClearPlaylist, true);
        // Number transform
        assert.strictEqual(savedPreferences.streamScannerTimeout, 75);
        // Flags parsing
        assert.deepStrictEqual(savedPreferences.customMpvFlags, [
            { flag: "--fs", enabled: true },
            { flag: "--volume=50", enabled: false }
        ]);
        assert.deepStrictEqual(savedPreferences.automaticMpvFlags, [
            { flag: "--hwdec=auto", description: "Hardware Decoding", enabled: true }
        ]);

        // Fallback: invalid timeout resets to 60
        popupEnv.document.getElementById("scanner-timeout-input").value = "invalid-not-a-number";
        optionsManager.saveAllPreferences();
        await new Promise(r => setTimeout(r, 20));
        assert.strictEqual(savedPreferences.streamScannerTimeout, 60, "Invalid timeout should fallback to 60");

        console.log("  ✅ Settings schema validation and transform verified.");

        // --- Step 7: Favorites Filtering Behavior ---
        console.log("Step 7: Testing Favorites Filtering Behavior...");
        const favsContainer = popupEnv.document.createElement("div");
        favsContainer.id = "test-favorites-root";
        favsContainer.innerHTML = `
            <div id="settings-sections-wrapper">
                <div class="cat-tab-btn" data-category="favorites"><span class="fav-tab-label">Favorites</span></div>
                <div class="cat-tab-btn" data-category="all">All</div>
                <div class="cat-tab-btn" data-category="playback">Playback</div>
                <div class="cat-tab-btn" data-category="network">Network</div>
                <div id="favorites-empty-notice" style="display: none;">No favorites found.</div>

                <details class="settings-section" data-category="playback" id="section-playback">
                    <summary class="settings-group-header">Playback</summary>
                    <div class="control-group" id="grp-geom">
                        <label class="settings-label">Launch Geometry</label>
                        <select id="fav-test-geom"></select>
                    </div>
                    <div class="control-group" id="custom-geometry-container" style="display: none;">
                        <input id="fav-custom-w" />
                    </div>
                    <div class="control-group" id="grp-terminal">
                        <label class="settings-label">Force Terminal</label>
                        <input type="checkbox" id="fav-test-terminal" />
                    </div>
                </details>

                <details class="settings-section" data-category="network" id="section-network">
                    <summary class="settings-group-header">Network</summary>
                    <div class="control-group" id="grp-cookies">
                        <label class="settings-label">Cookies</label>
                        <input type="checkbox" id="fav-test-cookies" />
                    </div>
                </details>
            </div>
        `;
        popupEnv.document.body.appendChild(favsContainer);

        optionsManager.favoriteSettings = new Set();
        optionsManager._initializeFavoriteButtons();

        // Verify star buttons were added to regular control groups but NOT to custom-geometry-container
        const starBtns = popupEnv.document.querySelectorAll("#test-favorites-root .btn-fav-setting");
        assert.strictEqual(starBtns.length, 3, "Should inject star buttons for 3 control groups");
        assert.strictEqual(popupEnv.document.querySelector("#custom-geometry-container .btn-fav-setting"), null, "custom-geometry-container must not have star button");

        // Toggle favorite on 'grp-geom'
        const geomId = optionsManager._getSettingIdentifier(popupEnv.document.getElementById("grp-geom"));
        assert.strictEqual(geomId, "fav-test-geom");
        optionsManager._toggleFavorite(geomId);

        assert.ok(optionsManager.favoriteSettings.has("fav-test-geom"));
        assert.strictEqual(optionsManager.favoriteSettings.size, 1);

        // Verify Star button and group CSS classes
        const geomStar = popupEnv.document.querySelector('#grp-geom .btn-fav-setting');
        assert.ok(geomStar.classList.contains("is-favorite"), "Star button should have is-favorite class");
        assert.ok(popupEnv.document.getElementById("grp-geom").classList.contains("is-favorite-setting"), "Group should have is-favorite-setting class");

        // Verify Tab label
        const favTabLabel = popupEnv.document.querySelector('.cat-tab-btn[data-category="favorites"] .fav-tab-label');
        assert.strictEqual(favTabLabel.textContent, "Favorites (1)");

        // Apply "favorites" filter
        optionsManager.applyCategoryFilter("favorites");
        const secPlayback = popupEnv.document.getElementById("section-playback");
        const secNetwork = popupEnv.document.getElementById("section-network");
        const emptyNotice = popupEnv.document.getElementById("favorites-empty-notice");

        assert.strictEqual(secPlayback.style.display, "block", "Section with favorite should be visible");
        assert.strictEqual(popupEnv.document.getElementById("grp-geom").style.display, "", "Favorited item should be visible");
        assert.strictEqual(popupEnv.document.getElementById("grp-terminal").style.display, "none", "Non-favorited item should be hidden");
        assert.strictEqual(secNetwork.style.display, "none", "Section without favorites should be hidden");
        assert.strictEqual(emptyNotice.style.display, "none", "Empty notice should be hidden when favorites exist");

        // Toggle favorite OFF -> Empty State
        optionsManager._toggleFavorite(geomId);
        assert.strictEqual(optionsManager.favoriteSettings.size, 0);
        assert.strictEqual(favTabLabel.textContent, "Favorites");
        assert.strictEqual(secPlayback.style.display, "none", "Playback section hidden when no favorites");
        assert.strictEqual(emptyNotice.style.display, "flex", "Empty notice visible when no favorites in favorites view");

        // Switch back to "all" category
        optionsManager.applyCategoryFilter("all");
        assert.strictEqual(secPlayback.style.display, "block");
        assert.strictEqual(secNetwork.style.display, "block");
        assert.strictEqual(popupEnv.document.getElementById("grp-terminal").style.display, "");
        assert.strictEqual(emptyNotice.style.display, "none");
    } finally {
        // Restore globals even if an assertion fails
        global.document = savedDoc;
        global.window = savedWin;
        if (savedLocalStorageDesc) {
            Object.defineProperty(global, "localStorage", savedLocalStorageDesc);
        } else {
            delete global.localStorage;
        }
    }
    console.log("  ✅ Favorites filtering and state updates verified.");

    // --- Step 7b: populateFolderDropdowns preserves selection and respects lastUsedFolderId ---
    console.log("Step 7b: Verifying populateFolderDropdowns selection preservation...");
    {
        const { createFolderManager } = await import("../../popup/popup_folders.js");
        const dropDom = new JSDOM(
            `<!DOCTYPE html><html><body>
                <select id="remove-folder-select"></select>
                <select id="mini-folder-select"></select>
                <button id="btn-remove-folder"></button>
                <button id="btn-rename-folder"></button>
            </body></html>`,
            { url: "chrome-extension://id/popup.html" },
        );
        const prevDoc = global.document;
        global.document = dropDom.window.document;
        try {
            const removeFolderSelect = dropDom.window.document.getElementById("remove-folder-select");
            const miniFolderSelect = dropDom.window.document.getElementById("mini-folder-select");
            const removeFolderBtn = dropDom.window.document.getElementById("btn-remove-folder");
            const renameFolderBtn = dropDom.window.document.getElementById("btn-rename-folder");
            const folderManager = createFolderManager({
                uiManager: { isMiniView: () => false },
                showStatus: () => {},
                showPopupConfirmation: async () => true,
                removeFolderSelect,
                miniFolderSelect,
                removeFolderBtn,
                renameFolderBtn,
                getRefreshPlaylist: () => () => {},
            });

            // 1. Initial popup open (empty select) must honor response.lastUsedFolderId
            folderManager.populateFolderDropdowns({
                success: true,
                folderIds: ["Default", "Anime", "Music"],
                lastUsedFolderId: "Anime",
            });
            assert.strictEqual(miniFolderSelect.value, "Anime", "Initial populateFolderDropdowns must select lastUsedFolderId");
            assert.strictEqual(removeFolderSelect.value, "Anime", "removeFolderSelect must mirror lastUsedFolderId");

            // 2. Subsequent update must preserve user's currently selected folder instead of snapping to folderIds[0]
            miniFolderSelect.value = "Music";
            folderManager.populateFolderDropdowns({
                success: true,
                folderIds: ["Default", "Anime", "Music", "Docs"],
                lastUsedFolderId: "Default",
            });
            assert.strictEqual(miniFolderSelect.value, "Music", "populateFolderDropdowns must preserve existing selection");

            // 3. Removed current selection falls back to lastUsedFolderId
            folderManager.populateFolderDropdowns({
                success: true,
                folderIds: ["Default", "Anime"],
                lastUsedFolderId: "Anime",
            });
            assert.strictEqual(miniFolderSelect.value, "Anime", "Removed selection must fall back to lastUsedFolderId");
        } finally {
            global.document = prevDoc;
        }
    }
    console.log("  ✅ populateFolderDropdowns selection preservation verified.");

    // --- Step 8: Folder Ordering Logic ---
    console.log("Step 8: Verifying Folder Ordering Logic & State Operations (real folder_management handlers)...");
    const {
        handleCreateFolder,
        handleGetAllFolderIds,
        handleRemoveFolder,
        handleRenameFolder,
        handleSetFolderOrder
    } = await import("../../background/handlers/folder_management.js");
    const { storage: bgStorage } = await import("../../background/storage_instance.js");

    // Simulate Background Storage Data State backed by real handler calls
    const mockStorageData = {
        folders: {
            "Default": { playlist: [] },
            "Anime": { playlist: [] },
            "Music": { playlist: [] }
        },
        folderOrder: ["Default", "Anime", "Music"],
        settings: { lastUsedFolderId: "Default" }
    };

    const origBgGet = bgStorage.get.bind(bgStorage);
    const origBgSet = bgStorage.set.bind(bgStorage);
    bgStorage.get = async () => mockStorageData;
    bgStorage.set = async (updated) => {
        Object.assign(mockStorageData, updated);
    };

    try {
        // Operation 1: Create Folder with Sanitization via real handleCreateFolder
        const res1 = await handleCreateFolder({ folderId: "  Podcasts Shows?  " });
        assert.strictEqual(res1.success, true);
        assert.strictEqual(res1.folderId, "Podcasts Shows");
        assert.deepStrictEqual(mockStorageData.folderOrder, ["Default", "Anime", "Music", "Podcasts Shows"]);
        assert.strictEqual(mockStorageData.settings.lastUsedFolderId, "Podcasts Shows");

        // Duplicate create rejected
        const resDup = await handleCreateFolder({ folderId: "Podcasts Shows" });
        assert.strictEqual(resDup.success, false);

        // Operation 2: Rename Folder (Preserving Index In-Place) via real handleRenameFolder
        const resRename = await handleRenameFolder({ oldFolderId: "Anime", newFolderId: "Animated Series" });
        assert.strictEqual(resRename.success, true);
        // Index 1 MUST remain index 1
        assert.deepStrictEqual(mockStorageData.folderOrder, ["Default", "Animated Series", "Music", "Podcasts Shows"]);

        // Operation 3: Reorder Folders (Custom Order) via real handleSetFolderOrder
        const resOrder = await handleSetFolderOrder({ order: ["Podcasts Shows", "Music", "Animated Series", "Default"] });
        assert.strictEqual(resOrder.success, true);
        assert.deepStrictEqual(mockStorageData.folderOrder, ["Podcasts Shows", "Music", "Animated Series", "Default"]);

        // Operation 4: Cyclic Playlist Navigation using handleGetAllFolderIds
        const switchPlaylist = async () => {
            const { folderIds, lastUsedFolderId } = await handleGetAllFolderIds({});
            const current = lastUsedFolderId || folderIds[0];
            const idx = folderIds.indexOf(current);
            const next = folderIds[(idx + 1) % folderIds.length];
            mockStorageData.settings.lastUsedFolderId = next;
            return next;
        };

        mockStorageData.settings.lastUsedFolderId = "Podcasts Shows"; // index 0
        assert.strictEqual(await switchPlaylist(), "Music");               // index 1
        assert.strictEqual(await switchPlaylist(), "Animated Series");      // index 2
        assert.strictEqual(await switchPlaylist(), "Default");              // index 3
        assert.strictEqual(await switchPlaylist(), "Podcasts Shows");       // wraps to 0

        // Operation 5: Remove Folder (Order Pruning & Fallback) via real handleRemoveFolder
        const resRemActive = await handleRemoveFolder({ folderId: "Podcasts Shows" });
        assert.strictEqual(resRemActive.success, true);
        assert.deepStrictEqual(mockStorageData.folderOrder, ["Music", "Animated Series", "Default"]);
        assert.strictEqual(mockStorageData.settings.lastUsedFolderId, "Music", "Active folder switch to first in order");
    } finally {
        bgStorage.get = origBgGet;
        bgStorage.set = origBgSet;
    }

    // Operation 6: Storage Janitor Reconciliation
    const { StorageManager } = await import("../../utils/storageManager.js");
    const dummyStorage = new StorageManager("test_mpv", () => {});
    // Test Janitor logic with orphaned and unlisted folders
    const janitorData = {
        folders: { "Folder1": { playlist: [] }, "Folder2": { playlist: [] } },
        folderOrder: ["GhostFolder", "Folder1"], // GhostFolder is orphaned, Folder2 is unlisted
        settings: { lastUsedFolderId: "Folder1" }
    };
    dummyStorage._cache = janitorData;
    dummyStorage.get = () => Promise.resolve(janitorData);
    let janitorSavedData = null;
    dummyStorage.set = (d) => { janitorSavedData = d; return Promise.resolve(); };

    await dummyStorage.runJanitorTasks();
    assert.ok(janitorSavedData, "Janitor should save reconciled data");
    assert.deepStrictEqual(janitorSavedData.folderOrder, ["Folder1", "Folder2"], "GhostFolder pruned, Folder2 appended");

    console.log("  ✅ Folder ordering, cyclic switching, and Janitor reconciliation verified.");

    // Operation 7: UI Preference & Minimized State Isolation Verification
    console.log("Testing UI Preference & Minimized State Isolation...");
    const { handleSetUiPreferences } = await import("../../background/handlers/ui_state.js");
    const { DOMAIN_SPECIFIC_KEYS } = await import("../../utils/commUtils.module.js");

    // 7.1 Verify domain-specific keys are correctly isolated
    const resDomain = await handleSetUiPreferences({
        preferences: {
            minimized: true,
            position: { top: "20px" },
            minimizedStubPosition: { top: "50px" },
            launchGeometry: "fullscreen"
        }
    }, { origin: "https://www.youtube.com" });

    assert.strictEqual(resDomain.success, true);
    assert.strictEqual(resDomain.domain, "www.youtube.com");
    assert.strictEqual(resDomain.domainPrefs?.minimized, true, "Domain should receive minimized preference");
    assert.deepStrictEqual(resDomain.domainPrefs?.position, { top: "20px" }, "Domain should receive position preference");
    assert.deepStrictEqual(resDomain.domainPrefs?.minimizedStubPosition, { top: "50px" }, "Domain should receive minimizedStubPosition");
    assert.strictEqual(resDomain.globalPrefs.minimized, undefined, "Global preferences must NEVER contain minimized");
    assert.strictEqual(resDomain.globalPrefs.position, undefined, "Global preferences must not contain position from domain");
    assert.strictEqual(resDomain.globalPrefs.launchGeometry, "fullscreen", "Global preferences should receive non-domain keys");

    // 7.2 Call handleSetUiPreferences without resolvable domain: DOMAIN_SPECIFIC_KEYS must NOT pollute global
    const resNoDomain = await handleSetUiPreferences({
        preferences: {
            minimized: true,
            position: { top: "100px" },
            mpvDecoder: "nvdec"
        }
    }, { origin: null });

    assert.strictEqual(resNoDomain.success, true);
    assert.strictEqual(resNoDomain.globalPrefs.minimized, undefined, "Global must NOT be polluted with minimized when domain is null");
    assert.strictEqual(resNoDomain.globalPrefs.position, undefined, "Global must NOT be polluted with position when domain is null");
    assert.strictEqual(resNoDomain.globalPrefs.mpvDecoder, "nvdec", "Global should receive valid global preference mpvDecoder");

    // 7.3 StorageManager self-healing of global.minimized
    const mockStorageKeys = {
        mpv_settings: {
            uiPreferences: {
                global: {
                    minimized: true,
                    invalid_snake_key: "trash",
                    launchGeometry: "custom"
                }
            }
        }
    };
    let setStorageData = null;
    dummyStorage.get = () => Promise.resolve(mockStorageKeys);
    dummyStorage.set = (d) => { setStorageData = d; return Promise.resolve(); };

    // Test migration purges global.minimized
    const storageManagerInstance = new StorageManager("test_storage", () => {});
    const defaultData = storageManagerInstance._getDefaultData();
    assert.strictEqual(defaultData.settings.uiPreferences.global.minimized, undefined, "_getDefaultData must NOT have minimized in global preferences");

    console.log("  ✅ UI preference and minimized state isolation verified.");

    // Operation 8: MpvController Timer & Watchdog Teardown Regression Test
    console.log("Testing MpvController Timer & Watchdog Teardown...");
    const origSetInterval = global.setInterval;
    const origClearInterval = global.clearInterval;
    const origSetTimeout = global.setTimeout;
    const origClearTimeout = global.clearTimeout;

    const activeIntervals = new Set();
    const activeTimeouts = new Set();

    global.setInterval = (fn, ms, ...args) => {
        const id = origSetInterval(fn, ms, ...args);
        activeIntervals.add(id);
        return id;
    };
    global.clearInterval = (id) => {
        activeIntervals.delete(id);
        return origClearInterval(id);
    };
    global.setTimeout = (fn, ms, ...args) => {
        const id = origSetTimeout(fn, ms, ...args);
        activeTimeouts.add(id);
        return id;
    };
    global.clearTimeout = (id) => {
        activeTimeouts.delete(id);
        return origClearTimeout(id);
    };

    try {
        const mockTimerController = {
            isTearingDown: false,
            heartbeatInterval: null,
            visualWatchdogInterval: null,
            suppressedByWatchdog: false,
            preFullscreenPosition: null,
            state: { state: {} },
            ui: { controllerHost: null },
            bridge: { send: () => Promise.resolve({ success: true }) },
            _safeWrap: (fn) => fn,
            _syncUiToState: () => {},
            teardown() {
                this.isTearingDown = true;
                this.timers.destroy();
            },
            destroy() {
                this.teardown();
            }
        };
        const timers = new MPV.ControllerTimers(mockTimerController);
        mockTimerController.timers = timers;

        timers.startHeartbeat(10000);
        timers.startVisualWatchdog(10000);
        timers.scheduleTimeout(() => {}, 10000);

        assert.strictEqual(activeIntervals.size, 2, "Heartbeat and visual watchdog intervals should be active");
        assert.strictEqual(activeTimeouts.size, 1, "Scheduled timeout should be active");
        assert.ok(mockTimerController.heartbeatInterval !== null, "Controller heartbeatInterval should be set");
        assert.ok(mockTimerController.visualWatchdogInterval !== null, "Controller visualWatchdogInterval should be set");

        mockTimerController.destroy();

        assert.strictEqual(activeIntervals.size, 0, "All intervals must be cleared on destroy()");
        assert.strictEqual(activeTimeouts.size, 0, "All timeouts must be cleared on destroy()");
        assert.strictEqual(timers.heartbeatInterval, null, "timers.heartbeatInterval must be null after destroy()");
        assert.strictEqual(timers.visualWatchdogInterval, null, "timers.visualWatchdogInterval must be null after destroy()");
        assert.strictEqual(mockTimerController.heartbeatInterval, null, "controller.heartbeatInterval must be null after destroy()");
        assert.strictEqual(mockTimerController.visualWatchdogInterval, null, "controller.visualWatchdogInterval must be null after destroy()");

        // Idempotency check
        timers.destroy();
        assert.strictEqual(activeIntervals.size, 0);
    } finally {
        global.setInterval = origSetInterval;
        global.clearInterval = origClearInterval;
        global.setTimeout = origSetTimeout;
        global.clearTimeout = origClearTimeout;
    }
    console.log("  ✅ MpvController timer/watchdog teardown verified without leaks.");

    // Operation 9: Scanner Async Rehydration & Core Sync Failure Recovery
    console.log("Testing Scanner Async Rehydration & Core Sync Failure Recovery...");
    const {
        handleGetDetectedUrlForTab,
        handleUpdateDetectedUrlForTab,
        _safeScrapeDetails,
    } = await import("../../background/handlers/m3u8_scanner.js");
    handleUpdateDetectedUrlForTab(777, "https://example.com/live.m3u8");
    const detectedForTab = await handleGetDetectedUrlForTab(777);
    assert.strictEqual(detectedForTab, "https://example.com/live.m3u8", "Async handleGetDetectedUrlForTab should resolve stored URL");
    handleUpdateDetectedUrlForTab(777, null);
    assert.strictEqual(await handleGetDetectedUrlForTab(777), null);
    console.log("  ✅ Scanner async rehydration verified.");

    // Operation 10: _safeScrapeDetails Fast-Path, Backoff & Snapshot Guard
    console.log("Testing _safeScrapeDetails fast-path, backoff & snapshot guard...");
    const origChrome = global.chrome;
    try {
        let sendCalls = [];
        let mockTab = {
            id: 888,
            status: "loading",
            url: "https://www.youtube.com/watch?v=abc",
            title: "My Real Video - YouTube",
        };
        global.chrome = {
            runtime: { lastError: null },
            tabs: {
                get: (tabId, cb) => cb(tabId === 888 ? mockTab : null),
                sendMessage: async (tabId, msg) => {
                    sendCalls.push({ tabId, msg });
                    return { title: "Channel - My Real Video", url: msg.detectedUrl, isProvisional: false };
                },
            },
        };

        // 1. Immediate first attempt even when tab.status === "loading" and originTitle was provisional
        const t0 = Date.now();
        const fastRes = await _safeScrapeDetails(
            888,
            "https://cdn.example/stream.m3u8",
            "YouTube",
            "https://www.youtube.com/watch?v=abc",
            "YouTube",
        );
        const elapsed = Date.now() - t0;
        assert.strictEqual(fastRes.title, "Channel - My Real Video");
        assert.strictEqual(sendCalls.length, 1);
        assert.strictEqual(sendCalls[0].msg.timeoutMs, 1500);
        assert.ok(elapsed < 400, `Expected fast-path without 1000ms sleep, took ${elapsed}ms`);

        // 2. Snapshot guard aborts when tab.url !== originPageUrl
        mockTab.url = "https://www.youtube.com/watch?v=other";
        sendCalls = [];
        const navRes = await _safeScrapeDetails(
            888,
            "https://cdn.example/stream.m3u8",
            "Fallback",
            "https://www.youtube.com/watch?v=abc",
            "Old Title",
        );
        assert.strictEqual(navRes.isProvisional, true);
        assert.strictEqual(sendCalls.length, 0);

        // 3. Retry backoff on sendMessage throw (200ms -> 500ms)
        mockTab.url = "https://www.youtube.com/watch?v=abc";
        let attempt = 0;
        global.chrome.tabs.sendMessage = async (tabId, msg) => {
            attempt++;
            if (attempt < 3) throw new Error("Receiving end does not exist");
            return { title: "Recovered Title", url: msg.detectedUrl, isProvisional: false };
        };
        const retryStart = Date.now();
        const retryRes = await _safeScrapeDetails(
            888,
            "https://cdn.example/stream.m3u8",
            "Fallback",
            "https://www.youtube.com/watch?v=abc",
            "Loading...",
        );
        const retryElapsed = Date.now() - retryStart;
        assert.strictEqual(retryRes.title, "Recovered Title");
        assert.strictEqual(attempt, 3);
        assert.ok(retryElapsed >= 600 && retryElapsed < 1400, `Expected ~700ms backoff, got ${retryElapsed}ms`);
    } finally {
        global.chrome = origChrome;
    }
    console.log("  ✅ _safeScrapeDetails fast-path, backoff & snapshot guard verified.");

    // Operation 11: Smart Reorder Stage 2 survives async PlaylistUI.render()
    console.log("Testing Smart Reorder Stage 2 persistence across async PlaylistUI.render()...");
    require("../../utils/ControllerActions.js");
    {
        const srEnv = createControllerEnv("https://example.com");
        const folderSel = srEnv.document.getElementById("folder-select");
        const opt = srEnv.document.createElement("option");
        opt.value = "Default";
        opt.textContent = "Default";
        folderSel.appendChild(opt);
        folderSel.value = "Default";

        const origDoc = global.document;
        const origChromeGet = global.chrome.storage.local.get;
        const origMpvInterface = MPV.MpvInterface;

        global.document = srEnv.document;
        global.chrome.storage.local.get = (keys, cb) => {
            setTimeout(() => cb({}), 15);
        };

        const reorderLiveCalls = [];
        MPV.MpvInterface = {
            getSmartReorder: async () => ({
                success: true,
                playlist: [
                    { id: "b", title: "B", url: "https://example.com/b" },
                    { id: "a", title: "A", url: "https://example.com/a" },
                ],
            }),
            reorderLive: async (folderId, itemIds) => {
                reorderLiveCalls.push({ folderId, itemIds });
                return { success: true };
            },
        };

        try {
            const srController = {
                ui: { shadowRoot: srEnv.document },
                state: {
                    state: { isFolderActive: true, lastPlayedId: null, settings: {} },
                    update: () => {},
                },
                checkContext: () => true,
                updateAddButtonState: () => {},
                addLogEntry: () => {},
            };
            const srPlaylistUI = new MPV.PlaylistUI(srController, { shadowRoot: srEnv.document });
            srController.playlistUI = srPlaylistUI;
            const srActions = new MPV.ControllerActions(srController);
            srController.handleSmartReorder = (e, b) => srActions.handleSmartReorder(e, b);

            srPlaylistUI.render([{ id: "a", title: "A", url: "https://example.com/a" }, { id: "b", title: "B", url: "https://example.com/b" }], null, true);
            await new Promise((r) => setTimeout(r, 35));

            const initialBtnC = srEnv.document.getElementById("btn-osc-quick-c");
            assert.ok(initialBtnC, "Quick action C button should render");

            // Stage 1: Smart reorder triggers async render()
            await srActions.handleSmartReorder({ preventDefault() {}, stopPropagation() {} }, initialBtnC);
            await new Promise((r) => setTimeout(r, 35));

            const rebuiltBtnC = srEnv.document.getElementById("btn-osc-quick-c");
            assert.notStrictEqual(rebuiltBtnC, initialBtnC, "Async render should rebuild quick action bar");
            assert.strictEqual(srPlaylistUI.isSmartSyncPending, true, "isSmartSyncPending must persist across async render");
            assert.ok(rebuiltBtnC.classList.contains("smart-sync-pending"), "Rebuilt button must retain .smart-sync-pending");
            assert.strictEqual(rebuiltBtnC.title, "Right-click again to sync MPV playlist");

            // Stage 2: Second right-click syncs live order to MPV and clears pending state
            await srActions.handleSmartReorder({ preventDefault() {}, stopPropagation() {} }, rebuiltBtnC);
            assert.strictEqual(reorderLiveCalls.length, 1);
            assert.deepStrictEqual(reorderLiveCalls[0], { folderId: "Default", itemIds: ["b", "a"] });
            assert.strictEqual(srPlaylistUI.isSmartSyncPending, false);
            assert.strictEqual(rebuiltBtnC.classList.contains("smart-sync-pending"), false);

            // Conflicting mode click or inactive render clears isSmartSyncPending
            srPlaylistUI.isSmartSyncPending = true;
            rebuiltBtnC.onclick({ stopPropagation() {} });
            assert.strictEqual(srPlaylistUI.isSmartSyncPending, false, "Entering live reorder mode clears smart sync pending");

            srPlaylistUI.isSmartSyncPending = true;
            srPlaylistUI.render([], null, false);
            assert.strictEqual(srPlaylistUI.isSmartSyncPending, false, "Inactive folder render clears smart sync pending");
        } finally {
            global.document = origDoc;
            global.chrome.storage.local.get = origChromeGet;
            MPV.MpvInterface = origMpvInterface;
        }
    }
    console.log("  ✅ Smart Reorder Stage 2 persistence verified.");

    // Operation 12: Live prefs sync (keybinds + filter words), e.key guards, YouTube URL & PageScraper host checks
    console.log("Testing live prefs sync, e.key guards, and YouTube URL/hostname checks...");
    require("../../utils/ControllerView.js");
    require("../../utils/PageScraper.js");
    {
        const updatedDeltas = [];
        let updatedWords = null;
        const viewController = {
            ui: { shadowRoot: {}, controllerHost: {} },
            state: {
                state: { settings: {} },
                update: (delta) => updatedDeltas.push(delta),
            },
            pageScraper: {
                updateFilterWords: (w) => { updatedWords = w; },
            },
        };
        const view = new MPV.ControllerView(viewController);
        view.applyPreferences({
            kbAddPlaylist: "Alt+A",
            kbToggleController: "Alt+T",
            kbOpenPopup: "Alt+P",
            kbPlayPlaylist: "Alt+X",
            kbSwitchPlaylist: "Alt+S",
            scraperFilterWords: ["myfilter"],
        });
        assert.strictEqual(updatedDeltas.length, 1);
        assert.strictEqual(updatedDeltas[0].kbAddPlaylist, "Alt+A");
        assert.strictEqual(updatedDeltas[0].kbToggleController, "Alt+T");
        assert.strictEqual(updatedDeltas[0].kbOpenPopup, "Alt+P");
        assert.strictEqual(updatedDeltas[0].kbPlayPlaylist, "Alt+X");
        assert.strictEqual(updatedDeltas[0].kbSwitchPlaylist, "Alt+S");
        assert.deepStrictEqual(updatedWords, ["myfilter"]);

        // Unguarded e.key in ControllerView.normalizeKeyCombo & settings_ui.startRecording
        assert.strictEqual(view.normalizeKeyCombo({ key: undefined }), null);
        assert.strictEqual(view.normalizeKeyCombo({ key: "" }), null);
        assert.strictEqual(view.normalizeKeyCombo({ ctrlKey: true, key: "A" }), "ctrl+a");

        const { startRecording, stopRecording } = await import("../../popup/settings_ui.js");
        const recDom = new JSDOM("<!DOCTYPE html><html><body><button id='rec'></button><input id='inp' value='Alt+K' /></body></html>");
        const prevWin = global.window;
        global.window = recDom.window;
        try {
            const recCtx = { activeRecorder: null, keyHandler: null, debouncedSaveAllPreferences: () => {} };
            const recBtn = recDom.window.document.getElementById("rec");
            const recInp = recDom.window.document.getElementById("inp");
            startRecording(recCtx, recBtn, recInp);
            // Synthetic autofill-like event with undefined key must not throw or end recording
            assert.doesNotThrow(() => recCtx.keyHandler({ key: undefined, preventDefault() {}, stopPropagation() {} }));
            assert.strictEqual(recInp.value, "Press combination...");
            stopRecording(recCtx);
        } finally {
            global.window = prevWin;
        }

        // Strict YouTube video URL detection (popup & popup_playback)
        const { isYouTubeVideoUrl } = await import("../../popup/popup_playback.js");
        assert.strictEqual(isYouTubeVideoUrl("https://www.youtube.com/watch?v=abc123"), true);
        assert.strictEqual(isYouTubeVideoUrl("https://m.youtube.com/shorts/short123"), true);
        assert.strictEqual(isYouTubeVideoUrl("https://youtube.com/live/live123"), true);
        assert.strictEqual(isYouTubeVideoUrl("https://notyoutube.com/watch?v=abc123"), false);
        assert.strictEqual(isYouTubeVideoUrl("https://evil.example/?u=youtube.com/watch"), false);
        assert.strictEqual(isYouTubeVideoUrl("https://www.youtube.com/playlist?list=PL123"), false);
        assert.strictEqual(isYouTubeVideoUrl("javascript:youtube.com/watch"), false);

        // PageScraper hostname check must reject lookalike domains like notyoutube.com
        const fakeYtDom = new JSDOM("<!DOCTYPE html><html><head><title>NotYT Playlist</title></head><body><h1>Real H1</h1></body></html>", {
            url: "https://notyoutube.com/playlist",
        });
        const prevDoc2 = global.document;
        const prevWin2 = global.window;
        const prevSanitize = MPV.sanitizeString;
        global.document = fakeYtDom.window.document;
        global.window = fakeYtDom.window;
        MPV.sanitizeString = (s) => s;
        try {
            const scraper = new MPV.PageScraper();
            const scraped = scraper.scrapePageDetails("https://notyoutube.com/playlist");
            assert.strictEqual(scraped.title, "Real H1", "Lookalike notyoutube.com must use generic scraper, not YouTube /playlist early return");
        } finally {
            global.document = prevDoc2;
            global.window = prevWin2;
            MPV.sanitizeString = prevSanitize;
        }
    }
    console.log("  ✅ Live prefs sync, e.key guards, and YouTube URL/hostname checks verified.");

    // Operation 13: domUtils (confirmStacked cross-folder, formatTitle missing URL, updateItemDelta, smoothScrollTo(0)),
    // ControllerView watchdog AniList suppression, and PlaylistUI .removing rollback on { success: false }
    console.log("Testing domUtils regressions, watchdog AniList suppression, and PlaylistUI .removing rollback...");
    {
        const { domUtils } = await import("../../utils/domUtils.module.js");
        const dom = new JSDOM("<!DOCTYPE html><html><body><div id='scroll-box'></div></body></html>", {
            url: "https://example.com/",
        });
        const prevDoc = global.document;
        const prevWin = global.window;
        global.document = dom.window.document;
        global.window = dom.window;

        try {
            // 1. smoothScrollTo with duration <= 0 sets scrollTop directly without NaN
            const scrollBox = dom.window.document.getElementById("scroll-box");
            scrollBox.scrollTop = 10;
            domUtils.smoothScrollTo(scrollBox, 120, 0);
            assert.strictEqual(scrollBox.scrollTop, 120, "smoothScrollTo(0) sets scrollTop directly");
            domUtils.smoothScrollTo(scrollBox, 45, -50);
            assert.strictEqual(scrollBox.scrollTop, 45, "smoothScrollTo(negative) sets scrollTop directly");

            // 2. formatTitle handles missing/undefined url without throwing
            const titleSpan = dom.window.document.createElement("span");
            assert.doesNotThrow(() => domUtils.formatTitle(titleSpan, { title: "S01E01 - Pilot" }));
            assert.strictEqual(titleSpan.textContent, "S01E01 - Pilot");
            const fallbackSpan = dom.window.document.createElement("span");
            assert.doesNotThrow(() => domUtils.formatTitle(fallbackSpan, { title: "", url: undefined }));
            assert.strictEqual(fallbackSpan.textContent, "");

            // 3. updateItemDelta keeps .item-watched consistent with watched and markedAsWatched
            const ytItem = domUtils.createPlaylistItemElement(
                { id: "yt1", url: "https://www.youtube.com/watch?v=abc", title: "Chan - Vid", watched: false, markedAsWatched: false },
                0
            );
            domUtils.updateItemDelta(ytItem, { markedAsWatched: true });
            assert.strictEqual(ytItem.classList.contains("item-watched"), true, "markedAsWatched adds .item-watched");
            assert.strictEqual(ytItem.querySelector(".checkbox-checkmark"), null, "markedAsWatched alone does not add local watched checkmark");
            domUtils.updateItemDelta(ytItem, { watched: false });
            assert.strictEqual(ytItem.classList.contains("item-watched"), true, "watched:false preserves .item-watched while markedAsWatched is true");
            domUtils.updateItemDelta(ytItem, { markedAsWatched: false });
            assert.strictEqual(ytItem.classList.contains("item-watched"), false, "Clearing both watched and markedAsWatched removes .item-watched");

            // 4. confirmStacked cross-folder isolation
            const firstPromise = domUtils.confirmStacked("FolderA", "Clear FolderA?", { folderId: "FolderA", count: 1 });
            const host = dom.window.document.getElementById("mpv-page-level-modal-host");
            assert.ok(host, "First confirmStacked creates modal host");
            assert.strictEqual(host.dataset.folderId, "FolderA");

            const crossFolderResult = await domUtils.confirmStacked("FolderB", "Clear FolderB?", { folderId: "FolderB", count: 9 });
            assert.strictEqual(crossFolderResult, false, "Cross-folder confirmStacked resolves immediately to false");
            assert.strictEqual(host.dataset.folderId, "FolderA", "Cross-folder call must not overwrite host folderId");
            assert.strictEqual(
                JSON.parse(host.dataset.latestRequest).folderId,
                "FolderA",
                "Cross-folder call must not corrupt host latestRequest"
            );

            // Confirm first modal to clean up host
            host.shadowRoot.getElementById("confirm-btn").click();
            const confirmedPayload = await firstPromise;
            assert.deepStrictEqual(confirmedPayload, { folderId: "FolderA", count: 1 });
        } finally {
            global.document = prevDoc;
            global.window = prevWin;
        }

        // 5. ControllerView.syncUiToState must not re-show AniList when suppressedByWatchdog is true
        const aniDom = new JSDOM('<!DOCTYPE html><html><body><div id="status-banner"><span id="stream-status"></span></div></body></html>', {
            url: "https://example.com/",
        });
        const prevWinAni = global.window;
        global.window = aniDom.window;
        try {
            const aniHost = aniDom.window.document.createElement("div");
            aniHost.style.display = "block";
            const ctrlHost = aniDom.window.document.createElement("div");
            const minHost = aniDom.window.document.createElement("div");
            const toggleCalls = [];
            const wdController = {
                suppressedByWatchdog: true,
                _lastUpdateHash: "",
                ui: {
                    shadowRoot: aniDom.window.document,
                    controllerHost: ctrlHost,
                    minimizedHost: minHost,
                    anilistPanelHost: aniHost,
                },
                state: { state: { settings: {} } },
                anilistUI: {
                    panelHost: aniHost,
                    toggleVisibility: (show, save) => toggleCalls.push({ show, save }),
                    updateDynamicStyles: () => {},
                    validatePosition: () => {},
                },
            };
            const wdView = new MPV.ControllerView(wdController);
            wdView.syncUiToState({
                minimized: false,
                pinned: false,
                logVisible: false,
                logFilters: { info: true, error: true },
                uiMode: "full",
                isFolderActive: false,
                lastPlayedId: null,
                isClosing: false,
                anilistVisible: true,
                anilistImageHeight: 126,
                detectedUrl: null,
                settings: { showMinimizedStub: true, enableAnilistIntegration: true },
            });
            assert.strictEqual(aniHost.style.display, "none", "Watchdog hides anilistPanelHost");
            assert.strictEqual(
                toggleCalls.filter((t) => t.show === true).length,
                0,
                "syncUiToState must not re-show AniList while suppressedByWatchdog is true"
            );
        } finally {
            global.window = prevWinAni;
        }

        // 6. PlaylistUI rolls back .removing when remove_item resolves with { success: false }
        const rmDom = new JSDOM(
            '<!DOCTYPE html><html><body><div id="playlist-container"><div class="list-item" data-id="item-1"><button class="btn-remove-item" data-index="0">×</button></div></div><select id="folder-select"><option value="Default" selected>Default</option></select><select id="compact-folder-select"><option value="Default" selected>Default</option></select></body></html>'
        );
        const rmLogs = [];
        const rmController = {
            checkContext: () => true,
            state: { state: { settings: {} } },
            sendCommandToBackground: async () => ({ success: false, error: "Item locked" }),
            addLogEntry: (entry) => rmLogs.push(entry),
            refreshPlaylist: () => {},
        };
        const rmPlaylistUI = new MPV.PlaylistUI(rmController, { shadowRoot: rmDom.window.document });
        rmPlaylistUI.bindEvents();
        const rmItem = rmDom.window.document.querySelector(".list-item");
        const rmBtn = rmDom.window.document.querySelector(".btn-remove-item");
        rmBtn.click();
        assert.strictEqual(rmItem.classList.contains("removing"), true, "Optimistic .removing added on click");
        await new Promise((r) => setTimeout(r, 10));
        assert.strictEqual(rmItem.classList.contains("removing"), false, ".removing rolled back when remove_item resolves with success:false");
        assert.ok(rmLogs.some((l) => l.type === "error" && l.text.includes("Item locked")), "Error log recorded on remove_item failure");
    }
    console.log("  ✅ domUtils regressions, watchdog AniList suppression, and PlaylistUI .removing rollback verified.");

    console.log("\n✨ UI SYNC TEST PASSED! ✨");
}

(async () => {
    try {
        await testUiSync();
    } catch (err) {
        console.error("\n❌ TEST FAILED!");
        console.error(err);
        process.exit(1);
    } finally {
        globalListeners.clear();
    }
})();
