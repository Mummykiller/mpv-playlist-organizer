# Python Refactoring & Sanitation Plan

This document outlines the architectural technical debt and refactoring priorities for the Python backend of the MPV Playlist Organizer. Issues are ordered from **Worst Case** (highest complexity/risk) to **Best Case** (minor optimizations).

---

## 1. Massive File Bloat: `installer.py` (~1,350 lines)
**Status:** ✅ COMPLETED
The installer is now decomposed into a tiny entry point, a logic engine in `installer_src/`, and a terminal interface.

---

## 2. The "God Object" Pattern: `HandlerManager` (~970 lines)
**Status:** High Risk / Maintenance Bottleneck
Located in `utils/native_host_handlers.py`, this class handles every single action from the Chrome Extension. As new features (AniList, M3U server, etc.) are added, this file becomes unreadable.

**Proposed Action:**
*   Decompose `HandlerManager` into specialized handler modules:
    *   `playback_handler.py`: `play`, `append`, `close_mpv`.
    *   `data_handler.py`: `export_data`, `import_from_file`, `sharding`.
    *   `services_handler.py`: `anilist`, `ytdlp_update`.
*   Use a lightweight `Router` in `native_host.py` to dispatch messages to the correct handler.

---

## 3. High Logic Duplication (DRY Violations)
**Status:** Medium Risk / Source of Subtle Bugs
Crucial logic is manually repeated in multiple locations, making the app fragile during updates.

*   **Lua Options Construction:** The `lua_options` dictionary (sent to MPV) is built in 4+ places (`mpv_session.py`, `session_services.py`).
*   **Settings Merging:** The logic to merge extension overrides into global settings is copy-pasted across `handle_play`, `handle_play_batch`, and `handle_play_m3u`.
*   **URL ID Injection:** Appending `#mpv_organizer_id=` to URLs is duplicated in `_generate_m3u_content` and `LauncherService.launch`.

**Proposed Action:**
*   Create a centralized `PayloadFactory` or move these into `services.py` as pure functions.

---

## 4. Module Bloat: `services.py` (~1,000 lines)
**Status:** Medium Risk / Low Navigability
This file has become a "junk drawer" for any logic that doesn't fit elsewhere (GPU detection, AniList caching, yt-dlp updates, command building).

**Proposed Action:**
*   Move `MpvCommandBuilder` to its own file.
*   Move AniList logic to `anilist_service.py`.
*   Move dependency checking (`check_mpv_and_ytdlp_status`) to `dependency_manager.py`.

---

## 5. Method Complexity & Deep Nesting
**Status:** Low Risk / Readability Issue
Specific methods are too long and handle too many low-level details.

*   **`LauncherService.launch`**: Spans over 150 lines. Handles environment scrubbing, process spawning, PID resolution, and initial IPC sync.
*   **`EnrichmentService.resolve_input_items`**: Heavily nested logic for distinguishing between local files, remote URLs, and raw M3U content.

**Proposed Action:**
*   Break these into private helper methods (e.g., `_prepare_env()`, `_wait_for_handshake()`).

---

## 6. Architectural Constraints: Late Imports (`E402`)
**Status:** Best Case / Documentation Need
`ruff` flags dozens of module-level imports that are not at the top of the file.

*   **Reason:** These are **intentional**. To meet the browser's Native Messaging timeout requirements, the "Native Host" must start in under 50ms. Moving heavy imports (like `tkinter`, `shlex`, or `concurrent.futures`) inside functions ensures the initial handshake is near-instant.

**Proposed Action:**
*   Keep as-is for performance, but add a global header comment explaining *why* we ignore PEP 8 in these specific cases.
