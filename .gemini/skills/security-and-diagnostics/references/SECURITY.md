# MPV Playlist Organizer: Security & Sanitation Standards

This document serves as the **single source of truth** for security protocols, input validation, browser extension isolation, and native host safety within the MPV Playlist Organizer project. All contributors and agents MUST adhere to these standards.

---

## 1. Input Validation & Length Limits
Strict enforcement of input sizes and payload structures prevents Denial of Service (DoS) via memory exhaustion and ensures UI and IPC stability.

| Parameter | JS Limit | Python Limit | Description |
| :--- | :--- | :--- | :--- |
| **Title Length** | 512 chars (`SECURITY_LIMITS.MAX_TITLE_LENGTH`) | 512 chars (`SECURITY_LIMITS['MAX_TITLE_LENGTH']`) | Video/Folder titles. Truncated in Python by `utils/security.py:sanitize_string`. |
| **URL Length** | 4096 chars (`SECURITY_LIMITS.MAX_URL_LENGTH`) | 4096 chars (`SECURITY_LIMITS['MAX_URL_LENGTH']`) | Enforced in JS by `isValidUrl`/`isValidWebUrl` and in Python by `is_safe_url`/`sanitize_string`. |
| **String Length** | N/A | 100 KB (`SECURITY_LIMITS['MAX_STRING_LENGTH']`) | General payload strings (`1024 * 100` bytes) checked in `validate_payload`. |
| **Playlist Items** | 10,000 (`SECURITY_LIMITS.MAX_PLAYLIST_ITEMS`) | 10,000 (`SECURITY_LIMITS['MAX_PLAYLIST_ITEMS']`) | Maximum items per folder/shard or payload list/dict (`validate_payload`). |
| **Folder Name** | 128 chars (`SECURITY_LIMITS.MAX_FOLDER_NAME_LENGTH`) | 128 chars (`SECURITY_LIMITS['MAX_FOLDER_NAME_LENGTH']`) | Folder and export base names (`sanitize_string(..., is_filename=True)`). |
| **Folders Count** | N/A | 2,000 (`SECURITY_LIMITS['MAX_FOLDERS']`) | Maximum number of folders. |
| **Payload Depth** | N/A | 32 levels (`max_depth=32`) | Maximum recursion depth in `utils/security.py:validate_payload`. |
| **Browser Error Log** | N/A | 4,096 chars | Per-field truncation cap for `message` and `stack` in `DataHandler.handle_log_event` and `DataHandler.handle_log_browser_error`. |
| **Completion Flag Read** | N/A | 256 bytes | Maximum bytes read from `mpv_natural_completion_<pid>.flag` in `utils/session_services.py:_safe_read_flag_file`. |
| **Executable Path** | N/A | 1,024 chars | Maximum length for configured binary paths in `utils/security.py:is_safe_executable_path`. |
| **Windows CLI Length** | N/A | 7,500 chars | Maximum constructed MPV command line length on Windows in `MpvCommandBuilder.build`. |
| **IPC Message** | N/A | 5 MB in / 800 KB soft / 900 KB hard out | Native messaging frame caps (`MAX_IPC_MESSAGE_SIZE`, `SAFE_OUTBOUND_PAYLOAD_SIZE`, `MAX_OUTBOUND_MESSAGE_SIZE`). |

### 1.1 Defense-in-Depth Validation Pipeline
- **Frontend Pre-Validation Gate (`utils/security.module.js`, `utils/nativeConnection.module.js:callNativeHost`):**
  - `isValidUrl`, `isValidWebUrl`, `areValidUrls`, `isSafeUrl`, and `isSafeWebUrl` validate both single strings and batch arrays of strings or `{ url }` objects, failing closed (`false`) if `new URL()` throws.
  - Before posting any message over the native port, `callNativeHost` validates `message.url`, `message.urlItem.url`, `message.urls`, `message.urlItems`, `message.playlist`, and `message.m3uData.value` (when `m3uData.type === "items"`) via `isAllowedNativeUrl`, which enforces `isValidUrl` and `isSafeUrl(..., { allowLocal: true })` for **all** allowed schemes (so `file://localhost/...` or `rtsp://127.0.0.1/...` are blocked at the bridge).
  - Enforces a 30-second handshake timeout (`restore_session`) and a 30-second per-request timeout (`DEFAULT_REQUEST_TIMEOUT_MS = 30000`).
- **Inbound Native Host Gate (`native_host.py:get_message`, `utils/security.py:validate_payload`):**
  - `get_message()` rejects raw native frames exceeding `MAX_IPC_MESSAGE_SIZE` (5 MB) before reading the payload buffer.
  - `validate_payload()` rejects non-dict messages, missing/non-string `action` fields, recursion deeper than 32 levels, strings over 100 KB, and lists/dicts exceeding 10,000 entries before handler dispatch.
- **Outbound Native Messaging Guard (`native_host.py:send_message_binary`, `utils/session_health.py:trim_oversized_reply`):**
  - **Soft Trim (`800 KB` / `SAFE_OUTBOUND_PAYLOAD_SIZE`):** Strips optional large preview fields (`enrichedM3uContent`/`enriched_m3u_content`, `playlist`, `enrichedUrlItems`/`enriched_url_items`) and sets `payloadTruncated: true` (`payload_truncated: True`).
  - **Hard Cap (`900 KB` / `MAX_OUTBOUND_MESSAGE_SIZE`):** Suppresses oversized messages and returns a compact `native_link.failure` response (preserving `request_id`) so Chrome never terminates the Native Host at its 1 MiB limit.

---

## 2. Protocol & URL Security
### 2.1 Protocol Allowlist & Web Scraper Isolation
- **Global Permitted Schemes (`ALLOWED_PROTOCOLS`):** `http://`, `https://`, `file://`, `udp://`, `rtmp://`, `rtsp://`, `mms://`
- **Web Scraper Protocol Isolation (`ALLOWED_WEB_PROTOCOLS` / `isValidWebUrl` / `isSafeWebUrl` / `is_safe_web_url`):** Content scripts, context menus, YouTube Tools, and automated page scrapers (`utils/PageScraper.js`, `utils/item_processor.js`, `utils/fallback_sync.py:mark_video_as_watched`) strictly permit `http:` and `https:`. Local system schemes (`file:`) and raw streaming protocols (`rtmp:`, `udp:`, `rtsp:`, `mms:`) are blocked from automated web ingestion and reserved exclusively for explicit user actions (`allowLocal: true` in JS / `web_only=False` in Python).
- **`file://` Hostname Restriction:** In `utils/security.py:is_safe_url`, `file://` URLs are only permitted when `parsed.hostname` is empty (local paths such as `file:///path/to/video.mkv`) and `web_only` is `False`. Any `file://` URL specifying a hostname (e.g., `file://localhost/...` or `file://127.0.0.1/...`) falls through to the hostname/IP SSRF checks and is rejected. `utils/security.module.js:isSafeUrl` enforces the same rule (`file:` is allowed only with `allowLocal` and an empty hostname). JS parity also covers 1/2/3/4-part dotted/dword IPv4 (decimal/octal/hex), full IPv6 `fc00::/7`, `fe80::/10`, and `ff00::/8` (multicast, except `udp:`).
- **`udp://` Multicast Rule:** Multicast IP ranges (`224.0.0.0/4` in IPv4 and `ip_obj.is_multicast` in Python) are blocked for all protocols except `udp://` streams.

### 2.2 SSRF Protection, Redirect Guard & Obfuscation Defense (`is_safe_url` / `isSafeUrl`)
To prevent the Native Host and extension from being used as an internal network proxy or SSRF gateway:
- **Hostname & Cloud Metadata Denylist (`BLOCKED_HOSTNAMES`):** Blocks `localhost`, `localhost.localdomain`, `ip6-localhost`, `ip6-loopback`, `*.localhost`, `*.local`, `metadata.google.internal`, `metadata.internal`, and `instance-data`.
- **Private & Restricted IPv4 Ranges Blocked:** RFC 1918 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), Loopback (`127.0.0.0/8`), Link-Local & Cloud Metadata (`169.254.0.0/16`, `169.254.169.254`), Current Network / Linux Local (`0.0.0.0/8`), Carrier-Grade NAT (`100.64.0.0/10`), and Reserved ranges.
- **IPv6 Protection:** Strips IPv6 zone IDs (`%eth0`), blocks loopback (`::1`), unspecified (`::`), link-local (`fe80::/10`), unique-local (`fc00::/7`, `fd00::/8`), and unwraps IPv4-mapped IPv6 addresses (`::ffff:127.0.0.1` and canonical hex `::ffff:7f00:1`) against the full IPv4 check suite.
- **IP Obfuscation Defenses (`utils/security.py:parse_obscured_ip`):** Detects and normalizes integer/dword literals (e.g., `http://2130706433/`), hex dwords (`http://0x7f000001/`), and 1/2/3/4-part classful dotted octal/hex/decimal variations (`http://0177.0.0.1/`, `http://0x7f.0.0.1/`, `http://017700000001/`).
- **DNS Resolution Inspection:** Resolves candidate hostnames via `socket.getaddrinfo` and verifies every returned IP record against `_is_unsafe_ip()`, with graceful `socket.gaierror` handling when offline or in a network-isolated test sandbox.
- **HTTP Redirect SSRF Verification (`utils/item_processor.py:ItemProcessor._fetch_remote_m3u`):** Uses a custom `SafeRedirectHandler(HTTPRedirectHandler)` with a 10-second timeout that re-validates every redirect target `newurl` via `is_safe_url(newurl)` and raises `HTTPError(..., 403, "Blocked unsafe redirect")` if a remote M3U URL redirects to an internal/private address.
- **Universal Enforcement Points:** `services.py:apply_bypass_script` runs `is_safe_url` *before* the `enable_url_analysis` short-circuit (disabling analysis never bypasses SSRF); `utils/mpv_command_builder.py:MpvCommandBuilder.with_url` drops any URL failing `is_safe_url` (only the exact local M3U server URL `http://127.0.0.1:<port>/playlist.m3u?token=<hex>` is exempt); `utils/m3u_parser.py:parse_m3u` rejects unsafe schemes/SSRF hosts and `..` traversal paths and sanitizes per-item yt-dlp options with `allow_settings_flags=False`; `utils/fallback_sync.py:mark_video_as_watched` requires `is_safe_web_url`.
- **Stream Output Verification (`utils/url_analyzer.py:run_bypass_logic`):** Every stream URL resolved externally by `yt-dlp --get-url` must pass `is_safe_url()` before being returned or passed to MPV.

### 2.3 URL Normalization & CDN Header Enforcement
- **URL Normalization (`utils/url_analyzer.py:normalize_url`, `utils/commUtils.module.js:normalizeYouTubeUrl`):** Strips tracking query parameters (`t`, `index`, `start`, `ab_channel`, `attr_tag`, `si`, `feature`, `pp`). Python's `normalize_url` also strips URL fragments and sorts remaining query parameters for deterministic deduplication and resume matching.
- **CDN Header Sanitization (`services.py:force_sanitize_headers`):** Enforces canonical `Referer: https://kwik.cx/` and `Origin: https://kwik.cx` headers on AnimePahe/Kwik vault CDN URLs (`.owocdn.top`, `.uwucdn.top`, `kwik.cx`), overriding stale or untrusted browser-supplied item headers.

---

## 3. Browser Extension, Native Host Manifest & Sub-Extension Isolation
### 3.1 Manifest V3 & Content Security Policy (`manifest.json`)
- **Extension Page CSP:** Enforces `"script-src 'self'; object-src 'none'"` on `extension_pages` (no `unsafe-inline`, no `unsafe-eval`, no remote scripts).
- **Web Accessible Resources:** Uses `"use_dynamic_url": true` and exposes only visual assets (`shared.css`, `content.css`, `images/*`), keeping all internal JS modules inaccessible to web pages and mitigating extension fingerprinting.
- **Domain Restriction (`restricted_domains`):** Content script initialization checks the user's `restricted_domains` list and aborts UI injection on excluded hosts.

### 3.2 Native Messaging Host Manifest & Origin Binding (`installer_src/installer_logic.py`)
- **Strict Extension ID Validation (`validate_extension_id`):** Validates that the target Chrome Extension ID matches `EXTENSION_ID_PATTERN = re.compile(r"^[a-p]{32}$")` before generating the native messaging manifest.
- **Single-Origin Locking:** The generated manifest (`com.mpv_playlist_organizer.handler-chrome.json` in `DATA_DIR`) binds `"allowed_origins": [f"chrome-extension://{extension_id}/"]` to that single extension ID (never wildcarded) with `"type": "stdio"`.
- **Wrapper Script Quoting & Least-Privilege Registration:**
  - **Unix (`UnixLogic.install`, `LinuxLogic`, `MacOSLogic`):** Quotes `sys.executable` and script paths via `shlex.quote` inside `run_native_host.sh` and `mpv-cli`, sets `0o755` permissions on `native_host.py` and the wrapper scripts, and registers per-user symlinks under `~/.config/<browser>/NativeMessagingHosts/` or `~/Library/Application Support/<browser>/NativeMessagingHosts/`.
  - **Windows (`WindowsLogic.install`):** Quotes executable paths in `run_native_host.bat` and `mpv-cli.bat` and registers the manifest under `HKEY_CURRENT_USER\SOFTWARE\<Browser>\NativeMessagingHosts\com.mpv_playlist_organizer.handler` (user-scoped registry, requiring no administrator elevation).

### 3.3 Shadow DOM Encapsulation & XSS Prevention
- **Shadow DOM Style Injection (`utils/UIManager.js`):** The on-page controller renders inside an isolated Shadow DOM container (`#mpv-organizer-root`). Stylesheets (`shared.css`, `content.css`) are fetched via `chrome.runtime.getURL` and injected into `<style>.textContent`—never via `<link rel="stylesheet">` (blocked by strict site CSPs) and never by overwriting `shadowRoot.innerHTML` after style injection.
- **XSS-Safe DOM Construction (`utils/domUtils.module.js`, `utils/anilist_renderer.module.js`, `popup/popup_youtube.js`):** Untrusted video titles, URLs, folder names, AniList release metadata, and YouTube library items are rendered exclusively via `document.createElement` and `textContent` (never raw `innerHTML`).

### 3.4 Shinku's YouTube Tools Sub-Extension Security (`background/yt_tools_service.js`, `yt-tools/`)
- **Opt-In by Default:** Controlled by `shinkuYtToolsEnabled` (default `false` in the main extension). When disabled, zero content scripts or context menus are registered for YouTube Tools.
- **Dynamic Registration Only:** Registered/unregistered dynamically via `chrome.scripting.registerContentScripts` / `unregisterContentScripts` (`*://*.youtube.com/*`), serialized through `registrationQueue`, and never statically declared in the main `manifest.json`.
- **Dual-World Privilege Separation (`MAIN` vs. `ISOLATED`):**
  - `yt-tools/yt_content.js` runs in the `MAIN` world (required for YouTube player API control) and has **no access** to `chrome.*` extension APIs.
  - `yt-tools/yt_bridge.js` runs in the `ISOLATED` world and mediates all `chrome.storage.local` and `chrome.runtime` access. It validates `window.postMessage` events (`event.source === window && event.origin === window.location.origin`), restricts messages to the `SHINKU__*` namespace, serializes storage writes via `libraryWriteQueue`, and automatically tears down listeners/intervals (`teardownInvalidatedBridge`) if the extension context is invalidated.
- **Prototype Pollution Guard on the Bridge:** `utils/commUtils.module.js:normalizeKeys`, `utils/native_link/translator.py:_normalize_message`, and `utils/native_link/responder.py:_translate_keys` drop `__proto__`, `constructor`, and `prototype` keys.
- **Prototype Pollution & Video ID Validation:** `yt_bridge.js`, `yt_tools_service.js`, and `background/handlers/import_export.js` block prototype-polluting keys (`FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"])`). `yt_tools_service.js` validates YouTube video IDs against `VALID_VIDEO_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/` before indexing `shinkuLibrary` or fetching YouTube oEmbed metadata.

---

## 4. String & Metadata Sanitation
### 4.1 Context-Aware Stripping (`utils/security.py:sanitize_string`, `utils/commUtils.module.js:sanitizeString`)
- **Python Backend (`utils/security.py:sanitize_string` — Authoritative Sanitizer & Truncator):**
  - **Filenames & Folder Names (`is_filename=True`):** Truncates to `MAX_FOLDER_NAME_LENGTH` (128 chars) and strips `/ \ : * ? " < > | $ ; & ` ` and `\n \r \t`.
  - **OSD, Titles & URLs (`is_filename=False`):** Auto-detects URI scheme prefixes (`http://`, `https://`, `file://`, `rtmp://`, `rtsp://`, `mms://`, `udp://`) to apply `MAX_URL_LENGTH` (4096 chars) when `is_url=True` or a scheme is detected, or `MAX_TITLE_LENGTH` (512 chars) otherwise. Strips `"`, `` ` ``, `$`, `\n`, `\r`, and `\t` while preserving `#` and `&` for URL fragments (`#mpv_organizer_id=<uuid>`) and query parameters.
- **JavaScript Frontend (`utils/commUtils.module.js:sanitizeString`):**
  - **Filenames (`isFilename = true`):** Strips `/[\\/:*?"<>|$;&`\n\r\t]/g` and trims whitespace.
  - **Titles & URLs (`isFilename = false`):** Strips `/["`\n\r\t]/g` and trims whitespace (relying on `utils/security.module.js` for URL length enforcement and Python's `sanitize_string` for `$` stripping and length truncation).

### 4.2 M3U Injection Hardening (`utils/session_ipc_ops.py:generate_m3u_content`, `utils/m3u_parser.py:parse_m3u`)
- **M3U Generation (`generate_m3u_content`):** All `#EXTINF` titles and stream URLs written to M3U playlists are sanitized via `file_io.sanitize_string()` and `services.sanitize_url()`—stripping `"`, `` ` ``, `$`, `\n`, `\r`, and `\t`—to prevent command, line-break, or player option injection when MPV parses the playlist.
- **M3U Parsing (`parse_m3u`):** Sanitizes `#EXTINF` titles and URL lines via `file_io.sanitize_string`, rejects malformed lines that lack a valid URI scheme (`^[a-zA-Z][a-zA-Z0-9+.-]*://`) or local path prefix (`/`, `./`, `../`, `<Drive>:\`), and requires any `#EXTYTDLOPTIONS` / `#EXT-X-YTDL-OPTIONS` entries to pass `sanitize_ytdlp_options(..., allow_settings_flags=False)` during enrichment.

---

## 5. Filesystem, TOCTOU Defenses, Storage & IPC Security
### 5.1 Path Sandboxing
All filesystem paths are canonicalized via `os.path.realpath(os.path.abspath(path))` and verified with `os.path.commonpath` to block directory traversal (`../`) and symlink escapes:
- **General Config, Script & Runtime Paths (`utils/security.py:validate_safe_path`):** Must reside within `DATA_DIR`, `SCRIPT_DIR`, `TEMP_DIR`, Linux runtime directories (`/dev/shm`, `XDG_RUNTIME_DIR`, `~/.mpv_playlist_organizer_ipc`), or Windows Named Pipes (`\\.\pipe\*`).
- **Playlist Shards (`file_io.py:_get_safe_shard_path`):** Sanitizes `folder_id` and verifies the resolved `<folder_id>.json` path resides directly inside `PLAYLISTS_DIR` (`DATA_DIR/playlists`).
- **Exports & Imports (`file_io.py:write_export_file`, `utils/handlers/data_handler.py:DataHandler.handle_import_from_file`):** Subfolders and filenames are sanitized and verified via `os.path.commonpath` to remain strictly inside `EXPORT_DIR` (`DATA_DIR/exported`), and imported files must end in `.json`.

### 5.2 Atomic Operations, File Locking & TOCTOU Protection
All JSON state writes (`index.json`, playlist shards, `config.json`, `anilist_cache.json`) use cross-process locking, TOCTOU verification, and atomic replacement:
1. **Hybrid Thread + OS Advisory Lock with Inode Verification (`utils/file_lock.py:FileLock`):**
   - Combines a per-path in-process `threading.RLock` and thread-local reentrancy counter (`_held_locks`) with an OS advisory lock on `<filepath>.lock` (opened via `os.open(..., os.O_CREAT | os.O_RDWR, 0o600)` with a 5.0s default timeout).
   - Uses `fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)` on POSIX and `msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)` on Windows.
   - **POSIX TOCTOU Inode Check:** After acquiring `flock`, compares `os.fstat(fd)` against `os.stat(self.lockfile)` (`st_ino` and `st_dev`) to guarantee the locked descriptor still matches the path on disk and was not unlinked/replaced during contention.
2. **Strict Lock Hierarchy (`file_io.py:update_shard`, `file_io.py:save_library_batch`):** Always acquires `FileLock(INDEX_FILE)` before `FileLock(shard_path)` to prevent deadlocks and read-modify-write races.
3. **Per-Thread Temp Write (`file_io.py:_atomic_json_dump`):** Writes to `<file>.<pid>.<tid>.tmp`, flushes, and forces disk sync via `os.fsync()`.
4. **Validated Backup:** Copies the existing primary file to `<file>.bak` **only** after verifying the existing file parses as valid non-empty JSON, preventing a corrupted primary file from overwriting a healthy backup.
5. **Atomic Swap:** Replaces the target file via `os.replace()`.
6. **Non-Destructive Recovery (`file_io.py:_safe_json_load`, `file_io.py:get_settings`):** Automatically restores from `<file>.bak` if the primary file is corrupted. If `config.json` fails to parse, `get_settings()` preserves the file on disk rather than overwriting user settings with defaults.
7. **Orphan Shard Quarantine (`file_io.py:save_library_batch`):** Removed folders are moved to `DATA_DIR/playlists/trash/` with a timestamp suffix (`_move_orphan_to_trash`) rather than unlinked immediately, and empty folder payloads are refused when `index.json` is non-empty.

### 5.3 IPC Socket, Session File & Completion Flag Security
- **IPC Sockets (`utils/ipc_utils.py:get_ipc_path`):** Created in `XDG_RUNTIME_DIR/mpv_playlist_organizer_ipc` (or `~/.mpv_playlist_organizer_ipc` fallback) with directory mode `0700` and socket mode `0600` (`mpv-socket-<pid>`). Windows uses per-PID named pipes (`\\.\pipe\mpv-playlist-organizer-ipc-<pid>`).
- **Scoped Socket Cleanup (`utils/ipc_utils.py:IPCSocketManager.cleanup_stale_sockets`):** Audits and unlinks dead sockets strictly within `IPC_DIR_LINUX`—never scanning `/tmp` or external directories.
- **Session File (`utils/session_health.py:persist_session_atomic`):** `session.json` is created via a per-PID/thread temp file opened with `os.open(..., os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)` at creation time (owner read/write only), synced with `os.fsync()`, and swapped into place via `os.replace()`.
- **Symlink-Safe Completion Flag Reading (`utils/session_services.py:_safe_read_flag_file`):** Natural completion flag files (`mpv_natural_completion_<pid>.flag`) are opened directly via `os.open(flag_file, os.O_RDONLY | os.O_NOFOLLOW)` and read up to a 256-byte cap before removal, preventing symlink TOCTOU attacks.
- **Monotonic Session Generation Token (`mpv_session.py:MpvSessionManager.session_generation`):** Incremented on every launch and restore; checked by `clear()`, `start_health_watcher`, and exit waiter threads (`dispatched_exit_generations`) so delayed exit callbacks from a previous MPV process cannot clobber a newly launched session.

### 5.4 Local M3U HTTP Server Hardening (`playlist_server.py`, `utils/m3u_server.py`)
- **Loopback & Ephemeral Port:** Binds exclusively to `127.0.0.1` on an OS-allocated ephemeral port (`--port 0`) using `ThreadedPlaylistServer(ThreadingHTTPServer)` with 10-second socket timeouts.
- **DNS Rebinding Defense (`PlaylistHandler.do_GET`):** Validates the HTTP `Host` header against `{127.0.0.1:<port>, localhost:<port>}`.
- **Fail-Closed Token Auth:** Passes `MPV_PLAYLIST_TOKEN` (`secrets.token_hex(16)`) via the scrubbed subprocess environment (never CLI arguments) and verifies `?token=` using constant-time `hmac.compare_digest`. Missing or unconfigured tokens always deny (`403`).
- **Path Restriction & Lifecycle Guard:** Serves only `/playlist.m3u` (`404` for all other paths) and runs a daemon `suicide_watch` thread that terminates the server (`os._exit(0)`) if the parent Native Host PID exits.
- **Private Artifacts:** `server_<pid>.m3u` (`M3UServer.start`), `batch_*.m3u` (`session_ipc_ops.append_batch_internal`), and `handshake_*.json` (`services.py:create_handshake_file`) are created via `os.open(..., 0o600)`; temp playlist dirs use `0o700`.
- **Token Redaction:** `security.mask_path` redacts `token=` query values everywhere it is applied (including `M3UServer.start` timeout errors), and `utils/mpv_command_builder.py:MpvCommandBuilder.build` redacts `([?&]token=)[^&\s\'"]+` to `\1[REDACTED]` before logging or writing `last_mpv_command.txt`.

---

## 6. Playback, Subprocess Escaping & Native Host Hardening
### 6.1 Subprocess Argument Escaping & Option-Injection Hardening (`utils/mpv_command_builder.py`, `utils/url_analyzer.py`, `utils/fallback_sync.py`)
- **Shell-Free Execution:** All external processes (`mpv`, `yt-dlp`, `ffmpeg`, `node`, terminal emulators, `anilist_releases.py`, `playlist_server.py`, `fallback_sync.py`) are invoked as discrete argument arrays via `subprocess.Popen` or `subprocess.run`—never with `shell=True`, `sh -c`, or `bash -c`.
- **End-of-Options `--` Delimiter:** `MpvCommandBuilder.build()` always inserts `'--'` before appending target URLs (`args + (['--'] + urls)`). All `yt-dlp` invocations in `utils/url_analyzer.py` (`get_cookies_file`, `extract_with_shadow_copy`, `run_bypass_logic`) and `utils/fallback_sync.py` (`mark_video_as_watched`) likewise pass `'--'` before the target URL so a URL or filename starting with `-` can never be parsed as an option flag.
- **Custom Flag Tokenization & `--script-opts` Protection (`MpvCommandBuilder.build`):**
  - Tokenizes user `custom_mpv_flags` via `shlex.split(..., posix=not is_windows)`.
  - **Drops** any `--script-opts=` token from custom flags entirely; only internal `script_opts` (`mpv_organizer-handshake`, `on_completion-flag_dir`, `on_completion-clear_on_item_finish`) reach mpv, so users cannot smuggle script options (e.g. `ytdl_hook-ytdl_path`).
  - Re-sanitizes pre-existing `ytdl_raw_options` via `sanitize_ytdlp_options` before building `--ytdl-raw-options`.
  - **Cookie inputs:** `cookies_browser` must pass `security.is_safe_cookie_browser` (`ALLOWED_COOKIE_BROWSERS`), and `cookies_file` must pass `security.is_safe_cookie_file` (sandboxed path, `mpv_cookies_*.txt`); enforced in `services.py:construct_lua_options`, `MpvCommandBuilder.build`, `utils/session_ipc_ops.py` hot-swap, `utils/url_analyzer.py:run_bypass_logic`/`get_cookies_file`, and `utils/fallback_sync.py`.
  - Filters all remaining custom and automatic flags against `SAFE_MPV_FLAGS_ALLOWLIST`.
- **Platform-Aware Diagnostic Quoting (`_smart_quote` & `_windows_quote`):** Diagnostic command strings logged to `native_host.log` and `DATA_DIR/last_mpv_command.txt` are formatted with `shlex.quote` on POSIX and `_windows_quote` on Windows (which preserves backslashes and escapes embedded double quotes as `""`), checked against the 7,500-character Windows CLI length ceiling, and token-redacted.

### 6.2 Two-Tier `yt-dlp` & MPV Flag Whitelisting (`utils/security.py`)
- **`YTDLP_SAFE_FLAGS_ALLOWLIST` (Item-Level Safe Flags):** Flags permitted in untrusted item payloads (`ytdl_raw_options`, with `allow_settings_flags=False`), such as `cookies`, `cookies-from-browser`, `user-agent`, `referer`, `add-header`, `format`, `concurrent-fragments`, `extractor-args`, etc. Values are stripped of `"`, `'`, `&`, `|`, `` ` ``, `\n`, `\r`, and `;` (with `;` and escaped `\,` continuations permitted specifically for `extractor-args` in `sanitize_ytdlp_options` and `file_io.merge_ytdlp_options`).
- **`YTDLP_SETTINGS_ONLY_FLAGS` (Settings-Only Flags):** Flags restricted exclusively to trusted backend settings (`allow_settings_flags=True`): `proxy`, `ffmpeg-location`, `js-runtimes`, `remote-components`, `compat-options`, `alias`, `update`, `print`, `no-check-certificate`, and `geo-verification-proxy`. Stripped from all item-level payloads in `services.construct_lua_options` and `ItemProcessor.enrich_single_item` before merging essential settings flags.
- **Blocked Execution Flags:** Dangerous flags such as `--exec`, `--output`, `--config-location`, and `--external-downloader` are blocked in all contexts.
- **`SAFE_MPV_FLAGS_ALLOWLIST` & Parameter Validation:** Filters `automatic_mpv_flags` and `custom_mpv_flags`, while `MpvCommandBuilder.build` enforces regex/numeric validation on `--hwdec` (`^[a-zA-Z0-9_-]+$`), `--tscale` (`^[a-zA-Z0-9_-]+$`), `--geometry` (`^[0-9x+%+-]+$`), `--start` (`int(float(start_time))`), and `--override-display-fps` (positive `float`).

### 6.3 Volatile Cookie Management (`utils/url_analyzer.py:VolatileCookieManager`)
- **Direct Browser Access First:** Single-video YouTube and Kwik/AnimePahe landing-page playback passes `--cookies-from-browser` directly to MPV so no cookie file is written to disk.
- **RAM-Backed Volatile Directory (`get_volatile_dir`, `cleanup_volatile_dir`):** When cookie file extraction is required (YouTube playlist expansion or fallback), cookies are extracted to a per-process `0700` directory (`tempfile.mkdtemp(prefix=f"mpv_cookies_{os.getpid()}_")` in `/dev/shm` on Linux or `TEMP_DIR` fallback). On POSIX, `get_volatile_dir()` and `cleanup_volatile_dir()` verify `os.stat(cookie_dir).st_uid == os.getuid()` before use or deletion, and extracted cookie files are set to `0600`.
- **Shadow Copy Fallback (`extract_with_shadow_copy`):** If the browser's SQLite cookie database is locked, it is duplicated into a temporary `0700` `shadow_profile_*` directory inside volatile storage for `yt-dlp` extraction and deleted immediately in a `finally` block + `atexit` handler.

### 6.4 Settings & Executable Binary Validation (`utils/security.py`, `file_io.py:set_settings`)
- **Settings Key Allowlist (`ALLOWED_SETTINGS_KEYS`):** `file_io.set_settings` filters all incoming keys against `ALLOWED_SETTINGS_KEYS` and validates `ytdl_quality` against `['best', '2160', '1440', '1080', '720', '480']`.
- **Binary Allowlist (`is_safe_executable_path` & `APPROVED_BINARY_NAMES`):** Configured paths for `mpv_path`, `ytdlp_path`, `ffmpeg_path`, `node_path`, and `terminal_emulator` must be ≤ 1024 chars, contain no forbidden metacharacters (`FORBIDDEN_PATH_CHARS = set(';&|`$\n\r<>"\'')`, permitting parentheses for `Program Files (x86)`), match approved base binary names for that setting key, exist on disk or in `PATH`, and have execute permissions (`os.X_OK`).

### 6.5 Terminal Emulation & Environment Scrubbing (`utils/mpv_command_builder.py`, `utils/security.py:get_scrubbed_env`)
- **Direct Terminal Argv (`MpvCommandBuilder.build`):** Terminal emulators (`konsole`, `alacritty`, `kitty`, `foot`, `xfce4-terminal`, `xterm`, `gnome-terminal`, `tilix`, `wezterm`, `xdg-terminal-exec`) receive discrete argv lists, using a direct Python runner (`sys.executable -c ...`) when a delayed exit hold (`is_forced_terminal`) is requested on terminals without a native `--hold` flag.
- **Environment Scrubbing (`get_scrubbed_env`):** Strips Python contamination variables (`PYTHON_ENV_VARS_TO_SCRUB`: `PYTHONPATH`, `PYTHONHOME`, `PYTHONIOENCODING`, `PYTHONDONTWRITEBYTECODE`, `PYTHONUNBUFFERED`). When `keep_terminal=False` (the default for background subprocesses), enforces a strict variable whitelist (`POSIX_ALLOWED_ENV_VARS` + `LC_*`/`XDG_*`) on Linux/macOS, and strips sensitive credential prefixes (`WINDOWS_SENSITIVE_ENV_PREFIXES`: `AWS_`, `GIT_`, `SSH_`, `SECRET`, `TOKEN`, `PASSWORD`, `API_KEY`) on Windows.

### 6.6 PID Verification & Executor Isolation
- **PID Identity Verification (`utils/ipc_utils.py:verify_mpv_process`):** Before signaling or terminating a restored/reconnected MPV process (`SIGTERM`, `SIGKILL`, `taskkill`), verifies that the PID genuinely belongs to MPV and matches the session via IPC `pid` property probe, `/proc/<pid>/cmdline`, `psutil`, Windows `QueryFullProcessImageNameW`, or macOS/BSD `ps`.
- **Dual-Executor Isolation (`native_host.py:select_executor`):** Routes fast control, health, and logging actions (`CONTROL_ACTIONS`: `ping`, `close_mpv`, `restore_session`, `get_playback_status`, `is_mpv_running`, `log_event`, `log_browser_error`) to a dedicated 4-worker `control_executor` so heavy enrichment tasks on the 8-worker `worker_executor` cannot cause control starvation.

---

## 7. Unified Logging, Error Sanitization & Maintenance
### 7.1 Non-Blocking Logging & Path Masking (`utils/logger.py`, `utils/security.py:mask_path`, `native_host.py`)
- **Non-Blocking Queue Pipeline:** Log records are tagged with `[Req: <request_id>]` via `ContextVar` (`ContextQueueHandler`) and written asynchronously by a background `QueueListener` across three size-capped `RotatingFileHandler` logs (`native_host.log` 5 MB × 2, `ipc_events.log` 5 MB × 1, `browser_errors.log` 2 MB × 2), degrading gracefully to `TEMP_DIR/MPVPlaylistOrganizer` or `stderr` if `DATA_DIR` is unwritable.
- **Path Masking (`mask_path`):** Replaces sensitive system paths in log files, `DiagnosticCollector.add_error`, unhandled task exceptions (`native_host.py:task_wrapper`), and the `"log"`, `"error"`, and (on `success: false`) `"message"` fields of outbound `send_message_binary` payloads (replacing longest paths first so nested paths are masked cleanly while leaving functional settings/file fields intact):
  - `data_dir` -> `<DATA_DIR>`
  - `script_dir` -> `<APP_DIR>`
  - `home_dir` (`/home/<user>`) -> `<HOME>`
- **Error Response Hygiene:** Handlers returning failure messages to the UI must never leak unmasked filesystem paths or secrets (`MPV_PLAYLIST_TOKEN`) in user-facing error strings.

### 7.2 The Janitor (`utils/janitor.py:Janitor`)
Runs on Native Host startup (`run_startup_sweep`, guarded by `DATA_DIR/.janitor.lock` with a 300-second staleness timeout) to clean transient artifacts:
- **Volatile Cookies (`mpv_cookies_*` in `TEMP_DIR` and `VolatileCookieManager.get_volatile_dir()`):** Removed after **24 hours** if the associated PID is no longer running.
- **Temporary Playlists, Sockets & Completion Flags (`delta_*.m3u`, `server_*.m3u`, `mpv-socket-*`, `mpv_natural_completion_*.flag`):** Removed after **72 hours** only after verifying the owning PID is dead and any Unix socket in `IPC_DIR_LINUX` or `~/.mpv_playlist_organizer_ipc` is unresponsive via `IPCSocketManager`.
- **Metadata Handshake Files (`handshake_*.json` in `DATA_DIR/flags`):** Removed after **1 hour**.

---

## 8. Security Maintenance
- **Secrets:** Never log, print, or commit API keys, session tokens (`MPV_PLAYLIST_TOKEN`), or browser cookies.
- **Dependencies:** Regularly update `yt-dlp` to mitigate site-specific extraction vulnerabilities.
- **Regression Testing:** All security boundaries, allowlists, and sanitizers are enforced by `testing_tools/scripts/test_security_claims.py` and `testing_tools/scripts/test_modular_components.js`. Any change to a security allowlist or validation rule MUST include a corresponding regression test.
