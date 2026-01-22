# Python Refactoring & Sanitation Plan

This document outlines the architectural technical debt and refactoring priorities for the Python backend of the MPV Playlist Organizer. Issues are ordered from **Worst Case** (highest complexity/risk) to **Best Case** (minor optimizations).

---

## 1. Massive File Bloat: `installer.py` (~1,350 lines)
**Status:** ✅ COMPLETED
The installer is now decomposed into a tiny entry point, a logic engine in `installer_src/`, and a terminal interface.

---

## 2. The "God Object" Pattern: `HandlerManager` (~970 lines)
**Status:** ✅ COMPLETED
Split into specialized modules in `utils/handlers/`:
*   `playback_handler.py`
*   `data_handler.py`
*   `settings_handler.py`
*   `base_handler.py` (Shared logic)

A dedicated `NativeLink` layer now handles all JS-Python translation and model validation.

---

## 3. High Logic Duplication (DRY Violations)
**Status:** ✅ COMPLETED
*   **Lua Options Construction:** Centralized into `services.construct_lua_options`.
*   **Settings Merging:** Automated via the `SettingsOverrides` model in `NativeLink`.
*   **Outbound Translation:** Automated in `native_host.py` via `responder._translate_keys`.

---

## 4. Module Bloat: `services.py` (~1,000 lines)
**Status:** Medium Risk / Next Priority
This file remains a "junk drawer."

**Proposed Action:**
*   Move `MpvCommandBuilder` to its own file.
*   Move AniList logic to `anilist_service.py`.
*   Move dependency checking (`check_mpv_and_ytdlp_status`) to `dependency_manager.py`.

---

## 5. Method Complexity & Deep Nesting
**Status:** Medium Risk / Source of Technical Debt
*   **`LauncherService.launch`**: Still spans over 150 lines. Needs decomposition into `_prepare_env`, `_spawn_process`, and `_sync_initial_state`.
*   **`EnrichmentService.resolve_input_items`**: Needs cleanup to reduce nesting levels.

**Proposed Action:**
*   Break these into private helper methods within `utils/session_services.py`.

---

## 6. Architectural Constraints: Late Imports (`E402`)
**Status:** Best Case / Documentation Need
`ruff` flags dozens of module-level imports that are not at the top of the file.

*   **Reason:** These are **intentional**. To meet the browser's Native Messaging timeout requirements, the "Native Host" must start in under 50ms. Moving heavy imports (like `tkinter`, `shlex`, or `concurrent.futures`) inside functions ensures the initial handshake is near-instant.

**Proposed Action:**
*   Keep as-is for performance, but add a global header comment explaining *why* we ignore PEP 8 in these specific cases.
