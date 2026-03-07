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
| **IPC Message** | N/A | 5 MB | Total size of a single JSON IPC message. |

**Action:** JS must enforce its stricter limits before sending data to the Native Host. Python must validate incoming payloads against its own limits as a second line of defense.

---

## 2. Protocol & URL Security
### 2.1 Protocol Allowlist
Only the following URI schemes are permitted:
`http://`, `https://`, `file://`, `udp://`, `rtmp://`, `rtsp://`, `mms://`

### 2.2 SSRF Protection (`is_safe_url`)
To prevent the Native Host from being used as an internal network proxy:
- All hostnames are resolved before access.
- Private IP ranges (10.x, 192.168.x, 172.16.x), Loopback (127.x), and Link-local addresses are **BLOCKED**.

### 2.3 URL Normalization
YouTube URLs must be normalized to strip non-essential tracking parameters (`t`, `index`, `si`, etc.) to ensure deduplication and robust resume logic.

---

## 3. String Sanitation
### 3.1 Context-Aware Stripping
- **Filenames:** Strips `/ \ : * ? " < > | $ ; & ` ` and control characters.
- **OSD/Metadata:** Strips `" ` ` and newlines (`\n`, `\r`, `\t`).

### 3.2 M3U Injection Hardening
**Standard:** All metadata written to M3U files MUST have shell metacharacters (`$`, `` ` `) escaped or stripped to prevent command injection when MPV processes the file.
- *Current Implementation:* Strips `\n`, `\r`, and `,`.
- *Required Upgrade:* Escape/Strip `$`, `` ` ` from titles.

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
Only flags in the `YTDLP_SAFE_FLAGS_ALLOWLIST` are permitted. Dangerous flags like `--exec`, `--output`, or `--config-location` are strictly blocked.

### 5.2 MPV Process Isolation (Mandatory Standard)
To prevent "Shadow Config" attacks, MPV should be launched with:
- `--no-config`: Ignore local `mpv.conf`.
- `--load-scripts=no`: Disable local Lua scripts (unless explicitly managed by the extension).

### 5.3 Volatile Cookie Management
- Cookies are extracted ONLY to RAM-backed storage (`/dev/shm` on Linux).
- Shadow copying is used to bypass browser database locks without compromising the original file.
- Cookies are cleaned up on session exit or by "The Janitor" on startup.

---

## 6. Unified Logging & Diagnostics
### 6.1 Path Masking
All loggers (JS and Python) must use `mask_path` to replace sensitive system paths with placeholders:
- `/home/user` -> `<HOME>`
- `App/Data/Dir` -> `<DATA_DIR>`

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
