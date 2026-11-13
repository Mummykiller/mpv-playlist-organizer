# Remediation Plan

Companion to [CODE_REVIEW.md](file:///home/shinku/Documents/mpv-playlist-organizer/CODE_REVIEW.md). Finding IDs (PY-H1, JS-M6 and so on) refer to that file. **No code has been changed yet.**

**Ground rules**
- Edit `utils/*.module.js`, never the generated `utils/*.js`.
- Run `python3 verify_changes.py` after every phase.
- Every fix ships with a regression test (see the updated `testing-and-test-authoring` skill).
- Items marked *verify* in the review are confirmed before any change is made.

Effort: S ≤ 1h, M ≈ half a day, L ≈ 1–2 days.

---

## Phase 0: Verify and baseline (S)

- **Why:** The reviewers read the code but never ran it. Don't fix imaginary bugs.
- **How:**
  - Run `python3 verify_changes.py` for a green baseline.
  - Reproduce each High finding with a small script (PY-H1, H2, H3, H5, JS-H3).
  - Confirm the *verify* items: JS-M7 (does `isSafeUrl` have a call site?), JS-L3 (dead `reinjectContentScripts`), JS-L7 (`innerHTML` audit of `settings.js`, `MpvController.js`, `AniListUI.js`).
  - Add `native_host_crash.log` to `.gitignore` and to the release excludes.

## Phase 1: Safety and quick wins (S–M each)

| ID | Fix | Why |
|----|-----|-----|
| PY-H1 | In CLI mode, inject a text/no-op sender instead of the framed `send_message`. | Binary garbage on the terminal, and replies nothing handles. |
| PY-H2 | Add an about 900 KB guard in `send_message` and page or reference large replies (restore, enrichment, AniList). Return a failure with the same `request_id`. | Chrome kills the host over 1 MiB, and the error is currently swallowed. |
| PY-H3 + PY-M10 | Verify PID identity (IPC `pid`, `/proc/<pid>/cmdline`, stored start time) before trusting or killing. Reset state on restore failure, and keep `session.json` on transient errors. | Reused PIDs can get an unrelated process killed. |
| PY-H5 | Make `proxy`, `ffmpeg-location`, `js-runtimes`, `remote-components`, `alias`, `update`, `print` and `no-check-certificate` settings-only. Strip them from item payloads. | The extension payload can currently redirect traffic or run arbitrary executables. |
| PY-M9 | Remove `()` from `FORBIDDEN_PATH_CHARS`. | Windows `Program Files (x86)` mpv paths are silently dropped. |
| JS-H3 | Remove `chrome.runtime.reload()`, or rate-limit it (once per N minutes, active tab only). | A global side effect that kills the native port and all state. |
| JS-L6 | Dispatch with `Object.hasOwn` or a `Map`. | `"constructor"` and `"__proto__"` hit `Object.prototype`. |
| JS-M7 | Make the `isValidUrl` catch-fallback return `false`. Validate `urlItems` and `urls` arrays. Add a scheme check in context-menu add. | Batch paths bypass validation. |
| PY-L4/L5 | Validate the extension ID with `^[a-p]{32}$`. Quote wrapper paths with `shlex.quote`. | Silent breakage and path injection in generated scripts. |

## Phase 2: Security hardening (M)

| ID | Fix | Why |
|----|-----|-----|
| PY-H4 | Require a token (fail closed). Use `ThreadingHTTPServer` with timeouts. Validate `Host`. Use `127.0.0.1` everywhere. Default to port 0. | Stalled clients block mpv, and there is DNS-rebinding exposure. |
| PY-M1 | Treat only refused or not-found as stale. Scope cleanup to the app's own IPC dir. | A busy mpv's live socket can be unlinked. |
| PY-M2 | Use per-session `mkdtemp` cookie dirs with ownership checks. | A second host deletes cookies a running mpv uses. |
| PY-M3 | Use the private flag dir, `O_NOFOLLOW`, and a capped read. | Another local user can spoof completion. |
| PY-L11 | Open the session file with 0600 at creation and write atomically. | The token is briefly world-readable. |
| JS-M9 | Fix or drop the gecko manifest block. Tighten `web_accessible_resources`. | Firefox doesn't support an MV3 service worker, and pages can fingerprint the extension. |
| JS-L8 | Replace Lua `os.execute` with `mp.command_native` subprocess args. | Quoting gaps. |
| JS-M8 | Cap `log_browser_error` message and stack sizes. | Log spam from a compromised script. |

## Phase 3: Reliability and data integrity (L)

- **PY-M7 and PY-M5, `FileLock` and read-modify-write**
  - Move to `fcntl.flock` / `msvcrt.locking`, and add an `update_shard(folder_id, fn)` helper.
  - **Why:** lost updates, and two processes holding the "same" lock.
- **PY-M8, `get_settings`**
  - Don't write on read, distinguish missing from corrupt, and cache by mtime.
  - **Why:** a transient read failure can wipe the user's config.
- **PY-M6 and PY-M14, tracker**
  - Merge the snapshot back on a failed commit, and guard shared sets with `self.lock`.
  - **Why:** lost watch progress, and `RuntimeError` from concurrent iteration.
- **PY-M4, session races**
  - Add a session generation token, and capture `manual_quit` at waiter start.
  - **Why:** the wrong exit reason, a double `mpv_exited`, and a stale waiter clearing a new session.
- **PY-M11 and PY-M12, IPC**
  - Re-send index metadata after moves, batch with `expect_response=False`, and add a Windows read timeout.
  - **Why:** wrong per-item options after prepend, and long lock holds.
- **PY-L1 and PY-L2, destructive pruning and backups**
  - Move pruned shards to a `trash/` dir, refuse empty payloads, and validate before backing up.
  - **Why:** one bad sync can currently wipe the library.
- **JS-H1, JS-M3, service-worker state**
  - Persist Auto-Add, scanner and queue state in `chrome.storage.session`. Use alarms, create them only on install/startup, and throttle the metadata sync.
  - **Why:** the worker is killed at about 30s idle, and Auto-Add silently turns off.
- **JS-H2, injection**
  - Use the declarative content scripts as primary, with programmatic injection as recovery only. Make log lines `debug`.
  - **Why:** double init, and live UI torn down mid-load.
- **JS-M6, native calls**
  - Add request and connect timeouts, wrap each listener in try/catch, and drop the closure state.
  - **Why:** the popup hangs forever on a stuck host.
- **JS-M2, JS-M4, JS-M5**
  - Make the sync debounce real, parse pathnames in the scanner and log after the duplicate check, and refresh state on tab activation.
  - **Why:** wasted full syncs, log floods, and stale UI in background tabs.

## Phase 4: Structural refactors (L, incremental)

- Split `native_host.py`: an importable module with handlers outside `main()` (PY-L9).
- Split `MpvSessionManager` into state, IPC and policy.
- Split `MpvController.js`, `popup.js` and `settings.js` one concern at a time (JS-H4). Add teardown tests for the timers.
- Break the `utils` → `background` import cycle through setters (JS-M1).
- Consolidate the duplicated rendering in `PlaylistRenderer` and `PlaylistUI`.
- Centralize constants (retry counts, delays, alarm periods) and `PYTHONDONTWRITEBYTECODE`.
- Document the generated vs. hand-written `utils/*.js` split.
- **Why:** these files are the main regression risk. Refactor only behind the Phase 3 tests.

## Phase 5: Tests and tooling (M, started alongside every phase)

1. Subprocess framing and oversize test.
2. Mocked-`chrome` Node harness (service-worker restart, `nativeConnection`, scanner, `createHandler`).
3. Multi-process `FileLock` and atomic-write tests.
4. Fake mpv IPC server (backlog, PID reuse, prepend, reorder, restore).
5. Playlist server tests (token, Host, concurrency).
6. Installer manifest tests.
7. Make `ruff` a hard dependency.
8. Extend the AST gate to JS comment-only `catch` and to `except Exception: pass` with no log.
9. Add a docs-vs-code drift test.
10. Exclude `*.log` from `create_release.py`.

## Low-priority cleanup (batch at the end)

JS-L1 to L5, L9, L10; PY-L3, L6, L7, L8, L10, L12, L13; the AniList fixes (offset wipe, `sys.argv` coupling, DST).

---

## Skill-file improvements (already applied)

These make it less likely that agents reintroduce the same issues. Each is an appended "Audit Guardrails" section. I only added text, and I did not rewrite existing sections.

| Skill | What was added |
|-------|----------------|
| [security-and-diagnostics](file:///home/shinku/Documents/mpv-playlist-organizer/.gemini/skills/security-and-diagnostics/SKILL.md) | A warning about doc/code drift (the yt-dlp flags and the 5 MB vs. 1 MiB limit). Rules for settings-only dangerous flags, fail-closed checks, the local HTTP server, temp paths, PID verification, path blacklists, and batch-field URL validation. |
| [content-script-lifecycle-and-resilience](file:///home/shinku/Documents/mpv-playlist-organizer/.gemini/skills/content-script-lifecycle-and-resilience/SKILL.md) | A warning that "Hail Mary" is a hazard to remove, not a pattern to copy. Rules for a single injection mechanism, cool-downs, a `destroy()` for every timer, `Object.hasOwn` dispatch, and `innerHTML` with untrusted data. |
| [bridge-and-protocol](file:///home/shinku/Documents/mpv-playlist-organizer/.gemini/skills/bridge-and-protocol/SKILL.md) | MV3 service-worker rules, native-call timeout and listener rules, the 900 KB outbound limit, the CLI-sender rule, and tab-activation refresh. |
| [storage-and-state-sync](file:///home/shinku/Documents/mpv-playlist-organizer/.gemini/skills/storage-and-state-sync/SKILL.md) | Locked read-modify-write, OS locks, no overwrite on read failure, prune guards, restorable snapshots, a single lock for shared state, and session generation tokens. |
| [mpv-playback-and-ipc](file:///home/shinku/Documents/mpv-playlist-organizer/.gemini/skills/mpv-playback-and-ipc/SKILL.md) | Stale-socket rules, PID identity before kill, restore resets, no slow IPC under `sync_lock`, index mapping, and per-session cookie dirs. |
| [testing-and-test-authoring](file:///home/shinku/Documents/mpv-playlist-organizer/.gemini/skills/testing-and-test-authoring/SKILL.md) | A regression-test-per-fix requirement, a risk→test-style table, linter and AST gate hardening, and a docs-vs-code drift test. |
| [native-host-installer-and-cli](file:///home/shinku/Documents/mpv-playlist-organizer/.gemini/skills/native-host-installer-and-cli/SKILL.md) | A warning that the CLI "Framing Bypass" claim is wrong. Extension ID validation, path quoting, no import side effects, and a read-only data-dir fallback. |
| [lead-architect](file:///home/shinku/Documents/mpv-playlist-organizer/.gemini/skills/lead-architect/SKILL.md) | A failure-class review checklist, "no test no merge", skills updated in the same change, a large-file extraction rule, and verifying reviewer findings before acting. |

> [!NOTE]
> The security and content-script skills describe some known-bad behavior (the permissive yt-dlp allowlist, "Hail Mary"). The new warnings flag these. After the code is fixed, rewrite those sections and remove the warnings.

## Suggested order and decision points

1. Phase 0, then Phase 1 (about 1–2 days). This is the biggest safety gain for the least risk.
2. Phase 2, then Phase 3 in this order: storage/lock, then session races, then service-worker state.
3. Phase 4 refactors only after the Phase 3 tests exist.

**Decisions for you**
- **JS-H3:** remove the extension auto-reload outright (recommended), or keep it rate-limited?
- **Firefox:** do you want Firefox support, or should I drop the gecko manifest block?
- **PY-H4:** is a random port for the playlist server acceptable, or does something rely on a fixed one?
