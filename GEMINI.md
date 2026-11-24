# MPV Playlist Organizer - Agent Rules & Router

## Non-Negotiable Invariants
1. **Golden Build Rule**: For transpiled modules, always edit `utils/*.module.js` and never edit their generated `utils/*.js` outputs directly (`SystemLogger.js`, `anilist_renderer.js`, `commUtils.js`, `security.js`, `nativeConnection.js`, `MpvInterface.js`, `domUtils.js`). All other `utils/*.js` files are hand-written sources and are safe to edit directly. Only run `verify_changes.py` when code, tests, or build/extension configs actually change—never for docs-only, `.gitignore`, git-only, or read-only tasks.
2. **Shadow DOM Styles**: Inject CSS via `<style>` textContent (fetched via `chrome.runtime.getURL`). Never use `<link rel="stylesheet">` (fails in Chrome extensions). Never overwrite `shadowRoot.innerHTML` after style injection.
3. **Bridge Protocol & Casing**: Action names MUST be `snake_case`. Native messaging auto-converts payload keys (`camelCase` in JS ↔ `snake_case` in Python). Always preserve `request_id`.

## Modular Skills Index
Before undertaking work in specific architectural domains, read the corresponding skill:
- **Dev Workflow, Linting & Testing**: [.gemini/skills/dev-workflow-and-testing/SKILL.md](.gemini/skills/dev-workflow-and-testing/SKILL.md)
- **Native Bridge & Protocol**: [.gemini/skills/bridge-and-protocol/SKILL.md](.gemini/skills/bridge-and-protocol/SKILL.md)
- **Extension UI & Content Scripts**: [.gemini/skills/extension-ui-and-content-scripts/SKILL.md](.gemini/skills/extension-ui-and-content-scripts/SKILL.md)
- **Storage & State Sync**: [.gemini/skills/storage-and-state-sync/SKILL.md](.gemini/skills/storage-and-state-sync/SKILL.md)
- **MPV Playback & Tracking**: [.gemini/skills/mpv-playback-and-tracking/SKILL.md](.gemini/skills/mpv-playback-and-tracking/SKILL.md)
- **Security & Diagnostics**: [.gemini/skills/security-and-diagnostics/SKILL.md](.gemini/skills/security-and-diagnostics/SKILL.md)
- **Site Compatibility & Scraping**: [.gemini/skills/site-compatibility-and-scraping/SKILL.md](.gemini/skills/site-compatibility-and-scraping/SKILL.md)
- **Playlist Operations & Reordering**: [.gemini/skills/playlist-operations-and-reordering/SKILL.md](.gemini/skills/playlist-operations-and-reordering/SKILL.md)
- **YouTube Tools Sub-Extension**: [.gemini/skills/youtube-tools-subextension/SKILL.md](.gemini/skills/youtube-tools-subextension/SKILL.md)

## Audit-Driven Review Checklist
Before finishing code changes, verify against these recurring failure classes:

| Failure class | Question to ask |
| :--- | :--- |
| Service-worker amnesia | Does this keep state in a JS variable or `setTimeout` that must survive 30s idle? |
| Unbounded waits | Does every native/IPC/lock call have a timeout, and does the timeout clean up its map entry? |
| Message size | Can any host→browser reply exceed ~900 KB? |
| Fail-open security | Is any check skipped when a token/hostname/PID/env var is missing? |
| Untrusted payload reach | Can item/browser-supplied options reach flags, paths, or executables? |
| Unlocked read-modify-write | Is a get followed by a save without one lock scope? |
| Stale thread/session | Can an old waiter or watcher mutate a newer session? |
| Global side effects from self-heal | Does a retry loop escalate to reload, kill, or delete? |
| Docs drift | Did the change make a `SKILL.md` claim false? Update the skill in the same change. |

Additional quality rules:
- **Fixes ship with a regression test** in `testing_tools/scripts/`.
- **Large-file rule:** Do not add features to `MpvController.js`, `popup.js`, `settings.js`, `playlist_tracker.py`, `background/handlers/playback.js`, or `MpvSessionManager` without first extracting the touched concern into its own module.
- **Do not skip linter warnings/errors** from the gate; confirm review claims against live code before fixing.

## Skill & Docs Maintenance
- Cite exact repo-relative `file:symbol` paths—never line numbers—and avoid hardcoded total counts of skills, files, or tests.
- Update the matching `SKILL.md` in the same task whenever an invariant, limit, or allowlist changes; keep each `SKILL.md` concise (~60–150 lines) and push dense tables to `references/`.
- Never run `verify_changes.py` for docs-only or `.gemini/skills/`-only edits.

## Local MCP Tools (`mpv-playlist-organizer`)
Prefer these MCP tools over raw shell commands or reading full log files directly:
- Use `check_repo_drift` before edits/commits to detect `utils/*.module.js`, `bridge_contract.js`, or `yt-tools-standalone/` drift and stray `__pycache__`.
- Use `verify_repo(mode="build"|"lint"|"targeted"|"test"|"fix"|"full")` for structured build, linter, auto-fix (`build` + `bridge_contract` + `ruff --fix` + verify), and test diagnostics.
- Use `inspect_runtime(target="logs"|"state"|"registration"|"ipc", ...)` for read-only log tailing, `DATA_DIR` snapshots, native-host manifest checks, and MPV Unix IPC inspection.
- Use `simulate_native_message` and `test_mpv_pipeline(mode="dry_run"|"headless")` for isolated native-host framing tests, mpv argv/M3U dry-runs, and headless Lua/IPC checks without touching real `DATA_DIR`.
- Never run `python3` directly without `PYTHONDONTWRITEBYTECODE=1` (or `python3 -B`), and use MCP tools directly instead of importing `mcp_server/tools_impl.py`.
