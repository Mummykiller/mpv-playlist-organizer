---
name: site-compatibility-and-scraping
description: >-
  Governs brand-based site compatibility overrides, source swapping header management,
  in-page video stream scraping, and URL normalization. Load this skill whenever modifying
  `SITE_COMPATIBILITY_SYSTEM.md`, `testing_tools/SOURCE_SWAPPING_GUIDE.md`, `utils/url_analyzer.py`,
  `utils/PageScraper.js`, `background/handlers/m3u8_scanner.js`, `data/Site_Compatibility.json`,
  or diagnosing streaming CDN reconnection loops and 403 Forbidden errors.
---

# Site Compatibility, Source Swapping & Scraping Architecture

This skill defines the brand-based site compatibility engine, source swapping state isolation, in-page stream scraping, and URL normalization protocols.

---

## 1. Brand-Based Predictive Compatibility System

### The Problem: CDN Reconnection Loops

Certain streaming CDNs fail when aggressive FFmpeg reconnection flags (`demuxer-lavf-o`) are enabled, causing the player to enter an infinite "Will reconnect to stream" loop:
- **Fragile Hostnames:** CDNs rotate subdomains and TLDs continuously (`vault-11.cdn.com`, `vault-99.cdn.com`), making hostname blacklists ineffective.
- **Manual Overhead:** Requiring users to manually toggle network flags for individual videos is unacceptable.

### The Solution: Brand Identity Extraction

The system extracts the **Originating Brand** from the video's `original_url` (where the media was located):
- `https://www.animeheaven.me/watch/ep1` → Brand: `animeheaven`
- If the domain changes TLD (`.me` → `.ru`) or rotates CDNs, the extracted brand remains constant.

### Compatibility Engine Pipeline

```
┌────────────────────────┐       ┌────────────────────────┐       ┌────────────────────────┐
│ 1. Persistent Storage  │ ----> │ 2. In-Memory Cache     │ ----> │ 3. Pre-Launch Injector │
│ Site_Compatibility.json│       │ Native Host startup    │       │ Injects safe flags     │
└────────────────────────┘       └────────────────────────┘       │ before MPV spawns      │
                                                                  └────────────────────────┘
                                                                             │
┌────────────────────────┐       ┌────────────────────────┐                  │
│ 5. Brand Learning      │ <---- │ 4. Failure Detection   │ <────────────────┘
│ Updates JSON file      │       │ Detects reconnect loop │
└────────────────────────┘       └────────────────────────┘
```

1. **Persistent Storage (`data/Site_Compatibility.json`):** Stores known brand profiles (e.g. `{"animeheaven": {"enable_reconnect": false}}`).
2. **In-Memory Cache:** Loaded into native host RAM at startup for zero-latency queries during pre-launch.
3. **Pre-Launch Injector:** When preparing playback, queries the brand cache and forces safe settings into the launch payload.
4. **Automated Discovery (Learning):** If an active session encounters a reconnection loop, the system applies an immediate hotfix, extracts the brand, and writes the rule to `Site_Compatibility.json`.

---

## 2. Source Swapping & Header State Isolation (`mpv_scripts/adaptive_headers.lua`)

Transitions between high-security video sources (e.g. YouTube and Animepahe) within a single session face state pollution:
- **YouTube:** Requires `ytdl=yes`, user-agent, and browser session cookies.
- **Animepahe (Kwik/Owocdn):** Requires `ytdl=no` (direct stream), custom `Referer` (`https://kwik.cx/`), and clean headers.
- **State Leakage:** MPV's global properties persist between playlist items. If YouTube cookie or header flags leak into an Animepahe request, the CDN returns `403 Forbidden`.

### The Isolation Architecture

1. **Hook Priority (`priority 10`):**
   - Configured via `mp.add_hook("on_load", 10, ...)`.
   - Runs before MPV's built-in `ytdl-hook` (`priority 15`), ensuring proper header assignment before stream extraction.
2. **State Reset (The Master Reset):**
   - On every file load, resets `user-agent` and `referrer` to default, clears `http-header-fields`, and resets `ytdl-raw-options`.
3. **Dynamic Source Detection:**
   - Detects YouTube URLs and forces `ytdl=yes`.
   - Detects Animepahe (`owocdn.top`, `kwik.cx`) and auto-injects `Referer: https://kwik.cx/` while setting `ytdl=no`.
4. **Hot Swap Manifest:**
   - When a user force-plays an item from the browser, Python sets `user-data/hot-swap-options`.
   - Lua reads this manifest synchronously during `on_load`, eliminating race conditions with async IPC messages.

---

## 3. URL Normalization & Deduplication

### Tracking Parameter Stripping

To guarantee reliable deduplication and resume position matching, video URLs (especially YouTube) are normalized before storage:
- Strips non-essential tracking parameters: `t`, `index`, `si`, `feature`, `pp`.
- Retains essential identity parameters: `v`, `list` (for playlist context).

---

## 4. In-Page Scraping & Scanner Engine

### DOM Scraping (`utils/PageScraper.js`)

- Inspects the active document DOM for `<video>`, `<source>`, and `<iframe>` elements.
- Extracts video titles, stream URLs, and page metadata while ignoring tracking pixels or ad iframes.

### Background M3U8 Scanner (`background/handlers/m3u8_scanner.js`)

- Automatically detects streaming URLs on pages opened with query parameter `mpv_playlist_scanner=true`.
- Renders the controller in hidden/background mode (`controllerHost.style.visibility = "hidden"`), scans network requests and DOM sources, extracts media, and closes or reports back to the calling tab.
