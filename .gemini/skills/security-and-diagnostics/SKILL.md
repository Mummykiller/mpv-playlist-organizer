---
name: security-and-diagnostics
description: >-
  Governs input validation, SSRF protection, subprocess isolation, path sandboxing,
  sanitization, unified logging, and diagnostics. Load this skill whenever modifying
  `utils/security.py`, `utils/security.module.js`, `utils/logger.py`, `utils/SystemLogger.module.js`,
  `references/SECURITY.md`, executing subprocesses, handling file paths, or modifying diagnostics reports.
---

# Security, Validation & Unified Diagnostics Architecture

This skill defines the security boundaries, protocol validation, process execution isolation, path sandboxing, and unified logging pipelines enforced across the MPV Playlist Organizer.

> [!NOTE]
> For the full security specification, limits, and checklists, see [references/SECURITY.md](references/SECURITY.md).

---

## 1. Shared Input Validation & Length Limits

To prevent Denial of Service (DoS) via memory exhaustion and buffer overflows, input limits are strictly enforced at two levels:

| Parameter | JS Frontend Limit | Python Backend Limit | Description |
| :--- | :--- | :--- | :--- |
| **Title Length** | 255 chars | 512 chars | Video and playlist titles. |
| **URL Length** | 2048 chars | 4096 chars | Maximum permissible URL length. |
| **String Length** | N/A | 100 KB | General payload strings (e.g., data exports). |
| **Playlist Items** | 5,000 items | 10,000 items | Maximum items per folder/shard. |
| **Folder Name** | 100 chars | 128 chars | Folder names. |
| **IPC Message** | N/A | 5 MB in, ≤900 KB out | Max size of JSON native messaging (Chrome terminates hosts over 1 MiB outbound). |

> **Defense in Depth:** JavaScript (`utils/security.module.js`) enforces tighter limits before transmitting requests. Python (`utils/security.py`) enforces its own limits upon receipt as an independent barrier.

---

## 2. Protocol Security & SSRF Protection

### Permitted Protocols Allowlist & Web Scraper Isolation

- **Global Allowlist:** `http://`, `https://`, `file://`, `udp://`, `rtmp://`, `rtsp://`, `mms://`
- **Web Isolation Boundary (`isValidWebUrl` / `is_safe_web_url`):** Injected content scripts and automated page scrapers (`PageScraper.js`, `item_processor.js`) strictly accept `http:` and `https:`. The `file:` scheme and streaming protocols cannot be injected via web DOM scraping and are restricted to explicit user UI operations.

### SSRF Protection (`utils/security.py:is_safe_url` & `utils/security.module.js:isSafeUrl`)

To prevent the Native Host and extension from being leveraged as an internal intranet proxy or SSRF gateway:
1. **Hostname & Metadata Inspection:** Hostnames matching `localhost`, `*.localhost`, `*.local`, `metadata.google.internal`, or `instance-data` are rejected immediately.
2. **Obfuscation Normalization:** Evaluates integer/dword addresses (e.g. `2130706433`), hex literals (`0x7f000001`), and octal dotted octets (`0177.0.0.1`) into normalized IPv4 addresses prior to inspection.
3. **Internal IP Range Blocking:**
   - **Loopback:** `127.0.0.0/8`, `::1`.
   - **Current Network / Linux Local:** `0.0.0.0/8`, `::`.
   - **Private RFC 1918:** `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`.
   - **Link-Local & Cloud Metadata:** `169.254.0.0/16`, `169.254.169.254`, `fe80::/10`.
   - **Carrier-Grade NAT (CGNAT):** `100.64.0.0/10`.
   - **IPv6 Private / Unique-Local:** `fc00::/7`, `fd00::/8`.
   - **IPv4-Mapped IPv6:** `::ffff:127.0.0.1`, `::ffff:7f00:1`.
4. **DNS Resolution & Stream Output Validation:** Candidate hostnames are resolved via `socket.getaddrinfo` and all returned IP records must satisfy IP safety checks. In addition, stream URLs resolved externally by `yt-dlp` must pass `is_safe_url` before player execution.

---

## 3. Subprocess Isolation & Command Injection Hardening

### Subprocess Rules

1. **Never use `shell=True` or `sh -c`:** All external process invocations (`mpv`, `yt-dlp`, `ffmpeg`, `node`, terminal emulators) **MUST** use `subprocess.Popen` or `subprocess.run` with argument lists (arrays), never raw shell command strings or shell string wrapping (`sh -c`).
2. **Shell-Free Terminal Emulation (`utils/mpv_command_builder.py`):**
   - Terminal emulators (`konsole`, `alacritty`, `kitty`, `foot`, `xfce4-terminal`, `xterm`, `gnome-terminal`) receive command arrays directly.
   - For terminals requiring a delayed exit hold, a direct Python runner (`sys.executable -c ...`) is invoked with argument arrays, eliminating shell string concatenation.
3. **Executable Binary Validation (`is_safe_executable_path`):**
   - User-supplied binary paths for `mpv_path`, `ytdlp_path`, `ffmpeg_path`, `node_path`, and `terminal_emulator` must point to existing, executable files matching vetted base names.
   - Any path containing shell injection characters (`;`, `&`, `|`, `` ` ``, `$`, `\n`) is rejected immediately.
4. **Settings Key Allowlist (`ALLOWED_SETTINGS_KEYS`):**
   - Configuration updates in `file_io.py:set_settings` are strictly filtered against the canonical allowlist to prevent prototype or arbitrary state pollution.
5. **Environment Variable Whitelisting (`utils/security.py:get_scrubbed_env`):**
   - Subprocesses run with sanitized environments via `utils/security.py:get_scrubbed_env`, stripping Python runtime contamination variables (`PYTHONPATH`, `PYTHONHOME`, etc.) and untrusted environment variables.
6. **Tool Flag Allowlists:**
   - **`yt-dlp` Flag Allowlist (`YTDLP_SAFE_FLAGS_ALLOWLIST` & `YTDLP_SETTINGS_ONLY_FLAGS`):** Only vetted item-level safe flags (e.g. `cookies`, `cookies-from-browser`, `user-agent`, `referer`, `add-header`, `format`, `extractor-args`) are permitted on untrusted item payloads (`sanitize_ytdlp_options(..., allow_settings_flags=False)`). Settings-only flags (`proxy`, `ffmpeg-location`, `js-runtimes`, `remote-components`, `compat-options`, `alias`, `update`, `print`, `no-check-certificate`, `geo-verification-proxy`) are only permitted from trusted settings (`allow_settings_flags=True`). Dangerous execution flags like `--exec`, `--output`, or `--config-location` are strictly rejected.
   - **`MPV` Safe Flags Allowlist (`SAFE_MPV_FLAGS_ALLOWLIST`):** Only safe player flags are permitted from UI inputs.

---

## 4. Path Sandboxing & String Sanitization

### Path Traversal Protection (`validate_safe_path`)

All file operations in `file_io.py` and backend handlers validate candidate paths using `security.validate_safe_path()`:
- Paths are resolved to their absolute canonical form (`os.path.realpath`).
- Canonical paths **must** reside strictly within authorized directories:
  - `DATA_DIR` (Application configuration and playlists)
  - `SCRIPT_DIR` (Project source directory)
  - `TEMP_DIR` (Temporary playlists and handshakes)
  - `XDG_RUNTIME_DIR` / `/dev/shm` / `~/.mpv_playlist_organizer_ipc` (Linux RAM-backed IPC and volatile cookies)
- Any path attempting to escape these sandboxes logs a security warning (`logging.warning("Security: Path outside sandbox: ...")`) and returns `None`.

### String & Filename Sanitization

- **Filename Sanitization (`sanitize_string(..., is_filename=True)`):** Strips path traversal delimiters and reserved characters: `/ \ : * ? " < > | $ ; & \`` and control characters.
- **M3U Injection Hardening (`sanitize_string`):** Metadata injected into M3U playlist lines (`#EXTINF`) strips `"`, `` ` ``, `$`, `\n`, `\r`, `\t`, and `,` to prevent shell injection or player option injection when MPV interprets the file.

---

## 5. Unified Logging & Diagnostics

The logging architecture correlates events across the Chrome Extension and Python Native Host while preventing path disclosure.

### Non-Blocking Logging Pipeline (`utils/logger.py`)

- Log records are placed onto an in-memory queue and processed by a background `QueueListener` thread to prevent I/O blocking on the main messaging loop.
- `SecurityFormatter` / `mask_path` automatically strips absolute user paths before writing to disk:
  - `/home/<username>` → `<HOME>`
  - `<project_root>/data` → `<DATA_DIR>`
  - `<project_root>` → `<APP_DIR>`

### Request Correlation

- User actions initiate a unique `request_id` in JavaScript.
- `request_id` propagates through native messaging into Python `logger.request_id_var.set(req_id)` (via `ContextVar`), attaching `[Req: <req_id>]` to all log lines generated during request processing.

### Cross-Environment Error Forwarding

- JavaScript `ERROR` and `FATAL` logs are forwarded to the Python host via the `log_event` and `log_browser_error` actions.
- Stored in `native_host.log` and `browser_errors.log`.

### Unified Diagnostics Report (`get_unified_diagnostics`)

Aggregates system health in a single JSON payload for debugging:
1. Browser environment metadata (Chrome version, OS, extension version).
2. Recent in-memory JavaScript breadcrumbs.
3. System dependency status (`mpv`, `ffmpeg`, `yt-dlp`, `node` paths and versions).
4. The last `100 KB` tail of `native_host.log`, `ipc_events.log`, and `browser_errors.log`.

### The Janitor (`utils/janitor.py`)

Runs on application startup and exit to clean up transient artifacts:
- Removes stale IPC domain sockets and lock files from dead processes.
- Cleans temporary M3U/M3U8 files older than 72 hours.
- Removes volatile cookie files in `/dev/shm`.


---

## 6. Audit Guardrails (added after the Nov 2026 code review; see `CODE_REVIEW.md`)

> [!NOTE]
> **Resolved Audit Findings (PY-H2, PY-H5):** The outbound message guard is enforced at ≤ 900 KB in `native_host.py` (`MAX_OUTBOUND_MESSAGE_SIZE`). Dangerous yt-dlp flags (`proxy`, `ffmpeg-location`, `js-runtimes`, `remote-components`, `alias`, `update`, `print`, `no-check-certificate`) are strictly restricted to trusted settings (`YTDLP_SETTINGS_ONLY_FLAGS`) and stripped from untrusted item payloads by default (`sanitize_ytdlp_options(..., allow_settings_flags=False)`).

Rules for any change touching security-sensitive code:

1. **Item-supplied vs. settings-supplied options.** Options that arrive in an item payload (`ytdl_raw_options`, anything from the browser) may only use a minimal safe subset. Flags that change what is executed, where traffic goes, or what is downloaded and run (`proxy`, `ffmpeg-location`, `js-runtimes`, `remote-components`, `exec`, `alias`, `update`) are **settings-only**, and path-like values must pass `is_safe_executable_path`.
2. **Allowlist changes need a test.** Every key added to a flag, settings or protocol allowlist requires a test proving that an item-supplied dangerous value is rejected.
3. **Fail closed.** Missing token, unresolved hostname, empty Host header, or unverifiable PID means *deny*, never "skip the check". Never write `if token:` around an auth check.
4. **Local HTTP servers** must: bind `127.0.0.1` (use that literal in URLs, not `localhost`), require a token, validate the `Host` header, be threaded with socket timeouts, and prefer a random port (`0`).
5. **Temp and shared paths.** Never use fixed world-writable paths (`/tmp/<name>_<pid>.flag`, `/dev/shm/<fixed-dir>`). Use per-process `mkdtemp` or the private 0700 dir, open with `O_NOFOLLOW`, verify ownership and mode, and write secrets with mode 0600 *at creation* (`os.open(..., 0o600)`), not chmod afterwards.
6. **Never signal a PID you have not verified.** Before `kill`, confirm identity (matching IPC `pid`, `/proc/<pid>/cmdline`, or stored process start time). PIDs get reused.
7. **Path-character blacklists** must not reject legitimate paths (`(`, `)` appear in `Program Files (x86)`). Because we never use a shell, validate by existence, executability and base name instead.
8. **Never leak raw `str(e)` with paths** into UI-bound responses; run it through `mask_path`.
9. **Cap untrusted text** forwarded to logs (`log_browser_error` message/stack ≤ a few KB).
10. **Validate batch fields too.** URL validation must cover `url`, `urlItem`, `urlItems`, and `urls`. A new payload field is a new bypass until it is validated. In JS, `isValidUrl` must return `false` (not a prefix match) when `new URL` throws.
