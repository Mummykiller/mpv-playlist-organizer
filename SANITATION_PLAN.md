# MPV Playlist Organizer: Sanitization & Security Plan

This document outlines the multi-layered sanitization strategy implemented to protect the system against command injection, filesystem errors, and data corruption while maintaining the functional integrity of complex streaming URLs.

## 🎯 Target Entities
1.  **URLs**: Must remain functional (preserve `&`, `?`, `;`, `$`) while stripping shell-dangerous characters (`"`, `` ` ``) and line breaks. Must adhere to strict protocol whitelisting.
2.  **Network Requests**: Must be validated against SSRF attacks (blocking Private IPs, Loopback, and Link-Local ranges).
3.  **Titles**: Must be safe for M3U formatting and MPV OSD display.
4.  **Folder Names**: Must be strictly safe for use as filenames across Windows, Linux, and macOS (64 character limit).
5.  **Resolution/Quality Settings**: Must be strictly whitelisted to prevent command-line flag injection.
6.  **yt-dlp Raw Options**: Must be validated against a **Strict Whitelist** of functional flags to prevent Remote Code Execution (RCE).
7.  **HTTP Headers**: Values must be stripped of commas and CRLF characters to prevent breaking MPV arguments or header injection.
8.  **File Paths & Flags**: Must be resolved (symlinks expanded) and validated to reside strictly within authorized application directories (`DATA`, `SCRIPT`, `TEMP`).

---

## 🛡️ The Four Layers of Defense

### Layer 1: Frontend Detection & Scraping (`content.js`, `PageScraper.js`)
**Purpose:** Neutralize data at the point of origin (web page detection) and ensure clean metadata.
- **Implementation:** `sanitizeString(str, isFilename = false)` surgical cleaning.
- **Logic:** 
    - Strips `"`, `` ` ``, and line breaks (`\n`, `\r`, `\t`) from detected URLs and Titles.
    - **Boundary Enforcement:** Enforces a 64-character limit on folder names with real-time UI feedback.
- **Feedback:** Logs raw vs. sanitized URLs to the browser console for developer transparency.

### Layer 2: Management Logic (`playlistManager.js`, `StorageManager.js`, `import_export.js`)
**Purpose:** Ensure all data entering the browser's permanent storage is clean and structurally sound.
- **Prototype Pollution Protection:** The `StorageManager.js` validation layer recursively scans all incoming data objects for malicious keys (`__proto__`, `constructor`, `prototype`) and aborts the write if "poisoned" data is detected.
- **Structural Validation:** `_validateData` verifies UUID formats and required fields before any storage commit.
- **Input Normalization:** `m3u_parser.py` automatically detects and removes **UTF-8 Byte Order Marks (BOM)** from incoming M3U content.

### Layer 3: Persistence & Path Integrity (`file_io.py`, `ipc_utils.py` & `native_host_handlers.py`)
**Purpose:** Second line of defense on the Python side. Protects the CLI, Native Host, and Filesystem.
- **yt-dlp Whitelisting:** `sanitize_ytdlp_options` parses custom flags and compares them against `YTDLP_SAFE_FLAGS_ALLOWLIST`. Any flag not explicitly permitted is removed to prevent RCE or unauthorized file writes.
- **Secure File Permissions:** 
    - Temporary cookie files generated in RAM are explicitly set to `0o600` (Read/Write for owner only).
    - **IPC Sockets** on Linux/Unix are created in directories restricted to `0o700`.
- **Buffer Normalization:** Automatically corrects numeric inputs (e.g., `1000`) to standard units (e.g., `1000M`) to prevent demuxer choking.
- **Symlink & Path Validation:** `validate_safe_path` resolves all file paths (using `os.path.realpath`) and enforces that they reside strictly within `DATA_DIR`, `SCRIPT_DIR`, or `TEMP_DIR`. This prevents symlink attacks (e.g., linking `file://` to `/etc/passwd`).

### Layer 4: Execution & Communication (`services.py`, `mpv_session.py`, `url_analyzer.py`)
**Purpose:** The final check before data touches the OS shell or the media player.
- **Environment Scrubbing (Zero-Trust):** Before launching MPV, the process environment is scrubbed. Only a strict whitelist of variables (e.g., `PATH`, `HOME`, `DISPLAY`) is passed to the child process, neutralizing `LD_PRELOAD` injection attacks.
- **SSRF & Private IP Guard:** The `url_analyzer.py` resolves hostnames and explicitly blocks connections to private network ranges (`10.0.0.0/8`, `192.168.0.0/16`, `127.0.0.0/8`) to prevent Server-Side Request Forgery via the M3U proxy.
- **Protocol Whitelisting:** Strictly permits only `http`, `https`, `file`, `udp`, `rtmp`, `rtsp`, and `mms` schemes.
- **Windows Length Guard:** Enforces a **7500-character limit** on the constructed MPV command line. If a massive playlist exceeds safe Windows limits, the launch is aborted with a clear error.
- **Header Hardening:** Improved sanitization strips CRLF and commas from `User-Agent` and `Referer` to prevent header injection.
- **Shell Quoting:** Uses `shlex.quote` for all arguments when generating terminal wrappers.
- **Execution Auditing:** Every MPV launch command is logged in a shell-quoted, copy-pasteable format to `last_mpv_command.txt`.

---

## 📋 Sanitization Rules Summary

| Entity | Strategy | Preserved Characters | Stripped / Blocked |
| :--- | :--- | :--- | :--- |
| **Protocols** | Strict Whitelist | `http`, `https`, `file` + streaming | `javascript`, `data`, `chrome`, etc. |
| **Network (SSRF)**| **IP Blocking** | Public IPs | Private IPs (`192.168.x`), Loopback |
| **URLs** | Minimal Destruction | `/ & ? ; $ , | ! @ ( ) [ ]` | `" ` \n \r \t` |
| **Folder Names** | Strict (Filesafe) | Alpha-numeric, Space, `_ - .` | `/ \ : * ? " < > | $ ; & ` \n \r \t` |
| **yt-dlp Opts** | **Strict Whitelist** | Safe functional flags | Any flag not in `ALLOWLIST` |
| **File Paths** | **Symlink Resolution** | Resolved Paths in `DATA/TEMP` | Paths outside authorized dirs |
| **Environment** | **Scrubbing** | Whitelisted (`PATH`, `HOME`...) | `LD_PRELOAD`, malicious vars |
| **Headers** | Injection Guard | Alpha-numeric, `- _ : .` | `\n \r , " ` ` |
| **Data Objects** | **Anti-Pollution** | Normal Object Keys | `__proto__`, `constructor`, `prototype` |
| **Cmd Length** | **Buffer Guard** | Under 7500 chars | Commands > 7500 chars (Windows) |
| **RAM/IPC** | **Unix Secure** | `0o600` / `0o700` Perms | Global read/write access |

---

## 🚀 Security Impact
By implementing this defense-in-depth model, we have transitioned from simple "cleaning" to a robust **Zero-Trust Security Shield**:
1.  **RCE Protection:** Whitelisting `yt-dlp` flags and protocols makes remote code execution via malformed URLs mathematically improbable.
2.  **Environment Hardening:** Process environment scrubbing eliminates entire classes of injection attacks (like `LD_PRELOAD`) used to hijack native processes.
3.  **SSRF Defense:** Network layer validation prevents the application from being used as a proxy to attack local network infrastructure.
4.  **Filesystem Integrity:** Strict symlink resolution and path validation ensure that data exfiltration via malicious paths is impossible.
5.  **State Protection:** Prototype Pollution protection ensures that malicious websites cannot manipulate the extension's internal settings via storage.
6.  **Privacy:** Secure file permissions and volatile (RAM) storage ensure that browser cookies never persist in a readable state on the hard drive.
7.  **OS Stability:** The Command-Length Guard and Buffer Normalization prevent the most common "silent crashes" on the Windows platform.
8.  **Functional Integrity:** By allowing `&`, `?`, and `;`, we ensure that 100% of modern streaming URLs remain functional.
