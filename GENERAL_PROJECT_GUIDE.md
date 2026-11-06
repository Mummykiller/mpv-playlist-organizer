# MPV Playlist Organizer: Architecture & Skills Guide

> [!NOTE]
> The monolithic project documentation has been fully modularized into domain-specific skills compliant with the agent skills architecture.
> 
> **For AI Agents:** Always refer to [`GEMINI.md`](./GEMINI.md) as the primary instruction router and enforce non-negotiable system invariants.

---

## Modular Skills Directory

All domain-specific architecture, protocols, and workflows are located in [`.gemini/skills/`](./.gemini/skills/):

- **Master Orchestrator:**
  - [`lead-architect`](./.gemini/skills/lead-architect/SKILL.md) — Multi-agent supervision, hybrid autonomy, and user communication.

- **Frontend & Browser Extension:**
  - [`ui-shadow-dom-and-settings`](./.gemini/skills/ui-shadow-dom-and-settings/SKILL.md) — Isolated DOM styles, CSS injection, and popup/overlay controls.
  - [`content-script-lifecycle-and-resilience`](./.gemini/skills/content-script-lifecycle-and-resilience/SKILL.md) — Injection gates, SPA navigation, and context-invalidation defense.
  - [`js-build-and-verification`](./.gemini/skills/js-build-and-verification/SKILL.md) — Golden Build rule, transpiler mappings, and verification pipeline.

- **Backend & Native Communication:**
  - [`bridge-and-protocol`](./.gemini/skills/bridge-and-protocol/SKILL.md) — Native messaging, case translation, and schema validation.
  - [`storage-and-state-sync`](./.gemini/skills/storage-and-state-sync/SKILL.md) — Atomic file I/O, cross-process locking, and playlist sharding.
  - [`security-and-diagnostics`](./.gemini/skills/security-and-diagnostics/SKILL.md) — Subprocess scrubbing, input validation, and diagnostic logging.

- **Playback & Integration:**
  - [`mpv-playback-and-ipc`](./.gemini/skills/mpv-playback-and-ipc/SKILL.md) — Process orchestration, IPC sockets, and Lua scripting.
  - [`playback-tracking-and-fallback-sync`](./.gemini/skills/playback-tracking-and-fallback-sync/SKILL.md) — Watch-time tracking, fallback timers, and history.
  - [`playlist-operations-and-reordering`](./.gemini/skills/playlist-operations-and-reordering/SKILL.md) — Queue mutations, reordering, and deduplication.
  - [`site-compatibility-and-scraping`](./.gemini/skills/site-compatibility-and-scraping/SKILL.md) — Cookie extraction, URL analyzers, and site adaptors.
  - [`anilist-integration`](./.gemini/skills/anilist-integration/SKILL.md) — GraphQL client, cache sharding, and release schedule browser.

- **Testing & Tooling:**
  - [`testing-and-test-authoring`](./.gemini/skills/testing-and-test-authoring/SKILL.md) — Multi-batch test runner, mock environments, and AST gates.
  - [`native-host-installer-and-cli`](./.gemini/skills/native-host-installer-and-cli/SKILL.md) — Cross-platform host registration and troubleshooting CLI.
