# MPV Playlist Organizer - Agent Rules & Router

## Non-Negotiable Invariants
1. **Golden Build Rule**: For transpiled modules, always edit `utils/*.module.js` and never edit their generated `utils/*.js` outputs directly (`SystemLogger.js`, `anilist_renderer.js`, `commUtils.js`, `security.js`, `nativeConnection.js`, `MpvInterface.js`, `domUtils.js`). All other `utils/*.js` files are hand-written sources and are safe to edit directly. Only run `python3 verify_changes.py` when code, tests, or build/extension configs actually change—never for docs-only, `.gitignore`, git-only, or read-only tasks.
2. **Shadow DOM Styles**: Inject CSS via `<style>` textContent (fetched via `chrome.runtime.getURL`). Never use `<link rel="stylesheet">` (fails in Chrome extensions). Never overwrite `shadowRoot.innerHTML` after style injection.
3. **Bridge Protocol & Casing**: Action names MUST be `snake_case`. Native messaging auto-converts payload keys (`camelCase` in JS ↔ `snake_case` in Python). Always preserve `request_id`.

## Modular Skills Index
Before undertaking work in specific architectural domains, read the corresponding skill:
- **Lead Architect & Orchestrator**: [.gemini/skills/lead-architect/SKILL.md](.gemini/skills/lead-architect/SKILL.md)
- **JS Build & Verification**: [.gemini/skills/js-build-and-verification/SKILL.md](.gemini/skills/js-build-and-verification/SKILL.md)
- **Linting & Static Analysis**: [.gemini/skills/linting-and-static-analysis/SKILL.md](.gemini/skills/linting-and-static-analysis/SKILL.md)
- **Native Bridge & Protocol**: [.gemini/skills/bridge-and-protocol/SKILL.md](.gemini/skills/bridge-and-protocol/SKILL.md)
- **UI, Shadow DOM & Settings**: [.gemini/skills/ui-shadow-dom-and-settings/SKILL.md](.gemini/skills/ui-shadow-dom-and-settings/SKILL.md)
- **Storage & State Sync**: [.gemini/skills/storage-and-state-sync/SKILL.md](.gemini/skills/storage-and-state-sync/SKILL.md)
- **MPV Playback & IPC**: [.gemini/skills/mpv-playback-and-ipc/SKILL.md](.gemini/skills/mpv-playback-and-ipc/SKILL.md)
- **Playback Tracking & Fallback Sync**: [.gemini/skills/playback-tracking-and-fallback-sync/SKILL.md](.gemini/skills/playback-tracking-and-fallback-sync/SKILL.md)
- **Security & Diagnostics**: [.gemini/skills/security-and-diagnostics/SKILL.md](.gemini/skills/security-and-diagnostics/SKILL.md)
- **Site Compatibility & Scraping**: [.gemini/skills/site-compatibility-and-scraping/SKILL.md](.gemini/skills/site-compatibility-and-scraping/SKILL.md)
- **Playlist Operations & Reordering**: [.gemini/skills/playlist-operations-and-reordering/SKILL.md](.gemini/skills/playlist-operations-and-reordering/SKILL.md)
- **Content Script Lifecycle**: [.gemini/skills/content-script-lifecycle-and-resilience/SKILL.md](.gemini/skills/content-script-lifecycle-and-resilience/SKILL.md)
- **Native Host Installer & CLI**: [.gemini/skills/native-host-installer-and-cli/SKILL.md](.gemini/skills/native-host-installer-and-cli/SKILL.md)
- **AniList Integration**: [.gemini/skills/anilist-integration/SKILL.md](.gemini/skills/anilist-integration/SKILL.md)
- **Testing & Test Authoring**: [.gemini/skills/testing-and-test-authoring/SKILL.md](.gemini/skills/testing-and-test-authoring/SKILL.md)
- **YouTube Tools Sub-Extension**: [.gemini/skills/youtube-tools-subextension/SKILL.md](.gemini/skills/youtube-tools-subextension/SKILL.md)
- **Skills Maintenance**: [.gemini/skills/skills-maintenance/SKILL.md](.gemini/skills/skills-maintenance/SKILL.md)
- **Skill & Tool Evolution**: [.gemini/skills/skill-and-tool-evolution/SKILL.md](.gemini/skills/skill-and-tool-evolution/SKILL.md) — Audits/evolves skills & `mcp_server/`; during any task, silently stage non-trivial friction proposals to `.gemini/proposals/` and append only a 1-line note.

## Local MCP Tools (`mpv-playlist-organizer`)
Prefer these MCP tools over raw shell commands, multi-file greps, or reading full log/`models.py` files directly:
- Use `check_repo_drift` before edits/commits to detect `utils/*.module.js`, `bridge_contract.js`, or `yt-tools-standalone/` drift and stray `__pycache__`.
- Use `verify_repo(mode="build"|"lint"|"targeted"|"test"|"full")` for structured build, linter, and test diagnostics.
- Use `tail_logs`, `inspect_runtime_state`, `check_native_host_registration`, and `probe_mpv_ipc` for read-only runtime, socket, and manifest inspection.
- Use `validate_bridge_payload` to verify `snake_case` actions, `request_id` preservation, and `models.py` schemas without reading full files.
- Use `trace_action(action_name)` to locate an action across `popup/`, `background/`, `utils/native_link/`, `utils/handlers/`, and `mpv_scripts/` in one call.
- Use `simulate_native_message` and `test_mpv_pipeline(mode="dry_run"|"headless")` for isolated native-host framing tests, mpv argv/M3U dry-runs, and headless Lua/IPC checks without touching real `DATA_DIR`.
- Never run `python3` directly without `PYTHONDONTWRITEBYTECODE=1` (or `python3 -B`), and use MCP tools directly instead of importing `mcp_server/tools_impl.py`.
