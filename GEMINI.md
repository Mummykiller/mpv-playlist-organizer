# MPV Playlist Organizer - Agent Rules & Router

## Non-Negotiable Invariants
1. **Golden Build Rule**: For the 7 transpiled modules, always edit `utils/*.module.js` and never edit their generated `utils/*.js` outputs directly (`SystemLogger.js`, `anilist_renderer.js`, `commUtils.js`, `security.js`, `nativeConnection.js`, `MpvInterface.js`, `domUtils.js`). All other `utils/*.js` files are hand-written sources and are safe to edit directly. Only run `python3 verify_changes.py` when code, tests, or build/extension configs actually change—never for docs-only, `.gitignore`, git-only, or read-only tasks.
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
