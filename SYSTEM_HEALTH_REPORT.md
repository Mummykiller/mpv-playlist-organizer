# System Health & Consistency Report
**Date:** January 24, 2026
**Status:** 🛠️ Significant Progress Made (Verification Ongoing)

## 1. Resolved Issues ✅
- **Duplicate Main Loop:** `native_host.py` redundancy removed. (Verified)
- **Hardcoded Settings Whitelist:** `ui_state.js` now uses a black-list approach (`UI_ONLY_KEYS`), making the sync to Python more robust for future settings. (Verified)
- **Path Masking Info-Leak:** `send_message` in `native_host.py` now recursively masks paths in the `result` payload. (Verified)
- **yt-dlp Flag Value Injection:** `security.sanitize_ytdlp_options` now sanitizes values, not just keys. (Verified)
- **Thread-Safety (Partial):** `PlaybackHandler.handle_append` now correctly passes the `sync_lock` to the processor. (Verified)

## 2. Pending / Unsolved Issues ❌
- **Path Masking Info-Leak (Regression):** 
    - **Issue:** The recent fix in `native_host.py` added a `isinstance(..., dict)` check for the `log` key, which accidentally skips masking if `log` is a plain string. Additionally, `native_link.success()` often merges result data into the top-level dictionary, bypassing the `message_content['result']` check.
    - **Fix:** `send_message` should recursively mask the *entire* `message_content` dictionary after removing sensitive keys like `request_id` or `action`.
- **Cookie DB Path Fragility:** 
    - **Issue:** `url_analyzer.py` still assumes `Default` profiles.
    - **Fix:** Use a glob pattern or loop through `Profile *` and `Default` directories in the identified browser config bases to find the `Cookies` SQLite file.
- **Volatile Storage Leak:** 
    - **Issue:** Cookie files in `/dev/shm` remain if the host crashes.
    - **Fix:** In `native_host.py`, perform a recursive cleanup of `VolatileCookieManager.get_volatile_dir()` immediately upon startup (before the main loop).
- **SSRF DNS Rebinding:** 
    - **Issue:** The logic still doesn't pin the resolved IP.
    - **Fix:** (Complex) Ideally, the `item_processor` should pass the resolved IP to `yt-dlp` or `urlopen` if supported, or we must accept this as a "known limitation" while documenting the risk.
- **UI Feedback (OSC) Gaps:** 
    - **Fix:** The `nativeConnection.module.js` catch-all is verified, but Python handlers like `export_playlists` still need `log` objects for *success* messages (e.g., "Export successful").
- **High-Frequency Disk I/O:** 
    - **Note:** Throttled cache implemented for resume time. 
    - **Pending:** `_update_marked_as_watched` in `PlaylistTracker` should also be added to the throttled commit cycle if `persist=True`.
- **M3U Parser Ambiguity:** 
    - **Fix:** The regex split `re.split(r',(?=[^,]+[=:])', s)` is a good heuristic but could be further improved by explicitly supporting quoted values.

## 3. New Scouting Findings 🔍
- **M3U Parser Ambiguity:** The comma-vs-pipe fallback logic in `m3u_parser.py` remains a risk for complex header parsing.
- **"Ghost" M3U Items:** The parser returns any non-tag line as a URL without validation, potentially cluttering the playlist with garbage items if the file is malformed.
- **Selective SSRF:** `ItemProcessor._fetch_remote_m3u` bypasses the `is_safe_url` check used in other parts of the processor.