# MPV Playlist Organizer: Sanitization & Security Plan

This document outlines the multi-layered sanitization strategy implemented to protect the system against command injection, filesystem errors, and data corruption while maintaining the functional integrity of complex streaming URLs.

## 🎯 Target Entities
1.  **URLs**: Must remain functional (preserve `&`, `?`, `;`, `$`) while stripping shell-dangerous characters (`"`, `` ` ``) and line breaks.
2.  **Titles**: Must be safe for M3U formatting and MPV OSD display.
3.  **Folder Names**: Must be strictly safe for use as filenames across Windows, Linux, and macOS.
4.  **Resolution/Quality Settings**: Must be strictly whitelisted to prevent command-line flag injection.
5.  **yt-dlp Raw Options**: Must be filtered against a blacklist of dangerous flags (e.g., `--exec`).
6.  **HTTP Headers**: Values must be stripped of commas and dangerous characters to prevent breaking MPV's `http-header-fields` argument.
7.  **Import File Paths**: Must be validated to prevent path traversal outside the authorized `exported` directory.

---

## 🛡️ The Four Layers of Defense

### Layer 1: Frontend Detection & Scraping (`content.js`, `PageScraper.js`)
**Purpose:** Neutralize data at the point of origin (web page detection) and ensure clean metadata.
- **Implementation:** `sanitizeString(str, isFilename = false)` surgical cleaning.
- **Logic:** 
    - Strips `"`, `` ` ``, and line breaks (`\n`, `\r`, `\t`) from detected URLs and Titles.
    - **AI-Driven Scraping Cleanup:** `PageScraper.js` uses strict selectors and regex to strip notification counts (e.g., `(1) `), site suffixes (e.g., ` - YouTube`), and junk decimals from titles.
- **Feedback:** Logs raw vs. sanitized URLs to the browser console for developer transparency.

### Layer 2: Management Logic (`playlistManager.js`, `folder_management.js`, `import_export.js`, `m3u_parser.py`)
**Purpose:** Ensure all data entering the browser's permanent storage or parsed from external files is clean.
- **Playlist Management:** Sanitizes both `URL` and `Title` using `sanitizeString` immediately before calling `storage.set()`.
- **Input Normalization:** `m3u_parser.py` automatically detects and removes **UTF-8 Byte Order Marks (BOM)** from incoming M3U content to prevent encoding errors.
- **Regex-Based Parsing:** Uses strict regular expressions to extract `#EXTINF` metadata, ensuring that malformed or malicious tags cannot break the parser.
- **Folder Management:** Applies **Strict Filesystem Sanitization** to folder names via `sanitizeString(str, true)`.
    - **Strict Blacklist:** `/ \ : * ? " < > | $ ; & ` ` and line breaks.
    - **Result:** Folder names are guaranteed safe for the `export/import` system.
- **Import Validation:** `import_export.js` re-sanitizes all URLs, titles, and derived folder names during file imports.

### Layer 3: Persistence Integrity (`file_io.py` & `native_host_handlers.py`)
**Purpose:** Second line of defense on the Python side. Protects the CLI and Native Host.
- **Implementation:** `sanitize_string(s, is_filename=False)`, `sanitize_ytdlp_options(options_str)`, and `set_settings(settings_dict)`.
- **Logic:** 
    - Automatically runs string sanitization during every read operation of `folders.json` via legacy migration logic.
    - `set_settings` performs **whitelist validation** on the `ytdl_quality` setting.
    - `sanitize_ytdlp_options` parses custom flags and removes blocked keys (e.g., `exec`, `output`, `paths`, `downloader`, `plugin-dirs`) to prevent RCE or unauthorized file writes.
    - **Path Traversal Protection:** `handle_import_from_file` in `native_host_handlers.py` validates that the requested file resides strictly within the `EXPORT_DIR`.
- **Janitor Smart Cleanup:** The `Janitor` service ensures that temporary files are only removed if they are older than 72 hours AND their associated process (PID) is no longer running, preventing accidental deletion of active session data.

### Layer 4: Execution & Communication (`services.py`, `mpv_session.py`, `url_analyzer.py`)
**Purpose:** The final check before data touches the OS shell or the media player.
- **Process Launch:** 
    - `MpvCommandBuilder` sanitizes URLs and performs a **final whitelist check** on resolution settings.
    - **Header Sanitization:** Custom HTTP headers are stripped of commas and shell-dangerous characters.
    - **Shell Quoting:** Uses `shlex.quote` for all arguments when generating terminal wrappers or logging command-lines to ensure safety against complex URLs.
- **Execution Auditing:** Every MPV launch command is logged in a shell-quoted, copy-pasteable format to `last_mpv_command.txt` in the app data directory, allowing users to audit exactly what is being executed.
- **Temporary File Sanitization:** All generated M3U and cookie files use strict naming conventions (`prefix_PID_uuid.ext`) and are stored in restricted subdirectories to prevent collision or unauthorized access.
- **External Analysis:** `url_analyzer.py` sanitizes URLs and applies the quality whitelist before passing them to `yt-dlp` for cookie extraction or metadata resolution.
- **IPC Communication:** Sanitizes data before sending it through the MPV IPC pipe:
    - `loadfile`: Direct playback.
    - `script-message`: Registering metadata with Lua.
    - `show-text`: Displaying Titles on the MPV OSD.
- **M3U Generation:** Ensures every line in temporary `.m3u` files is sanitized to prevent formatting breakage.

---

## 📋 Sanitization Rules Summary

| Entity | Strategy | Preserved Characters | Stripped / Blocked |
| :--- | :--- | :--- | :--- |
| **URLs** | Minimal Destruction | `/ & ? ; $ , | ! @ ( ) [ ]` | `" ` \n \r \t` |
| **Titles** | Minimal Destruction | `/ & ? ; $ , | ! @ ( ) [ ]` | `" ` \n \r \t` |
| **Folder Names** | Strict (Filesafe) | Alpha-numeric, Space, `_ - .` | `/ \ : * ? " < > | $ ; & ` \n \r \t` |
| **Quality** | Strict Whitelist | `best`, `2160`, `1440`, `1080`, `720`, `480` | Any other string |
| **yt-dlp Opts** | Blacklist | Safe functional flags | `exec`, `output`, `paths`, `batch-file`, etc. |
| **Headers** | Commaless | Alpha-numeric, `- _ : .` | `, " ` \n \r \t` |
| **File Paths** | Sub-directory Lock | `exported/` relative paths | `..`, `/`, `~`, or absolute paths |
| **M3U Metadata** | Regex Parsing | Valid EXT-X tags | Malformed or non-whitelisted tags |
| **UTF-8 BOM** | Normalization | None (Removes Prefix) | `\ufeff` |

---

## 🚀 Security Impact
By implementing this defense-in-depth model, we have significantly reduced the attack surface:
1.  **Shell Injection:** Impossible via unquoted arguments as all quotes and backticks are stripped, and `shlex.quote` is used for sub-shell execution.
2.  **M3U Injection:** Newlines are stripped, preventing malicious entries from being injected into playlist files.
3.  **Path Traversal:** Strict folder name rules and import path validation prevent users from reading or overwriting system files.
4.  **Arbitrary Command Execution:** Whitelisting quality settings and blacklisting dangerous `yt-dlp` flags prevents attackers from leveraging the media player's downloader for RCE.
5.  **Auditability:** Transparency is maintained via `last_mpv_command.txt`, ensuring no "hidden" flags are passed to the system.
6.  **Functional Integrity:** By allowing `&`, `?`, and `;`, we ensure that 100% of modern streaming URLs (CDN links, auth tokens) remain functional.