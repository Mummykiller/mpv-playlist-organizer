---
name: security-and-diagnostics
description: >-
  Governs input validation, SSRF protection, subprocess isolation, path sandboxing,
  sanitization, unified logging, and diagnostics. Load this skill whenever modifying
  `utils/security.py`, `utils/security.module.js`, `utils/logger.py`, `utils/SystemLogger.module.js`,
  `references/SECURITY.md`, executing subprocesses, handling file paths, or modifying diagnostics reports.
---

# Security, Validation & Unified Diagnostics Architecture

This skill defines the high-level security invariants, validation entry points, and audit guardrails across the Chrome Extension and Python Native Host.

> [!IMPORTANT]
> For the complete specification—including exact limits, allowlists, SSRF ranges, TOCTOU defenses, and Janitor retention thresholds—read [references/SECURITY.md](references/SECURITY.md).

---

## 1. Shared Input Validation & Native Messaging Limits

| Boundary | Entry Point | Enforcement Summary |
| :--- | :--- | :--- |
| **JS Pre-Validation** | `utils/security.module.js`<br>`utils/nativeConnection.module.js:callNativeHost` | Validates URLs (`MAX_URL_LENGTH: 4096`), titles (`512`), folder names (`128`), and item counts (`10,000`) across single values and batch fields (`url`, `urlItem`, `urls`, `urlItems`, `playlist`, `m3uData`). Enforces 30s handshake/request timeouts. |
| **Python Inbound Gate** | `native_host.py:get_message`<br>`utils/security.py:validate_payload` | Rejects raw frames > `5 MB` (`MAX_IPC_MESSAGE_SIZE`), non-dict payloads, missing `action`, recursion > `32` levels, strings > `100 KB`, and collections > `10,000` items. |
| **Python Outbound Guard** | `native_host.py:send_message_binary`<br>`utils/session_health.py:trim_oversized_reply` | Soft-trims optional preview fields above `800 KB` (`SAFE_OUTBOUND_PAYLOAD_SIZE`, setting `payloadTruncated: true`) and hard-blocks frames > `900 KB` (`MAX_OUTBOUND_MESSAGE_SIZE`). |

---

## 2. Protocol Security, SSRF & Extension Isolation

- **Protocol Allowlists (`ALLOWED_PROTOCOLS` vs. `ALLOWED_WEB_PROTOCOLS`):**
  - Global allowlist: `http://`, `https://`, `file://` (empty hostname only), `udp://`, `rtmp://`, `rtsp://`, `mms://`.
  - Web scrapers, content scripts, context menus, and YouTube Tools (`isValidWebUrl`, `isSafeWebUrl`, `is_safe_web_url`) strictly allow `http:` and `https:`.
- **SSRF & Redirect Defenses (`utils/security.py:is_safe_url`, `utils/security.module.js:isSafeUrl`):**
  - Blocks `BLOCKED_HOSTNAMES` (`localhost`, `*.localhost`, `*.local`, cloud metadata hosts), private/loopback/link-local/CGNAT IPv4 & IPv6 ranges, IPv4-mapped IPv6, and integer/hex/octal obfuscations (`parse_obscured_ip`).
  - Verifies all DNS records (`socket.getaddrinfo`), re-validates HTTP redirects (`utils/item_processor.py:SafeRedirectHandler`), and checks externally resolved `yt-dlp --get-url` outputs (`utils/url_analyzer.py:run_bypass_logic`).
- **Extension, Shadow DOM & YouTube Tools Isolation:**
  - `manifest.json` enforces `"script-src 'self'; object-src 'none'"` and `use_dynamic_url: true` for CSS/images only.
  - Native Host manifest (`installer_src/installer_logic.py:validate_extension_id`) validates `^[a-p]{32}$` and locks `allowed_origins` to the single extension ID.
  - On-page UI renders in Shadow DOM hosts (`#m3u8-controller-host`, `#m3u8-minimized-host`, `#anilist-panel-host`) with `<style>.textContent` injection and XSS-safe `createElement` + `textContent` rendering.
  - YouTube Tools (`background/yt_tools_service.js`, `yt-tools/`) is opt-in (`shinkuYtToolsEnabled: false`), dynamically registered via `chrome.scripting`, isolates `MAIN`-world `yt_content.js` from `chrome.*` APIs via `ISOLATED`-world `yt_bridge.js` (checking `event.source === window && event.origin === window.location.origin`), blocks `__proto__`/`constructor`/`prototype`, and validates video IDs (`VALID_VIDEO_ID_RE`).

---

## 3. Subprocess, Process & Command Hardening

1. **Shell-Free Execution & `--` Delimiters:** Always pass discrete argument arrays to `subprocess.Popen` / `subprocess.run` (never `shell=True` or `sh -c`). Always insert `'--'` before target URLs in `MpvCommandBuilder.build`, `utils/url_analyzer.py`, and `utils/fallback_sync.py`.
2. **Environment Scrubbing (`utils/security.py:get_scrubbed_env`):** Strips Python runtime variables (`PYTHON_ENV_VARS_TO_SCRUB`), enforces `POSIX_ALLOWED_ENV_VARS` (+ `LC_*`, `XDG_*`) on Linux/macOS, and strips `WINDOWS_SENSITIVE_ENV_PREFIXES` on Windows.
3. **Cookie, URL & Script-Opts Hardening:** `cookies_browser` → `is_safe_cookie_browser`; `cookies_file` → `is_safe_cookie_file`; custom `--script-opts=` is dropped; `MpvCommandBuilder.with_url`, `apply_bypass_script`, and `parse_m3u` all enforce `is_safe_url`; secret files are `0o600`.
4. **Settings, Binary & Flag Allowlists:**
   - Settings updates (`file_io.py:set_settings`) filter keys against `ALLOWED_SETTINGS_KEYS` and verify binaries (`mpv_path`, `ytdlp_path`, `ffmpeg_path`, `node_path`, `terminal_emulator`) via `is_safe_executable_path` (`APPROVED_BINARY_NAMES`, `FORBIDDEN_PATH_CHARS`, `os.X_OK`).
   - `yt-dlp` options use a two-tier allowlist (`sanitize_ytdlp_options`): untrusted item payloads are restricted to `YTDLP_SAFE_FLAGS_ALLOWLIST` (`allow_settings_flags=False`), while `YTDLP_SETTINGS_ONLY_FLAGS` (`proxy`, `ffmpeg-location`, `js-runtimes`, `remote-components`, etc.) are restricted to trusted settings (`allow_settings_flags=True`).
   - MPV flags are filtered against `SAFE_MPV_FLAGS_ALLOWLIST` in `MpvCommandBuilder.build` (and custom `--script-opts=` tokens are dropped so only internal handshake/script options reach MPV).
5. **PID Identity & Executor Isolation:** Verify reconnected MPV processes via `utils/ipc_utils.py:verify_mpv_process` before signaling. Keep `CONTROL_ACTIONS` on `control_executor` in `native_host.py:select_executor`.

---

## 4. Path Sandboxing, TOCTOU & Local Server Security

- **Canonical Path Sandboxing (`os.path.realpath` + `os.path.commonpath`):**
  - General config/runtime paths: `utils/security.py:validate_safe_path`.
  - Playlist shards: `file_io.py:_get_safe_shard_path` (inside `PLAYLISTS_DIR`).
  - Exports/imports: `file_io.py:write_export_file` and `DataHandler.handle_import_from_file` (inside `EXPORT_DIR`, `.json` only).
- **Locking, TOCTOU & Permissions:**
  - `utils/file_lock.py:FileLock` combines per-path `threading.RLock` with `0o600` OS advisory locks (`flock`/`msvcrt.locking`) and POSIX `fstat`/`stat` inode verification, acquired in `INDEX_FILE` → `shard_path` order.
  - `file_io.py:_atomic_json_dump` writes to `<file>.<pid>.<tid>.tmp` with `os.fsync()`, validates existing JSON before updating `<file>.bak`, and swaps via `os.replace()`.
  - `session.json` is created with `os.open(..., 0o600)` (`persist_session_atomic`), completion flags use `os.O_NOFOLLOW` with a 256-byte cap (`_safe_read_flag_file`), and `VolatileCookieManager` uses per-PID `0700` `/dev/shm` directories (UID-verified) with `0600` cookie files.
- **Local M3U Server (`playlist_server.py`, `utils/m3u_server.py`):** Binds to `127.0.0.1:0` (ephemeral port, 10s socket timeout), validates `Host`, requires `MPV_PLAYLIST_TOKEN` via `hmac.compare_digest` (redacted in logs/`last_mpv_command.txt`), serves only `/playlist.m3u`, and runs a parent-PID `suicide_watch` thread.

---

## 5. Unified Logging, Diagnostics & Janitor

- **Non-Blocking Logging & Masking (`utils/logger.py`, `utils/security.py:mask_path`):**
  - `ContextQueueHandler` injects `[Req: <request_id>]` from `request_id_var` and streams to `QueueListener` across rotating logs (`native_host.log`, `ipc_events.log`, `browser_errors.log`).
  - `SecurityFormatter`, `DiagnosticCollector.add_error`, `native_host.py:task_wrapper`, and outbound `send_message_binary` (`"log"` field) mask `<DATA_DIR>`, `<APP_DIR>`, and `<HOME>` (longest path first).
  - Forwarded browser errors (`log_event`, `log_browser_error`) cap `message` and `stack` at 4,096 chars each.
- **The Janitor (`utils/janitor.py:Janitor.run_startup_sweep`):** Guarded by `.janitor.lock` (5m staleness); cleans volatile cookies > **24h**, temp playlists/sockets/flags > **72h** (after PID and socket responsiveness checks), and handshakes > **1h**.

---

## 6. Audit Guardrails

1. **Item-supplied vs. settings-supplied options.** Item payloads (`ytdl_raw_options`) must use `allow_settings_flags=False`. Flags affecting execution, network routing, or downloads (`proxy`, `ffmpeg-location`, `js-runtimes`, `remote-components`, `alias`, `update`) are **settings-only**, and binary paths must pass `is_safe_executable_path`.
2. **Allowlist changes need a test.** Every key added to a flag, settings, or protocol allowlist requires a test in `testing_tools/scripts/test_security_claims.py` proving an item-supplied dangerous value is rejected.
3. **Fail closed.** Missing token, unresolved hostname, invalid `Host` header, or unverifiable PID means *deny*, never "skip the check".
4. **Local HTTP servers** must bind `127.0.0.1` on an ephemeral port (`0`), require a constant-time token check, validate the `Host` header, use threaded handlers with socket timeouts, and run a parent-PID `suicide_watch`.
5. **Temp and shared paths.** Never use fixed world-writable paths. Use per-process `mkdtemp` or private `0700` dirs, verify UID ownership, open flags with `O_NOFOLLOW`, and create secrets with mode `0600` via `os.open(..., 0o600)`.
6. **Never signal an unverified PID.** Confirm process identity via `verify_mpv_process` before `os.kill` or `taskkill`.
7. **Path-character blacklists** must not reject legitimate paths (`(`, `)` appear in `Program Files (x86)`). Validate by existence, `os.X_OK`, and `APPROVED_BINARY_NAMES`.
8. **Never leak raw paths or tokens** into UI-bound error responses or logs; use `mask_path` and redact `token=` query parameters.
9. **Cap untrusted text** forwarded to logs (`log_event` / `log_browser_error` `message` and `stack` ≤ 4,096 chars).
10. **Validate batch fields and pass `--` before URLs.** URL validation must cover `url`, `urlItem`, `urlItems`, `urls`, `playlist`, and `m3uData`. All CLI builders (`mpv`, `yt-dlp`) must insert `'--'` before positional URLs.
11. **Installer & wrapper safety (`installer_src/installer_logic.py`, `installer_cli.py`):** Validate extension IDs via `validate_extension_id` (`^[a-p]{32}$`) before writing manifests, quote all paths in generated wrappers (`shlex.quote` on Unix; double-quoted paths in `WindowsLogic`), and keep installer modules import-safe with read-only `DATA_DIR` fallback.
