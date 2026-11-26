# Source Swapping & Header Management Architecture

This document explains how the MPV Playlist Organizer handles transitions between high-security video sources like **YouTube** and **Animepahe**.

## 🧠 The Core Challenge
When swapping between platforms in a single MPV session:
1.  **YouTube** requires `ytdl=yes` and often specific browser cookies.
2.  **Animepahe (Kwik/Owocdn)** requires `ytdl=no` (direct stream), custom `Referer` headers, and specific `User-Agent` strings.
3.  **State Leakage**: MPV's global properties (like `ytdl-raw-options`) persist between files. If YouTube's "ignore-config" or cookie flags leak into an Animepahe request, the server returns a **403 Forbidden**.

## 🛠️ The Solution: `adaptive_headers.lua`

The logic is centered in `mpv_scripts/adaptive_headers.lua` using a high-priority `on_load` hook.

### 1. Hook Priority (`priority -100`)
We use priority `-100` (`mp.add_hook("on_load", -100, ...)`). This runs early—well before MPV's built-in `ytdl-hook` (which runs at `priority 15`)—so per-item `ytdl`, header, and networking overrides are applied before extraction begins.

### 2. State Isolation (The Reset)
Every time a subsequent file starts loading (or on hot-swap), the script performs a "Master Reset":
- Restores `user-agent` and `referrer` to the user's initial config values.
- Clears `http-header-fields` and `cookies-file` to remove old hot-linking headers and cookies.
- Resets `ytdl-raw-options`, `ytdl-format`, `ytdl`, and `demuxer-lavf-o` to the baseline provided at launch.
- This ensures that a YouTube session doesn't "poison" the next Animepahe stream.

### 3. Dynamic Source Detection & Header Application
The script resolves per-item options from `id_options`, `url_options`, `indexed_options`, or the handshake/hot-swap manifest:
- **YTDL Routing:** Applies `opts.use_ytdl_mpv` (`ytdl=yes` for YouTube/extractor-backed pages, `ytdl=no` for direct streams).
- **Header & Animepahe Handling:** Applies `opts.headers` (`user-agent`, `referrer`, `http-header-fields`) supplied by Python (`services.py:force_sanitize_headers` enforces `Referer: https://kwik.cx/` and `Origin: https://kwik.cx` for `owocdn.top`, `uwucdn.top`, and `kwik.cx`) and activates native MPV networking bypass for Animepahe CDNs (`kwik.cx`, `owocdn.top`, `uwucdn.top`).

### 4. Hot Swap Manifest
When the user clicks a video in the browser to "force play" it, Python sends a JSON manifest to `user-data/hot-swap-options`. 
- The Lua script reads this **synchronously** during `on_load` and clears the property afterward.
- This eliminates the race condition where MPV might start fetching the URL before the IPC `script-message` arrives.

## 🧪 Verification Steps
If swapping stops working, check the MPV console (`~` key) for these logs:
1. `AdaptiveHeaders: Setting YTDL to: [yes/no] (from use_ytdl_mpv=...)`
2. `AdaptiveHeaders: Setting Referrer: ...`
3. `AdaptiveHeaders: True Native Bypass active. Using native MPV networking for speed.`

## ⚠️ Known Constraints
- **ytdl-hook Conflict**: If another script sets `ytdl=yes` at priority lower than `-100`, it could conflict with our `no` setting for direct streams. Keep this script at priority `-100`.
- **Header Formatting**: When using `mp.set_property_native("http-header-fields", list)`, DO NOT escape commas. MPV's native property handler expects a clean list/array.