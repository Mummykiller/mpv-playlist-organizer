# MPV Playlist Organizer: Sanitation & Security Documentation

This document outlines the multi-layered sanitation and validation strategy used to ensure the security and integrity of the MPV Playlist Organizer system.

## 1. String & Content Sanitation
Used to prevent shell injection, M3U format breakage, and UI rendering issues.

### `sanitizeString` (JS) / `sanitize_string` (Python)
- **Context A: Titles & URLs (Default)**
    - **Goal:** Preserves URL functionality while ensuring they don't break JSON structures or M3U line parsing.
    - **Action:** Removes `"` (quotes), `` ` `` (backticks), and newlines (`\n`, `\r`, `\t`).
- **Context B: Filenames (Strict)**
    - **Goal:** Ensures strings can be safely used as folder names or exported filenames on all Operating Systems.
    - **Action:** Strips `/ \ : * ? " < > | $ ; & ` ` and control characters.

## 2. URL Normalization
Ensures that similar URLs are treated as identical for deduplication and resume logic.

### `normalizeYouTubeUrl`
- **Goal:** Removes non-essential tracking and session parameters from YouTube URLs.
- **Parameters Stripped:** `t` (timestamp), `index` (playlist position), `start`, `ab_channel`, `attr_tag`.
- **Reasoning:** Prevents duplicate entries in the same folder if the user navigates to the same video via a different playlist or link.

## 3. Path Validation (Python)
Crucial for preventing **Path Traversal** attacks where a malicious payload might try to access files outside the project directory.

### `validate_safe_path`
- **Mechanism:** Resolves paths to their absolute realpath (`os.path.realpath`) and verifies they reside within an allowlist of prefixes.
- **Allowlist:**
    - `DATA_DIR` (App configuration and local storage)
    - `SCRIPT_DIR` (Project source files)
    - `TEMP_DIR` (System temporary directory)
    - `XDG_RUNTIME_DIR` / `/dev/shm` (RAM-backed storage for volatile cookies)
- **Usage:** All IPC paths, log paths, and configuration file paths must pass this check.

## 4. Playback Security (yt-dlp)
Since `yt-dlp` is used to resolve streams, we must prevent users (or malicious page metadata) from passing dangerous flags to the shell.

### `sanitize_ytdlp_options`
- **Mechanism:** Implements a strict **Allowlist** of safe flags.
- **Allowed:** `format`, `cookies`, `user-agent`, `referer`, `concurrent-fragments`, etc.
- **Blocked:** Anything involving `--exec`, `--output`, `--write-file`, or local script execution.
- **Reasoning:** Prevents a crafted URL/Playlist from executing arbitrary commands on the host machine.

## 5. Network Security (SSRF Protection)
Prevents the backend from being used as a proxy to scan the user's local network.

### `is_safe_url`
- **Mechanism:** Resolves every hostname before resolution/playback and checks the resulting IP address.
- **Blocklist:**
    - Private IP ranges (10.x, 192.168.x, 172.16.x)
    - Loopback (127.x, localhost)
    - Link-local addresses.
- **Reasoning:** Ensures the backend cannot be tricked into accessing the user's router interface or other local services.

## 6. Data Integrity
- **Atomic Writes:** Python uses `.tmp` swap files with `os.replace` to ensure `config.json` and `folders.json` are never corrupted by partial writes (e.g., during a crash).
- **Redundancy:** Automatic `.bak` files are maintained and used as a fallback if primary JSON files are corrupted.
- **Sharding:** Playlists are stored in separate files (`playlists/<folder_id>.json`) so that a corruption in one folder does not affect the entire application.
