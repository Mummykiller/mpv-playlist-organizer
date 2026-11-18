/**
 * MAIN-world YouTube Tools script.
 * Handles player enhancements, static progress bar, on-player status badge,
 * seek/scroll overrides, feed filtering, and library bookmarking/sync.
 */
(function () {
  "use strict";

  if (window.__shinkuYtContentLoaded) {
    return;
  }
  window.__shinkuYtContentLoaded = true;

  const TARGET_ORIGIN = window.location.origin;
  const PROGRESS_CONTAINER_ID = "staticProgress-bar-container";
  const PROGRESS_FILL_ID = "staticProgress-bar-fill";
  const ON_PLAYER_STATUS_ID = "shinku-on-player-status";
  const PLUS_BUTTON_ID = "Shinku-plus-button";
  const TRACKER_INTERVAL_MS = 15000;

  let toolsEnabled = true;
  let userSetting = null;
  let shinkuLibrary = {};
  let pageID = extractVideoId(window.location.href);

  // Managed loop / timer handles
  let rafId = null;
  let trackerTimerId = null;
  let feedObserver = null;
  let feedScanTimer = null;
  let initWatchRetryTimer = null;
  let plusButtonRetryTimer = null;

  // Listener & per-video state
  let seekListenerAttached = false;
  let wheelListenerAttached = false;
  let scrollListenerAttached = false;
  let copyListenerAttached = false;
  let boundVideoEl = null;
  let endedHandledForId = null;
  let fastResumeAppliedForId = null;
  let autoPausedForId = null;
  let qualityAppliedForId = null;
  let speedAppliedForId = null;
  let theaterAppliedForId = null;
  let autoplayDisabledForId = null;
  let audioTrackAppliedForId = null;
  let ambientDisabledForId = null;
  let idleCheckTimerId = null;
  let tabChannel = null;
  const tabToken = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let isReceivingTabPause = false;
  let origIsTypeSupported = null;
  let audioCtx = null;
  const videoGainNodes = typeof WeakMap === "function" ? new WeakMap() : null;

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
      return null;
    } catch (_err) {
      return null;
    }
  }

  function isWatchPage() {
    const path = window.location.pathname;
    return (path === "/watch" || path.startsWith("/live/")) && Boolean(pageID);
  }

  function getPlayer() {
    return document.getElementById("movie_player");
  }

  function getVideo() {
    return (
      document.querySelector("#movie_player video.html5-main-video") ||
      document.querySelector("video.html5-main-video")
    );
  }

  function getPlayerSettings() {
    return userSetting?.["video-player-settings"] || {};
  }

  function getFrameSettings() {
    return userSetting?.["frame-removal-settings"] || {};
  }

  function getPlaylistSettings() {
    return userSetting?.["playlist-manager"] || {};
  }

  function getDistractionSettings() {
    return userSetting?.["distraction-settings"] || {};
  }

  function getThumbnailSettings() {
    return userSetting?.["thumbnail-title-settings"] || {};
  }

  function isPlayerMasterOn() {
    return toolsEnabled && Boolean(getPlayerSettings()["video-settings"]);
  }

  function isFrameMasterOn() {
    return toolsEnabled && Boolean(getFrameSettings()["frame-removal"]);
  }

  function isPlaylistMasterOn() {
    return toolsEnabled && Boolean(getPlaylistSettings()["playlist-manager"]);
  }

  function isDistractionMasterOn() {
    return toolsEnabled && Boolean(getDistractionSettings()["distraction-master"]);
  }

  function isThumbnailMasterOn() {
    return toolsEnabled && Boolean(getThumbnailSettings()["thumbnail-master"]);
  }

  function isHoverGuardOn() {
    return isThumbnailMasterOn() && Boolean(getThumbnailSettings()["hover-preview-guard"]);
  }

  function getHoverGuardDelayMs() {
    const raw = Number(getThumbnailSettings()["hover-preview-delay"]);
    const seconds = Number.isFinite(raw) && raw >= 0 ? raw : 3;
    return Math.round(seconds * 1000);
  }

  function formatTime(totalSeconds) {
    if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
      return "00:00";
    }
    const secs = Math.floor(totalSeconds);
    const hours = Math.floor(secs / 3600);
    const minutes = Math.floor((secs % 3600) / 60);
    const remSecs = secs % 60;
    const mm = String(minutes).padStart(2, "0");
    const ss = String(remSecs).padStart(2, "0");
    return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  function postToBridge(type, data) {
    try {
      window.postMessage({ type, data }, TARGET_ORIGIN);
    } catch (_err) {
      console.debug("[Shinku YT] postToBridge failed:", _err?.message || _err);
    }
  }

  // ---------------------------------------------------------------------------
  // Seek & Scroll Overrides
  // ---------------------------------------------------------------------------

  function isEditableTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      return true;
    }
    return Boolean(el.isContentEditable);
  }

  function hijackedSeek(e) {
    if (!isPlayerMasterOn() || !isWatchPage()) {
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) {
      return;
    }
    if (isEditableTarget(document.activeElement)) {
      return;
    }
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") {
      return;
    }

    const ps = getPlayerSettings();
    let offsetSeconds = 0;

    if (e.shiftKey) {
      if (!ps["shift-seek-override-enable"]) {
        return;
      }
      offsetSeconds = Number(ps["shift-seek-override"]);
      if (!Number.isFinite(offsetSeconds) || offsetSeconds <= 0) {
        offsetSeconds = 20;
      }
    } else {
      if (!ps["seek-override-enable"]) {
        return;
      }
      offsetSeconds = Number(ps["seek-override"]);
      if (!Number.isFinite(offsetSeconds) || offsetSeconds <= 0) {
        offsetSeconds = 2;
      }
    }

    const video = getVideo();
    if (!video || !Number.isFinite(video.currentTime)) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    const delta = e.key === "ArrowRight" ? offsetSeconds : -offsetSeconds;
    const duration = Number.isFinite(video.duration) ? video.duration : Infinity;
    const target = Math.max(0, Math.min(duration, video.currentTime + delta));

    const player = getPlayer();
    if (player && typeof player.seekTo === "function") {
      player.seekTo(target, true);
    } else {
      video.currentTime = target;
    }
  }

  function handleWheelVolume(e) {
    if (!isPlayerMasterOn()) {
      return;
    }
    const ps = getPlayerSettings();
    const allowShiftSpeed = Boolean(ps["shift-scroll-speed"]);
    const allowVolume = Boolean(ps["scroll-volume"]);
    if (e.shiftKey && allowShiftSpeed) {
      if (e.deltaY === 0) return;
      const player = getPlayer();
      if (!player || !player.contains(e.target)) return;
      const video = getVideo();
      if (!video) return;
      e.preventDefault();
      const step = 0.25;
      const direction = e.deltaY < 0 ? 1 : -1;
      const currentRate = Number.isFinite(video.playbackRate) ? video.playbackRate : 1;
      const nextRate = Math.max(0.25, Math.min(4, Math.round((currentRate + direction * step) * 100) / 100));
      video.playbackRate = nextRate;
      if (typeof player.setPlaybackRate === "function") {
        player.setPlaybackRate(nextRate);
      }
      return;
    }
    if (!allowVolume) {
      return;
    }
    if (e.deltaY === 0) {
      return;
    }
    const player = getPlayer();
    if (!player || !player.contains(e.target)) {
      return;
    }
    const video = getVideo();
    if (!video) {
      return;
    }

    e.preventDefault();
    const isUp = e.deltaY < 0;
    const key = isUp ? "ArrowUp" : "ArrowDown";
    const keyCode = isUp ? 38 : 40;

    // Pass through ArrowUp/ArrowDown to the player so YouTube adjusts volume
    // and displays its native on-screen volume feedback overlay.
    const keyEvent = new KeyboardEvent("keydown", {
      key,
      code: key,
      keyCode,
      which: keyCode,
      bubbles: true,
      cancelable: true
    });
    const handledByPlayer = !player.dispatchEvent(keyEvent);
    if (handledByPlayer) {
      return;
    }

    const step = 5;
    const direction = isUp ? 1 : -1;

    if (typeof player.getVolume === "function" && typeof player.setVolume === "function") {
      const current = player.getVolume();
      const next = Math.max(0, Math.min(100, current + direction * step));
      player.setVolume(next);
      if (next > 0 && typeof player.isMuted === "function" && player.isMuted()) {
        player.unMute?.();
      }
    } else {
      const next = Math.max(0, Math.min(1, video.volume + direction * (step / 100)));
      video.volume = next;
      if (next > 0 && video.muted) {
        video.muted = false;
      }
    }
  }

  function handleStickyMiniPlayerScroll() {
    syncStickyMiniPlayer();
  }

  function stripTrackingFromText(text) {
    if (!text || typeof text !== "string" || (!text.includes("youtube.com") && !text.includes("youtu.be"))) {
      return text;
    }
    try {
      const url = new URL(text.trim());
      if (!url.hostname.includes("youtube.com") && url.hostname !== "youtu.be") {
        return text;
      }
      url.searchParams.delete("si");
      url.searchParams.delete("pp");
      return url.toString();
    } catch (_err) {
      return text;
    }
  }

  function handleCopyStripTracking(e) {
    if (!isThumbnailMasterOn() || !getThumbnailSettings()["strip-tracking-params"]) {
      return;
    }
    const sel = window.getSelection ? String(window.getSelection()) : "";
    if (!sel || (!sel.includes("youtube.com") && !sel.includes("youtu.be"))) {
      return;
    }
    const cleaned = stripTrackingFromText(sel);
    if (cleaned !== sel && e.clipboardData) {
      e.preventDefault();
      e.clipboardData.setData("text/plain", cleaned);
    }
  }

  function updateGlobalListeners() {
    const ps = getPlayerSettings();
    const ts = getThumbnailSettings();
    const masterOn = isPlayerMasterOn();
    const wantSeek =
      masterOn && (Boolean(ps["seek-override-enable"]) || Boolean(ps["shift-seek-override-enable"]));
    const wantScroll =
      masterOn && (Boolean(ps["scroll-volume"]) || Boolean(ps["shift-scroll-speed"]));
    const wantStickyScroll = masterOn && Boolean(ps["sticky-mini-player"]) && isWatchPage();
    const wantCopyClean = isThumbnailMasterOn() && Boolean(ts["strip-tracking-params"]);

    if (wantSeek && !seekListenerAttached) {
      window.addEventListener("keydown", hijackedSeek, true);
      seekListenerAttached = true;
    } else if (!wantSeek && seekListenerAttached) {
      window.removeEventListener("keydown", hijackedSeek, true);
      seekListenerAttached = false;
    }

    if (wantScroll && !wheelListenerAttached) {
      window.addEventListener("wheel", handleWheelVolume, { passive: false, capture: true });
      wheelListenerAttached = true;
    } else if (!wantScroll && wheelListenerAttached) {
      window.removeEventListener("wheel", handleWheelVolume, { capture: true });
      wheelListenerAttached = false;
    }

    if (wantStickyScroll && !scrollListenerAttached) {
      window.addEventListener("scroll", handleStickyMiniPlayerScroll, { passive: true });
      scrollListenerAttached = true;
    } else if (!wantStickyScroll && scrollListenerAttached) {
      window.removeEventListener("scroll", handleStickyMiniPlayerScroll);
      scrollListenerAttached = false;
    }

    if (wantCopyClean && !copyListenerAttached) {
      document.addEventListener("copy", handleCopyStripTracking, true);
      copyListenerAttached = true;
    } else if (!wantCopyClean && copyListenerAttached) {
      document.removeEventListener("copy", handleCopyStripTracking, true);
      copyListenerAttached = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Static Progress Bar & On-Player Status Badge
  // ---------------------------------------------------------------------------

  function ensureProgressBar() {
    const ps = getPlayerSettings();
    const showBar = Boolean(ps["progress-bar"]);
    const showStatus = Boolean(ps["on-player-status"]);
    const shouldShowContainer = isPlayerMasterOn() && (showBar || showStatus) && isWatchPage();
    const existing = document.getElementById(PROGRESS_CONTAINER_ID);

    if (!shouldShowContainer) {
      if (existing) {
        existing.remove();
      }
      stopProgressBarLoop();
      return;
    }

    const player = getPlayer();
    if (!player) {
      return;
    }

    let container = existing;
    if (!container) {
      container = document.createElement("div");
      container.id = PROGRESS_CONTAINER_ID;
      Object.assign(container.style, {
        position: "absolute",
        left: "0",
        right: "0",
        top: "0",
        height: "3px",
        background: "rgba(255, 255, 255, 0.18)",
        pointerEvents: "none",
        zIndex: "40",
        overflow: "visible"
      });

      const fill = document.createElement("div");
      fill.id = PROGRESS_FILL_ID;
      Object.assign(fill.style, {
        width: "0%",
        height: "100%",
        background: "#ff0033",
        transition: "width 80ms linear",
        pointerEvents: "none"
      });

      const statusBadge = document.createElement("div");
      statusBadge.id = ON_PLAYER_STATUS_ID;
      Object.assign(statusBadge.style, {
        position: "absolute",
        right: "10px",
        top: "8px",
        padding: "2px 6px",
        borderRadius: "4px",
        background: "rgba(15, 15, 15, 0.78)",
        color: "#f1f1f1",
        fontSize: "11px",
        fontWeight: "600",
        fontFamily: "Roboto, Arial, sans-serif",
        fontVariantNumeric: "tabular-nums",
        lineHeight: "1.3",
        letterSpacing: "0.02em",
        pointerEvents: "none",
        whiteSpace: "nowrap",
        display: "none"
      });
      statusBadge.textContent = "00:00 / 00:00";

      container.appendChild(fill);
      container.appendChild(statusBadge);
      player.appendChild(container);
    }

    container.style.background = showBar ? "rgba(255, 255, 255, 0.18)" : "transparent";
    const fillEl = document.getElementById(PROGRESS_FILL_ID);
    if (fillEl) {
      fillEl.style.display = showBar ? "block" : "none";
    }

    updateOnPlayerStatusVisibility();
    startProgressBarLoop();
  }

  function updateOnPlayerStatusVisibility() {
    const statusBadge = document.getElementById(ON_PLAYER_STATUS_ID);
    if (!statusBadge) return;
    const showStatus = isPlayerMasterOn() && Boolean(getPlayerSettings()["on-player-status"]);
    statusBadge.style.display = showStatus ? "block" : "none";
  }

  function syncProgressBarFrame() {
    rafId = null;
    const ps = getPlayerSettings();
    if (!isPlayerMasterOn() || (!ps["progress-bar"] && !ps["on-player-status"]) || !isWatchPage()) {
      return;
    }

    const video = getVideo();
    const fill = document.getElementById(PROGRESS_FILL_ID);
    const statusBadge = document.getElementById(ON_PLAYER_STATUS_ID);

    if (video && Number.isFinite(video.duration) && video.duration > 0) {
      const pct = Math.max(0, Math.min(100, (video.currentTime / video.duration) * 100));
      if (fill && ps["progress-bar"]) {
        fill.style.width = `${pct.toFixed(2)}%`;
      }
      if (statusBadge && ps["on-player-status"]) {
        statusBadge.textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
      }
    }

    rafId = requestAnimationFrame(syncProgressBarFrame);
  }

  function startProgressBarLoop() {
    stopProgressBarLoop();
    rafId = requestAnimationFrame(syncProgressBarFrame);
  }

  function stopProgressBarLoop() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Bookmark (+) Button & Library Save
  // ---------------------------------------------------------------------------

  function isVideoSaved(id) {
    return Boolean(id && shinkuLibrary && Object.prototype.hasOwnProperty.call(shinkuLibrary, id));
  }

  function updatePlusButtonState() {
    const btn = document.getElementById(PLUS_BUTTON_ID);
    if (!btn) return;
    const saved = isVideoSaved(pageID);
    btn.textContent = saved ? "✓" : "+";
    const label = saved ? "Saved in Shinku Watch Later" : "Save to Shinku Watch Later";
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.style.color = saved ? "#3ea6ff" : "#ffffff";
  }

  function ensurePlusButton(attempt = 0) {
    if (plusButtonRetryTimer !== null) {
      clearTimeout(plusButtonRetryTimer);
      plusButtonRetryTimer = null;
    }
    const ps = getPlayerSettings();
    const shouldShow = isPlayerMasterOn() && Boolean(ps["button"]) && isWatchPage();
    const existing = document.getElementById(PLUS_BUTTON_ID);

    if (!shouldShow) {
      if (existing) {
        existing.remove();
      }
      return;
    }

    if (existing) {
      updatePlusButtonState();
      return;
    }

    const rightControls = document.querySelector("#movie_player .ytp-right-controls");
    if (!rightControls) {
      if (attempt < 10) {
        plusButtonRetryTimer = setTimeout(() => ensurePlusButton(attempt + 1), 300);
      }
      return;
    }

    const btn = document.createElement("button");
    btn.id = PLUS_BUTTON_ID;
    btn.type = "button";
    btn.className = "ytp-button";
    Object.assign(btn.style, {
      fontSize: "20px",
      fontWeight: "700",
      lineHeight: "1",
      textAlign: "center",
      verticalAlign: "top",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      cursor: "pointer"
    });
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      bookmarkVideo();
    });

    rightControls.insertBefore(btn, rightControls.firstChild);
    updatePlusButtonState();
  }

  function getVideoTitle() {
    const titleEl =
      document.querySelector("h1.ytd-watch-metadata yt-formatted-string") ||
      document.querySelector("ytd-watch-metadata h1 yt-formatted-string");
    if (titleEl && titleEl.textContent) {
      return titleEl.textContent.trim();
    }
    return document.title.replace(/ - YouTube$/, "").trim() || pageID || "YouTube Video";
  }

  function getChannelName() {
    const channelEl =
      document.querySelector("ytd-watch-metadata #channel-name a") ||
      document.querySelector("#owner #channel-name a");
    return channelEl && channelEl.textContent ? channelEl.textContent.trim() : "";
  }

  function bookmarkVideo() {
    if (!toolsEnabled || !pageID) {
      return;
    }
    const video = getVideo();
    const currentTime = video && Number.isFinite(video.currentTime) ? Math.floor(video.currentTime) : 0;
    const duration = video && Number.isFinite(video.duration) ? Math.floor(video.duration) : 0;

    const channel = getChannelName();
    const entry = {
      id: pageID,
      videoId: pageID,
      title: getVideoTitle(),
      channel,
      uploader: channel || "YouTube",
      thumbnail: `https://i.ytimg.com/vi/${encodeURIComponent(pageID)}/mqdefault.jpg`,
      url: window.location.href,
      currentTime,
      duration,
      done: false,
      doneAt: null,
      updatedAt: Date.now()
    };

    shinkuLibrary = { ...shinkuLibrary, [pageID]: { ...(shinkuLibrary[pageID] || {}), ...entry } };
    updatePlusButtonState();
    postToBridge("SHINKU__saveToLibrary", { videoId: pageID, entry });
  }

  // ---------------------------------------------------------------------------
  // Quality Lock, Auto-Pause, Fast Resume, Auto-Next
  // ---------------------------------------------------------------------------

  function applyQualityLock(force = false) {
    if (!isPlayerMasterOn() || !isWatchPage() || (!force && qualityAppliedForId === pageID)) {
      return;
    }
    const quality = getPlayerSettings()["quality-selection"];
    if (!quality || quality === "off") {
      return;
    }
    const player = getPlayer();
    if (!player) {
      return;
    }

    if (typeof player.setPlaybackQualityRange === "function") {
      player.setPlaybackQualityRange(quality, quality);
    }
    if (typeof player.setPlaybackQuality === "function") {
      player.setPlaybackQuality(quality);
    }
    qualityAppliedForId = pageID;
  }

  function applyPlaybackSpeed(force = false) {
    const raw = getPlayerSettings()["playback-speed"];
    if (!isPlayerMasterOn() || !raw || raw === "off") {
      if (speedAppliedForId !== null) {
        speedAppliedForId = null;
        const player = getPlayer();
        const video = getVideo();
        if (player && typeof player.setPlaybackRate === "function") {
          player.setPlaybackRate(1);
        }
        if (video) {
          video.playbackRate = 1;
        }
      }
      return;
    }
    if (!isWatchPage() || (!force && speedAppliedForId === pageID)) {
      return;
    }
    const rate = Number(raw);
    if (!Number.isFinite(rate) || rate <= 0) {
      return;
    }
    const player = getPlayer();
    const video = getVideo();
    if (player && typeof player.setPlaybackRate === "function") {
      player.setPlaybackRate(rate);
    }
    if (video) {
      video.playbackRate = rate;
    }
    speedAppliedForId = pageID;
  }

  function applyAutoTheater() {
    if (!isPlayerMasterOn() || !getPlayerSettings()["auto-theater"] || !isWatchPage()) {
      return;
    }
    if (theaterAppliedForId === pageID) {
      return;
    }
    const watchFlexy = document.querySelector("ytd-watch-flexy");
    if (watchFlexy && watchFlexy.hasAttribute("theater")) {
      theaterAppliedForId = pageID;
      return;
    }
    const sizeBtn = document.querySelector("#movie_player .ytp-size-button");
    if (sizeBtn) {
      theaterAppliedForId = pageID;
      sizeBtn.click();
    }
  }

  function applyDisableNativeAutoplay() {
    if (!isPlayerMasterOn() || !getPlayerSettings()["disable-native-autoplay"] || !isWatchPage()) {
      return;
    }
    if (autoplayDisabledForId === pageID) {
      return;
    }
    const autonavBtn = document.querySelector("#movie_player .ytp-autonav-toggle-button");
    if (!autonavBtn) {
      return;
    }
    autoplayDisabledForId = pageID;
    if (autonavBtn.getAttribute("aria-checked") === "true") {
      autonavBtn.click();
    }
  }

  const ENDSCREEN_STYLE_ID = "shinku-hide-endscreens-style";
  const DISTRACTION_STYLE_ID = "shinku-distraction-style";
  const PLAYER_COMFORT_STYLE_ID = "shinku-player-comfort-style";
  const STICKY_PLAYER_STYLE_ID = "shinku-sticky-player-style";
  const THUMBNAIL_STYLE_ID = "shinku-thumbnail-style";
  const CINEMA_BACKDROP_ID = "shinku-cinema-backdrop";
  const SCREENSHOT_BUTTON_ID = "shinku-screenshot-button";
  const LOOP_BUTTON_ID = "shinku-loop-button";

  function upsertStyleTag(id, cssText) {
    const existing = document.getElementById(id);
    if (!cssText) {
      if (existing) existing.remove();
      return;
    }
    if (existing) {
      if (existing.textContent !== cssText) existing.textContent = cssText;
      return;
    }
    if (document.head) {
      const style = document.createElement("style");
      style.id = id;
      style.textContent = cssText;
      document.head.appendChild(style);
    }
  }

  function syncEndscreenStyle() {
    const shouldHide =
      isPlayerMasterOn() && Boolean(getPlayerSettings()["hide-endscreens"]) && isWatchPage();
    upsertStyleTag(
      ENDSCREEN_STYLE_ID,
      shouldHide
        ? "#movie_player .ytp-ce-element, #movie_player .ytp-endscreen-content, #movie_player .ytp-ce-covering-overlay { display: none !important; }"
        : ""
    );
  }

  function syncDistractionStyle() {
    if (!isDistractionMasterOn()) {
      upsertStyleTag(DISTRACTION_STYLE_ID, "");
      return;
    }
    const ds = getDistractionSettings();
    const rules = [];
    if (ds["hide-home-feed"]) {
      rules.push(
        'ytd-browse[page-subtype="home"] #primary, ytd-browse[page-subtype="home"] ytd-two-column-browse-results-renderer { display: none !important; }'
      );
    }
    if (ds["hide-related-sidebar"]) {
      rules.push("#related, ytd-watch-next-secondary-results-renderer { display: none !important; }");
    }
    if (ds["hide-comments"]) {
      rules.push("#comments, ytd-comments { display: none !important; }");
    }
    if (ds["hide-live-chat"]) {
      rules.push("#chat, ytd-live-chat-frame { display: none !important; }");
    }
    if (ds["hide-endscreen-wall"]) {
      rules.push(".html5-endscreen, .ytp-endscreen-content, .ytp-endscreen-paginate { display: none !important; }");
    }
    if (ds["hide-merch-tickets"]) {
      rules.push(
        "ytd-merch-shelf-renderer, ytd-ticket-shelf-renderer, #ticket-shelf, ytd-metadata-row-container-renderer #always-shown { display: none !important; }"
      );
    }
    if (ds["hide-ai-summaries"]) {
      rules.push(
        'ytd-expandable-metadata-renderer[has-magic-wand], #expandable-metadata ytd-structuring-summary-renderer, button[aria-label*="Ask" i], ytd-video-description-transcript-section-renderer[is-ai-summary] { display: none !important; }'
      );
    }
    if (ds["hide-info-cards-watermarks"]) {
      rules.push(".ytp-cards-button, .ytp-cards-teaser, .iv-branding, .annotation { display: none !important; }");
    }
    if (ds["hide-action-buttons"]) {
      rules.push(
        '#top-level-buttons-computed ytd-button-renderer:has(a[href*="clip"]), #flexible-item-buttons ytd-button-renderer, ytd-download-button-renderer, #top-level-buttons-computed button[aria-label*="Thanks" i], #top-level-buttons-computed button[aria-label*="Clip" i], #top-level-buttons-computed button[aria-label*="Share" i] { display: none !important; }'
      );
    }
    if (ds["hide-sidebar-explore"]) {
      rules.push(
        'ytd-guide-section-renderer:has(a[href*="/feed/trending"]), ytd-guide-section-renderer:has(a[href*="/gaming"]), ytd-guide-entry-renderer:has(a[href*="/feed/trending"]), ytd-guide-entry-renderer:has(a[href*="/gaming"]), ytd-guide-entry-renderer:has(a[href*="/channel/UC-9-kyTW8ZkZNDHQJ6FgpwQ"]) { display: none !important; }'
      );
    }
    upsertStyleTag(DISTRACTION_STYLE_ID, rules.join("\n"));
  }

  function applyHomeToSubsRedirect() {
    const active = isDistractionMasterOn() && Boolean(getDistractionSettings()["redirect-home-to-subs"]);
    const logos = document.querySelectorAll("a#logo");
    for (const logo of logos) {
      if (active) {
        if (!logo.hasAttribute("data-shinku-orig-href")) {
          logo.setAttribute("data-shinku-orig-href", logo.getAttribute("href") || "/");
        }
        logo.setAttribute("href", "/feed/subscriptions");
      } else if (logo.hasAttribute("data-shinku-orig-href")) {
        logo.setAttribute("href", logo.getAttribute("data-shinku-orig-href"));
        logo.removeAttribute("data-shinku-orig-href");
      }
    }
    if (active && window.location.pathname === "/") {
      try {
        window.location.replace("/feed/subscriptions");
      } catch (_err) {
        console.debug("[Shinku YT] home redirect skipped:", _err?.message || _err);
      }
    }
  }

  function applyConvertShortsToWatch() {
    if (!isPlayerMasterOn() || !getPlayerSettings()["convert-shorts-to-watch"]) {
      return;
    }
    if (!window.location.pathname.startsWith("/shorts/")) {
      return;
    }
    const id = extractVideoId(window.location.href);
    if (!id) return;
    try {
      window.location.replace(`https://www.youtube.com/watch?v=${encodeURIComponent(id)}`);
    } catch (_err) {
      console.debug("[Shinku YT] shorts redirect skipped:", _err?.message || _err);
    }
  }

  function syncPlayerComfortStyle() {
    const ps = getPlayerSettings();
    const disableAmbient = isPlayerMasterOn() && Boolean(ps["disable-ambient-mode"]);
    upsertStyleTag(
      PLAYER_COMFORT_STYLE_ID,
      disableAmbient ? "#cinematics, #cinematics-container { display: none !important; }" : ""
    );
    if (disableAmbient && ambientDisabledForId !== pageID) {
      const checkedItems = document.querySelectorAll(
        '.ytp-settings-menu .ytp-menuitem[aria-checked="true"]'
      );
      for (const item of checkedItems) {
        if (/ambient/i.test(item.textContent || "")) {
          item.click();
          ambientDisabledForId = pageID;
          break;
        }
      }
    }
  }

  function applyOriginalAudioTrack() {
    if (!isPlayerMasterOn() || !getPlayerSettings()["disable-auto-dubbing"] || !isWatchPage()) {
      return;
    }
    if (audioTrackAppliedForId === pageID) return;
    const player = getPlayer();
    if (!player) return;
    const tracks =
      (typeof player.getAvailableAudioTracks === "function" && player.getAvailableAudioTracks()) ||
      null;
    if (Array.isArray(tracks) && tracks.length > 1 && typeof player.setAudioTrack === "function") {
      const original = tracks.find(
        (t) => t && (t.isDefault || /original/i.test(String(t.name || t.id || "")))
      );
      if (original) {
        player.setAudioTrack(original);
        audioTrackAppliedForId = pageID;
      }
    }
  }

  function syncCodecPreference() {
    if (typeof window.MediaSource === "undefined" || typeof window.MediaSource.isTypeSupported !== "function") {
      return;
    }
    const pref = isPlayerMasterOn() ? String(getPlayerSettings()["codec-preference"] || "off") : "off";
    if (pref === "off") {
      if (origIsTypeSupported) {
        window.MediaSource.isTypeSupported = origIsTypeSupported;
        origIsTypeSupported = null;
      }
      return;
    }
    if (!origIsTypeSupported) {
      origIsTypeSupported = window.MediaSource.isTypeSupported.bind(window.MediaSource);
    }
    const baseFn = origIsTypeSupported;
    const av1Supported = baseFn('video/mp4; codecs="av01.0.05M.08"');
    window.MediaSource.isTypeSupported = (mimeType) => {
      const lower = String(mimeType || "").toLowerCase();
      if (pref === "vp9" && lower.includes("av01")) return false;
      if (pref === "h264" && (lower.includes("av01") || lower.includes("vp9") || lower.includes("vp09"))) {
        return false;
      }
      if (pref === "av1" && av1Supported && (lower.includes("vp9") || lower.includes("vp09"))) {
        return false;
      }
      return baseFn(mimeType);
    };
  }

  function syncCinemaMode() {
    const active = isPlayerMasterOn() && Boolean(getPlayerSettings()["cinema-mode"]) && isWatchPage();
    let backdrop = document.getElementById(CINEMA_BACKDROP_ID);
    const watchFlexy = document.querySelector("ytd-watch-flexy");
    const theaterEl = document.querySelector("#player-theater-container");
    const useTheater = Boolean(
      theaterEl && (watchFlexy?.hasAttribute("theater") || theaterEl.querySelector("#movie_player"))
    );
    const playerContainer =
      (useTheater ? theaterEl : null) || document.querySelector("#player") || getPlayer();

    if (!active) {
      if (backdrop) backdrop.remove();
      const elevated = document.querySelectorAll("[data-shinku-cinema-z]");
      for (const el of elevated) {
        el.style.position = el.getAttribute("data-shinku-orig-pos") || "";
        el.style.zIndex = el.getAttribute("data-shinku-orig-z") || "";
        el.removeAttribute("data-shinku-orig-pos");
        el.removeAttribute("data-shinku-orig-z");
        el.removeAttribute("data-shinku-cinema-z");
      }
      return;
    }

    if (!backdrop && document.body) {
      backdrop = document.createElement("div");
      backdrop.id = CINEMA_BACKDROP_ID;
      Object.assign(backdrop.style, {
        position: "fixed",
        inset: "0",
        background: "rgba(0, 0, 0, 0.78)",
        pointerEvents: "none",
        zIndex: "1"
      });
      document.body.appendChild(backdrop);
    }
    if (playerContainer) {
      if (!playerContainer.hasAttribute("data-shinku-cinema-z")) {
        playerContainer.setAttribute("data-shinku-orig-pos", playerContainer.style.position || "");
        playerContainer.setAttribute("data-shinku-orig-z", playerContainer.style.zIndex || "");
        playerContainer.setAttribute("data-shinku-cinema-z", "1");
      }
      if (!playerContainer.style.position) {
        playerContainer.style.position = "relative";
      }
      playerContainer.style.zIndex = "2";
    }
  }

  function syncStickyMiniPlayer() {
    const active =
      isPlayerMasterOn() && Boolean(getPlayerSettings()["sticky-mini-player"]) && isWatchPage();
    const scrolled = (window.scrollY || 0) > 420;
    upsertStyleTag(
      STICKY_PLAYER_STYLE_ID,
      active && scrolled
        ? "#movie_player { position: fixed !important; bottom: 16px !important; right: 16px !important; width: 360px !important; height: 202px !important; z-index: 2147483646 !important; box-shadow: 0 8px 24px rgba(0,0,0,0.6) !important; border-radius: 8px !important; overflow: hidden !important; }\n#movie_player video.html5-main-video { width: 100% !important; height: 100% !important; left: 0 !important; top: 0 !important; object-fit: contain !important; }"
        : ""
    );
  }

  function captureVideoScreenshot() {
    const video = getVideo();
    if (!video || !video.videoWidth || !video.videoHeight) return;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx2d = canvas.getContext("2d");
      if (!ctx2d) return;
      ctx2d.drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/png");
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = `youtube-${pageID || "frame"}-${Math.floor(video.currentTime || 0)}s.png`;
      document.body?.appendChild(a);
      a.click();
      a.remove();
    } catch (_err) {
      console.debug("[Shinku YT] Screenshot skipped:", _err?.message || _err);
    }
  }

  function ensureScreenshotButton() {
    const shouldShow =
      isPlayerMasterOn() && Boolean(getPlayerSettings()["screenshot-btn"]) && isWatchPage();
    const existing = document.getElementById(SCREENSHOT_BUTTON_ID);
    if (!shouldShow) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return;
    const rightControls = document.querySelector("#movie_player .ytp-right-controls");
    if (!rightControls) return;

    const btn = document.createElement("button");
    btn.id = SCREENSHOT_BUTTON_ID;
    btn.type = "button";
    btn.className = "ytp-button";
    btn.textContent = "📷";
    btn.title = "Save Screenshot Frame";
    btn.setAttribute("aria-label", "Save Screenshot Frame");
    Object.assign(btn.style, {
      fontSize: "15px",
      lineHeight: "1",
      textAlign: "center",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      cursor: "pointer"
    });
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      captureVideoScreenshot();
    });
    rightControls.insertBefore(btn, rightControls.firstChild);
  }

  function updateLoopButtonVisual(btn) {
    if (!btn) return;
    const video = getVideo();
    const isLoop = Boolean(video && video.loop);
    btn.style.color = isLoop ? "#3ea6ff" : "#ffffff";
    btn.title = isLoop ? "Loop Enabled (Click to Disable)" : "Loop Video";
  }

  function ensureLoopButton() {
    const shouldShow =
      isPlayerMasterOn() && Boolean(getPlayerSettings()["loop-btn"]) && isWatchPage();
    const existing = document.getElementById(LOOP_BUTTON_ID);
    if (!shouldShow) {
      if (existing) existing.remove();
      const video = getVideo();
      if (video && video.hasAttribute("data-shinku-loop-managed")) {
        video.loop = false;
        video.removeAttribute("data-shinku-loop-managed");
      }
      return;
    }
    if (existing) {
      updateLoopButtonVisual(existing);
      return;
    }
    const rightControls = document.querySelector("#movie_player .ytp-right-controls");
    if (!rightControls) return;

    const btn = document.createElement("button");
    btn.id = LOOP_BUTTON_ID;
    btn.type = "button";
    btn.className = "ytp-button";
    btn.textContent = "🔁";
    btn.setAttribute("aria-label", "Toggle Loop Video");
    Object.assign(btn.style, {
      fontSize: "15px",
      lineHeight: "1",
      textAlign: "center",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      cursor: "pointer"
    });
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const video = getVideo();
      if (!video) return;
      video.loop = !video.loop;
      video.setAttribute("data-shinku-loop-managed", "1");
      updateLoopButtonVisual(btn);
    });
    rightControls.insertBefore(btn, rightControls.firstChild);
    updateLoopButtonVisual(btn);
  }

  function syncVolumeBoost() {
    const video = getVideo();
    if (!video || !videoGainNodes) return;
    const ps = getPlayerSettings();
    const enabled = isPlayerMasterOn() && Boolean(ps["volume-boost-enable"]) && isWatchPage();
    const levelPct = Number(ps["volume-boost-level"]);
    const targetGain = enabled
      ? Math.max(1, Math.min(3, (Number.isFinite(levelPct) ? levelPct : 150) / 100))
      : 1;

    let entry = videoGainNodes.get(video);
    if (!entry) {
      if (!enabled) return;
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (typeof AudioCtx !== "function") return;
      try {
        if (!audioCtx) audioCtx = new AudioCtx();
        const source = audioCtx.createMediaElementSource(video);
        const gainNode = audioCtx.createGain();
        source.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        entry = { gainNode };
        videoGainNodes.set(video, entry);
      } catch (_err) {
        console.debug("[Shinku YT] Volume boost setup skipped:", _err?.message || _err);
        return;
      }
    }
    entry.gainNode.gain.value = targetGain;
    if (enabled && audioCtx && audioCtx.state === "suspended" && typeof audioCtx.resume === "function") {
      audioCtx.resume().catch((err) => console.debug("[Shinku YT] AudioContext resume skipped:", err));
    }
  }

  function syncTabPlaybackChannel() {
    const active = isPlayerMasterOn() && Boolean(getPlayerSettings()["pause-other-tabs"]);
    if (!active) {
      if (tabChannel) {
        try {
          tabChannel.close();
        } catch (_err) {
          console.debug("[Shinku YT] BroadcastChannel close skipped:", _err?.message || _err);
        }
        tabChannel = null;
      }
      return;
    }
    if (tabChannel || typeof window.BroadcastChannel !== "function") return;
    try {
      tabChannel = new window.BroadcastChannel("shinku_yt_tab_playback");
      tabChannel.onmessage = (ev) => {
        if (!isPlayerMasterOn() || !getPlayerSettings()["pause-other-tabs"]) return;
        const data = ev?.data;
        if (!data || data.type !== "play" || data.tabToken === tabToken) return;
        const player = getPlayer();
        const video = getVideo();
        isReceivingTabPause = true;
        try {
          if (player && typeof player.pauseVideo === "function") {
            player.pauseVideo();
          } else if (video && !video.paused) {
            video.pause();
          }
        } finally {
          isReceivingTabPause = false;
        }
      };
    } catch (_err) {
      console.debug("[Shinku YT] BroadcastChannel init skipped:", _err?.message || _err);
    }
  }

  function broadcastTabPlay() {
    if (isReceivingTabPause || !tabChannel) return;
    if (!isPlayerMasterOn() || !getPlayerSettings()["pause-other-tabs"]) return;
    try {
      tabChannel.postMessage({ type: "play", tabToken });
    } catch (_err) {
      console.debug("[Shinku YT] BroadcastChannel post skipped:", _err?.message || _err);
    }
  }

  function checkIdleContinueDialog() {
    if (!isPlayerMasterOn() || !getPlayerSettings()["prevent-idle-pause"]) return;
    const dialogs = document.querySelectorAll("yt-confirm-dialog-renderer, tp-yt-paper-dialog");
    for (const dialog of dialogs) {
      const text = (dialog.textContent || "").toLowerCase();
      if (text.includes("continue watching") || text.includes("still watching")) {
        const confirmBtn = dialog.querySelector("#confirm-button button, #confirm-button");
        if (confirmBtn) {
          confirmBtn.click();
          const player = getPlayer();
          const video = getVideo();
          if (player && typeof player.playVideo === "function") {
            player.playVideo();
          } else if (video && video.paused) {
            video.play().catch((err) => console.debug("[Shinku YT] Idle resume skipped:", err));
          }
        }
      }
    }
  }

  function syncIdleCheckTimer() {
    const active = isPlayerMasterOn() && Boolean(getPlayerSettings()["prevent-idle-pause"]);
    if (!active) {
      if (idleCheckTimerId !== null) {
        clearInterval(idleCheckTimerId);
        idleCheckTimerId = null;
      }
      return;
    }
    if (idleCheckTimerId === null) {
      idleCheckTimerId = setInterval(checkIdleContinueDialog, 5000);
    }
  }

  function applyAutoPause() {
    if (!isPlayerMasterOn() || !getPlayerSettings()["pause"] || !isWatchPage()) {
      return;
    }
    if (autoPausedForId === pageID) {
      return;
    }
    const video = getVideo();
    if (!video) {
      return;
    }
    // Only mark as auto-paused once the video is actually playing or has metadata ready;
    // otherwise YouTube's autoplay can start playback right after and override an early pause.
    if (video.paused && video.readyState < 1) {
      return;
    }
    autoPausedForId = pageID;
    const player = getPlayer();
    if (player && typeof player.pauseVideo === "function") {
      player.pauseVideo();
    } else if (!video.paused) {
      video.pause();
    }
  }

  function applyFastResume() {
    if (!isPlayerMasterOn() || !getPlayerSettings()["force-seek-to-saved"] || !isWatchPage()) {
      return;
    }
    if (fastResumeAppliedForId === pageID) {
      return;
    }
    const saved = shinkuLibrary?.[pageID];
    const savedTime = saved && Number(saved.currentTime);
    if (!Number.isFinite(savedTime) || savedTime <= 1) {
      return;
    }
    const video = getVideo();
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0 || video.readyState < 1) {
      return;
    }
    const player = getPlayer();
    const playerVideoId =
      player && typeof player.getVideoData === "function"
        ? player.getVideoData()?.video_id
        : null;
    if (playerVideoId && pageID && playerVideoId !== pageID) {
      return;
    }
    if (savedTime >= video.duration - 5) {
      return;
    }

    fastResumeAppliedForId = pageID;
    if (player && typeof player.seekTo === "function") {
      player.seekTo(savedTime, true);
    } else {
      video.currentTime = savedTime;
    }
  }

  function getSortedLibraryIds(library) {
    if (!library || typeof library !== "object") {
      return [];
    }
    const entries = Array.isArray(library)
      ? library
          .filter((item) => item && typeof item === "object" && (item.id || item.videoId) && !item.done)
          .map((item) => [String(item.id || item.videoId), item])
      : Object.entries(library)
          .filter(([, item]) => item && typeof item === "object" && !item.done)
          .map(([key, item]) => [String(item.id || item.videoId || key), item]);

    entries.sort(([, a], [, b]) => {
      const ta = Number(a?.updatedAt || a?.lastWatched || a?.timestamp || 0);
      const tb = Number(b?.updatedAt || b?.lastWatched || b?.timestamp || 0);
      return tb - ta;
    });

    return entries.map(([id]) => id);
  }

  function handleVideoEnded() {
    if (!isPlaylistMasterOn() || !isWatchPage()) {
      return;
    }
    const pls = getPlaylistSettings();
    if (!pls["auto-next"] && !pls["auto-update-library"]) {
      return;
    }
    if (endedHandledForId === pageID) {
      return;
    }
    endedHandledForId = pageID;

    if (isVideoSaved(pageID)) {
      const video = getVideo();
      const duration = video && Number.isFinite(video.duration) ? Math.floor(video.duration) : 0;
      const entry = {
        ...shinkuLibrary[pageID],
        videoId: pageID,
        currentTime: duration || shinkuLibrary[pageID].currentTime || 0,
        duration: duration || shinkuLibrary[pageID].duration || 0,
        done: true,
        doneAt: Date.now(),
        updatedAt: Date.now()
      };
      shinkuLibrary[pageID] = entry;
      postToBridge("SHINKU__saveToLibrary", { videoId: pageID, entry });
    }

    if (!pls["auto-next"]) {
      return;
    }

    const keys = getSortedLibraryIds(shinkuLibrary).filter((k) => k !== pageID);
    if (keys.length === 0) {
      return;
    }

    const nextId = keys[0];
    window.location.assign(`https://www.youtube.com/watch?v=${encodeURIComponent(nextId)}`);
  }

  function handleVideoMetadata() {
    applyQualityLock();
    applyPlaybackSpeed();
    applyOriginalAudioTrack();
    syncVolumeBoost();
    applyFastResume();
  }

  function handleVideoPlay() {
    applyAutoPause();
    syncVolumeBoost();
    broadcastTabPlay();
  }

  function bindVideoElement() {
    const video = getVideo();
    if (!video || video === boundVideoEl) {
      return;
    }
    unbindVideoElement();
    boundVideoEl = video;
    boundVideoEl.addEventListener("ended", handleVideoEnded);
    boundVideoEl.addEventListener("loadedmetadata", handleVideoMetadata);
    boundVideoEl.addEventListener("play", handleVideoPlay);
  }

  function unbindVideoElement() {
    if (boundVideoEl) {
      boundVideoEl.removeEventListener("ended", handleVideoEnded);
      boundVideoEl.removeEventListener("loadedmetadata", handleVideoMetadata);
      boundVideoEl.removeEventListener("play", handleVideoPlay);
      boundVideoEl = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Video Time Tracker (Auto-Update Library every 15s)
  // ---------------------------------------------------------------------------

  function stopVideoTimeTracker() {
    if (trackerTimerId !== null) {
      clearTimeout(trackerTimerId);
      trackerTimerId = null;
    }
  }

  function scheduleVideoTimeTracker() {
    stopVideoTimeTracker();
    const pls = getPlaylistSettings();
    if (!isPlaylistMasterOn() || (!pls["auto-update-library"] && !pls["auto-next"]) || !isWatchPage()) {
      return;
    }
    trackerTimerId = setTimeout(videoTimeTracker, TRACKER_INTERVAL_MS);
  }

  function videoTimeTracker() {
    trackerTimerId = null;
    const pls = getPlaylistSettings();
    if (!isPlaylistMasterOn() || (!pls["auto-update-library"] && !pls["auto-next"]) || !isWatchPage()) {
      return;
    }

    const video = getVideo();
    if (pls["auto-update-library"] && video && pageID && isVideoSaved(pageID) && Number.isFinite(video.currentTime)) {
      const savedTime = Number(shinkuLibrary[pageID].currentTime) || 0;
      const current = Math.floor(video.currentTime);
      const duration = Number.isFinite(video.duration) ? Math.floor(video.duration) : 0;

      if (Math.abs(current - savedTime) > 1) {
        const entry = {
          ...shinkuLibrary[pageID],
          videoId: pageID,
          currentTime: current,
          duration: duration || shinkuLibrary[pageID].duration || 0,
          updatedAt: Date.now()
        };
        shinkuLibrary[pageID] = entry;
        postToBridge("SHINKU__saveToLibrary", { videoId: pageID, entry });
      }
    }

    // Fallback check for video end in case player state ended without DOM event
    const player = getPlayer();
    if (
      (pls["auto-next"] || pls["auto-update-library"]) &&
      ((video && video.ended) || (player && typeof player.getPlayerState === "function" && player.getPlayerState() === 0))
    ) {
      handleVideoEnded();
      return;
    }

    scheduleVideoTimeTracker();
  }

  // ---------------------------------------------------------------------------
  // Feed & Frame Removal (with clean attribute-based restore on hot-reload)
  // ---------------------------------------------------------------------------

  const FEED_ITEM_SELECTOR = [
    "ytd-rich-item-renderer",
    "ytd-video-renderer",
    "ytd-grid-video-renderer",
    "ytd-compact-video-renderer",
    "ytd-reel-item-renderer",
    "ytd-rich-shelf-renderer",
    "ytd-reel-shelf-renderer",
    "ytd-rich-section-renderer",
    "ytd-shelf-renderer",
    "ytd-horizontal-card-list-renderer",
    "ytd-statement-banner-renderer",
    "ytd-radio-renderer",
    "ytd-backstage-post-thread-renderer",
    "ytd-post-renderer",
    "yt-lockup-view-model",
    "grid-shelf-view-model",
    "ytd-mini-game-card-view-model",
    "ytm-shorts-lockup-view-model",
    "ytm-shorts-lockup-view-model-v2"
  ].join(",");

  const SHELF_CONTAINER_TAGS = new Set([
    "YTD-RICH-SHELF-RENDERER",
    "YTD-REEL-SHELF-RENDERER",
    "YTD-RICH-SECTION-RENDERER",
    "YTD-SHELF-RENDERER",
    "YTD-HORIZONTAL-CARD-LIST-RENDERER",
    "GRID-SHELF-VIEW-MODEL"
  ]);

  function getShelfTitleText(el) {
    const titleEl = el.querySelector(
      "#title, #title-text, yt-shelf-header-layout h2, .yt-shelf-header-layout__title, h2"
    );
    return (titleEl?.textContent || "").trim().toLowerCase();
  }

  function hasThumbnailBadgeText(el, targetWord) {
    const badges = el.querySelectorAll(
      "yt-thumbnail-overlay-badge-view-model, yt-thumbnail-badge-view-model, badge-shape, .badge-shape-wiz__text, ytd-thumbnail-overlay-time-status-renderer"
    );
    for (const badge of badges) {
      if ((badge.textContent || "").trim().toUpperCase() === targetWord) {
        return true;
      }
    }
    return false;
  }

  function getBlockedKeywordsList(fs) {
    return String(fs["blocked-keywords"] || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }

  function isWatchedProgressHigh(el) {
    const progressEl = el.querySelector(
      "#progress, .ytThumbnailOverlayProgressBarHostWatchedProgressBarSegment, .yt-thumbnail-overlay-progress-bar-view-model__progress-bar"
    );
    if (!progressEl || !progressEl.style || !progressEl.style.width) {
      return false;
    }
    const pct = parseFloat(progressEl.style.width);
    return Number.isFinite(pct) && pct >= 90;
  }

  function matchesBlockedKeyword(el, keywords) {
    if (!keywords || keywords.length === 0) return false;
    const titleEl = el.querySelector(
      "#video-title, h3, .yt-lockup-metadata-view-model__title"
    );
    const channelEl = el.querySelector(
      "#channel-name, ytd-channel-name, yt-content-metadata-view-model"
    );
    const combined = `${titleEl?.textContent || ""} ${channelEl?.textContent || ""}`.toLowerCase();
    if (!combined.trim()) return false;
    return keywords.some((kw) => combined.includes(kw));
  }

  function classifyFeedItem(el, blockedKeywords = []) {
    const tag = el.tagName;
    const isShelfContainer = SHELF_CONTAINER_TAGS.has(tag);

    if (tag === "YTD-BACKSTAGE-POST-THREAD-RENDERER" || tag === "YTD-POST-RENDERER") {
      return "posts";
    }

    if (
      tag === "YTD-MINI-GAME-CARD-VIEW-MODEL" ||
      el.hasAttribute("is-playables") ||
      el.hasAttribute("is-playable") ||
      Boolean(el.querySelector('ytd-mini-game-card-view-model, a[href*="/playables"]')) ||
      (isShelfContainer && getShelfTitleText(el).includes("playables"))
    ) {
      return "playables";
    }

    if (
      tag === "YTD-REEL-ITEM-RENDERER" ||
      tag === "YTD-REEL-SHELF-RENDERER" ||
      tag === "YTM-SHORTS-LOCKUP-VIEW-MODEL" ||
      tag === "YTM-SHORTS-LOCKUP-VIEW-MODEL-V2" ||
      el.hasAttribute("is-shorts") ||
      Boolean(
        el.querySelector(
          'a[href*="/shorts/"], [overlay-style="SHORTS"], ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2, ytd-reel-shelf-renderer'
        )
      ) ||
      (isShelfContainer && getShelfTitleText(el) === "shorts")
    ) {
      return "shorts";
    }

    if (tag === "YTD-STATEMENT-BANNER-RENDERER") {
      return "news-movies";
    }

    if (isShelfContainer) {
      const shelfTitle = getShelfTitleText(el);
      if (
        shelfTitle.includes("people also watched") ||
        shelfTitle.includes("for you") ||
        shelfTitle.includes("previously watched") ||
        shelfTitle.includes("related to your search") ||
        shelfTitle.includes("others searched for")
      ) {
        return "search-filler";
      }
      if (
        shelfTitle.includes("breaking news") ||
        shelfTitle.includes("top news") ||
        shelfTitle.includes("movies & tv") ||
        shelfTitle.includes("primetime movies")
      ) {
        return "news-movies";
      }
      return null;
    }

    if (
      tag === "YTD-RADIO-RENDERER" ||
      Boolean(
        el.querySelector(
          'ytd-radio-renderer, a[href*="start_radio=1"], a[href*="list=RD"], ytd-thumbnail-overlay-bottom-panel-renderer'
        )
      ) ||
      hasThumbnailBadgeText(el, "MIX")
    ) {
      return "mixes";
    }

    if (
      Boolean(
        el.querySelector(
          '.badge-style-type-members-only, ytd-badge-supported-renderer[aria-label*="Members only" i]'
        )
      ) ||
      hasThumbnailBadgeText(el, "MEMBERS ONLY")
    ) {
      return "members";
    }

    if (
      Boolean(
        el.querySelector(
          '[overlay-style="LIVE"], .badge-style-type-live-now-alternate, ytd-badge-supported-renderer[aria-label*="LIVE" i], .yt-badge-shape--thumbnail-live, .badge-shape-wiz--thumbnail-live'
        )
      ) ||
      hasThumbnailBadgeText(el, "LIVE")
    ) {
      return "live";
    }

    if (
      Boolean(el.querySelector('[overlay-style="UPCOMING"], button[aria-label*="Notify me" i]')) ||
      hasThumbnailBadgeText(el, "UPCOMING")
    ) {
      return "upcoming";
    }

    const metaEl = el.querySelector("#metadata-line, yt-content-metadata-view-model");
    const metaText = (metaEl?.textContent || "").toLowerCase();
    if (metaText.includes("streamed ")) {
      return "streamed";
    }
    if (metaText.includes("premieres") || metaText.includes("upcoming")) {
      return "upcoming";
    }
    if (metaText.includes("members only")) {
      return "members";
    }

    if (isWatchedProgressHigh(el)) {
      return "watched";
    }

    if (matchesBlockedKeyword(el, blockedKeywords)) {
      return "keyword";
    }

    return null;
  }

  function restoreHiddenItems(category) {
    const selector = category
      ? `[data-shinku-hidden="${category}"]`
      : "[data-shinku-hidden]";
    const hiddenEls = document.querySelectorAll(selector);
    for (const el of hiddenEls) {
      el.style.display = "";
      el.removeAttribute("data-shinku-hidden");
    }
  }

  function applyContentFilter() {
    if (!userSetting) return;
    const fs = getFrameSettings();

    if (!isFrameMasterOn()) {
      restoreHiddenItems(null);
      return;
    }

    const blockedKeywords = getBlockedKeywordsList(fs);
    const enabledCategories = {
      shorts: Boolean(fs["shorts-removal"]),
      live: Boolean(fs["live-removal"]),
      streamed: Boolean(fs["streamed-removal"]),
      upcoming: Boolean(fs["upcoming-removal"]),
      playables: Boolean(fs["playables-removal"]),
      mixes: Boolean(fs["mixes-removal"]),
      members: Boolean(fs["members-removal"]),
      posts: Boolean(fs["posts-removal"]),
      watched: Boolean(fs["watched-removal"]),
      "search-filler": Boolean(fs["search-filler-removal"]),
      "news-movies": Boolean(fs["news-movies-removal"]),
      keyword: blockedKeywords.length > 0
    };

    // Always re-evaluate keyword-hidden items in case blocked-keywords changed
    restoreHiddenItems("keyword");

    // Restore any categories that were turned off
    for (const [cat, enabled] of Object.entries(enabledCategories)) {
      if (!enabled) {
        restoreHiddenItems(cat);
      }
    }

    const items = document.querySelectorAll(FEED_ITEM_SELECTOR);
    for (const el of items) {
      if (el.hasAttribute("data-shinku-hidden")) {
        continue;
      }
      if (el.parentElement && el.parentElement.closest("[data-shinku-hidden]")) {
        continue;
      }
      const category = classifyFeedItem(el, blockedKeywords);
      if (category && enabledCategories[category]) {
        el.setAttribute("data-shinku-hidden", category);
        el.style.display = "none";
      } else if (enabledCategories.keyword && matchesBlockedKeyword(el, blockedKeywords)) {
        el.setAttribute("data-shinku-hidden", "keyword");
        el.style.display = "none";
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Thumbnail Hover-Preview Blocker (Hidden Shield Layer)
  // ---------------------------------------------------------------------------

  const HOVER_SHIELD_CLASS = "shinku-hover-shield";
  const THUMBNAIL_SELECTOR = "ytd-thumbnail, yt-thumbnail-view-model, ytd-playlist-thumbnail";
  const CARD_SELECTOR =
    "ytd-rich-item-renderer, ytd-rich-grid-media, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer, yt-lockup-view-model";
  const HOVER_CAPTURE_EVENTS = [
    "pointerover",
    "pointerenter",
    "mouseover",
    "mouseenter",
    "pointermove",
    "mousemove"
  ];
  let activeHoverShield = null;
  let activeHoverTimer = null;
  let activeHoverX = 0;
  let activeHoverY = 0;
  let unlockedShieldEntry = null; // { shield, container, card }
  let hoverCaptureAttached = false;
  let isDispatchingSyntheticHover = false;

  function showShieldHoverState(shield, delayMs) {
    if (!shield) return;
    shield.style.background = "rgba(0, 0, 0, 0.10)";
    shield.style.boxShadow = "inset 0 0 0 1px rgba(255, 255, 255, 0.18)";
    const indicator = shield.firstElementChild;
    if (!indicator) return;
    indicator.style.display = "block";
    const bar = indicator.lastElementChild;
    if (bar) {
      bar.style.transition = "none";
      bar.style.width = "0%";
      if (delayMs > 0) {
        // Force style flush so the width transition animates from 0% to 100%
        void bar.offsetWidth;
        bar.style.transition = `width ${delayMs}ms linear`;
        bar.style.width = "100%";
      } else {
        bar.style.width = "100%";
      }
    }
  }

  function hideShieldHoverState(shield) {
    if (!shield) return;
    shield.style.background = "transparent";
    shield.style.boxShadow = "none";
    const indicator = shield.firstElementChild;
    if (!indicator) return;
    indicator.style.display = "none";
    const bar = indicator.lastElementChild;
    if (bar) {
      bar.style.transition = "none";
      bar.style.width = "0%";
    }
  }

  function clearActiveHoverTimer() {
    if (activeHoverTimer !== null) {
      clearTimeout(activeHoverTimer);
      activeHoverTimer = null;
    }
    if (activeHoverShield) {
      hideShieldHoverState(activeHoverShield);
    }
    activeHoverShield = null;
  }

  function restoreUnlockedShield() {
    if (!unlockedShieldEntry) return;
    const { shield } = unlockedShieldEntry;
    unlockedShieldEntry = null;
    if (shield && shield.dataset.shinkuUnlocked === "1") {
      delete shield.dataset.shinkuUnlocked;
      shield.style.display = "block";
      shield.style.pointerEvents = "auto";
    }
  }

  function isPointerStillOverUnlocked(activeTarget) {
    if (!unlockedShieldEntry) return false;
    const { container, card } = unlockedShieldEntry;
    if (!container.isConnected) return false;
    if (!activeTarget) {
      return Boolean(container.matches?.(":hover") || card?.matches?.(":hover"));
    }
    const overContainer = container.contains(activeTarget);
    const overCard = Boolean(card && card.contains(activeTarget));
    const overPortal =
      typeof activeTarget.closest === "function" &&
      Boolean(activeTarget.closest("ytd-video-preview"));
    return Boolean(overContainer || overCard || overPortal);
  }

  function isPointInRect(x, y, rect) {
    if (!rect || (rect.width === 0 && rect.height === 0)) return false;
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  function findLockedShieldForEvent(e, target) {
    if (!target || typeof target.closest !== "function") {
      return null;
    }
    const directShield = target.classList?.contains(HOVER_SHIELD_CLASS)
      ? target
      : target.closest(`.${HOVER_SHIELD_CLASS}`);
    let container = directShield
      ? directShield.parentElement
      : target.closest("[data-shinku-hover-guarded]");

    if (!container && (e.type === "mouseenter" || e.type === "pointerenter")) {
      const card =
        target.closest(CARD_SELECTOR) || (target.matches?.(CARD_SELECTOR) ? target : null);
      if (card) {
        const thumb = card.querySelector("[data-shinku-hover-guarded]");
        if (thumb && typeof e.clientX === "number" && typeof e.clientY === "number") {
          if (isPointInRect(e.clientX, e.clientY, thumb.getBoundingClientRect())) {
            container = thumb;
          }
        }
      }
    }

    if (!container) return null;
    const shield =
      directShield || container.querySelector(`:scope > .${HOVER_SHIELD_CLASS}`);
    if (!shield || shield.dataset.shinkuUnlocked === "1") {
      return null;
    }
    return { shield, container };
  }

  function handleHoverCapture(e) {
    if (isDispatchingSyntheticHover) {
      return;
    }
    const target = e.target;

    if (unlockedShieldEntry && !isPointerStillOverUnlocked(target)) {
      restoreUnlockedShield();
    }
    if (!isHoverGuardOn()) {
      clearActiveHoverTimer();
      return;
    }

    const match = findLockedShieldForEvent(e, target);
    if (!match) {
      if (e.type === "mousemove" || e.type === "pointermove" || e.type === "mouseover" || e.type === "pointerover") {
        clearActiveHoverTimer();
      }
      return;
    }

    const { shield, container } = match;
    if (typeof e.clientX === "number" && typeof e.clientY === "number") {
      activeHoverX = e.clientX;
      activeHoverY = e.clientY;
    }

    if (activeHoverShield !== shield) {
      clearActiveHoverTimer();
      activeHoverShield = shield;
      const delayMs = getHoverGuardDelayMs();
      showShieldHoverState(shield, delayMs);
      activeHoverTimer = setTimeout(() => {
        activeHoverTimer = null;
        if (!isHoverGuardOn() || !container.isConnected || activeHoverShield !== shield) {
          return;
        }
        hideShieldHoverState(shield);
        activeHoverShield = null;
        restoreUnlockedShield();
        shield.dataset.shinkuUnlocked = "1";
        shield.style.pointerEvents = "none";
        shield.style.display = "none";

        const parentCard = container.closest(CARD_SELECTOR);
        unlockedShieldEntry = { shield, container, card: parentCard };

        const under =
          (typeof document.elementFromPoint === "function"
            ? document.elementFromPoint(activeHoverX, activeHoverY)
            : null) ||
          container.querySelector("a#thumbnail, #mouseover-overlay, img") ||
          container;
        const hoverTarget = container.contains(under) ? under : container;
        if (parentCard) {
          dispatchSyntheticHover(parentCard, activeHoverX, activeHoverY);
        }
        dispatchSyntheticHover(hoverTarget, activeHoverX, activeHoverY);
      }, delayMs);
    }

    e.stopImmediatePropagation();
  }

  function handlePageMouseLeave() {
    clearActiveHoverTimer();
    restoreUnlockedShield();
  }

  function ensureHoverCaptureListeners() {
    if (hoverCaptureAttached) return;
    for (const evtName of HOVER_CAPTURE_EVENTS) {
      window.addEventListener(evtName, handleHoverCapture, true);
    }
    document.addEventListener("mouseleave", handlePageMouseLeave);
    hoverCaptureAttached = true;
  }

  function removeHoverCaptureListeners() {
    if (!hoverCaptureAttached) return;
    for (const evtName of HOVER_CAPTURE_EVENTS) {
      window.removeEventListener(evtName, handleHoverCapture, true);
    }
    document.removeEventListener("mouseleave", handlePageMouseLeave);
    hoverCaptureAttached = false;
  }

  function removeAllHoverGuards() {
    removeHoverCaptureListeners();
    clearActiveHoverTimer();
    restoreUnlockedShield();
    const leftovers = document.querySelectorAll(`.${HOVER_SHIELD_CLASS}`);
    for (const el of leftovers) {
      el.remove();
    }
    const containers = document.querySelectorAll("[data-shinku-hover-guarded]");
    for (const container of containers) {
      container.removeAttribute("data-shinku-hover-guarded");
    }
  }

  function dispatchSyntheticHover(target, clientX, clientY) {
    if (!target) return;
    const MouseEvt = typeof window.MouseEvent === "function" ? window.MouseEvent : null;
    const PointerEvt = typeof window.PointerEvent === "function" ? window.PointerEvent : null;

    const commonInit = {
      clientX,
      clientY,
      view: window
    };

    const events = [
      { Ctor: PointerEvt, type: "pointerover", bubbles: true },
      { Ctor: PointerEvt, type: "pointerenter", bubbles: false },
      { Ctor: MouseEvt, type: "mouseover", bubbles: true },
      { Ctor: MouseEvt, type: "mouseenter", bubbles: false },
      { Ctor: MouseEvt, type: "mousemove", bubbles: true }
    ];

    isDispatchingSyntheticHover = true;
    try {
      for (const { Ctor, type, bubbles } of events) {
        if (!Ctor) continue;
        try {
          target.dispatchEvent(new Ctor(type, { ...commonInit, bubbles, cancelable: true }));
        } catch (_err) {
          console.debug("[Shinku YT] dispatchSyntheticHover skipped:", _err?.message || _err);
        }
      }
    } finally {
      isDispatchingSyntheticHover = false;
    }
  }

  function attachHoverGuard(container) {
    if (!container || container.hasAttribute("data-shinku-hover-guarded")) {
      return;
    }
    if (
      container.closest("#movie_player") ||
      container.closest("ytd-reel-video-renderer") ||
      container.closest("[data-shinku-hidden]")
    ) {
      return;
    }
    if (container.parentElement && container.parentElement.closest(THUMBNAIL_SELECTOR)) {
      return;
    }

    container.setAttribute("data-shinku-hover-guarded", "1");
    if (typeof window.getComputedStyle === "function") {
      const cs = window.getComputedStyle(container);
      if (cs.position === "static") {
        container.style.position = "relative";
      }
      if (cs.display === "inline") {
        container.style.display = "block";
      }
    } else if (!container.style.position) {
      container.style.position = "relative";
    }

    const shield = document.createElement("div");
    shield.className = HOVER_SHIELD_CLASS;
    shield.setAttribute("aria-hidden", "true");
    Object.assign(shield.style, {
      position: "absolute",
      top: "0",
      left: "0",
      width: "100%",
      height: "100%",
      display: "block",
      zIndex: "2147483646",
      background: "transparent",
      boxShadow: "none",
      pointerEvents: "auto",
      cursor: "pointer"
    });

    const indicator = document.createElement("div");
    indicator.className = "shinku-hover-indicator";
    Object.assign(indicator.style, {
      position: "absolute",
      inset: "0",
      display: "none",
      pointerEvents: "none"
    });

    const pill = document.createElement("div");
    pill.textContent = "Preview blocked";
    Object.assign(pill.style, {
      position: "absolute",
      top: "6px",
      left: "6px",
      padding: "2px 6px",
      borderRadius: "4px",
      background: "rgba(15, 15, 15, 0.65)",
      color: "rgba(255, 255, 255, 0.85)",
      fontSize: "10px",
      fontWeight: "500",
      fontFamily: "Roboto, Arial, sans-serif",
      lineHeight: "1.3",
      letterSpacing: "0.02em",
      pointerEvents: "none"
    });

    const bar = document.createElement("div");
    Object.assign(bar.style, {
      position: "absolute",
      left: "0",
      bottom: "0",
      height: "2px",
      width: "0%",
      background: "rgba(255, 255, 255, 0.6)",
      pointerEvents: "none"
    });

    indicator.appendChild(pill);
    indicator.appendChild(bar);
    shield.appendChild(indicator);

    const cancelHoverTimer = () => {
      if (activeHoverShield === shield) {
        clearActiveHoverTimer();
      }
    };

    shield.addEventListener("mouseleave", cancelHoverTimer);

    const forwardClickIfNeeded = (e) => {
      // If container is already wrapped by an <a>, let the click bubble naturally.
      if (container.closest("a[href]")) {
        return;
      }
      const link = container.querySelector("a[href]");
      if (!link) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const MouseEvt = typeof window.MouseEvent === "function" ? window.MouseEvent : null;
      if (MouseEvt && e.type === "click" && (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey)) {
        link.dispatchEvent(
          new MouseEvt("click", {
            bubbles: true,
            cancelable: true,
            ctrlKey: e.ctrlKey,
            metaKey: e.metaKey,
            shiftKey: e.shiftKey,
            altKey: e.altKey,
            button: e.button,
            view: window
          })
        );
      } else if (e.type === "auxclick" && MouseEvt) {
        link.dispatchEvent(
          new MouseEvt("auxclick", {
            bubbles: true,
            cancelable: true,
            button: e.button,
            ctrlKey: e.ctrlKey,
            metaKey: e.metaKey,
            view: window
          })
        );
      } else {
        link.click();
      }
    };

    shield.addEventListener("click", forwardClickIfNeeded);
    shield.addEventListener("auxclick", forwardClickIfNeeded);

    container.appendChild(shield);
  }

  const THUMB_BOOKMARK_BTN_CLASS = "shinku-thumb-bookmark-btn";

  function isThumbnailBookmarkOn() {
    return isPlaylistMasterOn() && Boolean(getPlaylistSettings()["thumbnail-bookmark-btn"]);
  }

  function removeAllThumbnailBookmarkButtons() {
    const btns = document.querySelectorAll(`.${THUMB_BOOKMARK_BTN_CLASS}`);
    for (const btn of btns) {
      btn.remove();
    }
  }

  function extractCardMetadata(container) {
    const link = container.closest("a[href]") || container.querySelector("a[href]");
    const href = link?.getAttribute("href") || "";
    const absUrl = href ? new URL(href, window.location.origin).href : "";
    const videoId = absUrl ? extractVideoId(absUrl) : null;
    if (!videoId) return null;

    const card = container.closest(CARD_SELECTOR) || container.parentElement;
    const titleEl = card?.querySelector(
      "#video-title, h3, .yt-lockup-metadata-view-model__title"
    );
    const channelEl = card?.querySelector(
      "#channel-name a, #channel-name, ytd-channel-name a, .yt-content-metadata-view-model__metadata-text"
    );
    const title = titleEl?.textContent?.trim() || `YouTube Video (${videoId})`;
    const channel = channelEl?.textContent?.trim() || "";

    return {
      id: videoId,
      videoId,
      title,
      channel,
      uploader: channel || "YouTube",
      thumbnail: `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/mqdefault.jpg`,
      url: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
      currentTime: 0,
      duration: 0,
      done: false,
      doneAt: null,
      updatedAt: Date.now()
    };
  }

  function updateThumbBookmarkButtonVisual(btn, videoId) {
    const saved = isVideoSaved(videoId);
    btn.textContent = saved ? "✓" : "+";
    const label = saved ? "Remove from Shinku Watch Later" : "Save to Shinku Watch Later";
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.style.color = saved ? "#3ea6ff" : "#ffffff";
  }

  function updateAllThumbnailBookmarkButtons() {
    const btns = document.querySelectorAll(`.${THUMB_BOOKMARK_BTN_CLASS}`);
    for (const btn of btns) {
      const vid = btn.dataset.shinkuVideoId;
      if (vid) updateThumbBookmarkButtonVisual(btn, vid);
    }
  }

  function attachThumbnailBookmarkButton(container) {
    if (
      !container ||
      container.querySelector(`:scope > .${THUMB_BOOKMARK_BTN_CLASS}`) ||
      container.closest("#movie_player") ||
      container.closest("ytd-reel-video-renderer") ||
      container.closest("[data-shinku-hidden]")
    ) {
      return;
    }
    if (container.parentElement && container.parentElement.closest(THUMBNAIL_SELECTOR)) {
      return;
    }
    const meta = extractCardMetadata(container);
    if (!meta) return;

    if (typeof window.getComputedStyle === "function") {
      if (window.getComputedStyle(container).position === "static") {
        container.style.position = "relative";
      }
    } else if (!container.style.position) {
      container.style.position = "relative";
    }

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = THUMB_BOOKMARK_BTN_CLASS;
    btn.dataset.shinkuVideoId = meta.videoId;
    Object.assign(btn.style, {
      position: "absolute",
      top: "6px",
      right: "6px",
      zIndex: "2147483647",
      width: "24px",
      height: "24px",
      padding: "0",
      border: "1px solid rgba(255, 255, 255, 0.25)",
      borderRadius: "4px",
      background: "rgba(15, 15, 15, 0.78)",
      fontSize: "15px",
      fontWeight: "700",
      lineHeight: "1",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      cursor: "pointer"
    });
    updateThumbBookmarkButtonVisual(btn, meta.videoId);

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const latest = extractCardMetadata(container) || meta;
      if (isVideoSaved(latest.videoId)) {
        const nextLib = { ...shinkuLibrary };
        delete nextLib[latest.videoId];
        shinkuLibrary = nextLib;
        updateThumbBookmarkButtonVisual(btn, latest.videoId);
        postToBridge("SHINKU__saveToLibrary", { videoId: latest.videoId, remove: true });
      } else {
        shinkuLibrary = {
          ...shinkuLibrary,
          [latest.videoId]: { ...(shinkuLibrary[latest.videoId] || {}), ...latest }
        };
        updateThumbBookmarkButtonVisual(btn, latest.videoId);
        postToBridge("SHINKU__saveToLibrary", { videoId: latest.videoId, entry: latest });
      }
    });

    container.appendChild(btn);
  }

  function syncThumbnailBookmarkButtons() {
    if (!userSetting) return;
    if (!isThumbnailBookmarkOn()) {
      removeAllThumbnailBookmarkButtons();
      return;
    }
    const thumbnails = document.querySelectorAll(THUMBNAIL_SELECTOR);
    for (const thumb of thumbnails) {
      attachThumbnailBookmarkButton(thumb);
    }
  }

  function syncHoverPreviewGuards() {
    if (!userSetting) return;
    if (!isHoverGuardOn()) {
      removeAllHoverGuards();
      return;
    }
    ensureHoverCaptureListeners();
    const thumbnails = document.querySelectorAll(THUMBNAIL_SELECTOR);
    for (const thumb of thumbnails) {
      attachHoverGuard(thumb);
    }
  }

  // ---------------------------------------------------------------------------
  // Thumbnails, Titles & Links Transforms
  // ---------------------------------------------------------------------------

  function cleanClickbaitText(str) {
    if (!str) return str;
    let cleaned = str.replace(/([!?])\1+/g, "$1");
    cleaned = cleaned.replace(/\b([A-Z]{3,})\b/g, (word) => {
      return word.charAt(0) + word.slice(1).toLowerCase();
    });
    return cleaned.trim();
  }

  function syncThumbnailStyle() {
    if (!isThumbnailMasterOn()) {
      upsertStyleTag(THUMBNAIL_STYLE_ID, "");
      return;
    }
    const ts = getThumbnailSettings();
    const rules = [];
    if (ts["hide-social-counts"]) {
      rules.push(
        "#metadata-line, .yt-content-metadata-view-model__metadata-row:nth-child(2), #owner-sub-count, #info-strings { display: none !important; }"
      );
    }
    if (ts["compact-grid-density"]) {
      rules.push("ytd-rich-grid-renderer { --ytd-rich-grid-items-per-row: 5 !important; }");
    }
    upsertStyleTag(THUMBNAIL_STYLE_ID, rules.join("\n"));
  }

  function applyTitleAndThumbnailTransforms() {
    if (!userSetting) return;
    syncThumbnailStyle();

    const masterOn = isThumbnailMasterOn();
    const ts = getThumbnailSettings();
    const doCleanTitles = masterOn && Boolean(ts["clean-clickbait-titles"]);
    const doStillThumbs = masterOn && Boolean(ts["still-frame-thumbnails"]);
    const doStripTracking = masterOn && Boolean(ts["strip-tracking-params"]);

    // 1. Clean Clickbait Titles
    const titleEls = document.querySelectorAll(
      "#video-title, .yt-lockup-metadata-view-model__title"
    );
    for (const el of titleEls) {
      if (doCleanTitles) {
        if (!el.hasAttribute("data-shinku-orig-title")) {
          el.setAttribute("data-shinku-orig-title", el.textContent || "");
        }
        const orig = el.getAttribute("data-shinku-orig-title") || "";
        const next = cleanClickbaitText(orig);
        if (el.textContent !== next) {
          el.textContent = next;
        }
      } else if (el.hasAttribute("data-shinku-orig-title")) {
        el.textContent = el.getAttribute("data-shinku-orig-title");
        el.removeAttribute("data-shinku-orig-title");
      }
    }

    // 2. Replace Thumbnails with Video Stills
    const thumbImgs = document.querySelectorAll(
      "ytd-thumbnail img, yt-thumbnail-view-model img"
    );
    for (const img of thumbImgs) {
      if (doStillThumbs) {
        const currentSrc = img.getAttribute("src") || "";
        const match = currentSrc.match(/\/vi\/([^/]+)\/(maxresdefault|hqdefault|mqdefault|sddefault)\.(jpg|webp)/i);
        if (match) {
          if (!img.hasAttribute("data-shinku-orig-src")) {
            img.setAttribute("data-shinku-orig-src", currentSrc);
          }
          const nextSrc = `https://i.ytimg.com/vi/${encodeURIComponent(match[1])}/hq2.jpg`;
          if (currentSrc !== nextSrc) {
            img.setAttribute("src", nextSrc);
          }
        }
      } else if (img.hasAttribute("data-shinku-orig-src")) {
        img.setAttribute("src", img.getAttribute("data-shinku-orig-src"));
        img.removeAttribute("data-shinku-orig-src");
      }
    }

    // 3. Strip Tracking Parameters from Feed Links
    const trackedLinks = document.querySelectorAll(
      'a[href*="si="], a[href*="pp="], a[data-shinku-orig-href]'
    );
    for (const link of trackedLinks) {
      if (doStripTracking) {
        const href = link.getAttribute("href") || "";
        if (!href || (!href.includes("si=") && !href.includes("pp="))) continue;
        try {
          const parsed = new URL(href, window.location.origin);
          if (parsed.searchParams.has("si") || parsed.searchParams.has("pp")) {
            if (!link.hasAttribute("data-shinku-orig-href")) {
              link.setAttribute("data-shinku-orig-href", href);
            }
            parsed.searchParams.delete("si");
            parsed.searchParams.delete("pp");
            const nextHref = href.startsWith("/")
              ? `${parsed.pathname}${parsed.search}${parsed.hash}`
              : parsed.toString();
            link.setAttribute("href", nextHref);
          }
        } catch (_err) {
          console.debug("[Shinku YT] Link strip skipped:", _err?.message || _err);
        }
      } else if (link.hasAttribute("data-shinku-orig-href") && link.id !== "logo") {
        link.setAttribute("href", link.getAttribute("data-shinku-orig-href"));
        link.removeAttribute("data-shinku-orig-href");
      }
    }
  }

  function scheduleContentFilter() {
    if (feedScanTimer !== null) {
      return;
    }
    feedScanTimer = setTimeout(() => {
      feedScanTimer = null;
      applyContentFilter();
      applyHomeToSubsRedirect();
      applyTitleAndThumbnailTransforms();
      syncHoverPreviewGuards();
      syncThumbnailBookmarkButtons();
    }, 150);
  }

  function initContentFilter() {
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", initContentFilter, { once: true });
      return;
    }
    applyConvertShortsToWatch();
    syncDistractionStyle();
    applyHomeToSubsRedirect();
    applyContentFilter();
    applyTitleAndThumbnailTransforms();
    syncHoverPreviewGuards();
    syncThumbnailBookmarkButtons();
    syncCodecPreference();
    syncTabPlaybackChannel();
    syncIdleCheckTimer();
    if (feedObserver) {
      return;
    }
    feedObserver = new MutationObserver(() => {
      if (
        isFrameMasterOn() ||
        isHoverGuardOn() ||
        isThumbnailBookmarkOn() ||
        isThumbnailMasterOn() ||
        isDistractionMasterOn()
      ) {
        scheduleContentFilter();
      }
    });
    feedObserver.observe(document.body, { childList: true, subtree: true });
  }

  // ---------------------------------------------------------------------------
  // Session Lifecycle & Hot-Reload
  // ---------------------------------------------------------------------------

  function sessionCleanup() {
    stopProgressBarLoop();
    stopVideoTimeTracker();
    unbindVideoElement();

    const loopVideos = document.querySelectorAll("video[data-shinku-loop-managed]");
    for (const v of loopVideos) {
      v.loop = false;
      v.removeAttribute("data-shinku-loop-managed");
    }

    if (initWatchRetryTimer !== null) {
      clearTimeout(initWatchRetryTimer);
      initWatchRetryTimer = null;
    }
    if (plusButtonRetryTimer !== null) {
      clearTimeout(plusButtonRetryTimer);
      plusButtonRetryTimer = null;
    }
    if (feedScanTimer !== null) {
      clearTimeout(feedScanTimer);
      feedScanTimer = null;
    }

    endedHandledForId = null;
    fastResumeAppliedForId = null;
    autoPausedForId = null;
    qualityAppliedForId = null;
    speedAppliedForId = null;
    theaterAppliedForId = null;
    autoplayDisabledForId = null;
    audioTrackAppliedForId = null;
    ambientDisabledForId = null;
  }

  function initWatchPage(attempt = 0) {
    if (initWatchRetryTimer !== null) {
      clearTimeout(initWatchRetryTimer);
      initWatchRetryTimer = null;
    }
    if (!userSetting || !isWatchPage()) {
      return;
    }

    const player = getPlayer();
    const video = getVideo();
    const playerVideoId =
      player && typeof player.getVideoData === "function"
        ? player.getVideoData()?.video_id
        : null;
    const isStalePlayer = Boolean(playerVideoId && pageID && playerVideoId !== pageID);

    if (!player || !video || isStalePlayer) {
      if (attempt < 15) {
        initWatchRetryTimer = setTimeout(() => initWatchPage(attempt + 1), 250);
      }
      return;
    }

    bindVideoElement();
    ensureProgressBar();
    ensurePlusButton();
    ensureScreenshotButton();
    ensureLoopButton();
    syncEndscreenStyle();
    syncPlayerComfortStyle();
    syncCinemaMode();
    syncStickyMiniPlayer();
    applyAutoTheater();
    applyDisableNativeAutoplay();
    if (video.readyState >= 1) {
      applyQualityLock();
      applyPlaybackSpeed();
      applyOriginalAudioTrack();
      syncVolumeBoost();
      applyAutoPause();
      applyFastResume();
    }
    scheduleVideoTimeTracker();
  }

  function applySettingsHotReload() {
    updateGlobalListeners();
    applyConvertShortsToWatch();
    syncDistractionStyle();
    applyHomeToSubsRedirect();
    applyContentFilter();
    applyTitleAndThumbnailTransforms();
    syncHoverPreviewGuards();
    syncThumbnailBookmarkButtons();
    syncCodecPreference();
    syncTabPlaybackChannel();
    syncIdleCheckTimer();
    syncEndscreenStyle();
    syncPlayerComfortStyle();
    syncCinemaMode();
    syncStickyMiniPlayer();
    syncVolumeBoost();

    if (isWatchPage()) {
      ensureProgressBar();
      updateOnPlayerStatusVisibility();
      ensurePlusButton();
      ensureScreenshotButton();
      ensureLoopButton();
      applyQualityLock(true);
      applyPlaybackSpeed(true);
      applyOriginalAudioTrack();
      applyAutoTheater();
      applyDisableNativeAutoplay();
      scheduleVideoTimeTracker();
    } else {
      const bar = document.getElementById(PROGRESS_CONTAINER_ID);
      if (bar) bar.remove();
      const btn = document.getElementById(PLUS_BUTTON_ID);
      if (btn) btn.remove();
      ensureScreenshotButton();
      ensureLoopButton();
      applyPlaybackSpeed(true);
      stopProgressBarLoop();
      stopVideoTimeTracker();
    }
  }

  // ---------------------------------------------------------------------------
  // Bridge Message Handling
  // ---------------------------------------------------------------------------

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== TARGET_ORIGIN) {
      return;
    }
    const msg = event.data;
    if (!msg || typeof msg.type !== "string") {
      return;
    }

    switch (msg.type) {
      case "SHINKU__bridgeReady": {
        toolsEnabled = true;
        if (!userSetting) {
          postToBridge("SHINKU__requestSettings");
        }
        postToBridge("SHINKU__requestLibrary");
        break;
      }
      case "SHINKU__toolsDisabled": {
        toolsEnabled = false;
        sessionCleanup();
        updateGlobalListeners();
        restoreHiddenItems(null);
        removeAllHoverGuards();
        removeAllThumbnailBookmarkButtons();
        syncEndscreenStyle();
        syncDistractionStyle();
        syncPlayerComfortStyle();
        syncCinemaMode();
        syncStickyMiniPlayer();
        syncCodecPreference();
        syncVolumeBoost();
        syncTabPlaybackChannel();
        syncIdleCheckTimer();
        applySettingsHotReload();
        break;
      }
      case "SHINKU__toolsEnabled": {
        toolsEnabled = true;
        if (msg.data && typeof msg.data === "object") {
          userSetting = msg.data;
        }
        initContentFilter();
        applySettingsHotReload();
        if (isWatchPage()) {
          initWatchPage(0);
        }
        break;
      }
      case "SHINKU__userSetting": {
        const isFirstInit = userSetting === null;
        toolsEnabled = true;
        userSetting = msg.data || {};
        if (isFirstInit) {
          postToBridge("SHINKU__requestLibrary");
          updateGlobalListeners();
          initContentFilter();
          if (isWatchPage()) {
            initWatchPage(0);
          }
        } else {
          initContentFilter();
          applySettingsHotReload();
          if (isWatchPage()) {
            initWatchPage(0);
          }
        }
        break;
      }
      case "SHINKU__updateUserSetting": {
        userSetting = msg.data || {};
        applySettingsHotReload();
        break;
      }
      case "SHINKU__Library":
      case "SHINKU__updatingLibrary": {
        shinkuLibrary = msg.data && typeof msg.data === "object" ? msg.data : {};
        updatePlusButtonState();
        updateAllThumbnailBookmarkButtons();
        if (isWatchPage()) {
          applyFastResume();
        }
        break;
      }
      case "SHINKU__NEW_YOUTUBE_URL": {
        const nextId = msg.videoId || msg.data?.videoId || extractVideoId(window.location.href);
        sessionCleanup();
        pageID = nextId;
        if (userSetting) {
          initContentFilter();
          if (isWatchPage()) {
            initWatchPage(0);
          } else {
            applySettingsHotReload();
          }
        }
        break;
      }
      case "SHINKU__saveCurrentVideo": {
        bookmarkVideo();
        break;
      }
      default:
        break;
    }
  });

  // Request settings & library in case bridge posted before MAIN script attached
  postToBridge("SHINKU__requestSettings");
  postToBridge("SHINKU__requestLibrary");
})();
