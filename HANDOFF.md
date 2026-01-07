# MPV Playlist Organizer - 1440p & Performance Handoff

This document details the efforts to achieve consistent high-resolution (1440p+) playback and the implementation of the new Performance Profile system.

## 🎯 The 1440p Objective
The primary goal was to ensure that YouTube videos consistently play at 1440p (or the user's selected resolution) rather than falling back to 1080p.

### 🛠️ Key Discoveries & Implementation
1.  **The "n-challenge" Requirement**: 
    *   YouTube high-res formats (1440p+) are hidden or throttled unless `yt-dlp` can solve a JavaScript signature challenge.
    *   This requires a JS runtime like **Node.js** or **Deno** to be visible in the player's environment.
2.  **Environment Hardening**:
    *   Modified `native_host.py` to aggressively prepend standard system paths (`/usr/bin`, `/usr/local/bin`) to the process `PATH`.
    *   This ensures `yt-dlp` can find `ffmpeg` for merging and `node` for the signature challenge even when launched from a restricted browser environment.
3.  **MPV Syntax Sensitivity**:
    *   MPV's internal option parser is simplistic. Boolean flags in `ytdl-raw-options` (like `ignore-config=`) **must** include the trailing equals sign, or they will be joined with subsequent options, causing a crash.
    *   Updated `file_io.py` and `adaptive_headers.lua` to guarantee this syntax and deduplicate flags using a key-value map logic.
4.  **Bulletproof Format String**:
    *   Standardized on `bv*[height<=?{q}][fps<=?60]+ba/best`. The `?` allows graceful fallback if 1440p is missing, while the `/best` at the end ensures playback even if merging fails (Backward Compatibility).
5.  **Direct Launch Injection**:
    *   Modified `session_services.py` to pass the URL and quality flags **together** in the initial MPV command line. This eliminates race conditions where scripts might load too late to affect the initial stream selection.

## 🚀 Performance Profiles & Quality
We have implemented a 5-tier performance system:
*   **System Default**: No quality flags sent; respects the user's `mpv.conf`.
*   **Low (Fast)**: Forces `--profile=fast`.
*   **Medium (Balanced)**: Forces `spline36` scaling and `vo=gpu`.
*   **High (HQ)**: Forces `--profile=gpu-hq`.
*   **Ultra (Extreme)**: Forces `ewa_lanczossharp`, 16-bit floating-point processing (`rgba16f`), aggressive debanding, and motion interpolation.

## 💾 Backup & Restore System
*   **Portable Backups**: Backups saved to `exported/settings/` are machine-independent (strips window positions).
*   **Smart Import**: Preserves local paths (MPV/FFmpeg) during restoration to prevent breaking the install while restoring preferences.

## 🔍 Resolved Mystery: 1440p Regex & yt-dlp Challenges
The intermittent 1080p fallback and playback stalls have been addressed with four key fixes:
1.  **Regex Update**: The regex for VP9 codec selection was updated from `^vp09` to `^vp0?9` to correctly match all VP9 streams.
2.  **yt-dlp N-Challenge**: Added `remote-components=ejs:github` to the `ytdl-raw-options` passed to MPV. This allows `yt-dlp` to fetch the necessary "PhantomJS-like" scripts (EJS) to solve YouTube's latest signature challenges.
3.  **Explicit Node.js Runtime**: Added `js-runtimes=node` to `ytdl-raw-options`. Modern `yt-dlp` does *not* auto-detect Node.js for challenge solving unless explicitly told to do so.
4.  **Enabling Persistence**: Changed `disable_http_persistent` from `True` to `False` for YouTube. This allows MPV to reuse connections for segment downloads, drastically reducing overhead and fixing the "0.1s cache stall" seen at 1440p.
5.  **Simplified Client Selection**: Removed explicit `ios` client spoofing. Diagnostic logs showed that modern `yt-dlp` automatically selects the best working client (like `tv`) when `node` is available, and that the `ios` client was incompatible with the user's cookies.

## ⚠️ Notes on YouTube Playback Stability
We have standardized on three global flags for all streaming content to ensure maximum responsiveness across all resolutions:
-   `--force-seekable=yes`: Ensures MPV doesn't give up on slow server responses during a jump.
-   `--demuxer-thread=yes`: Isolates network logic to its own thread to prevent UI freezes.
-   `--cache-pause-initial=no`: Forces playback to begin as soon as the first data arrives, preventing long "black screen" waits while large buffers fill.

The combination of these flags and the **Node.js/EJS** solver provides the most stable 1440p+ experience currently possible in early 2026.

## 🛡️ Reliability & Concurrency Overhaul (v2.6.0)
A major architectural update was performed to move the extension from a "Prototype" to an "Industrial Strength" state, focusing on data integrity and process safety.

### 1. Concurrency & Process Safety (Python)
*   **The "Receptionist" Pattern**: Modified `native_host.py` to use a `ThreadPoolExecutor`. The main loop now acts as a non-blocking dispatcher, handing off heavy tasks (Play, Add, AniList sync) to background threads. This prevents the browser UI from "freezing" while Python is busy.
*   **Cross-Process File Locking**: Implemented a custom `FileLock` class in `file_io.py`. It uses atomic OS-level file creation (`O_EXCL`) to ensure that `folders.json` is never written to by two processes at once (e.g., the Native Host and the Tracker). This eliminates the "Lost Update" race condition.
*   **Named Processes**: The native host now identifies itself in system monitors using `ctypes` (`mpv-pl-organize` on Linux, `mpv playlist organizer` on Windows), making troubleshooting and resource monitoring much easier for users.

### 2. Manifest V3 Lifecycle & Data Sync (JS)
*   **Alarm-Based Scheduling**: Replaced all `setInterval` calls in `background.js` with the `chrome.alarms` API. This ensures that heartbeats and data syncing survive the Service Worker's ephemeral "sleep" cycles.
*   **Persistent Sync Queue**: The data sync to the native host now uses a 1-minute alarm-based debounce rather than a memory-based one, ensuring that pending changes are flushed to disk even if the service worker unloads unexpectedly.

### 3. Granular Storage (The "Bucket" System)
*   **Storage Refactoring**: Moved away from a monolithic `mpv_organizer_data` key. Data is now split into logical buckets:
    *   `mpv_settings`: Global preferences (tiny).
    *   `mpv_folder_index`: Folder names and order (tiny).
    *   `mpv_folder_data_[ID]`: Individual playlist data (one key per folder).
*   **Memory Efficiency**: The extension now only loads the specific folder being viewed or played, drastically reducing the memory footprint for users with massive libraries.
*   **Schema Versioning**: Introduced `mpv_storage_version` (v2) with a robust migration script to safely transition user data to the new bucket system.

### 4. Messaging & Performance
*   **Handshake Optimization**: Combined `init_ui_state` and `render_playlist` into a single "Handshake" message. This cuts IPC traffic in half during page loads and eliminates UI flickering.
*   **Smart Broadcasting**: Updated `broadcastToTabs` to query only active `http/https` tabs, preventing redundant browser errors on restricted/internal system pages.

## 🔒 Privacy & User Control
*   **Restricted Domains**: Implemented a "Privacy & Restrictions" system. Users can now list domains (e.g., banks, email) where the extension is strictly forbidden from injecting its UI or listeners.
*   **Automatic Cleanup**: The restriction settings include smart URL parsing, automatically converting full URLs (like `https://bank.com/`) into clean domain names for the blacklist.

## 🐛 Critical Bug Fixes
*   **Specialized MPV Modules**: Refactored Lua logic into two distinct "Specialists" for better maintainability and performance:
    *   `adaptive_headers.lua` (Stream Specialist): Manages headers, resolution, and `yt-dlp` networking. Now handles digital signaling for stream failures via `ytdl-error` monitoring.
    *   `on_completion.lua` (LifeCycle Specialist): Focused strictly on playlist completion, exit codes (99), and success flags.
*   **Digital Error Signaling**: Replaced brittle log-parsing in the Native Host with a direct "Digital Signal" from Lua. The Python host now reacts to `script-message` events for `yt-dlp` failures, making error detection 100% accurate.
*   **Temporary File Safety**: Implemented `try...finally` blocks in `mpv_session.py` to guarantee the deletion of temporary M3U playlists, even if a handoff error or crash occurs.
*   **M3U Title Sanitization**: Enhanced the `sanitize_string` logic to strictly strip linebreaks and control characters from titles, preventing M3U corruption during batch operations.
*   **Bypass Logic Hardening**: Improved the AnimePahe/Kwik bypass with modern browser headers (`Sec-Fetch-*`) and added browser cookie extraction support to survive Cloudflare challenges.
*   **Property Leakage Fix**: `adaptive_headers.lua` now aggressively resets all HTTP and YTDL properties between playlist items, preventing YouTube headers from "leaking" into other streams and causing 403 errors.
