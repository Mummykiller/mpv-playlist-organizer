# Source Swapping & Header Management Architecture

This document explains how the MPV Playlist Organizer handles transitions between high-security video sources like **YouTube** and **Animepahe**.

## 🧠 The Core Challenge
When swapping between platforms in a single MPV session:
1.  **YouTube** requires `ytdl=yes` and often specific browser cookies.
2.  **Animepahe (Kwik/Owocdn)** requires `ytdl=no` (direct stream), custom `Referer` headers, and specific `User-Agent` strings.
3.  **State Leakage**: MPV's global properties (like `ytdl-raw-options`) persist between files. If YouTube's "ignore-config" or cookie flags leak into an Animepahe request, the server returns a **403 Forbidden**.

## 🛠️ The Solution: `adaptive_headers.lua`

The logic is centered in `mpv_scripts/adaptive_headers.lua` using a high-priority `on_load` hook.

### 1. Hook Priority (`priority 10`)
We use priority `10`. This is early enough to run before MPV's built-in `ytdl-hook` (which usually starts at `priority 15`), but late enough that the initial properties passed by the Python bridge are already registered in the property system.

### 2. State Isolation (The Reset)
Every time a new file starts loading, the script performs a "Master Reset":
- Restores `user-agent` and `referrer` to the user's initial config values.
- Clears `http-header-fields` to remove old hot-linking headers.
- Resets `ytdl-raw-options` to the baseline provided by Python.
- This ensures that a YouTube session doesn't "poison" the next Animepahe stream.

### 3. Dynamic Source Detection
The script uses both the `path` (current URL) and `original-url` (stored in `user-data`) to detect the platform:
- **YouTube Detection**: Enables `ytdl=yes`.
- **Animepahe Detection**: Specifically looks for `owocdn.top` or `kwik.cx`. It injects the mandatory `Referer: https://kwik.cx/` header automatically if the Python bridge hasn't provided it.

### 4. Hot Swap Manifest
When the user clicks a video in the browser to "force play" it, Python sends a JSON manifest to `user-data/hot-swap-options`. 
- The Lua script reads this **synchronously** during `on_load`.
- This eliminates the race condition where MPV might start fetching the URL before the IPC `script-message` arrives.

## 🧪 Verification Steps
If swapping stops working, check the MPV console (`~` key) for these logs:
1. `AdaptiveHeaders: YouTube detected. Defaulting ytdl=yes`
2. `AdaptiveHeaders: Auto-added Referer for Animepahe link.`
3. `AdaptiveHeaders: Final ytdl state for this file: [yes/no]`

## ⚠️ Known Constraints
- **ytdl-hook Conflict**: If another script sets `ytdl=yes` at priority `0-9`, it might override our `no` setting for direct streams. Keep this script at priority `10`.
- **Header Formatting**: When using `mp.set_property_native("http-header-fields", list)`, DO NOT escape commas. MPV's native property handler expects a clean list/array.