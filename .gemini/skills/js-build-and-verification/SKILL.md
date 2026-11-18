---
name: js-build-and-verification
description: >-
  Enforces the JavaScript build and verification pipeline for the MPV Playlist Organizer extension.
  Load this skill whenever creating or editing JavaScript files (especially `utils/*.module.js` and
  `background/`), updating transpile mappings in `testing_tools/generate_js.py`, running verification
  via `verify_changes.py`, managing `pycache_watchdog.py`, or reviewing code comments and documentation standards.
---

# JavaScript Build, Verification & Documentation Standards

This skill documents the build system, verification workflows, bytecode management, and code documentation rules for the MPV Playlist Organizer extension.

---

## 1. The Golden Build Rule

Chrome Content Scripts cannot natively use ES Module `import` statements across local extension resources without complex bundling. The codebase solves this cleanly using a transpiler that converts modern ES modules into namespaced globals.

> [!IMPORTANT]
> **Source of Truth:** Always edit `utils/*.module.js` source files.
> **NEVER** edit generated `utils/*.js` files directly. Any direct modifications to `utils/*.js` will be overwritten and lost during the next build or verification run.

### Module Namespace Mapping

`testing_tools/generate_js.py` maintains the transpilation configuration:

| Source Module | Generated Target | Global Namespace | Transpiled Window Export |
| :--- | :--- | :--- | :--- |
| `utils/SystemLogger.module.js` | `utils/SystemLogger.js` | `MPV_INTERNAL` | `window.MPV_INTERNAL.logger`, `window.MPV_INTERNAL.LogLevel` |
| `utils/anilist_renderer.module.js` | `utils/anilist_renderer.js` | `MPV_INTERNAL` | `window.MPV_INTERNAL.AniListRenderer` |
| `utils/commUtils.module.js` | `utils/commUtils.js` | `MPV_INTERNAL` | `window.MPV_INTERNAL` |
| `utils/security.module.js` | `utils/security.js` | `MPV_SECURITY` | `window.MPV_SECURITY` |
| `utils/nativeConnection.module.js` | `utils/nativeConnection.js` | `MPV_INTERNAL` | `window.MPV_INTERNAL` |
| `utils/MpvInterface.module.js` | `utils/MpvInterface.js` | `MPV_INTERNAL` | `window.MPV_INTERNAL.MpvInterface` |
| `utils/domUtils.module.js` | `utils/domUtils.js` | `MPV_INTERNAL` | `window.MPV_INTERNAL.domUtils` |

### Generated vs. Hand-Written `utils/*.js`

Only the **7 files** listed in the table above are generated from `utils/*.module.js` (and marked with `// AUTO-GENERATED from <Module>.module.js. DO NOT EDIT MANUALLY.`).

All other `utils/*.js` files are **hand-written sources** and are safe to edit directly:
- **Classic content-script / UI helpers (`window.MPV_INTERNAL`):** `AniListUI.js`, `ContentState.js`, `ControllerActions.js`, `ControllerTimers.js`, `ControllerView.js`, `Draggable.js`, `MessageBridge.js`, `MpvController.js`, `NavigationObserver.js`, `PageScraper.js`, `PlaybackStateManager.js`, `PlaylistRenderer.js`, `PlaylistUI.js`, `Resizable.js`, `UIManager.js`, `janitor.js`.
- **ES modules (background / popup):** `contextMenu.js`, `item_processor.js`, `nativeLink.js`, `playlistManager.js`, `settings.js`, `storageManager.js`.

### Transpilation Mechanism

When transpiling, `generate_js.py`:
1. Strips ES module `import { ... } from "..."` and maps imported symbols to their global namespace aliases (e.g., `const normalizeKeys = window.MPV_INTERNAL.normalizeKeys;`).
2. Converts exports (`export class Foo`, `export function bar`, `export const BAZ`) to namespace assignments: `const Foo = MPV.Foo = class Foo ...`.
3. Wraps the generated output in an IIFE:
   ```javascript
   // AUTO-GENERATED from <Module>.module.js. DO NOT EDIT MANUALLY.
   window.<NAMESPACE> = window.<NAMESPACE> || {};
   (() => {
       const MPV = window.<NAMESPACE>;
       // Module body...
   })();
   ```
4. If adding a new `*.module.js` or updating dependencies between modules, register the mapping in `CONFIG` inside `testing_tools/generate_js.py`.

---

## 2. Verification Workflow

Run the unified verification script from the repository root:

```bash
python3 verify_changes.py
```

### When to Run vs. When NOT to Run

- **DO run `verify_changes.py`:**
  - After making meaningful code changes to Python backend files (`native_host.py`, `file_io.py`, `services.py`, `utils/handlers/`, etc.).
  - After modifying `utils/*.module.js` or `background/` JavaScript files.
  - Before concluding a coding task to guarantee no test regressions or syntax breaks.
- **DO NOT run `verify_changes.py`:**
  - For non-code tasks such as deleting obsolete files, logs, or updating `.gitignore`.
  - For markdown documentation edits, skill authoring, or git-only operations (staging, committing, pushing).
  - For simple read-only inspections and code exploration.
  - When a verification run already passed and no code, test, or build/extension config changed since.
- **Build-Only Shortcut:**
  - If you only modified a `*.module.js` file and want to transpile without running the entire test suite, run:
    ```bash
    python3 testing_tools/generate_js.py
    ```

### Verification Execution Stages

`verify_changes.py` runs:
1. **Pycache Watchdog Check:** Verifies or starts `testing_tools/pycache_watchdog.py`.
2. **JS Build:** Rebuilds all `utils/*.js` targets from `utils/*.module.js`.
3. **Concurrent Test & Static Suite (`testing_tools/run_suite.py`):**
   - **Parallel Python Pool (`PYTHON_TEST_FILES`):** Runs all 9 Python test modules (`test_logging_system.py`, `test_robustness.py`, `test_repro_crash.py`, `test_native_host_boot.py`, `test_security_claims.py`, `test_storage_locking.py`, `test_playback_ipc_concurrency.py`, `test_server_and_installer.py`, `test_logging_pipeline.py`) in parallel via `ThreadPoolExecutor`.
   - **Concurrent `run_js_batch()`:**
     - Synchronizes bridge contract via `testing_tools/generate_bridge_contract.py`.
     - Auto-discovers and runs all `testing_tools/scripts/test_*.js` scripts (`test_bridge_js.js`, `test_bridge_protocol.js`, `test_logger_logic.js`, `test_modular_components.js`, `test_resilience_fixes.js`, `test_ui_sync.js`, `test_yt_tools.js`, `test_yt_tools_standalone.js`).
     - Runs `node --check` syntax validation and the JS empty/comment-only `catch {}` regex gate across all `.js` files.
     - Runs Python AST static checks enforcing syntax, forbidding bare `except:` clauses, and forbidding silent `except ...: pass` (`_is_silent_pass`).
     - Runs `ruff` (`testing_tools/pyproject.toml`), `biome` (`testing_tools/biome.json`), `luac -p` (`mpv_scripts/*.lua`), `luacheck` (`testing_tools/.luacheckrc`), `shellcheck` (`*.sh`), and `pyright` (`testing_tools/pyrightconfig.json`) when installed.
   - Note: `testing_tools/create_release.py` packages release builds; `run_suite.py` excludes `yt-tools-legacy`, `yt-tools-standalone`, and `mpv-playlist-organizer-release` during static scans.

---

## 3. Pycache Watchdog Daemon

To keep the repository clean of compiled bytecode artifacts (`__pycache__` directories and `*.pyc` files), a persistent daemon monitors the workspace:

```bash
python3 testing_tools/pycache_watchdog.py        # Starts daemon if not running, or reports active PID
python3 testing_tools/pycache_watchdog.py status # Check running status
python3 testing_tools/pycache_watchdog.py clean  # One-shot immediate sweep
python3 testing_tools/pycache_watchdog.py kill   # Terminate daemon
```

### Daemon Guidelines

- Runs persistently in the background until system reboot or manual termination.
- Uses `inotify` via `watchdog.observers.Observer` if available, falling back to non-blocking polling.
- Both `verify_changes.py` and `testing_tools/run_suite.py` enforce `sys.dont_write_bytecode = True` and set `PYTHONDONTWRITEBYTECODE=1` in their environments.

---

## 4. Documentation & Comment Standards

**Core Principle:** Code explains the *Action*; comments explain the *Intent*. Prioritize self-documenting code over narration.

### Permitted Comment Types

1. **Functional Logic-Guards:**
   - **Role:** Signals intentional logic boundaries to prevent accidental "optimizations" or regressions.
   - **Mandatory for:** Index checks, safety rails, boundary conditions, and race condition mitigations.
   - **Example:**
     ```python
     if index < len(queue) - 1: # Guard: Prevents premature EOF termination before playlist queue finishes
     ```
2. **Architectural Context:**
   - **Role:** Explains non-obvious workarounds for cross-platform differences, browser sandbox limits, or IPC race conditions.
   - **Usage:** Use when the "Why" cannot be inferred from the syntax alone.
   - **Example:**
     ```javascript
     // Workaround: Inject styles as textContent in <style> to prevent cross-origin stylesheet block on YouTube.
     ```

### Prohibited Comment Types

- **Redundant "What" Narration:** Do not write comments that describe literal, self-explanatory operations (e.g., `# Loop through items`, `# Increment counter`, `# Return success response`).
- **Subjective Style Rewrites:** Do not rewrite or restyle existing comments simply for phrasing preferences. If an existing comment lacks technical value, omit or remove it entirely.

---

## 5. Developer Troubleshooting & Reloading Matrix

### Component Reloading Matrix

| Component | How to Reload | Notes |
| :--- | :--- | :--- |
| **Extension UI / Popup** | Close and reopen the popup | Popup reloads on every open. |
| **Content Scripts** | Refresh the web page (`F5`) | Content scripts reload on page navigation. |
| **Service Worker (`background.js`)** | Go to `chrome://extensions` and click 🔄 **Reload** | Needed when modifying `background/`, `manifest.json`, or root scripts. |
| **Python Native Host** | **Restart the browser** or terminate the `python3 native_host.py` process | Chrome holds the native host process open for the duration of the browser session. |
| **MPV Scripts** | Restart MPV or re-trigger playback | Active MPV processes hold loaded Lua scripts in memory. |

### Common Troubleshooting Checklist

- **Service worker registration failed (Status code: 15):** Top-level JavaScript syntax error or unresolved import in `background.js` or one of its imported handlers. Run `node --check background/handlers/<file>.js` or `python3 testing_tools/run_suite.py` to pinpoint the offending file and line number.
- **Transpile Mismatch / Missing Globals:** If a newly exported function in a `*.module.js` file is `undefined` at runtime, verify that:
  1. The module is registered in `testing_tools/generate_js.py`.
  2. `python3 testing_tools/generate_js.py` has been executed.
  3. The consumer script reads from the correct namespace (`window.MPV_INTERNAL` vs `window.MPV_SECURITY`).
