# Handoff: MPV Playlist Organizer - Ultra Performance & Stability Finalization

## 🎯 Current Status
The project has reached a high-performance "Ultra" state. All core networking, buffering, and synchronization systems have been synchronized between the Python backend, the extension UI, and the MPV Lua scripts. The system is now hardened against user typos, extension reload gaps, and browser database locks.

---

## 🏗️ Architectural Core

### 1. Dual-Layer Networking (`all-none-yt`)
The system now differentiates between **YouTube** (Aggressive "Turbo" Buffering) and **Everything Else** ("True Native" Speed).
- **YouTube:** Receives the full `3G` RAM buffer, `2000s` readahead, and `6` parallel download threads.
- **Native Bypass (Pahe/Others):** Automatically strips heavy overrides to use MPV's native speed. It keeps only **Robust Reconnect** logic and essential headers (`Referer`, `User-Agent`).
- **State Reset:** `adaptive_headers.lua` now snapshots the initial MPV state at launch and performs a **full property reset** between every video to prevent settings leakage.

### 2. The "Shutdown Shield" (Zero-Data-Loss)
A robust failsafe system ensures playback progress is never lost, even if the browser is closed or refreshed.
- **Immediate Heartbeat:** The Python tracker sends a heartbeat the millisecond it connects, minimizing gaps during extension refreshes.
- **Forced Sync:** `python_loader.lua` bypasses the heartbeat timer on shutdown to ensure the final timestamp is always written to disk via a detached `fallback_sync.py` process.

### 3. "Self-Healing" Cookie Sync (Shadow Copy)
Implemented a sophisticated multi-stage fallback for YouTube history synchronization:
- **Optimistic Native:** MPV first attempts to read the browser database directly for speed.
- **Shadow Copy Fallback:** If the browser database is locked (browser open), the system automatically creates a temporary "Shadow Copy" in RAM (`/dev/shm`), reads the cookies, and wipes the copy instantly.
- **Zero-Footprint:** Sensitive data never touches the physical hard drive; it resides strictly in system memory.

### 4. Smart Configuration Engine (`file_io.py`)
The backend now actively cleans and corrects settings:
- **Auto-Suffixing:** Numeric buffer inputs (e.g., `1000`) are automatically converted to Megabytes (`1000M`).
- **Cache Alignment:** `cache_secs` and `demuxer_readahead_secs` are hard-linked to prevent demuxer stalling.
- **Windows Safety:** A 7500-character guard prevents MPV launch failures due to OS command-line limits.

---

## 🛡️ Security & Sanitization
- **Prototype Pollution Protection:** Storage layer recursively scans for and blocks malicious object keys.
- **yt-dlp Whitelisting:** Switched from a blacklist to a strict **Whitelist** of safe functional flags.
- **Protocol Enforcement:** Strictly permits only `http`, `https`, and `file` schemes.
- **Permissions:** RAM-based cookie files are secured with `0o600` (Owner-only) permissions.

---

## ⚙️ Verified "Ultra" Configuration
- **Targeted Defaults:** `all-none-yt`
- **Max Buffer (RAM):** `3G`
- **Max Back-Buffer:** `1000M`
- **Buffer Ahead:** `2000s` (Synced)
- **HTTP Persistence:** `on`
- **Node Path:** `/usr/bin/node` (Corrected)

---
**Status:** All core systems verified. Optimization and Improvement plans are 100% implemented. Signed off for Ultra-performance deployment.
