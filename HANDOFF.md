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
