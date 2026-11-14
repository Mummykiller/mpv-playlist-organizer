# MPV Playlist Organizer: Security & Sanitation Standards

This document serves as the **single source of truth** for security protocols, input validation, and architectural safety within the MPV Playlist Organizer project. All contributors and agents MUST adhere to these standards.

---

## 1. Input Validation & Length Limits
Strict enforcement of input sizes prevents Denial of Service (DoS) via memory exhaustion and ensures UI stability.

| Parameter | JS Limit | Python Limit | Description |
| :--- | :--- | :--- | :--- |
| **Title Length** | 255 chars | 512 chars | Video/Folder titles. |
| **URL Length** | 2048 chars | 4096 chars | Maximum length for any URL. |
| **String Length** | N/A | 100 KB | General payload strings (e.g., data export). |
| **Playlist Items** | 5,000 | 10,000 | Maximum items per folder/shard. |
| **IPC Message** | N/A | 5 MB in / 900 KB out (`MAX_OUTBOUND_MESSAGE_SIZE`) | Maximum size of a single JSON native messaging payload (5 MB inbound to Python; 900 KB outbound from host to browser). |

**Action:** JS must enforce its stricter limits before sending data to the Native Host. Python must validate incoming payloads against its own limits as a second line of defense.

---

## 2. Protocol & URL Security
### 2.1 Protocol Allowlist & Web Scraper Isolation
- **Global Permitted Schemes:** `http://`, `https://`, `file://`, `udp://`, `rtmp://`, `rtsp://`, `mms://`
- **Web Scraper Protocol Isolation (`isValidWebUrl` / `is_safe_web_url`):** Content scripts and automated page scrapers (`PageScraper.js`, `item_processor.js`) strictly permit `http:` and `https:`. Local system schemes (`file:`) and streaming protocols (`rtmp:`, `udp:`) are blocked from automated web ingestion and are reserved exclusively for explicit user actions.

### 2.2 SSRF Protection & Obfuscation Defense (`is_safe_url`)
To prevent the Native Host from being used as an internal network proxy or SSRF gateway:
- **Private IP Ranges Blocked:** RFC 1918 (10.x, 192.168.x, 172.16-31.x), Loopback (127.x), Link-Local (169.254.x), 0.0.0.0/8, and Carrier-Grade NAT (100.64.0.0/10).
- **IPv6 Protection:** Blocked loopback (`::1`, `::`), link-local (`fe80::/10`), unique-local (`fc00::/7`, `fd00::/8`), and IPv4-mapped IPv6 evasions (`::ffff:127.0.0.1`, `::ffff:7f00:1`).
- **Cloud Metadata Endpoints Blocked:** `169.254.169.254`, `metadata.google.internal`, `metadata.internal`, `instance-data`.
- **IP Obfuscation Defenses:** Detects and decodes integer/dword literals (e.g. `http://2130706433/`), octal octets (`http://0177.0.0.1/`), and hex addresses (`http://0x7f000001/`) to prevent filter evasion.
- **DNS Resolution Inspection:** Resolves candidate hostnames via DNS and validates all returned target IP addresses, with offline/sandbox resilience when resolution fails.
- **Stream Output Verification:** Secondary validation on stream URLs returned by `yt-dlp` before player handoff.

### 2.3 URL Normalization
YouTube URLs must be normalized to strip non-essential tracking parameters (`t`, `index`, `si`, etc.) to ensure deduplication and robust resume logic.

---

## 3. String Sanitation
### 3.1 Context-Aware Stripping
- **Filenames:** Strips `/ \ : * ? " < > | $ ; & ` ` and control characters.
- **OSD/Metadata:** Strips `" ` ` and newlines (`\n`, `\r`, `\t`).

### 3.2 M3U Injection Hardening
**Standard:** All metadata written to M3U files MUST have shell metacharacters (`$`, `` ` ``) escaped or stripped to prevent command injection when MPV processes the file.
- *Current Implementation:* Strips `"`, `` ` ``, `$`, `\n`, `\r`, `\t`, and `,` via `sanitize_string()`.

---

## 4. Filesystem & IPC Security
### 4.1 Path Validation (`validate_safe_path`)
All file operations must be restricted to the following sandboxed directories:
- `DATA_DIR` (App configuration)
- `SCRIPT_DIR` (Source files)
- `TEMP_DIR` (Temporary M3U8/Playlists)
- `XDG_RUNTIME_DIR` / `/dev/shm` (Linux RAM-backed IPC/Cookies)

### 4.2 Atomic Operations
All JSON writes (folders, config, shards) MUST use the **Atomic Write Pattern**:
1. Write to `<file>.tmp`.
2. Sync to disk (`fsync`).
3. Atomically replace the target file (`os.replace`).
4. Maintain a `<file>.bak` as a recovery fallback.

### 4.3 IPC Socket Security
- IPC sockets MUST be created in a secure directory (e.g., `/dev/shm` or `~/.mpv_playlist_organizer_ipc`).
- Permissions MUST be set to `0600` (Owner Read/Write only).

---

## 5. Playback & Process Isolation
### 5.1 yt-dlp Flag Whitelisting
`yt-dlp` options are enforced using a two-tier allowlist in `utils/security.py`:
- **`YTDLP_SAFE_FLAGS_ALLOWLIST` (Item-Level Safe Flags):** Flags permitted in untrusted item payloads (`ytdl_raw_options`, with `allow_settings_flags=False`), such as `cookies`, `cookies-from-browser`, `user-agent`, `referer`, `add-header`, `format`, `concurrent-fragments`, `extractor-args`, etc.
- **`YTDLP_SETTINGS_ONLY_FLAGS` (Settings-Only Flags):** Flags restricted exclusively to trusted backend settings (`allow_settings_flags=True`), including `proxy`, `ffmpeg-location`, `js-runtimes`, `remote-components`, `compat-options`, `alias`, `update`, `print`, `no-check-certificate`, and `geo-verification-proxy`. These are stripped from item-level payloads.
- Dangerous execution or file-write flags like `--exec`, `--output`, or `--config-location` are strictly blocked in all contexts.

### 5.2 Volatile Cookie Management
- Cookies are extracted ONLY to RAM-backed storage (`/dev/shm` on Linux).
- Shadow copying is used to bypass browser database locks without compromising the original file.
- Cookies are cleaned up on session exit or by "The Janitor" on startup.

### 5.3 Settings & Binary Path Validation (`is_safe_executable_path`)
- **Key Allowlist (`ALLOWED_SETTINGS_KEYS`):** Incoming configuration and UI preference updates are strictly filtered against a canonical key allowlist to prevent arbitrary state pollution.
- **Binary Allowlist:** Executable binary paths (`mpv_path`, `ytdlp_path`, `ffmpeg_path`, `node_path`, `terminal_emulator`) must point to existing executables matching vetted base binary names and must not contain shell metacharacters (`;`, `&`, `|`, `` ` ``, `$`, `\n`).

### 5.4 Shell-Free Terminal Execution
- Subprocess execution never invokes raw shells (`sh -c` or `bash -c`).
- Terminal emulators (`konsole`, `alacritty`, `kitty`, `xfce4-terminal`, `xterm`, `gnome-terminal`) are invoked with discrete argv argument lists.
- Delayed window closing logic utilizes direct process invocation (`sys.executable -c ...`) with direct argument lists rather than shell string concatenation.

---

## 6. Unified Logging & Diagnostics
### 6.1 Path Masking
All loggers (JS and Python) must use `mask_path` to replace sensitive system paths with placeholders:
- `/home/user` (`home_dir`) -> `<HOME>`
- `script_dir` (Application root directory) -> `<APP_DIR>`
- `data_dir` (App configuration & data directory) -> `<DATA_DIR>`

### 6.2 The Janitor
A dedicated maintenance task that runs on startup and periodically to:
- Remove stale IPC sockets and flags.
- Clean temporary M3U/M3U8 files older than 72 hours.
- Clear volatile cookie files for dead processes.

---

## 7. Security Maintenance
- **Secrets:** Never log, print, or commit API keys or session cookies.
- **Dependencies:** Regularly update `yt-dlp` to mitigate site-specific extraction vulnerabilities.
- **Testing:** New features involving shell execution or file I/O MUST include security test cases in `testing_tools/scripts/`.
