---
name: mpv-playback-and-ipc
description: >-
  Governs the MPV player lifecycle, launch modes, JSON-IPC bidirectional control,
  temporary handshake file mechanism, and Lua script behaviors. Load this skill whenever
  modifying `mpv_session.py`, `utils/session_ipc_ops.py`, `utils/session_health.py`,
  `utils/ipc_utils.py`, `utils/mpv_command_builder.py`, `services.py` (create_handshake_file),
  `utils/m3u_server.py`, or Lua scripts in `mpv_scripts/`.
---

# MPV Playback Engine & JSON-IPC Architecture

This skill defines MPV launch modes, command-line construction, bidirectional JSON-IPC socket/pipe control, temporary handshake files, and Lua script hooks.

> [!IMPORTANT]
> - For handshake JSON schemas, `session_ipc_ops.py` / `session_health.py` method tables, and Lua hook details (`adaptive_headers.lua`, `on_completion.lua`), see [references/IPC_AND_LUA_HOOKS.md](references/IPC_AND_LUA_HOOKS.md).
> - For playback progress math, health monitoring, and detached fallback sync, see [../playback-tracking-and-fallback-sync/SKILL.md](../playback-tracking-and-fallback-sync/SKILL.md).

---

## 1. Playback Launch Modes (`mpv_session.py`, `utils/handlers/playback_handler.py`)

1. **Mode A: Extractor-Backed Streams (YouTube, Portals, Kwik Landing Pages)**
   - Resolved via `yt-dlp` (`use_ytdl_mpv=True`).
   - Passes `--cookies-from-browser <browser>` directly to MPV for single videos; uses `utils/url_analyzer.py:VolatileCookieManager` (`0700` per-PID `/dev/shm` directory + SQLite shadow copy fallback) only when Python-side playlist expansion or cookie fallback is required.
   - Subprocesses run with `utils/security.py:get_scrubbed_env()` to prevent Python runtime variables from contaminating standalone `yt-dlp` binaries.
2. **Mode B: Direct Streams & Local M3U Server (HLS `.m3u8`, Direct Media)**
   - Direct vault streams (`owocdn.top`, `uwucdn.top`) and media files use `use_ytdl_mpv=False` with headers enforced by `services.py:force_sanitize_headers` and `mpv_scripts/adaptive_headers.lua`.
   - Multi-item M3U payloads are served via `utils/m3u_server.py:M3UServer` (`playlist_server.py`) on `127.0.0.1:0` with `MPV_PLAYLIST_TOKEN` authentication.
3. **Mode C: Unmanaged / Detached Launch (`play_new_instance` / ⚡ Quick Action)**
   - Spawns an independent MPV process (`PlaybackHandler._launch_unmanaged_mpv`) without binding the primary session's IPC socket, using `handshake_unmanaged_<uuid>.json` (cleaned up after 10s).

---

## 2. IPC Socket & Handshake Lifecycle (`utils/ipc_utils.py`, `services.py`)

- **IPC Path & Permissions (`ipc_utils.get_ipc_path`):**
  - **Linux / macOS:** Unix socket in `XDG_RUNTIME_DIR/mpv_playlist_organizer_ipc/mpv-socket-<pid>` (or `~/.mpv_playlist_organizer_ipc/mpv-socket-<pid>` fallback) with directory mode `0700` and socket mode `0600`.
  - **Windows:** Named pipe at `\\.\pipe\mpv-playlist-organizer-ipc-<pid>`.
- **Handshake File (`services.create_handshake_file`):** Writes initial metadata and `construct_lua_options` output to `DATA_DIR/flags/handshake_<uuid>.json` (forward-slash normalized on Windows) and passes `--script-opts=mpv_organizer-handshake=<path>` via `MpvCommandBuilder`.
- **Natural Completion (`mpv_scripts/on_completion.lua`):** Writes `mpv_natural_completion_<pid>.flag` in `DATA_DIR/flags` and exits with code `99` (`quit 99`) when the final queue item reaches EOF.

---

## 3. Audit Guardrails

1. **Stale-socket detection (`IPCSocketManager._is_socket_stale`):** Only `ConnectionRefusedError` / `FileNotFoundError` (`ECONNREFUSED` / `ENOENT`) indicate a stale socket. A socket timeout means MPV is *busy*, never dead—never unlink on timeout. `cleanup_stale_sockets` scans only `IPC_DIR_LINUX`, never `/tmp`.
2. **Verify PID identity before signaling (`ipc_utils.verify_mpv_process`):** Confirm PID ownership via IPC `pid` property probe, `/proc/<pid>/cmdline`, `psutil`, Windows `QueryFullProcessImageNameW`, or `ps` before sending `SIGTERM`/`SIGKILL`/`taskkill`.
3. **Restore failure cleanup (`session_health.restore_session`):** If persistent IPC attachment fails during restore, reset in-memory session state (`pid`, `ipc_path`, `owner_folder_id`, `ipc_manager`) and preserve `session.json` on disk if `verify_mpv_process` confirms the MPV process is still alive.
4. **Never hold `sync_lock` across slow IPC loops:** Batch `set_url_options` or `playlist-move` commands, or release the lock around blocking IPC calls. All IPC reads must enforce a timeout on both Unix (`select.select`) and Windows (`PeekNamedPipe`).
5. **Re-index Lua metadata after moves:** After prepending or reordering playlist items in MPV, re-send `script-message set_url_options` with updated global indices *after* the moves complete.
6. **Prevent global property leakage:** `adaptive_headers.lua` (`on_load` priority `-100`) must reset `user-agent`, `referrer`, `http-header-fields`, and `ytdl-raw-options` on every track transition, and `LauncherService._sync_initial_state` must not leave `user-data/hot-swap-options` set after initial load.
7. **Shared bounded executor:** Background playlist enrichment must use `EnrichmentService.executor` (bounded `ThreadPoolExecutor`), never unbounded per-item threads.
