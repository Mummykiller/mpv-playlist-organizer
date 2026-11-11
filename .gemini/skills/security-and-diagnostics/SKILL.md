---
name: security-and-diagnostics
description: >-
  Governs input validation, SSRF protection, subprocess isolation, path sandboxing,
  sanitization, unified logging, and diagnostics. Load this skill whenever modifying
  `utils/security.py`, `utils/security.module.js`, `utils/logger.py`, `utils/SystemLogger.module.js`,
  `SECURITY.md`, executing subprocesses, handling file paths, or modifying diagnostics reports.
---

# Security, Validation & Unified Diagnostics Architecture

This skill defines the security boundaries, protocol validation, process execution isolation, path sandboxing, and unified logging pipelines enforced across the MPV Playlist Organizer.

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
| **IPC Message** | N/A | 5 MB | Max size of a single JSON native messaging message. |

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

1. **Never use `shell=True`:** All external process invocations (`mpv`, `yt-dlp`, `ffmpeg`, `node`) **MUST** use `subprocess.Popen` or `subprocess.run` with argument lists (arrays), never raw shell command strings.
2. **Environment Variable Whitelisting (`get_mpv_popen_kwargs`):**
   - Subprocesses run with sanitized environments, stripping untrusted environment variables.
3. **Tool Flag Allowlists:**
   - **`yt-dlp` Flag Allowlist (`YTDLP_SAFE_FLAGS_ALLOWLIST`):** Only vetted flags (e.g. `--cookies`, `--user-agent`, `--format`, `--sub-lang`) are permitted. Dangerous execution flags like `--exec`, `--output`, or `--config-location` are strictly rejected.
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
  - `XDG_RUNTIME_DIR` / `/dev/shm` (Linux RAM-backed IPC and volatile cookies)
- Any path attempting to escape these sandboxes throws a `ValueError("Security: Path traversal attempted")`.

### String & Filename Sanitization

- **Filename Sanitization (`sanitize_filename`):** Strips path traversal delimiters and reserved characters: `/ \ : * ? " < > | $ ; & \`` and control characters.
- **M3U Injection Hardening (`sanitize_string`):** Metadata injected into M3U playlist lines (`#EXTINF`) strips `"`, `` ` ``, `$`, `\n`, `\r`, `\t`, and `,` to prevent shell injection or player option injection when MPV interprets the file.

---

## 5. Unified Logging & Diagnostics

The logging architecture correlates events across the Chrome Extension and Python Native Host while preventing path disclosure.

### Non-Blocking Logging Pipeline (`utils/logger.py`)

- Log records are placed onto an in-memory queue and processed by a background `QueueListener` thread to prevent I/O blocking on the main messaging loop.
- `SecurityFormatter` / `mask_path` automatically strips absolute user paths before writing to disk:
  - `/home/<username>` → `<HOME>`
  - `<project_root>/data` → `<DATA_DIR>`
  - `<project_root>` → `<PROJECT_ROOT>`

### Request Correlation

- User actions initiate a unique `request_id` in JavaScript.
- `request_id` propagates through native messaging into Python `logger.runWithContext()`, attaching the ID to all log lines generated during request processing.

### Cross-Environment Error Forwarding

- JavaScript `ERROR` and `FATAL` logs are forwarded to the Python host via the `log_event` and `log_browser_error` actions.
- Stored in `native_host.log` and `browser_errors.log`.

### Unified Diagnostics Report (`get_unified_diagnostics`)

Aggregates system health in a single JSON payload for debugging:
1. Browser environment metadata (Chrome version, OS, extension version).
2. Recent in-memory JavaScript breadcrumbs.
3. System dependency status (`mpv`, `ffmpeg`, `yt-dlp`, `node` paths and versions).
4. The tail (last 50 lines) of `native_host.log` and `ipc_events.log`.

### The Janitor (`utils/janitor.py`)

Runs on application startup and exit to clean up transient artifacts:
- Removes stale IPC domain sockets and lock files from dead processes.
- Cleans temporary M3U/M3U8 files older than 72 hours.
- Removes volatile cookie files in `/dev/shm`.
