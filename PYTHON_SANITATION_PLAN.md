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
**Status:** ✅ COMPLETED
*   Decomposed into `mpv_command_builder.py`, `anilist_service.py`, and `dependency_manager.py`.
*   `services.py` now acts as a clean entry point with minimal delegation logic.

---

## 5. Method Complexity & Deep Nesting
**Status:** ✅ COMPLETED
*   `LauncherService.launch` decomposed into `_prepare_launch_env`, `_spawn_process`, and `_sync_initial_state`.
*   `EnrichmentService.resolve_input_items` refactored to reduce nesting levels.

---

## 6. Architectural Constraints: Late Imports (`E402`)
**Status:** ✅ COMPLETED
*   Added global header comments to `native_host.py` and `services.py` explaining the performance rationale for late imports.
