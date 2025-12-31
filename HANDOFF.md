# MPV Playlist Organizer - Session Handoff (Dec 30, 2025)

## 🛠 Fixes Implemented

### 1. MPV Hanging Fix
- **Issue**: MPV would stay open in an "idle" state after a playback error or playlist finish.
- **Fix**: Changed `--idle=yes` to `--idle=once`. Updated `services.py` to support string values for the `idle` argument.
- **Result**: MPV now closes automatically on failure or completion.

### 2. YouTube Playback & 403/400 Errors
- **Root Cause**: The system `mpv` (v0.40.0-dirty) lacks `edl` protocol support, breaking the internal `ytdl` hook.
- **Fix**: 
    - Moved resolution from MPV to the Python backend (`url_analyzer.py`).
    - Fixed **400 Bad Request** by disabling HLS keepalive (`http_persistent=0`).
    - Fixed **403 Forbidden** by extracting browser cookies (Brave) and synchronizing the **User-Agent** between `yt-dlp` and `mpv`.
    - Resolution is handled via `adaptive_headers.lua` injecting `cookies-file`.

### 3. ID-Based Deduplication
- **Improvement**: Switched deduplication from URL-based to ID-based.
- **Fix**: Updated `native_host_handlers.py` and `mpv_session.py` (`append`/`append_batch`) to prevent duplicate entries when hitting play multiple times on the same folder.

### 4. Performance: Parallel Resolution
- **Improvement**: Initial playback launch was slow because `yt-dlp` was resolving URLs one-by-one.
- **Fix**: Implemented `ThreadPoolExecutor` in `mpv_session.py` and `native_host_handlers.py` to resolve all playlist items in parallel.

### 5. Persistent M3U Server
- **Issue**: Switching folders caused "Failed to start local M3U server" due to port 8000 being locked by leaked processes.
- **Fix**: 
    - Refactored server into a **Persistent Singleton**. It now stays alive and watches a stable file on disk.
    - Added **Suicide Watch** to `playlist_server.py` so it kills itself if the Host dies.
    - Implemented **Auto-Switching** logic in `mpv_session.py` to close old instances when a new folder is played.

### 6. YouTube Playlist Expansion
- **Improvement**: YouTube playlist URLs only added one item with a generic name.
- **Fix**: Updated `url_analyzer.py` to use `yt-dlp --flat-playlist` to expand URLs into individual items with correct titles.

### 7. Thumbnailer Bug Patch
- **Issue**: User's external thumbnailer script had a syntax error (passing `--playlist` after the `--` separator).
- **Fix**: Created `mpv_scripts/fix_thumbnailer_playlist.lua` to intercept and correct the command-line arguments on the fly.

## ⚠️ Important Environment Info
- **OS**: Arch Linux
- **Python**: 3.13 (Bytecode generation disabled via `sys.dont_write_bytecode`).
- **MPV Build**: `v0.40.0-dirty` - **Missing `edl` support**.
- **Current Recommendation**: User is falling asleep. Next step is to verify if reinstalling `mpv` or installing `mpv-git` restores `edl` support. If it does, many of the manual "External Resolution" workarounds in `url_analyzer.py` can be reverted to use native `ytdl` hooks for better quality.

## 📂 Key Files Modified
- `mpv_session.py`: Launch logic, parallel enrichment, auto-switching.
- `services.py`: Command building, 8-tuple resolution return.
- `utils/url_analyzer.py`: YouTube expansion and external resolution.
- `utils/native_host_handlers.py`: Persistent server management and sync logic.
- `mpv_scripts/adaptive_headers.lua`: Header/Cookie/Keepalive injection.
- `mpv_scripts/fix_thumbnailer_playlist.lua`: Subprocess interception.
- `playlist_server.py`: Added suicide watch and persistence support.
