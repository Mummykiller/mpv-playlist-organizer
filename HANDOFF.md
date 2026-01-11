# MPV Playlist Organizer - System Hardening Handoff (January 2026 Update)

This document summarizes the major improvements, resolved architectural issues, and the current state of the codebase following the "Stellar Stability" sprint.

## 🛡️ Major System Hardening (v2.8.0)

### 1. Reliability & Process Control
*   **Polling Readiness**: Replaced brittle `time.sleep` in the MPV launch sequence with a robust polling loop. The system now verifies IPC connectivity and MPV responsiveness before sending initial commands, ensuring 100% startup success on all hardware.
*   **JSON Port Discovery**: Replaced fragile `stderr` scraping for M3U server port detection. `playlist_server.py` now communicates its status via structured JSON on `stdout`, making local server initialization instant and reliable.
*   **Windows Lifecycle Management**: Implemented a native Windows console control handler using `ctypes`. The Python host now catches `CTRL_CLOSE_EVENT` and shuts down gracefully, eliminating stale IPC pipes and zombie processes on Windows.
*   **Platform Consolidation**: The installer now records the detected `os_platform` in `config.json`. This centralized reference is used by `services.py` and `native_host_handlers.py` to ensure platform-specific logic (like file explorers or terminal wrappers) is consistent and predictable.

### 2. Performance & Resource Optimization
*   **Lazy Content Injection**: Background scripts now only target active tabs on startup. All other tabs receive script injection "on-demand" when activated. This resolves the massive CPU/Memory spikes previously seen when starting browsers with hundreds of tabs.
*   **Targeted Messaging**: Broadcasts are now restricted to active/visible contexts. Log messages and UI updates no longer "wake up" background tabs, significantly reducing the battery drain and IPC overhead of the extension.
*   **Accelerated Playback**: Increased the cookie cache to 1 hour and implemented a persistent disk cache using browser-specific stable filenames. Playback of multiple private videos is now nearly instant, as the heavy `yt-dlp` extraction process is skipped for cached files.
*   **Lua Memory Safety**: Implemented a FIFO (First-In-First-Out) cache in `adaptive_headers.lua`. The script now caps its memory footprint to 100 unique URLs, preventing unbounded memory growth and keeping fuzzy-match lookups fast during long sessions.

### 3. Data Integrity & UI Safety
*   **Stable Identity Persistence**: Fixed a critical bug where reordering or importing would regenerate item IDs. The system now prioritizes existing UUIDs, ensuring your "Last Played" highlight and "Smart Resume" positions remain linked even across different devices.
*   **Clear-on-Completion Integrity**: Refactored the "End of Folder" detection. The extension now intelligently verifies if the finished item was truly the tail of the playlist, preventing accidental wipes when playing single middle-episodes.
*   **Strict Sanitization**: Conducted a full audit against `SANITATION_PLAN.md`.
    *   Unified `commUtils.js` and `commUtils.module.js` into a master-sync pair.
    *   Removed obsolete `sanitization.js`.
    *   Aligned UI validation with strict backend rules (blocking `$`, `;`, `&`, etc., in folder names).
*   **Race Condition Shield**: Moved initialization guards to the very first line of `content.js` and added a secondary DOM-level check in `UIManager.js`, permanently preventing "Double Controller" UI duplication.

### 4. Live Swapping & Header Reliability
*   **Synchronous Hot Swap**: Python now sends a full playback manifest (`hot-swap-options`) via IPC properties just milliseconds before the `loadfile` command. This eliminates race conditions where MPV would start loading a file before the script-message options were processed.
*   **Absolute Priority (Hooking 100)**: `adaptive_headers.lua` now runs at the highest possible priority (100). This guarantees it executes before MPV's native `ytdl-hook`, allowing it to correctly enable/disable YouTube support and apply headers for direct streams like Pahe.
*   **Native Table Headers**: Rewrote header application to use Lua Native Tables via `mp.set_property_native`. This bypasses the fragility of comma-separated strings, ensuring complex headers (like `Accept-Language`) are transmitted without corruption.
*   **State Isolation Master Reset**: Every new file load now triggers a total reset of network properties. This prevents "leakage" of YouTube credentials or `ytdl=yes` flags into direct stream requests, which was previously causing 403 Forbidden errors.

## 💾 Current State of Issues

| Issue | Title | Status | Resolution |
| :--- | :--- | :--- | :--- |
| **1** | Startup Race Condition | **Fixed** | Switched from sleep to IPC polling. |
| **2** | Brittle Port Detection | **Fixed** | Implemented JSON handshake via stdout. |
| **3** | Windows Signal Failure | **Fixed** | Added ctypes console control handler. |
| **4** | Lua Memory Leak | **Fixed** | Implemented 100-entry FIFO cache. |
| **5** | Injection Perf Spike | **Fixed** | Implemented Lazy/Active tab injection. |
| **6** | Excessive IPC Chatter | **Fixed** | Targeted messaging to active tabs only. |
| **7** | Slow Cookie Extraction | **Fixed** | 1h Disk Cache + Memory Cache. |
| **8** | Scanner Timeout | **Fixed** | Now respects user preferences (Default 60s). |
| **9** | Import ID Loss | **Fixed** | Prioritizes existing IDs; updated Import UI. |
| **10**| Code Duplication | **Fixed** | Consolidated to `commUtils` Master pair. |
| **11**| Live Swap Failure | **Fixed** | Implemented Synchronous Hot Swap Manifest. |
| **12**| Pahe 403 Forbidden | **Fixed** | Switched to Native Tables + priority 100 hook. |

## 📈 Next Steps (Roadmap)
The **Improvement Plan** has been created to guide the next phase of development:
1.  **Phase 1**: Boundary Enforcement (Length limits & Char counts in UI).
2.  **Phase 2**: Security Hardening (yt-dlp Whitelisting & Secure Permissions).
3.  **Phase 3**: Schema Validation & Content Security Policy (CSP).
4.  **Phase 4**: Diagnostic Collector (Structured error reporting).

The system is now stable, optimized, and significantly more secure.
