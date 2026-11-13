# Code Review: mpv-playlist-organizer (v2.6.0)

Two reviewers read the code independently: one for the browser extension (JS, MV3) and one for the Python native host. Neither ran tests or the code. Findings come from reading only, and line numbers are approximate (±5).

**Not fully read**
- JS side: `popup.js`, `MpvController.js`, `settings.js`, `storageManager.js`, `playlistManager.js`, most handlers, and `m3u8_scanner.js` after about line 330.
- Python side: `installer_ui.py`, `utils/handlers/*`, `utils/native_link/*` and `utils/logger.py`.

Anything marked "verify" was not confirmed.

## 1. Architecture

```
Browser (MV3 service worker + content scripts + popup)
   │  chrome.runtime.connectNative  (4-byte length-prefixed JSON, snake_case actions)
   ▼
native_host.py  ── ThreadPoolExecutor(10) ── HandlerRegistry
   ├─ MpvSessionManager (state, RLock) ── LauncherService / EnrichmentService
   ├─ IPCSocketManager ── mpv (unix socket / Windows pipe)
   ├─ PlaylistTracker (second IPC connection, resume and watched tracking)
   ├─ file_io (sharded JSON store with a cross-process FileLock)
   └─ m3u_server → playlist_server.py (127.0.0.1, token)
```

**Strengths**
- Consistent handler factory on the JS side.
- Shadow-DOM UI that uses `textContent` for dynamic data.
- SSRF validation that covers obscured IPs (octal, hex, dword, IPv6 zone IDs).
- Allowlists for settings keys, executables and yt-dlp flags.
- mpv launched without a shell and with a scrubbed environment.
- IPC directory is 0700 and the session file is 0600.
- Atomic writes with a `.bak` fallback.
- Crash logging from the first line of the host.
- A static check against silent `except`/`catch`.

**Structural weaknesses**
- Monolithic files: `MpvController.js` (2094 lines), `popup.js` (2567), `settings.js` (1719), `MpvSessionManager` (about 1100).
- `native_host.py` registers its handlers inside `main()`, so it can't be imported for tests.
- Heavy global mutable state in `file_io`.
- The service worker keeps important state in memory.

## 2. Priority summary

| # | Area | Item | Severity |
|---|------|------|----------|
| 1 | Py | CLI mode writes binary frames to the terminal (PY-H1) | High |
| 2 | Py | No 1 MiB limit on host→browser messages (PY-H2) | High |
| 3 | Py | PID reuse can lead to killing an unrelated process (PY-H3) | High |
| 4 | Py | Playlist server: optional token, single-threaded, no Host check (PY-H4) | High |
| 5 | Py | Dangerous yt-dlp flags allowed from item payloads (PY-H5) | High |
| 6 | JS | Service-worker in-memory state is lost on suspension (JS-H1) | High |
| 7 | JS | Duplicate content-script injection (JS-H2) | High |
| 8 | JS | `chrome.runtime.reload()` "Hail Mary" (JS-H3) | High |
| 9 | JS | Monolithic files (JS-H4) | High |
| 10 | Py | Medium: socket cleanup, cookie dir, `/tmp` flags, races, locks (PY-M1 to M14) | Medium |
| 11 | JS | Medium: native-call timeouts, URL validation, alarms (JS-M1 to M9) | Medium |

## 3. Browser extension (JS)

### High

**JS-H1. Service-worker state is lost when the worker is killed (about 30s idle).**
- Affected state:
  - `autoAddActive`, `autoAddTimer` and `autoAddCooldowns` (`background.js` ~L30–80).
  - `m3u8DetectionPromises`, `lastDetectedUrls` and `_detectedUrlsState` (`m3u8_scanner.js` L7–10).
  - `activeTasks`.
  - `playbackManager.sessions` (queue, `isPlaying`, `completedItemIds`, `pendingClear`).
  - `requestPromises` and the native port in `nativeConnection`.
- Effects:
  - Auto-Add silently turns off while the popup may still show it as on.
  - In-flight scanner promises never resolve.
  - Queued appends and pending-clear state are wiped.
  - `setTimeout`-based timers and injection retries die with the worker.
- Only `mpv_playback_cache` is partially rehydrated (`PlaybackManager._initFromCache`).
- **Fix:** persist what must survive in `chrome.storage.session`. Use `chrome.alarms` instead of `setTimeout` for anything over a few seconds.

**JS-H2. Content scripts are registered twice.**
- `manifest.json` L20–45 declares `content_scripts` on `<all_urls>` with `all_frames`.
- `injectIntoTab` (`background.js` ~L555–640) removes UI hosts and calls `scripting.executeScript` on every `tabs.onActivated`.
- Consequences:
  - Scripts can run twice per page. Only the `window.mpvControllerInitialized` flag prevents double init, and the cleanup function resets it.
  - The pre-cleanup can remove live UI while the tab is still loading.
  - About four persisted log lines per activation.
- **Fix:** use the declarative mechanism, with programmatic injection only as recovery after an extension reload.

**JS-H3. The "Hail Mary" recovery calls `chrome.runtime.reload()`** (`background.js` ~L620).
- After 3 failed verification pings for one tab it reloads the whole extension. This kills the native port and all in-memory state.
- A bfcache restore, a page that blocks messaging or a slow `document_idle` can trigger it.
- There is no cool-down or loop guard.
- **Fix:** remove it, or rate-limit it (once per N minutes, active tab only).

**JS-H4. Monolithic files.**
- `MpvController.js`, `popup.js` and `settings.js` interleave controller logic, rendering, polling and state.
- `MpvController.js` has at least two `setInterval` timers (heartbeat at L1551 and a visual watchdog at L2288) and listener add/remove juggling.
- This is the biggest maintainability and regression risk, and it is hard to unit test.

### Medium

- **JS-M1. Circular and inverted dependencies.**
  - `storage_instance.js` → `messaging.js` → `storage_instance.js` works only through function hoisting.
  - `utils/nativeConnection.module.js` imports `../background/messaging.js`.
  - **Fix:** inject `broadcastLog` through a setter, as `logger.setNativeSender` does.
- **JS-M2. Dead per-folder sync debounce** (`core_services.js`).
  - `pendingSyncFolders` and `pendingFullSync` are maintained, but the alarm handler always calls `_syncToNativeHostFile()` with no argument, so it does a full sync.
  - `_syncToNativeHostFile` is fire-and-forget, so callers don't see failures.
- **JS-M3. Alarms and heartbeat are re-created on every worker wake-up** (`startNativeHostHeartbeat()` at top level, `background.js` ~L420).
  - Each wake-up pings the host and runs `syncMetadataCache()`, which fetches every shard serially.
  - `chrome.alarms.create` with an existing name resets its schedule.
  - **Fix:** create alarms in `onInstalled`/`onStartup`, or after `alarms.get`. Throttle the metadata sync by timestamp.
- **JS-M4. The stream scanner is noisy and loose** (`m3u8_scanner.js` ~L45–55).
  - It logs before the 2s duplicate check, for any URL that contains `.m3u8` or `.mp4` anywhere (including query strings).
  - Chunked or range MP4 requests flood the log and `broadcastToTabs`.
  - `tabId >= 0` is not filtered, and storage is read per matching request.
  - **Fix:** parse the pathname, filter on `tabId`, and log after the duplicate check.
- **JS-M5. `broadcastToTabs` reaches only active tabs.**
  - Background tabs miss `foldersChanged`, `preferences_changed`, `log` and `auto_add_state_changed`.
  - The catch-up on activation only runs `broadcastPlaylistState` if MPV is running.
  - **Fix:** on activation, always send a refresh message.
- **JS-M6. `callNativeHost` has no timeout** (`nativeConnection.module.js` ~L165–215).
  - A hung host leaves the promise in `requestPromises` forever and the caller hangs, including the popup.
  - The handshake has no timeout, and `connectionPromise` is shared, so a stuck `restore_session` blocks every later call.
  - `onDisconnect` doesn't reject `connectionPromise` when the state is CONNECTED.
  - `lastRestoredIsPaused` is closure state that leaks stale `isPaused` into later events.
  - A throwing listener in `dispatchNativeEvent` aborts the forEach, so later listeners are skipped.
  - **Fix:** add per-request (about 30s) and connect timeouts, and try/catch around each listener.
- **JS-M7. URL validation is uneven.**
  - `callNativeHost` checks only `message.url` and `message.urlItem.url`, with `isValidUrl`, which allows `file:`, `udp:`, `rtmp:`, `rtsp:` and `mms:`.
  - It is not `isSafeUrl`, and no call site of `isSafeUrl` was found in the code read. Check that the host enforces SSRF itself.
  - Batch arrays (`urlItems`, `urls`) bypass the check.
  - The `isValidUrl` catch fallback accepts anything that starts with `http:` or `https:` even when `new URL` throws.
  - Context-menu add uses `linkUrl || srcUrl || pageUrl` with no scheme check at that point (verify downstream).
- **JS-M8. Logging and error handling.**
  - `broadcastLog` for errors calls `logger.error(..., {persist: true})` again, and loop protection relies on a string check plus a re-entrancy guard.
  - `broadcastLog` is async and mostly unawaited, so rejections can go unhandled.
  - `log_browser_error` forwards content-script text to the host with no length cap.
  - The `content.js` error filter matches on a filename substring, which is brittle.
- **JS-M9. Manifest issues.**
  - `browser_specific_settings.gecko` is declared, but there is `background.service_worker` and no `background.scripts` fallback. Firefox MV3 doesn't support service workers.
  - `web_accessible_resources.matches` is redundant (`*://*/*` and `<all_urls>`), and it lets any page fingerprint the extension through `images/*`, `shared.css` and `content.css`.

### Low

- **JS-L1.** `injectIntoTab` writes up to about 4 `persist: true` info logs on every tab activation. Use `debug`, and persist only failures.
- **JS-L2.** The restricted-domain check is duplicated with `isScriptableUrl`. The `/webstore` pathname match is too broad.
- **JS-L3.** `reinjectContentScripts()` may be dead (verify).
- **JS-L4.** `toggle_auto_add` race: with no `folderId` the cooldown is set and the URL is dropped for 5s. `response.success === false` is not handled in the detached IIFE.
- **JS-L5.** `get_last_folder_id` falls back to `Object.keys(folders)[0]`, which is order-dependent and has no empty-object guard.
- **JS-L6.** `actionHandlers` is a plain object, so `request.action === "constructor"` or `"__proto__"` hits `Object.prototype`. Use `Object.hasOwn` or a `Map`.
- **JS-L7.** `innerHTML`:
  - The reviewed sites use static templates or `textContent`, and no XSS was found.
  - Audit sites that may interpolate page or API-derived values: `settings.js` (L1232, 1400, 1829, 1880), `MpvController.js` (L1392–1458), `PlaylistUI.js` (L142) and `AniListUI.js` (L205).
  - `popup.js` L1643 uses `innerHTML.includes("<line")` as state, which is fragile.
- **JS-L8.** Lua `ensure_dir` (`mpv_scripts/on_completion.lua` L100–107) uses `os.execute` and doesn't strip `\` or `%`. Use `mp.command_native` with a subprocess args array.
- **JS-L9.** Retry counts, delays, cooldowns and alarm periods are hard-coded and scattered.
- **JS-L10.** Mixed tabs and CRLF in `background.js`. Several comment-only `catch` blocks (`m3u8_scanner.js`) get past the AST gate.

### Dead and duplicated code (JS)
- The "never edit `utils/*.js`" rule applies only to the 7 generated files that have a `.module.js` source. About 18 other `utils/*.js` files are hand-written, so the split is confusing. Document it or rename the generated outputs.
- `PlaylistRenderer.js` and `PlaylistUI.js` appear to duplicate copy-button, check-mark and quick-action logic.
- `popup.html` loads `security.js`, `commUtils.js` and `domUtils.js` as classic scripts while `popup.js` also imports ES modules (check for a double load).
- `native_host_crash.log` is in the repo root. It should be git-ignored, and it should be excluded from releases.

## 4. Native host (Python)

### High

**PY-H1. CLI mode writes native-messaging binary frames to the terminal.**
- `native_host.py:214-223` wires `send_message` into `MpvSessionManager` unconditionally. In `mpv-cli play …` (`cli.py:36-99`) it writes a `struct.pack('@I')` header plus JSON to `sys.stdout.buffer` (`:199-204`).
- **Fix:** select a text or no-op sender based on `is_browser`.

**PY-H2. No size limit on host→browser messages.**
- `send_message` (`native_host.py:180-208`) never checks Chrome's 1 MiB limit, and Chrome kills the host on an oversized message.
- Candidates:
  - `restore_session` (`mpv_session.py:385-393`, `495-503`).
  - `start()` enriched items and M3U (`:946-951`, `:1130-1134`).
  - AniList `raw_schedules_for_cache` (`anilist_releases.py:238`).
- The blanket `except` at `native_host.py:207` would hide the symptom.
- **Fix:** guard at about 900 KB. Chunk or page the reply, or at least return a failure with the same `request_id`.

**PY-H3. PID reuse can kill an unrelated process.**
- `restore()` (`mpv_session.py:419-426`) treats a session as alive if the saved PID is running, even when the IPC probe fails.
- `LauncherService.close()` (`utils/session_services.py:541-561`) then sends SIGTERM and SIGKILL to that PID.
- **Fix:**
  - Trust a PID only after IPC returns a matching pid.
  - Alternatively check `/proc/<pid>/cmdline` or the process create time.
  - Store the start time in `session.json`.

**PY-H4. Playlist HTTP server weaknesses.**
- Token:
  - `playlist_server.py:32-37` skips the check when `MPV_PLAYLIST_TOKEN` is unset.
  - `m3u_server.py:45` can set the env var to `None`, which makes `Popen` raise `TypeError`.
  - The standalone `__main__` has no token.
  - The token travels in the query string.
- Concurrency and Host header:
  - It uses a blocking, single-threaded `TCPServer`, so one stalled client blocks every request.
  - There is no `Host` header validation, so DNS rebinding is possible when the token is absent.
- Hostnames: the URLs use `localhost` while the bind is `127.0.0.1`, which can cause IPv6-first delays.
- **Fix:**
  - Require a token and fail closed.
  - Use `ThreadingHTTPServer` with a socket timeout.
  - Validate the `Host` header.
  - Use `127.0.0.1` everywhere.
  - Default to `start_port=0`.

**PY-H5. The yt-dlp flag allowlist includes dangerous options.**
- `utils/security.py:160-177` allows `proxy`, `ffmpeg-location`, `js-runtimes`, `remote-components`, `alias`, `compat-options`, `update`, `print` and `no-check-certificate`.
- Item-supplied `ytdl_raw_options` are merged (`services.py:129-136`), and they originate from the extension.
- Value sanitization (`security.py:457`) strips only quotes and `;&|` and backticks.
- **Fix:**
  - Drop the risky keys from item-supplied options.
  - Take `ffmpeg-location`, `js-runtimes` and `remote-components` from settings only, after `is_safe_executable_path`.
  - Add a test that an item-supplied `proxy=` is rejected.

### Medium

- **PY-M1. `_is_socket_stale` treats timeouts as stale** (`utils/ipc_utils.py:429-449`).
  - `socket.timeout` is an `OSError`, so a busy live mpv socket is unlinked.
  - `cleanup_stale_sockets` runs on every `close()` and scans `/tmp/mpv_sockets`, `/dev/shm`, the IPC dir and `/tmp`, so other hosts' sockets are at risk.
  - **Fix:** only `ConnectionRefusedError` and `FileNotFoundError` mean stale. Scan only the app's own IPC dir.
- **PY-M2. Shared cookie temp dir** (`utils/url_analyzer.py:45-73`).
  - The fixed `/dev/shm/mpv_organizer_cookies` is deleted at host start (`native_host.py:289-290`), at exit (`:280`) and in `clear()` (`mpv_session.py:350-354`), so a second host can delete cookies a running mpv still uses.
  - `/dev/shm` is world-writable, and `chmod` silently fails if another user pre-created the dir.
  - **Fix:** use a per-host or per-session `mkdtemp`, and verify ownership.
- **PY-M3. Predictable `/tmp` flag files** (`session_services.py:208-211`, `:455-459`).
  - `/tmp/mpv_natural_completion_<pid>.flag` can be pre-created or symlinked by another local user to spoof completion.
  - **Fix:** use only the private `FLAG_DIR`, open with `O_NOFOLLOW`, and cap the read length.
- **PY-M4. `manual_quit` race.**
  - `clear()` resets `manual_quit` (`mpv_session.py:306`) before the waiter thread reads it (`session_services.py:463`), so a user quit can be treated as natural completion (code 99, playlist cleared).
  - An old waiter can `clear()` a newly started session, and `mpv_exited` can be sent twice.
  - **Fix:** capture `manual_quit` when the waiter starts. Pass a PID or generation token into `clear()` and ignore stale callers.
- **PY-M5. Unlocked read-modify-write** (`playlist_tracker.py:570-608`).
  - The `get_index` → `save_index` and shard get/save calls each lock separately, so they can interleave with `save_library_batch`.
  - **Fix:** add an `update_shard(folder_id, fn)` helper that holds the lock for the whole operation. Keep the INDEX→shard lock order.
- **PY-M6. Tracker snapshot loss** (`playlist_tracker.py:549-564`, `:610`).
  - Caches are cleared before the disk write, so a failed write permanently loses resume times and watched flags.
  - **Fix:** merge the snapshot back on failure.
- **PY-M7. `FileLock` stale detection is racy** (`file_io.py:142-175`).
  - Two processes can both consider a lock stale and both proceed.
  - Lock files are not 0600.
  - The fallback to a thread-only lock on EROFS/EACCES silently drops cross-process safety (`:135-140`).
  - **Fix:** use `fcntl.flock` on POSIX and `msvcrt.locking` on Windows, which the OS releases when the process dies.
- **PY-M8. `get_settings()` can overwrite user config** (`file_io.py:894-901`).
  - It takes a file lock and may write on every call, and it is called from hot paths.
  - If `config.json` is unreadable and `.bak` is missing, defaults overwrite the user's config. A transient read failure on Windows (antivirus) can cause data loss.
  - **Fix:** distinguish missing from unreadable, write defaults only when the file doesn't exist, and cache by mtime.
- **PY-M9. `FORBIDDEN_PATH_CHARS` rejects `(` and `)`** (`utils/security.py:324`).
  - `C:\Program Files (x86)\...\mpv.exe` fails, and `set_settings` silently drops `mpv_path` (`file_io.py:980-982`).
  - **Fix:** remove `()`. mpv is launched without a shell.
- **PY-M10. Restore error paths leak state** (`mpv_session.py:434-449`, `:513`).
  - If connect fails, `pid`, `owner_folder_id` and the IPC manager stay populated, which confuses a later `start()`.
  - `session.json` is deleted even for transient failures, so orphaned mpv processes are never re-adopted.
- **PY-M11. Prepend and reorder metadata indices** (`mpv_session.py:643-664`, `:808-814`).
  - `set_url_options` uses indices computed before the entries are moved to index 0, so options attach to the wrong items.
  - N sequential IPC calls with 1s timeouts under `sync_lock` can block for a long time.
  - `reorder` calls `ipc_manager.send` at `:814` outside its guard.
  - **Fix:** re-send options after the moves (as `reorder` does) and batch with `expect_response=False`.
- **PY-M12. Windows IPC read has no timeout** (`ipc_utils.py:333-340`).
  - `readline()` on the pipe blocks forever while holding `_send_lock`, which affects `is_process_alive` and `restore`.
- **PY-M13. Noisy `time-pos` handling** (`playlist_tracker.py:325-331`).
  - `int(t) % 5 == 0` is true for every event within that second, so `_update_resume_time` and `send_message` run many times. Throttle by bucket.
- **PY-M14. Tracker state mutated without locks** (`playlist_tracker.py`).
  - `played_item_ids`, `threshold_met_ids` and several other sets and dicts are mutated from the tracking thread, the IPC reader thread and callback threads.
  - Iterating while another thread mutates (`:85`, `:536`) can raise `RuntimeError`.
  - `update_playlist_order` aliases the session's list (`:127`).

### Low

- **PY-L1.** `save_library_batch` (non-incremental) deletes every shard not in the payload (`file_io.py:518-548`). A buggy or empty payload wipes the library. Move shards to a `trash/` directory, refuse to prune on an empty payload, and keep an `index.json` backup.
- **PY-L2.** `_atomic_json_dump` copies a possibly corrupt current file over a good `.bak` (`file_io.py:570-571`), and there is no directory fsync.
- **PY-L3.** `get_mpv_executable()` searches the project dir and `sys.executable`'s directory before PATH, and `native_host.py:88-95` prepends them to PATH. Pin it to the configured path after install.
- **PY-L4.** The installer doesn't validate `extension_id` (`installer_logic.py:325-331`, `:444`). Use `^[a-p]{32}$`.
- **PY-L5.** The `.sh` and `.bat` wrappers embed paths unescaped (`installer_logic.py:319`, `:383`, `:438`, `:478`). Use `shlex.quote`. The tracked `run_native_host.sh` is overwritten by the installer and dirties git.
- **PY-L6.** Installer gaps:
  - Importing `file_io` and `services` creates data dirs as a side effect.
  - Firefox is unsupported but undocumented.
  - Windows uninstall doesn't remove the fallback registry key on its own.
- **PY-L7.** `anilist_releases.py`:
  - It reads `sys.argv` inside `get_today_airing_anime`.
  - `--days` is unbounded.
  - DST handling is off with a fixed-offset tz.
  - `status != 200` is dead code.
  - It spoofs a Mozilla User-Agent and relies on a custom `ca.pem`.
  - `utils/anilist_service.py` wipes all day offsets when today's cache expires.
- **PY-L8.** `cli.py`:
  - `folders_data.get(folder_id)` is exact-match while elsewhere IDs are case-insensitive.
  - The `is_process_alive` poll can exit early.
  - It rebinds the module global `time`.
- **PY-L9.** `native_host.py`:
  - The 10-worker pool has no per-command timeout or priority lane, so `ping`, `close` and `restore_session` queue behind slow `start()` calls.
  - Handlers live inside `main()`.
  - `cleanup_ipc_socket` reads `ipc_path` without a lock.
  - The version string `1.1.1` is hard-coded.
  - `PYTHONDONTWRITEBYTECODE` is set in about 10 modules.
  - `logger.initialize` crashes on a read-only data dir (see `native_host_crash.log`). Degrade to stderr-only logging.
- **PY-L10.** The health watcher (`mpv_session.py:70-116`) reads `self.ipc_manager` without a lock and calls `clear()` from its own thread. The restored-process watcher plus PID reuse can send a wrong `mpv_exited`.
- **PY-L11.** `persist_session` writes the session file (which contains the token) and then chmods it (`mpv_session.py:242-248`). Open it with 0600 and write via a temp file plus `os.replace`.
- **PY-L12.** Hot-swap sets global mpv properties, which leak to later items (`:1040-1054`), and has a `sleep(0.1)` race (`:1069`). `start()` creates a new `ThreadPoolExecutor` per call.
- **PY-L13.** Code quality:
  - Shadowed `file_io` imports.
  - `start()` is about 240 lines.
  - Leftover thinking comments (`mpv_session.py:187-193`).
  - Inconsistent return types in `clear_live`.
  - String matching on "Address already in use" in `playlist_server.py` (use `errno.EADDRINUSE`).
  - A `SimpleHTTPRequestHandler` base class where `BaseHTTPRequestHandler` would be safer.

### Security notes (native messaging, IPC, local server)

- **Native messaging**
  - The host doesn't check `argv[1]` (the calling origin), and any non-TTY stdin counts as the browser (`native_host.py:408-416`).
  - `validate_payload` checks only size and `action`, not per-action schemas, and `check_size` has no depth limit.
  - Error strings (`native_link.failure(str(e))`) can leak full paths, because `mask_path` is applied only to the `log` key.
- **mpv IPC**
  - The socket is chmodded after launch (`mpv_session.py:1116-1120`), which is fine under the 0700 dir.
  - Titles reach `show-text` and `script-message`. `services.sanitize_url` is a URL sanitizer and doesn't cover OSD text (`mpv_session.py:741`).
- **SSRF**
  - `is_safe_url` resolves DNS at check time, but yt-dlp and mpv resolve again later (TOCTOU and rebinding).
  - Hostnames that fail to resolve are allowed (`security.py:297-301`).

### Concurrency summary
- **Locks present:** `sync_lock` (RLock), `print_lock`, `restore_lock`, the tracker `lock`, `FileLock`, and the IPC `_send_lock` and `_buffer_lock`.
- **Main risks:**
  - Long IPC and sleeps under `sync_lock`.
  - Worker-pool starvation.
  - Stale waiter threads calling `clear()` (PY-M4).
  - Unlocked tracker state (PY-M14).
  - Cross-process lock staleness (PY-M7).
- **Daemon threads** die abruptly at exit. `atexit` → `mpv_session.clear` → `tracker.stop_tracking` does a final commit, so keep that.

### Error handling
- The pattern is broad `except Exception` with log-and-continue.
- `send_message` swallows all errors.
- `restore` returns `None` for both "no session" and "failed".
- Raw exception text with paths reaches the UI.
- Several IPC results are ignored (`playlist-move`, hot-swap `set_property`).
- `task_wrapper` both re-raises and is decorated with `@logger.catch(ui_alert=True)`, so an error is reported twice.

## 5. Test coverage

**Existing**
- `testing_tools/scripts/` has 6 JS tests and 6 Python tests (about 74 tests).
- JS tests: bridge protocol, bridge, logger logic, modular components, UI sync, and the bridge contract.
- Python tests: logging, native-host boot, crash repro, robustness and security claims.
- `run_suite.py` adds static checks: ruff if it is installed, `node --check`, and an AST check for silent excepts.

**Gaps**
- **JS:**
  - `handler_factory` ordering and failure paths.
  - Scanner lifecycle.
  - `injectIntoTab` and Hail-Mary retries.
  - `processQueue`.
  - `core_services` debounce.
  - `nativeConnection` disconnect, timeout and listener exceptions.
  - popup flows and Lua.
- **Python:**
  - `file_io` (locking, batch prune, atomic dump, settings).
  - `playlist_tracker`.
  - `mpv_session` (start, hot swap, prepend, reorder, restore).
  - `ipc_utils`.
  - The playlist server and token enforcement.
  - AniList.
  - Installer logic.
  - `cli.py`.
  - `native_host` dispatch.
- **Tooling:**
  - ruff is skipped when absent. Make it a declared dependency.
  - `base_test.py` clears the global logger handlers.
  - `verify_changes.py` starts a background watchdog.
  - `create_release.py` doesn't exclude `*.log`.

**Suggested tests, in priority order**
1. A subprocess test that sends oversized and malformed frames to the host.
2. A Node harness with a mocked `chrome.*` for `createHandler`, `processQueue`, the scanner and `nativeConnection`.
3. Multi-process `FileLock` and `_atomic_json_dump` tests.
4. `_is_socket_stale` with a full backlog.
5. Playlist server: token required and threaded.
6. A fake mpv IPC server to test `MpvSessionManager` end to end (prepend, reorder, restore with PID reuse, close).
7. Installer manifest generation per platform.

## 6. Recommended roadmap

1. **Quick wins and safety**
   - PY-H1 (CLI sender), PY-H2 (size guard), PY-H3 (PID verification), PY-H5 (flag allowlist).
   - JS-H3 (remove or rate-limit reload), JS-L6 (`Object.hasOwn`), JS-M7 (`isValidUrl` fallback and batch URLs).
   - PY-M9 (path chars).
2. **Security hardening:** PY-H4, PY-M1, PY-M2, PY-M3, JS-M6, JS-M9, JS-L8.
3. **Reliability**
   - Service worker: persist state (JS-H1), unify injection (JS-H2), alarms (JS-M3), native timeouts (JS-M6).
   - Host: session generation token (PY-M4), locked `update_shard` (PY-M5), flock-based `FileLock` (PY-M7), safe `get_settings` (PY-M8), tracker locking (PY-M14).
4. **Refactors:** split `MpvController.js`, `popup.js`, `settings.js`, `MpvSessionManager` and `native_host.py`. Break the `utils`↔`background` cycle. Deduplicate the rendering code.
5. **Tests and tooling** per section 5.
