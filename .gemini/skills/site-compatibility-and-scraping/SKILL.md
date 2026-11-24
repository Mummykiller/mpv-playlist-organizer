---
name: site-compatibility-and-scraping
description: >-
  Governs per-source header isolation (`mpv_scripts/adaptive_headers.lua`), browser SQLite cookie
  shadow copying (`VolatileCookieManager`), direct-vs-extractor stream routing, domain-sharded
  metadata caching, URL normalization, and in-page scraping/M3U8 scanning. Load whenever modifying
  `utils/url_analyzer.py`, `services.py` (`force_sanitize_headers`, `construct_lua_options`),
  `utils/native_link/metadata_cache.py`, `utils/PageScraper.js`, `background/handlers/m3u8_scanner.js`,
  `mpv_scripts/adaptive_headers.lua`, or debugging 403/cookie-lock/scraping issues.
---

# Site Compatibility, Source Swapping & Scraping

## 1. Source Swapping & Header Isolation (`mpv_scripts/adaptive_headers.lua`, `services.py`)
Compatibility rules are applied dynamically per source/CDN (there is no `Site_Compatibility.json`):
- **Global Property Leakage Trap:** MPV global properties persist across playlist items. If YouTube cookies/headers leak into an AnimePahe/Kwik stream, CDNs return `403 Forbidden`.
- **Hook Priority `-100`:** `adaptive_headers.lua` registers `mp.add_hook("on_load", -100, ...)` so it runs before MPV's built-in `ytdl-hook` (priority `15`).
- **Master Reset:** On every file load, reset `user-agent`, `referrer`, `http-header-fields`, and `ytdl-raw-options` before applying per-source rules (`ytdl=yes` for YouTube; `ytdl=no` + `Referer: https://kwik.cx/` for `owocdn.top`/`uwucdn.top`/`kwik.cx`).
- **Hot-Swap Manifest:** Force-plays from the browser set `user-data/hot-swap-options` so Lua reads options synchronously during `on_load` without async IPC races.
- **Server-Side Header Enforcement (`services.py:force_sanitize_headers`):** Always force `Referer: https://kwik.cx/` and `Origin: https://kwik.cx` for `.owocdn.top`, `.uwucdn.top`, and `kwik.cx` regardless of incoming browser headers. Direct streams (`.m3u8`, `.mp4`, `.mkv`) bypass `yt-dlp` (`use_ytdl_mpv=False`); portal pages (YouTube, Twitch) use `use_ytdl_mpv=True`.

---

## 2. SQLite Cookie Shadow Copying (`utils/url_analyzer.py:VolatileCookieManager`)
Active Chromium browsers lock their `Cookies` / `Network/Cookies` SQLite DB, breaking `yt-dlp --cookies-from-browser`:
- `VolatileCookieManager.extract_with_shadow_copy` discovers candidate profiles (system, Flatpak `~/.var/app/`, Snap, `Default`/`Profile *`), creates a `0700` per-PID temp dir in `/dev/shm`, copies the locked DB via `shutil.copy2`, runs `yt-dlp --cookies-from-browser <browser>:<shadow_profile_dir> --cookies <volatile_output> --skip-download -- <url>` with `get_scrubbed_env()`, and always purges the shadow profile in a `finally` block.

---

## 3. URL Normalization, Playlist Detection & Metadata Cache
- **Strict Host Validation (`utils/commUtils.module.js:isYouTubeUrl`, `utils/url_analyzer.py:YOUTUBE_RE`):** Always validate `http:`/`https:` scheme and exact `youtube.com` / `*.youtube.com` / `youtu.be` hosts—never loose `.includes()`.
- **Tracking Param Stripping (`normalize_url`, `normalizeYouTubeUrl`):** Strip `t`, `index`, `start`, `ab_channel`, `attr_tag`, `si`, `feature`, `pp` while preserving `v` and `list`.
- **Dedicated Playlist Detection (`utils/url_analyzer.py:is_youtube_playlist_url`):** Returns `True` **only** for `/playlist` with non-empty `list`—never `/watch?v=...&list=...`. `MpvCommandBuilder.build` uses this to pass `no-playlist=` for single videos and uses `line.rsplit('|', 1)` when parsing playlist expansion output so titles containing `|` do not corrupt URLs.
- **Safe oEmbed (`utils/playlistManager.js:buildYouTubeOEmbedUrl`):** Validates video IDs against `/^[a-zA-Z0-9_-]{1,64}$/`.
- **Metadata Cache (`utils/native_link/metadata_cache.py`):** Per-domain files in `DATA_DIR/metadata_cache/<domain>.json`, synced to `chrome.storage.local` (`mpv_meta_cache_<domain>`) behind an in-memory LRU cache.

---

## 4. In-Page Scraping & M3U8 Scanner
- **`utils/PageScraper.js` & `utils/ControllerView.js`:** `ControllerView.getEffectiveAddUrl()` centralizes target URL resolution (preferring `detectedUrl`, falling back to `window.location.href` on YouTube `/watch`, `/shorts/`, `/live/`). Right-click capture must support both classic (`ytd-*-renderer`) and modern (`yt-lockup-view-model`) YouTube DOM selectors.
- **`background/handlers/m3u8_scanner.js`:** Opens target pages with `mpv_playlist_scanner=true` (controller hidden via `visibility: hidden`), captures network/DOM stream URLs, reports back, and closes.
