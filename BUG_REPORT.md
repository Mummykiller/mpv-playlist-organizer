# Bug Report & Inconsistency Analysis (Pass 2)
**Date:** 2026-01-15
**Status:** Fixing

## 🚨 Logic Issues

### 1. Stale Dependency Cache on Update
**Severity:** Medium
**Location:** `services.py`
**Description:** 
The function `check_mpv_and_ytdlp_status` caches the version of `yt-dlp` for 5 minutes (`CACHE_EXPIRY_SECONDS = 300`).
The function `update_ytdlp` updates the binary on disk but **does not invalidate this cache**.
**Impact:** After a successful update, the UI will continue to report the old version (or "Update Available") for up to 5 minutes, confusing the user.

### 2. Race Condition in M3U Server (Concurrent Play Requests)
**Severity:** Medium
**Location:** `utils/native_host_handlers.py`
**Description:** 
The `handle_play_m3u` handler uses a single shared file (`temp_m3u_file_for_server`) for the local M3U server.
If two "Play" requests arrive rapidly (e.g., User double-clicks or clicks two folders fast):
1.  Request A writes content A to the file.
2.  Request B overwrites the file with content B.
3.  Request A launches MPV.
4.  MPV (A) reads the file and gets content B.
**Impact:** MPV might start playing the wrong playlist, or display incorrect metadata, before being killed by Request B's session start.
**Proposed Fix:** Serialize `handle_play_m3u` requests or use a re-entrant lock that covers the [Write -> Launch] sequence.

## ⚠️ Minor Issues

### 3. Missing Explicit RLock for Server
**Severity:** Low
**Location:** `utils/native_host_handlers.py`
**Description:** `server_lock` is a standard `Lock`. If we need to expand the critical section to cover the whole handler (to fix the race condition), we need `RLock` to allow the internal `_start_local_m3u_server` helper to also acquire it without deadlocking.

---

## 🛠️ Fix Plan
1.  **services.py:** In `update_ytdlp`, clear `_DEPENDENCY_STATUS_CACHE` upon success.
2.  **utils/native_host_handlers.py:** 
    *   Change `server_lock` to `threading.RLock()`.
    *   Wrap the critical logic in `handle_play_m3u` (M3U generation -> Server Start -> MPV Launch) with `with self.server_lock:`.