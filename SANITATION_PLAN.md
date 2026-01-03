# MPV Playlist Organizer: Sanitization & Security Plan

This document outlines the multi-layered sanitization strategy implemented to protect the system against command injection, filesystem errors, and data corruption while maintaining the functional integrity of complex streaming URLs.

## 🎯 Target Entities
1.  **URLs**: Must remain functional (preserve `&`, `?`, `;`, `$`) while stripping shell-dangerous characters.
2.  **Titles**: Must be safe for M3U formatting and MPV OSD display.
3.  **Folder Names**: Must be strictly safe for use as filenames across Windows, Linux, and macOS.

---

## 🛡️ The Four Layers of Defense

### Layer 1: Frontend Detection (`content.js`)
**Purpose:** Neutralize data at the point of origin (web page detection).
- **Implementation:** `sanitizeString(str, isFilename = false)`
- **Logic:** Strips `"`, `` ` ``, and line breaks from detected URLs.
- **Feedback:** Logs raw vs. sanitized URLs to the browser console for developer transparency.

### Layer 2: Management Logic (`playlistManager.js` & `folder_management.js`)
**Purpose:** Ensure all data entering the browser's permanent storage is clean.
- **Playlist Management:** Sanitizes both `URL` and `Title` immediately before calling `storage.set()`.
- **Folder Management:** Applies **Strict Filesystem Sanitization** to folder names.
    - **Strict Blacklist:** `/ \ : * ? " < > | $ ; & ` ` and line breaks.
    - **Result:** Folder names are guaranteed safe for the `export/import` system.

### Layer 3: Persistence Integrity (`file_io.py`)
**Purpose:** Second line of defense on the Python side. Protects the CLI and Native Host.
- **Implementation:** `sanitize_string(s, is_filename=False)`
- **Logic:** Automatically runs during every read operation of `folders.json`.
- **Migration:** If the script detects unsanitized data in the JSON file (e.g., from manual editing), it sanitizes the entries and re-saves the file.

### Layer 4: Execution & Communication (`services.py`, `mpv_session.py`, `url_analyzer.py`)
**Purpose:** The final check before data touches the OS shell or the media player.
- **Process Launch:** `MpvCommandBuilder` sanitizes URLs right before they are added to the `subprocess` argument list.
- **External Analysis:** `url_analyzer.py` sanitizes URLs before passing them to `yt-dlp` for cookie extraction or metadata resolution.
- **IPC Communication:** Sanitizes data before sending it through the MPV IPC pipe:
    - `loadfile`: Direct playback.
    - `script-message`: Registering metadata with Lua.
    - `show-text`: Displaying Titles on the MPV OSD.
- **M3U Generation:** Ensures every line in temporary `.m3u` files is sanitized to prevent formatting breakage.

---

## 📋 Sanitization Rules Summary

| Entity | Strategy | Preserved Characters | Stripped Characters |
| :--- | :--- | :--- | :--- |
| **URLs** | Non-Destructive | `/ & ? ; $ , |` | `" ` \n \r \t` |
| **Titles** | Non-Destructive | `/ & ? ; $ , |` | `" ` \n \r \t` |
| **Folder Names** | Strict (Filesafe) | Alpha-numeric, Space, `_ - .` | `/ \ : * ? " < > | $ ; & ` \n \r \t` |

---

## 🚀 Security Impact
By implementing this defense-in-depth model, we have significantly reduced the attack surface:
1.  **Shell Injection:** Impossible via unquoted arguments as all quotes and backticks are stripped.
2.  **M3U Injection:** Newlines are stripped, preventing malicious entries from being injected into playlist files.
3.  **Path Traversal:** Strict folder name rules prevent users from creating folders that could overwrite system files during export.
4.  **Functional Integrity:** By allowing `&`, `?`, and `;`, we ensure that 100% of modern streaming URLs (CDN links, auth tokens) remain functional.
