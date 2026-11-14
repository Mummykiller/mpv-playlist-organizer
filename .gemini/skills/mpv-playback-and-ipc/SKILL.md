---
name: mpv-playback-and-ipc
description: >-
  Governs the MPV player lifecycle, launch modes, JSON-IPC bidirectional control,
  temporary handshake file mechanism, and Lua script behaviors. Load this skill whenever
  modifying `mpv_session.py`, `utils/ipc_utils.py`, `utils/mpv_command_builder.py`,
  `services.py` (create_handshake_file), `utils/m3u_server.py`, or Lua scripts in `mpv_scripts/`.
---

# MPV Playback Engine & JSON-IPC Architecture

This skill defines the MPV launch modes, cookie management, command-line construction, bidirectional JSON-IPC pipe communication, temporary handshake files, and custom Lua script hooks.

> [!NOTE]
> For playback progress tracking, watch duration mathematics, health monitoring, and detached fallback synchronization, see the companion skill: [../playback-tracking-and-fallback-sync/SKILL.md](../playback-tracking-and-fallback-sync/SKILL.md).

---

## 1. Playback Launch Modes

The application orchestrates MPV playback in two primary operational modes:

### Mode A: Stream Resolution (YouTube, Twitch, Video Portals)

- **Extractor:** Handled by `yt-dlp`. `utils/url_analyzer.py` detects platform compatibility.
- **Cookie Management & Volatile Cookie Extraction (`VolatileCookieManager`):**
  - By default, direct browser cookie access (`--cookies-from-browser <browser>`) is passed to `yt-dlp` / MPV.
  - For playlist expansion or when browser SQLite cookie databases are locked on disk, `VolatileCookieManager` creates a per-session volatile directory via `tempfile.mkdtemp(prefix=f"mpv_cookies_{os.getpid()}_", ...)` with `0o700` permissions (in `/dev/shm` on Linux or `TEMP_DIR` on Windows/macOS) and extracts cookies using an unlocked SQLite shadow copy (`--cookies-file`).
  - Per-session volatile cookie directories are cleaned up upon session termination (`cleanup_volatile_dir` / `atexit`) and startup sweeps by the janitor.
- **Python Environment Isolation (`utils/security.py:get_scrubbed_env`):**
  - Strips `PYTHONPATH`, `PYTHONHOME`, `PYTHONIOENCODING`, `PYTHONDONTWRITEBYTECODE`, and `PYTHONUNBUFFERED` from the subprocess environment.
  - Prevents the native host's Python runtime from contaminating standalone/frozen `yt-dlp` executables, eliminating "Failed to start embedded python interpreter" crashes on Windows.

### Mode B: Direct Stream (AnimePahe, HLS/m3u8, Direct Media URLs)

- **Header Injection:** Custom HTTP headers (`Referer`, `User-Agent`) are passed via command arguments and dynamically reinforced by `adaptive_headers.lua`.
- **Local M3U Streaming Server (`utils/m3u_server.py`):**
  - For complex playlists with per-item headers or large queues, the backend hosts a local loopback HTTP server (`playlist_server.py`).
  - Generates `#EXTM3U` playlists pointing to internal endpoints protected with a randomized session token (`?token=...`).

### Mode C: Unmanaged Launch (⚡ Quick Action / Play New)

- Spawns an independent, detached MPV instance.
- Bypasses the primary IPC socket connection to allow multiple concurrent video players without state collision.
- Generates a dedicated `handshake_unmanaged_<uuid>.json` file.

---

## 2. Temporary JSON Handshake File Mechanism

Passing complex settings, headers, and folder metadata across process boundaries via shell arguments is vulnerable to shell metacharacter injection and command length limits (especially on Windows 8192-character limits).

### The Handshake Workflow (`services.create_handshake_file`)

```
1. Python creates temporary JSON: data/flags/handshake_<uuid>.json
2. Windows backslashes normalized to forward slashes (C:/path/to/data/...)
3. MPV launched with flag: --script-opts=mpv_organizer-handshake=<normalized_path>
4. Lua scripts (mpv_scripts/*.lua) load the file synchronously using mp.utils.parse_json()
```

### Handshake Payload Structure

```json
{
  "folder_id": "Anime",
  "project_root": "/path/to/project",
  "flag_dir": "/path/to/data/flags",
  "playlist_start_index": 0,
  "is_youtube": false,
  "use_ytdl_mpv": false,
  "title": "Episode 1",
  "id": "item_123",
  "original_url": "https://example.com/watch",
  "headers": { "Referer": "https://kwik.cx/" },
  "cookies_browser": "chrome",
  "is_unmanaged": false
}
```

---

## 3. Bidirectional JSON-IPC Socket Communication (`utils/ipc_utils.py`)

Primary MPV sessions are controlled in real time over mpv's JSON-IPC interface using `IPCSocketManager`.

### Socket Location & Permissions

- **Linux / macOS:** Unix domain socket created in `/dev/shm` or `~/.mpv_playlist_organizer_ipc/` with strict `0600` permissions (owner read/write only).
- **Windows:** Named pipe format: `\\.\pipe\mpv-playlist-organizer-ipc-<pid>`.

### The Event Reader Thread

- `_event_reader_loop()` runs in a daemon thread, continuously reading newline-delimited JSON packets from the socket.
- Routes responses to waiting caller promises via `request_id`.
- Routes unsolicited MPV events (`property-change`, `end-file`, `playback-restart`) to registered handlers.
- Monitored properties: `time-pos`, `pause`, `duration`, `playlist-pos`, `media-title`.

---

## 4. Custom Lua Scripts Architecture (`mpv_scripts/`)

### `adaptive_headers.lua` (Header Isolation & Source Swapping)

Manages transitions between high-security sources (e.g., swapping between YouTube and AnimePahe within the same MPV playlist):

1. **Hook Priority (`priority -100`):**
   - Configured with `mp.add_hook("on_load", -100, ...)`.
   - Runs well before MPV's built-in `ytdl-hook` (which runs at priority 15), ensuring headers and options are applied before stream extraction begins.
2. **State Reset (Anti-Poisoning):**
   - MPV global properties persist across playlist items. If YouTube flags leak into an AnimePahe request, servers return `403 Forbidden`.
   - On every `on_load`, the script resets `user-agent` and `referrer` to baseline, clears `http-header-fields`, and resets `ytdl-raw-options`.
3. **Dynamic Source Detection & `force_sanitize_headers` (`services.py`):**
   - Detects YouTube URLs and sets `ytdl=yes`.
   - Detects AnimePahe / Kwik (`owocdn.top`, `uwucdn.top`, `kwik.cx`) and auto-injects `Referer: https://kwik.cx/` and sets `ytdl=no` (backed on the Python side by `services.py:force_sanitize_headers`).
4. **Hot Swap Manifest:**
   - Reads `user-data/hot-swap-options` synchronously during `on_load` when the user force-plays an item from the browser, avoiding race conditions with asynchronous IPC messages.

### `on_completion.lua` (Natural Completion & Exit Code 99)

Tracks playback completion and cleanly notifies the Python backend:

1. **Completion Detection:** Listens to `end-file` events where `event.reason == "eof"`.
2. **Completion Flag:** Immediately writes a natural completion flag file (`mpv_natural_completion_<pid>.flag`) inside `user-data/flag-dir` (resolved from handshake `flag_dir` / `mp.get_opt("flag_dir")`).
3. **Exit Code 99 (`MPV_PLAYLIST_COMPLETED_EXIT_CODE`):**
   - When the final item in the playlist queue reaches EOF naturally, the script waits 0.5s (to allow flag flushing) and executes:
     ```lua
     mp.command("quit 99")
     ```
   - The Python backend inspects the process exit code; code `99` signals that the playlist concluded naturally, preventing the backend from treating player close as an unexpected crash or abort.

---

## 5. Playback Troubleshooting Checklist

- **AnimePahe / Stream returns 403 Forbidden:**
  - Verify that `adaptive_headers.lua` is loaded at hook priority `-100`.
  - Check whether a previous YouTube stream leaked `ytdl-raw-options`. The reset hook must clear `http-header-fields` on every file load.
- **Handshake File Not Found by Lua:**
  - On Windows, verify that backslashes in `--script-opts=mpv_organizer-handshake=<path>` were converted to forward slashes. Backslashes can be corrupted by shell escaping.
- **Zombie IPC Sockets:**
  - If MPV crashes hard, stale socket files may remain in `/dev/shm` or temp directories. `native_host.py` registers cleanup handlers in `cleanup_ipc_socket()` and startup sweeps in `utils/janitor.py`.


---

## Audit Guardrails (added after the Nov 2026 code review; see `CODE_REVIEW.md`)

1. **Stale-socket detection:** only `ConnectionRefusedError` / `FileNotFoundError` mean stale. A timeout means *busy*, not dead, so never unlink on timeout. Clean up only inside the app's own IPC dir, never scan `/tmp` or other hosts' sockets.
2. **Process identity before kill:** trust a saved PID only after IPC returns the same `pid` (or `/proc/<pid>/cmdline` matches mpv plus our socket). Persist process start time in `session.json`.
3. **Restore failure must reset state** (`pid`, `ipc_path`, `owner_folder_id`, IPC manager) and keep `session.json` unless the process is truly gone.
4. **Never hold `sync_lock` across slow IPC loops.** Batch `set_url_options` / `playlist-move` with `expect_response=False`, or run them off-lock. IPC reads must have a timeout on every platform (Windows pipes included).
5. **Index mapping:** after prepend or reorder, re-send index-keyed metadata *after* the moves, never before.
6. **Per-item options must not leak globally.** Hot-swap that sets global mpv properties must restore them or be scoped per item.
7. **Use the shared bounded `EnrichmentService` executor**, never a new `ThreadPoolExecutor` per call.
8. **Cookie dirs are per-session** (`mkdtemp`, owned, 0700). Cleanup deletes only this session's files, never a shared fixed directory.
9. **Check IPC results** for `playlist-move` and `set_property`. Partial failure must be logged.
