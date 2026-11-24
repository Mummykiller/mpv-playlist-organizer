---
name: mpv-playback-and-tracking
description: >-
  Governs MPV player launch modes, JSON-IPC sockets/pipes, handshake files, Lua hooks,
  monotonic playback progress math, session health state machine, detached fallback sync,
  and async queue enrichment. Load whenever modifying `mpv_session.py`, `playlist_tracker.py`,
  `utils/session_ipc_ops.py`, `utils/session_health.py`, `utils/session_services.py`,
  `utils/ipc_utils.py`, `utils/mpv_command_builder.py`, `utils/m3u_server.py`,
  `utils/fallback_sync.py`, `utils/PlaybackStateManager.js`, or `mpv_scripts/*.lua`.
---

# MPV Playback, IPC & Tracking Architecture

> [!IMPORTANT]
> For handshake JSON schemas, `session_ipc_ops.py` / `session_health.py` method tables, and Lua hook details (`adaptive_headers.lua`, `on_completion.lua`), see [references/IPC_AND_LUA_HOOKS.md](references/IPC_AND_LUA_HOOKS.md).

---

## 1. Playback Launch Modes (`mpv_session.py`, `utils/handlers/playback_handler.py`)
1. **Mode A — Extractor-Backed Streams (YouTube, Portals, Kwik Landing Pages):** `use_ytdl_mpv=True`. Passes `--cookies-from-browser <browser>` directly to MPV for single videos; uses `utils/url_analyzer.py:VolatileCookieManager` (`0700` per-PID `/dev/shm` dir + SQLite shadow copy) only when Python-side expansion or cookie fallback is required. Always run subprocesses with `utils/security.py:get_scrubbed_env()`.
2. **Mode B — Direct Streams & Local M3U Server (HLS `.m3u8`, Direct Media):** `use_ytdl_mpv=False` with headers enforced by `services.py:force_sanitize_headers` and `mpv_scripts/adaptive_headers.lua`. Multi-item M3U payloads are served via `utils/m3u_server.py:M3UServer` (`playlist_server.py`) on `127.0.0.1:0` with `MPV_PLAYLIST_TOKEN`.
3. **Mode C — Unmanaged / Detached Launch (`play_new_instance` / ⚡):** Spawns an independent MPV process (`PlaybackHandler._launch_unmanaged_mpv`) without binding the primary IPC socket, using `handshake_unmanaged_<uuid>.json` (cleaned up after 10s).

---

## 2. IPC Socket & Handshake Lifecycle (`utils/ipc_utils.py`, `services.py`)
- **IPC Path & Permissions (`ipc_utils.get_ipc_path`):**
  - Linux/macOS: `XDG_RUNTIME_DIR/mpv_playlist_organizer_ipc/mpv-socket-<pid>` (fallback `~/.mpv_playlist_organizer_ipc/`) with dir `0700`, socket `0600`.
  - Windows: `\\.\pipe\mpv-playlist-organizer-ipc-<pid>`.
- **Handshake File (`services.create_handshake_file`):** Writes initial metadata + `construct_lua_options` to `DATA_DIR/flags/handshake_<uuid>.json` (forward-slash normalized on Windows) and passes `--script-opts=mpv_organizer-handshake=<path>` via `MpvCommandBuilder`.
- **Natural Completion (`mpv_scripts/on_completion.lua`):** Writes `mpv_natural_completion_<pid>.flag` in `DATA_DIR/flags` and exits with code `99` (`quit 99`) when the final item reaches EOF. `LauncherService.start_restored_process_watcher` reads flags via `_safe_read_flag_file` (`os.O_RDONLY | os.O_NOFOLLOW`, 256-byte cap).

---

## 3. Progress Math, Health Machine & Fallback Sync
- **Monotonic Forward Math (`playlist_tracker.py`):** Accumulate `current_session_duration` **only** when `0 < delta < 2.0`. Never accumulate seeks/rewinds (`abs(delta)`).
- **2-Second Staged `lastPlayedId` Commit:** Commit `pending_last_played_id` to disk only after `current_session_duration >= 2`. Watch threshold triggers at `>= 30s`.
- **Dual-Tier Disk Throttling:** Update in-memory resume position every 5s of media time (`int(current_time) % 5 == 0`), but throttle physical disk commits to 10s (`commit_interval`). Never block the IPC event loop on disk locks.
- **Late EOF Attribution:** If `end-file` (`reason == "eof"`) arrives when `current_session_duration < 1.0`, attribute it to `previous_id` rather than `current_id`.
- **Health Watcher (`utils/session_health.py:start_health_watcher`):** Polls `pid` over IPC every 500ms (`0.3s` timeout), guarded by `session_generation` (`current_gen != gen`). Transitions `OK` → (1–2 timeouts) `STALE` → (3rd timeout) `DEAD`, dispatching `action: "playback_health_changed"`. Tears down sockets/temp files only when `ipc_utils.is_pid_running(self.pid)` is `False`.
- **Detached Fallback Sync (`mpv_scripts/python_loader.lua`, `utils/fallback_sync.py`):** Spawns detached `fallback_sync.py` (with its own `FileLock`) only when `tracker_heartbeat` has been missing for **> 12 seconds** (crashed host or unmanaged ⚡ session).
- **Async Queue Enrichment (`utils/session_services.py`):** `LauncherService` plays the target item immediately; `EnrichmentService` enriches remaining items in `batch_size = 5` using its bounded `EnrichmentService.executor` (`ThreadPoolExecutor`).

---

## 4. Audit Guardrails
1. **Stale-socket detection (`IPCSocketManager._is_socket_stale`):** Only `ECONNREFUSED` / `ENOENT` indicates a stale socket. A timeout means MPV is *busy*, never dead—never unlink on timeout. `cleanup_stale_sockets` scans only `IPC_DIR_LINUX`, never `/tmp`.
2. **Verify PID before signaling (`ipc_utils.verify_mpv_process`):** Confirm PID ownership via IPC `pid` probe, `/proc/<pid>/cmdline`, `psutil`, Windows `QueryFullProcessImageNameW`, or `ps` before signaling.
3. **Restore failure cleanup (`session_health.restore_session`):** On persistent IPC attach failure, reset in-memory session fields and preserve `session.json` if `verify_mpv_process` confirms MPV is still alive.
4. **Never hold `sync_lock` across slow IPC loops:** Batch `set_url_options` / `playlist-move` or release the lock around blocking calls. Enforce timeouts on both Unix (`select.select`) and Windows (`PeekNamedPipe`).
5. **Re-index Lua metadata after moves:** Re-send `script-message set_url_options` with updated global indices *after* playlist moves finish.
6. **Prevent global property leakage:** `adaptive_headers.lua` (`on_load` priority `-100`) resets `user-agent`, `referrer`, `http-header-fields`, and `ytdl-raw-options` per track; `LauncherService._sync_initial_state` must clear `user-data/hot-swap-options` after initial load.
