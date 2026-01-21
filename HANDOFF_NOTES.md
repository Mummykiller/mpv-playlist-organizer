# Agent Handoff Notes: Python Sanitation & NativeLink Refactor

## 🎯 Current Project Goal
Clean up the Python backend to make it more readable, modular, and isolated from the JavaScript frontend's data structures.

## ✅ Completed in Last Session
1.  **Installer Refactor**: `installer.py` is now a tiny entry point. 
    *   Logic and GUI are in `installer_src/`.
    *   Terminal interface is in `installer_cli.py` (can be run directly).
2.  **Linting Sweep**: Applied ~100+ fixes for PEP 8 compliance.
    *   Fixed critical **Undefined Name** errors in `mpv_session.py` and `native_host_handlers.py`.
    *   Expanded one-liners and replaced bare `except:` with `except Exception:`.
3.  **Documentation**: Created `PYTHON_SANITATION_PLAN.md` (high-level) and `NATIVE_LINK_REFACTOR.md` (specific to the bridge logic).

## 🛠️ Pending Tasks (High Priority)

### 1. Implement "NativeLink" (`NATIVE_LINK_REFACTOR.md`)
The app's logic currently "leaks" JS keys like `folderId` and `url_item` into deep Python functions. 
*   **Action**: Create `utils/native_link/` package.
*   **Goal**: Translate all incoming JSON into typed Python Dataclasses/Models before it reaches `HandlerManager`.

### 2. Decompose the God Object
`utils/native_host_handlers.py` contains a single class (`HandlerManager`) that is nearly 1,000 lines long.
*   **Action**: Split into `playback_handler.py`, `data_handler.py`, and `settings_handler.py`.

### 3. Centralize Lua Options
Logic to build the `lua_options` dictionary for MPV is duplicated in 4+ places. 
*   **Action**: Extract this into a single `PayloadFactory.construct_lua_options()` in `services.py` or a new module.

## ⚠️ Notes for the Next Agent
*   **Performance Constraint**: Do **NOT** move late imports (`E402`) to the top of files if they are in `native_host.py` or core services. The Native Host must handshake with the browser in < 50ms.
*   **Registry/FS Logic**: Most critical logic lives in `file_io.py`. Ensure any changes there are tested against the `FileLock` implementation to avoid deadlocks.
*   **Bridge Key-Matching**: Refer to `GENERAL_PROJECT_GUIDE.md` section 2 before changing any keys that cross the JS-Python bridge.
