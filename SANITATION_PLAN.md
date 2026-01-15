# MPV Playlist Organizer: Sanitization & Security Plan

This document outlines the multi-layered sanitization strategy implemented to protect the system against command injection, filesystem errors, and data corruption while maintaining the functional integrity of complex streaming URLs.

## 🎯 Target Entities
1.  **URLs**: Must remain functional (preserve `&`, `?`, `;`, `$`) while stripping shell-dangerous characters (`"`, `` ` ``) and line breaks. Must adhere to strict protocol whitelisting.
2.  **Titles**: Must be safe for M3U formatting and MPV OSD display.
3.  **Folder Names**: Must be strictly safe for use as filenames across Windows, Linux, and macOS (64 character limit).
4.  **Resolution/Quality Settings**: Must be strictly whitelisted to prevent command-line flag injection.
5.  **yt-dlp Raw Options**: Must be validated against a **Strict Whitelist** of functional flags to prevent Remote Code Execution (RCE).
6.  **HTTP Headers**: Values must be stripped of commas and CRLF characters to prevent breaking MPV arguments or header injection.
7.  **Import File Paths**: Must be validated to prevent path traversal outside the authorized `exported` directory.

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

### Layer 3: Persistence Integrity (`file_io.py` & `native_host_handlers.py`)
**Purpose:** Second line of defense on the Python side. Protects the CLI and Native Host.
- **yt-dlp Whitelisting:** `sanitize_ytdlp_options` parses custom flags and compares them against `YTDLP_SAFE_FLAGS_ALLOWLIST`. Any flag not explicitly permitted is removed to prevent RCE or unauthorized file writes.
- **Secure File Permissions:** Temporary cookie files generated in RAM are explicitly set to `0o600` (Read/Write for owner only), protecting sensitive session data on shared systems.
- **Buffer Normalization:** Automatically corrects numeric inputs (e.g., `1000`) to standard units (e.g., `1000M`) to prevent demuxer choking.
- **Path Traversal Protection:** Validates that all import requests reside strictly within the `EXPORT_DIR`.

### Layer 4: Execution & Communication (`services.py`, `mpv_session.py`, `url_analyzer.py`)
**Purpose:** The final check before data touches the OS shell or the media player.
- **Protocol Whitelisting:** Strictly permits only `http`, `https`, and `file` schemes. All other protocols (e.g., `javascript:`, `data:`) are rejected to prevent protocol smuggling.
- **Windows Length Guard:** Enforces a **7500-character limit** on the constructed MPV command line. If a massive playlist exceeds safe Windows limits, the launch is aborted with a clear error.
- **Header Hardening:** Improved sanitization strips CRLF and commas from `User-Agent` and `Referer` to prevent header injection.
- **Shell Quoting:** Uses `shlex.quote` for all arguments when generating terminal wrappers.
- **Execution Auditing:** Every MPV launch command is logged in a shell-quoted, copy-pasteable format to `last_mpv_command.txt`.

---

## 📋 Sanitization Rules Summary

| Entity | Strategy | Preserved Characters | Stripped / Blocked |
| :--- | :--- | :--- | :--- |
| **Protocols** | Strict Whitelist | `http`, `https`, `file` | `javascript`, `data`, `chrome`, etc. |
| **URLs** | Minimal Destruction | `/ & ? ; $ , | ! @ ( ) [ ]` | `" ` \n \r \t` |
| **Folder Names** | Strict (Filesafe) | Alpha-numeric, Space, `_ - .` | `/ \ : * ? " < > | $ ; & ` \n \r \t` |
| **yt-dlp Opts** | **Strict Whitelist** | Safe functional flags | Any flag not in `ALLOWLIST` |
| **Headers** | Injection Guard | Alpha-numeric, `- _ : .` | `\n \r , " ` ` |
| **Data Objects** | **Anti-Pollution** | Normal Object Keys | `__proto__`, `constructor`, `prototype` |
| **Cmd Length** | **Buffer Guard** | Under 7500 chars | Commands > 7500 chars (Windows) |
| **RAM Files** | **Unix Secure** | `0o600` Permissions | Global read/write access |

---

## 🚀 Security Impact
By implementing this defense-in-depth model, we have transitioned from simple "cleaning" to a robust **Security Shield**:
1.  **RCE Protection:** Whitelisting `yt-dlp` flags and protocols makes remote code execution via malformed URLs mathematically improbable.
2.  **State Protection:** Prototype Pollution protection ensures that malicious websites cannot manipulate the extension's internal settings via storage.
3.  **Privacy:** Secure file permissions and volatile (RAM) storage ensure that browser cookies never persist in a readable state on the hard drive.
4.  **OS Stability:** The Command-Length Guard and Buffer Normalization prevent the most common "silent crashes" on the Windows platform.
5.  **Functional Integrity:** By allowing `&`, `?`, and `;`, we ensure that 100% of modern streaming URLs remain functional.
