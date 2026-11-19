/**
 * ISOLATED-world bridge between chrome.storage / chrome.runtime and
 * the MAIN-world YouTube Tools script (yt_content.js).
 */
(function () {
  "use strict";

  if (window.__shinkuYtBridgeLoaded) {
    return;
  }
  window.__shinkuYtBridgeLoaded = true;

  const SETTINGS_KEY = "shinkuExtensionSettings";
  const LIBRARY_KEY = "shinkuLibrary";
  const TARGET_ORIGIN = window.location.origin;
  const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

  let cachedSettings = null;
  let lastNavSignature = "";
  let initRetryTimer1 = null;
  let initRetryTimer2 = null;
  let toolsEnabled = true;
  let mainContentAlive = false;
  let libraryWriteQueue = Promise.resolve();

  function clearInitRetries() {
    if (initRetryTimer1 !== null) {
      clearTimeout(initRetryTimer1);
      initRetryTimer1 = null;
    }
    if (initRetryTimer2 !== null) {
      clearTimeout(initRetryTimer2);
      initRetryTimer2 = null;
    }
  }

  function getDefaults() {
    return globalThis.SHINKU_YT_DEFAULTS || {};
  }

  /**
   * Deep-merge saved settings with SHINKU_YT_DEFAULTS so newly added keys
   * are populated without overwriting existing user preferences.
   */
  function mergeSettingsWithDefaults(saved) {
    const defaults = getDefaults();
    const source = saved && typeof saved === "object" ? saved : {};
    const merged = {};
    let changed = !saved || typeof saved !== "object";

    for (const category of Object.keys(defaults)) {
      const defCat = defaults[category];
      const savedCat = source[category] && typeof source[category] === "object" ? source[category] : null;
      if (!savedCat) {
        changed = true;
      }
      merged[category] = {};
      for (const key of Object.keys(defCat)) {
        if (savedCat && Object.prototype.hasOwnProperty.call(savedCat, key) && savedCat[key] !== undefined) {
          merged[category][key] = savedCat[key];
        } else if (
          key === "video-settings" &&
          savedCat &&
          Object.prototype.hasOwnProperty.call(savedCat, "Video-settings") &&
          savedCat["Video-settings"] !== undefined
        ) {
          merged[category][key] = savedCat["Video-settings"];
          changed = true;
        } else {
          merged[category][key] = defCat[key];
          changed = true;
        }
      }
      // Preserve any extra keys from savedCat (except migrated legacy Video-settings)
      if (savedCat) {
        for (const key of Object.keys(savedCat)) {
          if (category === "video-player-settings" && key === "Video-settings") {
            continue;
          }
          if (!Object.prototype.hasOwnProperty.call(merged[category], key)) {
            merged[category][key] = savedCat[key];
          }
        }
      }
    }

    for (const category of Object.keys(source)) {
      if (!Object.prototype.hasOwnProperty.call(merged, category)) {
        merged[category] = source[category];
      }
    }

    return { merged, changed };
  }

  function postToMain(type, data) {
    try {
      window.postMessage({ type, data }, TARGET_ORIGIN);
    } catch (_err) {
      console.debug("[Shinku YT Bridge] postToMain failed:", _err?.message || _err);
    }
  }

  function extractVideoId(urlStr) {
    try {
      const url = new URL(urlStr || window.location.href);
      if (url.pathname === "/watch") {
        return url.searchParams.get("v") || null;
      }
      if (url.pathname.startsWith("/shorts/")) {
        return url.pathname.split("/")[2] || null;
      }
      if (url.pathname.startsWith("/live/")) {
        return url.pathname.split("/")[2] || null;
      }
      if (url.pathname.startsWith("/embed/")) {
        return url.pathname.split("/")[2] || null;
      }
      return null;
    } catch (_err) {
      return null;
    }
  }

  function getNavSignature() {
    const url = new URL(window.location.href);
    const v = url.searchParams.get("v") || "";
    return `${url.pathname}|${v}`;
  }

  function isContextValid() {
    try {
      if (typeof chrome === "undefined" || !chrome?.runtime) return false;
      if ("id" in chrome.runtime && !chrome.runtime.id) return false;
      return true;
    } catch (_err) {
      return false;
    }
  }

  let navIntervalId = null;

  function startNavInterval() {
    if (navIntervalId === null) {
      navIntervalId = setInterval(checkAndNotifyNavigation, 500);
    }
  }

  function stopNavInterval() {
    if (navIntervalId !== null) {
      clearInterval(navIntervalId);
      navIntervalId = null;
    }
  }

  function teardownInvalidatedBridge() {
    clearInitRetries();
    stopNavInterval();
    window.removeEventListener("message", onWindowMessage);
    window.removeEventListener("yt-navigate-finish", checkAndNotifyNavigation);
    window.removeEventListener("popstate", checkAndNotifyNavigation);
  }

  function checkAndNotifyNavigation() {
    if (!isContextValid()) {
      teardownInvalidatedBridge();
      return;
    }
    const sig = getNavSignature();
    if (sig === lastNavSignature) {
      return;
    }
    lastNavSignature = sig;
    const videoId = extractVideoId(window.location.href);
    window.postMessage(
      {
        type: "SHINKU__NEW_YOUTUBE_URL",
        videoId,
        data: { videoId, url: window.location.href }
      },
      TARGET_ORIGIN
    );
  }

  async function initSettings() {
    try {
      const result = await chrome.storage.local.get([SETTINGS_KEY, "shinkuYtToolsEnabled"]);
      if (result.shinkuYtToolsEnabled === false) {
        toolsEnabled = false;
        clearInitRetries();
        stopNavInterval();
        postToMain("SHINKU__toolsDisabled", {});
        return;
      }
      toolsEnabled = true;
      startNavInterval();
      const { merged, changed } = mergeSettingsWithDefaults(result[SETTINGS_KEY]);
      cachedSettings = merged;

      if (changed) {
        await chrome.storage.local.set({ [SETTINGS_KEY]: merged });
      }

      // Post immediately and retry briefly in case MAIN-world script attaches slightly later
      clearInitRetries();
      postToMain("SHINKU__userSetting", merged);
      initRetryTimer1 = setTimeout(() => {
        initRetryTimer1 = null;
        if (toolsEnabled) postToMain("SHINKU__userSetting", cachedSettings);
      }, 150);
      initRetryTimer2 = setTimeout(() => {
        initRetryTimer2 = null;
        if (toolsEnabled) postToMain("SHINKU__userSetting", cachedSettings);
      }, 600);
    } catch (_err) {
      console.debug("[Shinku YT Bridge] initSettings skipped:", _err?.message || _err);
    }
  }

  function normalizeLibraryObject(rawLibrary) {
    const out = {};
    if (Array.isArray(rawLibrary)) {
      for (const item of rawLibrary) {
        if (!item || typeof item !== "object") continue;
        const vid = String(item.id || item.videoId || "");
        if (!vid || FORBIDDEN_KEYS.has(vid)) continue;
        out[vid] = { ...item, id: vid, videoId: vid };
      }
      return out;
    }
    if (rawLibrary && typeof rawLibrary === "object") {
      for (const [k, item] of Object.entries(rawLibrary)) {
        if (FORBIDDEN_KEYS.has(k) || !item || typeof item !== "object" || Array.isArray(item)) continue;
        const vid = String(item.id || item.videoId || k);
        if (!vid || FORBIDDEN_KEYS.has(vid)) continue;
        out[k] = item;
      }
    }
    return out;
  }

  function handleSaveToLibrary(payload) {
    if (!payload || typeof payload !== "object") {
      return Promise.resolve();
    }
    const videoId = payload.videoId;
    if (!videoId || typeof videoId !== "string" || FORBIDDEN_KEYS.has(videoId)) {
      return Promise.resolve();
    }

    const nextWrite = libraryWriteQueue.then(async () => {
      try {
        const result = await chrome.storage.local.get([LIBRARY_KEY]);
        const library = normalizeLibraryObject(result[LIBRARY_KEY]);

        if (payload.remove) {
          delete library[videoId];
        } else {
          const entryData =
            payload.entry && typeof payload.entry === "object" ? payload.entry : payload;
          const existing =
            Object.prototype.hasOwnProperty.call(library, videoId) &&
            library[videoId] &&
            typeof library[videoId] === "object"
              ? library[videoId]
              : {};
          library[videoId] = {
            ...existing,
            ...entryData,
            id: videoId,
            videoId,
            updatedAt: entryData.updatedAt || Date.now()
          };
        }

        await chrome.storage.local.set({ [LIBRARY_KEY]: library });
        if (payload.saveId) {
          postToMain("SHINKU__saveToLibraryAck", { saveId: payload.saveId, videoId });
        }
      } catch (_err) {
        console.debug("[Shinku YT Bridge] handleSaveToLibrary failed:", _err?.message || _err);
      }
    });
    libraryWriteQueue = nextWrite.catch(() => {});
    return nextWrite;
  }

  async function handleRequestLibrary() {
    try {
      const result = await chrome.storage.local.get([LIBRARY_KEY]);
      const library = normalizeLibraryObject(result[LIBRARY_KEY]);
      postToMain("SHINKU__Library", library);
    } catch (_err) {
      console.debug("[Shinku YT Bridge] handleRequestLibrary failed:", _err?.message || _err);
      postToMain("SHINKU__Library", {});
    }
  }

  // Listen for MAIN-world messages
  function onWindowMessage(event) {
    if (!isContextValid()) {
      teardownInvalidatedBridge();
      return;
    }
    if (event.source !== window || event.origin !== TARGET_ORIGIN) {
      return;
    }
    const msg = event.data;
    if (!msg || typeof msg.type !== "string") {
      return;
    }

    if (msg.type.startsWith("SHINKU__")) {
      mainContentAlive = true;
    }

    if (msg.type === "SHINKU__saveToLibrary") {
      handleSaveToLibrary(msg.data || msg);
    } else if (msg.type === "SHINKU__requestLibrary") {
      handleRequestLibrary();
    } else if (msg.type === "SHINKU__requestSettings") {
      if (!toolsEnabled) {
        postToMain("SHINKU__toolsDisabled", {});
      } else if (cachedSettings) {
        postToMain("SHINKU__userSetting", cachedSettings);
      } else {
        initSettings();
      }
    }
  }
  window.addEventListener("message", onWindowMessage);

  // Watch chrome.storage changes and forward to MAIN world
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") {
        return;
      }
      if (changes.shinkuYtToolsEnabled) {
        if (changes.shinkuYtToolsEnabled.newValue) {
          toolsEnabled = true;
          startNavInterval();
          postToMain("SHINKU__toolsEnabled", cachedSettings || getDefaults());
        } else {
          toolsEnabled = false;
          clearInitRetries();
          stopNavInterval();
          postToMain("SHINKU__toolsDisabled", {});
        }
      }
      if (changes[SETTINGS_KEY]) {
        const { merged } = mergeSettingsWithDefaults(changes[SETTINGS_KEY].newValue);
        cachedSettings = merged;
        if (toolsEnabled) {
          postToMain("SHINKU__updateUserSetting", merged);
        }
      }
      if (changes[LIBRARY_KEY]) {
        const lib = normalizeLibraryObject(changes[LIBRARY_KEY].newValue);
        postToMain("SHINKU__updatingLibrary", lib);
      }
    });
  }

  // Listen for extension runtime messages (e.g. context menu save)
  if (chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || typeof message !== "object") {
        return false;
      }
      const action = message.action || message.type;
      if (action === "shinku_yt_save_current_video") {
        const currentVideoId = extractVideoId(window.location.href);
        if (!toolsEnabled || !mainContentAlive || !currentVideoId) {
          if (typeof sendResponse === "function") {
            sendResponse({ success: false, saved: false });
          }
          return false;
        }
        window.postMessage({ type: "SHINKU__saveCurrentVideo" }, TARGET_ORIGIN);
        if (typeof sendResponse === "function") {
          sendResponse({ success: true, saved: true, videoId: currentVideoId });
        }
        return false;
      }
      return false;
    });
  }

  // YouTube SPA navigation detection
  lastNavSignature = getNavSignature();
  window.addEventListener("yt-navigate-finish", checkAndNotifyNavigation);
  window.addEventListener("popstate", checkAndNotifyNavigation);
  startNavInterval();

  // Initialize settings and announce bridge readiness for MAIN-world handshake
  postToMain("SHINKU__bridgeReady", {});
  initSettings();
})();
