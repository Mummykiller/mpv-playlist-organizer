---
name: site-compatibility-and-scraping
description: >-
  Governs source swapping header management, browser cookie SQLite shadow copying,
  stream resolution routing, and in-page video scraping.
  Load this skill whenever modifying `testing_tools/SOURCE_SWAPPING_GUIDE.md`,
  `utils/url_analyzer.py`, `services.py` (force_sanitize_headers, construct_lua_options),
  `utils/native_link/metadata_cache.py`, `utils/PageScraper.js`, `background/handlers/m3u8_scanner.js`,
  `mpv_scripts/adaptive_headers.lua`, or diagnosing streaming CDN loops, cookie database locks, and 403 Forbidden errors.
---

# Site Compatibility, Source Swapping & Scraping Architecture

This skill defines source swapping header isolation (`mpv_scripts/adaptive_headers.lua`), browser SQLite cookie shadow copying, stream resolution routing, in-page stream scraping, and URL normalization protocols.

---

## 1. Per-Source Compatibility Rules (`mpv_scripts/adaptive_headers.lua` & `services.py`)

Compatibility overrides are applied dynamically by source/CDN rather than via a persistent `Site_Compatibility.json` file (which does not exist in this codebase):
- **Dynamic Header & Extractor Routing:** `services.py:force_sanitize_headers` and `mpv_scripts/adaptive_headers.lua` reset `user-agent`, `referrer`, `http-header-fields`, and `ytdl-raw-options` per item load and apply host-specific overrides (e.g., `owocdn.top`, `uwucdn.top`, `kwik.cx`).
- **Stream vs Portal Routing:** `utils/url_analyzer.py` and `services.py` distinguish direct media streams (`use_ytdl_mpv=False`) from portal URLs (`use_ytdl_mpv=True`).

---

## 2. Source Swapping & Header State Isolation (`mpv_scripts/adaptive_headers.lua`)

Transitions between high-security video sources (e.g. YouTube and Animepahe) within a single session face state pollution:
- **YouTube:** Requires `ytdl=yes`, user-agent, and browser session cookies.
- **Animepahe (Kwik/Owocdn):** Requires `ytdl=no` (direct stream), custom `Referer` (`https://kwik.cx/`), and clean headers.
- **State Leakage:** MPV's global properties persist between playlist items. If YouTube cookie or header flags leak into an Animepahe request, the CDN returns `403 Forbidden`.

### The Isolation Architecture

1. **Hook Priority (`priority -100`):**
   - Configured via `mp.add_hook("on_load", -100, ...)`.
   - Runs well before MPV's built-in `ytdl-hook` (`priority 15`), ensuring proper header assignment before stream extraction.
2. **State Reset (The Master Reset):**
   - On every file load, resets `user-agent` and `referrer` to default, clears `http-header-fields`, and resets `ytdl-raw-options`.
3. **Dynamic Source Detection:**
   - Detects YouTube URLs and forces `ytdl=yes`.
   - Detects Animepahe (`owocdn.top`, `kwik.cx`) and auto-injects `Referer: https://kwik.cx/` while setting `ytdl=no`.
4. **Hot Swap Manifest:**
   - When a user force-plays an item from the browser, Python sets `user-data/hot-swap-options`.
   - Lua reads this manifest synchronously during `on_load`, eliminating race conditions with async IPC messages.

---

## 3. Browser SQLite Cookie Shadow Copying (`utils/url_analyzer.py`)

Browsers lock their SQLite cookie databases (e.g., Chrome `Cookies` or `Network/Cookies` file) while active, causing `yt-dlp --cookies-from-browser` to fail with database lock errors.

### The Shadow Copy Mechanism (`VolatileCookieManager.extract_with_shadow_copy`)

When primary extraction fails:
1. **Candidate Profile Discovery:** Scans standard system paths, Flatpak (`~/.var/app/`), Snap, and Chromium profile folders (`Default`, `Profile *`).
2. **Path Discrimination:** Inspects both modern Chromium paths (`<profile>/Network/Cookies`) and legacy paths (`<profile>/Cookies`).
3. **Volatile Shadow Profile:** Creates a temporary profile structure in RAM-backed storage (`/dev/shm` on Linux) with `0700` permissions.
4. **Unlocked DB Duplicate:** Copies the locked database file into the shadow profile via `shutil.copy2` (which circumvents SQLite exclusive locks).
5. **Extraction:** Executes yt-dlp targeting the shadow profile:
   ```bash
   yt-dlp --cookies-from-browser <browser>:<shadow_profile_dir> --cookies <volatile_output> --skip-download -- <url>
   ```
6. **Teardown:** The shadow profile directory is purged in a `finally` block, leaving only the volatile Netscape cookie file.

---

## 4. Stream Routing & Header Enforcement Matrix (`services.py`)

Stream URLs must be classified and sanitized before passing them to MPV:

### Direct Media vs Extractor Routing
- **Direct Video Streams:** URLs containing `.m3u8`, `.mp4`, `.mkv`, etc. must bypass `yt-dlp` entirely (`use_ytdl_mpv=False`) to avoid unnecessary extraction latency and stream parsing errors.
- **Portal Landing Pages:** Supported sites (YouTube, Twitch) use `use_ytdl_mpv=True`.

### AnimePahe / Kwik CDN Overrides (`force_sanitize_headers`)
- If the resolved media host matches `.owocdn.top`, `.uwucdn.top`, or `kwik.cx`:
  - Force `Referer: https://kwik.cx/`.
  - Force `Origin: https://kwik.cx`.
  - This override applies regardless of incoming browser headers to prevent CDN `403 Forbidden` errors.

---

## 5. Domain-Sharded Metadata Caching (`utils/native_link/metadata_cache.py`)

To eliminate repeated external network lookups for titles, stream URLs, and headers:
- Metadata is cached per-domain in persistent files under `DATA_DIR/metadata_cache/<domain>.json`.
- Synchronized to browser `chrome.storage.local` under the `mpv_meta_cache_<domain>` bucket.
- High-frequency lookups hit in-memory LRU cache before checking disk.

---

## 6. URL Normalization, Playlist Detection & oEmbed (`utils/url_analyzer.py`, `utils/commUtils.module.js`, `utils/playlistManager.js`)

### Tracking Parameter Stripping & Host Validation
- **Strict Host Validation (`utils/commUtils.module.js:isYouTubeUrl`, `utils/url_analyzer.py:YOUTUBE_RE`):** Parses URLs with `new URL()` / anchored regex to verify `http:`/`https:` scheme and exact `youtube.com`, `*.youtube.com`, or `youtu.be` hostnames (never loose substring `.includes()`).
- **Normalization (`utils/url_analyzer.py:normalize_url`, `utils/commUtils.module.js:normalizeYouTubeUrl`):** Normalizes `/watch`, `/shorts/`, `/live/`, `/playlist`, and `youtu.be` links by stripping non-essential tracking parameters (`t`, `index`, `start`, `ab_channel`, `attr_tag`, `si`, `feature`, `pp`) while retaining essential identity parameters (`v`, `list`). Python's `normalize_url` also strips URL fragments and sorts remaining query keys.
- **Dedicated YouTube Playlist Detection (`utils/url_analyzer.py:is_youtube_playlist_url`):** Returns `True` **only** when `parsed.path.rstrip("/").lower() == "/playlist"` and the `list` query parameter is non-empty—never for single `/watch?v=...&list=...` URLs. `utils/mpv_command_builder.py:MpvCommandBuilder.build` uses `is_youtube_playlist_url` to automatically pass `no-playlist=` for single videos while allowing true `/playlist?list=` URLs to expand (using `line.rsplit('|', 1)` so titles containing `|` do not corrupt URLs).
- **Safe oEmbed Construction (`utils/playlistManager.js:buildYouTubeOEmbedUrl`):** Builds URL-encoded oEmbed requests for both `/playlist?list=` and single video URLs (`/watch`, `/shorts/`, `/live/`, `/embed/`, `/v/`, `youtu.be`), validating video IDs against `/^[a-zA-Z0-9_-]{1,64}$/`.

---

## 7. In-Page Scraping & Scanner Engine

### DOM Scraping & YouTube Card Extraction (`utils/PageScraper.js`, `utils/ControllerView.js`, `utils/ControllerActions.js`)
- `PageScraper.js` inspects active DOM for `<video>`, `<source>`, and `<iframe>` elements, extracting titles and stream URLs while ignoring tracking pixels or ad iframes.
- `ControllerView.getEffectiveAddUrl()` centralizes target URL resolution for `#btn-add`, `#btn-compact-add`, and the minimized stub one-click add (preferring `detectedUrl` and falling back to `window.location.href` on YouTube `/watch`, `/shorts/`, or `/live/` pages).
- Right-click capture in `ControllerView.js` supports both classic YouTube renderers (`ytd-rich-item-renderer`, `ytd-video-renderer`, `ytd-grid-video-renderer`, `ytd-compact-video-renderer`) and modern lockup view models (`yt-lockup-view-model`, `a.yt-lockup-view-model__content-image`, `.yt-lockup-metadata-view-model__title`, `.yt-content-metadata-view-model__metadata-text`).

### Background M3U8 Scanner (`background/handlers/m3u8_scanner.js`)
- Automatically detects streaming URLs on pages opened with query parameter `mpv_playlist_scanner=true`.
- Renders the controller in hidden/background mode (`controllerHost.style.visibility = "hidden"`), scans network requests and DOM sources, extracts media, and closes or reports back to the calling tab.
