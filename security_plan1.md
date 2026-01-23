# MPV Playlist Organizer: Security Roadmap (V1.1)

This plan categorizes security requirements based on their current implementation status and assigns priority to outstanding tasks.

## 🟢 1. Fully Implemented (Maintenance Mode)
These features are core to the current security posture and require regular verification but no immediate refactoring.

1.  **[PRIORITY: CRITICAL] yt-dlp Flag Whitelisting:** Strict `YTDLP_SAFE_FLAGS_ALLOWLIST` in `file_io.py` prevents arbitrary command execution via yt-dlp.
2.  **[PRIORITY: HIGH] SSRF Protection:** `is_safe_url` in `url_analyzer.py` prevents the host from accessing private/local IP ranges.
3.  **[PRIORITY: HIGH] Volatile Cookie Management:** `VolatileCookieManager` stores sensitive session cookies in RAM (`/dev/shm`) and ensures cleanup.
4.  **[PRIORITY: MEDIUM] Data Integrity:** Atomic writes (`.tmp` swap) and `.bak` redundancy in `file_io.py` prevent configuration corruption.
5.  **[PRIORITY: MEDIUM] The Janitor:** Automated startup cleanup of stale IPC sockets and temporary M3U files.

## 🟡 2. Partially Implemented (Needs Work)
These features exist but have gaps that could be exploited under specific conditions.

1.  **[PRIORITY: CRITICAL] M3U Injection Hardening:** 
    - *Current:* Strips newlines.
    - *Required:* Escape shell metacharacters (`$`, `` ` `) in titles to prevent interpretation by sub-processes.
2.  **[PRIORITY: HIGH] IPC Socket Permissions:**
    - *Current:* Sockets are cleaned up.
    - *Required:* Explicitly set `0600` (owner-only) permissions upon socket creation in `mpv_session.py`.
3.  **[PRIORITY: HIGH] Protocol Whitelisting:**
    - *Current:* `ALLOWED_PROTOCOLS` exists in `services.py`.
    - *Required:* Remove or strictly gate `file://` protocol; ensure validation is enforced at the JS entry point (`NativeLink.js`) before reaching Python.
4.  **[PRIORITY: MEDIUM] String Sanitation:**
    - *Current:* Basic character stripping.
    - *Required:* Integrate context-aware sanitation that distinguishes between OSD titles and filesystem-safe names.

## 🔴 3. Not Implemented (New Requirements)
High-impact security features that are currently missing from the codebase.

1.  **[PRIORITY: CRITICAL] Input Length Limits:**
    - *Goal:* Implement `SECURITY_LIMITS` for URLs (max 2048) and Titles (max 255) to prevent memory exhaustion and UI breakage.
2.  **[PRIORITY: HIGH] Secure Error Handling (Path Masking):**
    - *Goal:* Implement a wrapper to mask system paths (e.g., `/home/user/` -> `<HOME>/`) in logs and messages sent to the browser.
3.  **[PRIORITY: HIGH] MPV Process Isolation:**
    - *Goal:* Launch MPV with `--no-config` and `--load-scripts=no` by default to prevent "Shadow Config" attacks where malicious local files interfere with the extension.
4.  **[PRIORITY: MEDIUM] Content Security Policy (CSP):**
    - *Goal:* Define a strict CSP in `manifest.json` to prevent XSS within the extension's popup and options pages.
5.  **[PRIORITY: LOW] Automated Security Tests:**
    - *Goal:* Create a `testing_tools/security_fuzzer.py` to test path traversal and injection vectors automatically.

## 📈 Implementation Priority Queue

1.  **Immediate:** Input Length Limits & Path Masking.
2.  **Next:** MPV Isolation (`--no-config`) & Socket Permission Hardening.
3.  **Future:** CSP Policy & Automated Fuzzing.
