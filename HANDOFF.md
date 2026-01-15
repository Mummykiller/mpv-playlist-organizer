# Handoff: MPV Playlist Organizer - Ultra Performance & Stability Finalization

## 🎯 Current Status
The project has reached a high-performance "Ultra" state. All core networking, buffering, and synchronization systems have been synchronized between the Python backend, the extension UI, and the MPV Lua scripts. The system is now hardened against user typos and extension reload gaps.

---

## 🏗️ Architectural Core

### 1. Dual-Layer Networking (`all-none-yt`)
The system now differentiates between **YouTube** (Aggressive "Turbo" Buffering) and **Everything Else** ("True Native" Speed).
- **YouTube:** Receives the full `3G` RAM buffer, `2000s` readahead, and `6` parallel download threads.
- **Native Bypass (Pahe/Others):** Automatically strips heavy overrides to use MPV's native speed. It keeps only **Robust Reconnect** logic and essential headers (`Referer`, `User-Agent`).
- **State Reset:** `adaptive_headers.lua` now snapshots the initial MPV state at launch and performs a **full property reset** between every video to prevent YouTube settings from "poisoning" subsequent native streams.

### 2. The "Shutdown Shield" (Zero-Data-Loss)
A robust failsafe system ensures playback progress is never lost, even if the browser is closed or refreshed.
- **Immediate Heartbeat:** The Python tracker now sends a heartbeat the millisecond it connects, preventing the fallback from "taking over" unnecessarily.
- **Forced Sync:** The Lua script (`python_loader.lua`) now bypasses the heartbeat timer on shutdown. Every video end/quit triggers an immediate, detached `fallback_sync.py` process to write the final timestamp to disk.
- **Independent Resume:** Smart Resume now functions purely via the local `folders.json` database, making it 100% independent of browser memory.

### 3. "Smart" Configuration Engine (`file_io.py`)
The backend now actively cleans and corrects settings to prevent common performance-breaking mistakes:
- **Auto-Suffixing:** If a user enters a pure number (e.g., `1000`) for buffer settings, the system automatically appends `M` (Megabytes).
- **Cache Alignment:** `cache_secs` and `demuxer_readahead_secs` are now hard-linked. Updating one automatically updates the other to ensure the demuxer doesn't stop before the cache is full.
- **Typo Correction:** Fixed critical typos in binary paths (e.g., `/usr/bin/nod` -> `/usr/bin/node`).

---

## 🛠️ Key Files & Responsibilities

- **`mpv_scripts/adaptive_headers.lua`:** The "Brain." Handles per-video header injection, networking bypass logic, and the global property reset.
- **`mpv_scripts/python_loader.lua`:** The "Silent Watcher." Detects when the browser is gone and takes over progress saving.
- **`utils/fallback_sync.py`:** The "Worker." A standalone script used by both MPV and Python to update the JSON database and YouTube history.
- **`services.py`:** The "Launcher." Constructs the initial MPV command line with visual and hardware profiles.

---

## ⚙️ Verified "Ultra" Configuration
- **Targeted Defaults:** `all-none-yt`
- **Max Buffer (RAM):** `3G`
- **Max Back-Buffer:** `1000M` (Automatically corrected from `1000`)
- **Buffer Ahead:** `2000s` (Synchronized with Readahead)
- **HTTP Persistence:** `on` (Restored for segment loading speed)
- **Reconnect Logic:** Uses `streamed` and `on_network_error` flags (Removed `at_eof` to stop log spam).

## 🚀 Future Roadmap
- **AniList Sync Enhancement:** Extend `fallback_sync.py` to update AniList "Episodes Watched" counts when the browser is closed (currently only handles local disk and YouTube).
- **Custom CSS Themes:** Allow users to swap between Material, Dark, and High-Contrast themes for the on-page controller.

---
**Status:** All core systems verified. Native speeds restored for streams, Turbo active for YT, and Resume Data is indestructible.