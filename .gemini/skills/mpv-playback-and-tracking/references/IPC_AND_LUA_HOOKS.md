# MPV Handshake Schema, IPC Operations & Lua Hooks Reference

This reference documents the JSON handshake file schema, extracted session modules (`utils/session_ipc_ops.py` and `utils/session_health.py`), and custom MPV Lua scripts (`mpv_scripts/adaptive_headers.lua` and `mpv_scripts/on_completion.lua`).

---

## 1. Temporary JSON Handshake Mechanism (`services.py:create_handshake_file`)

Passing complex per-item headers, Lua options, and folder metadata via CLI arguments risks hitting Windows command-line length limits (7,500 chars enforced in `MpvCommandBuilder.build`). Instead, Python writes an atomic JSON file in `DATA_DIR/flags/`:

1. Creates `handshake_<uuid>.json` (or `handshake_unmanaged_<uuid>.json` for detached ⚡ launches).
2. Normalizes Windows backslashes to forward slashes (`C:/path/to/flags/handshake_...`) so MPV/Lua `--script-opts` parsing does not strip escape characters.
3. Launches MPV with `--script-opts=mpv_organizer-handshake=<normalized_path>`.
4. Lua scripts read and parse the file synchronously on startup via `mp.utils.parse_json()`.

### Handshake JSON Schema
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
  "headers": { "Referer": "https://kwik.cx/", "Origin": "https://kwik.cx" },
  "cookies_browser": "chrome",
  "lua_options": { "...": "constructed by services.construct_lua_options" },
  "is_unmanaged": false
}
```

---

## 2. Extracted Session IPC & Health Modules

| Module | Functions | Responsibility |
| :--- | :--- | :--- |
| **`utils/session_ipc_ops.py`** | `generate_m3u_content`, `sync_playlist_from_mpv`, `perform_cookie_fallback`, `append_batch_internal`, `remove_item`, `reorder_playlist`, `clear_live_playlist`, `hot_swap_item` | Live playlist mutations over JSON-IPC, M3U generation with `#mpv_organizer_id=<id>` fragments, cookie-extraction fallback on `ytdl_error_detected`, and hot-swapping active tracks. |
| **`utils/session_health.py`** | `start_health_watcher`, `persist_session_atomic`, `trim_oversized_reply`, `restore_session` | 500ms IPC `pid` health polling (guarded by `session_generation`), `0o600` atomic `session.json` persistence, 800 KB outbound payload trimming, and verified session restoration. |
| **`utils/ipc_utils.py`** | `IPCSocketManager`, `get_ipc_path`, `is_pid_running`, `is_process_alive`, `verify_mpv_process` | Persistent Unix domain socket (`XDG_RUNTIME_DIR/mpv_playlist_organizer_ipc/mpv-socket-<pid>` or `~/.mpv_playlist_organizer_ipc/mpv-socket-<pid>`) and Windows named pipe (`\\.\pipe\mpv-playlist-organizer-ipc-<pid>`) management, background `_event_reader_loop`, and PID identity verification. |

---

## 3. Custom MPV Lua Scripts (`mpv_scripts/`)

### `mpv_scripts/adaptive_headers.lua` (Header Isolation & Source Swapping)
Manages transitions between heterogeneous streaming sources within the same MPV playlist:
1. **Early Hook Priority (`priority -100`):** Registered via `mp.add_hook("on_load", -100, ...)` so it executes before MPV's built-in `ytdl_hook` (priority `15`).
2. **Per-Item State Reset (Anti-Poisoning):** Resets `user-agent`, `referrer`, `http-header-fields`, and `ytdl-raw-options` on every track load so YouTube flags/cookies never leak into direct CDN requests (which would trigger `403 Forbidden`).
3. **Source Routing:**
   - YouTube and Kwik landing pages: enables `ytdl=yes` and applies per-item `ytdl_raw_options`.
   - Direct AnimePahe/Kwik vault `.m3u8` streams (`owocdn.top`, `uwucdn.top`): forces `Referer: https://kwik.cx/`, `Origin: https://kwik.cx`, and `ytdl=no` (backed on the Python side by `services.py:force_sanitize_headers`).
4. **Synchronous Hot-Swap Manifest:** Reads `user-data/hot-swap-options` during `on_load` when the user force-switches tracks from the browser UI.

### `mpv_scripts/on_completion.lua` (Natural Completion & Exit Code 99)
1. **EOF Detection:** Listens for `end-file` events where `event.reason == "eof"`.
2. **Completion Flag File:** Writes `mpv_natural_completion_<pid>.flag` inside `flag_dir` (`DATA_DIR/flags`). Python reads this file using `utils/session_services.py:_safe_read_flag_file` (`os.O_RDONLY | os.O_NOFOLLOW`, 256-byte cap).
3. **Exit Code `99`:** When the final playlist item finishes naturally, waits 0.5s for flag flushing and runs `mp.command("quit 99")` so the Python exit watcher recognizes natural playlist completion vs. manual close or crash.
