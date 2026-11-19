---
name: js-build-and-verification
description: >-
  Enforces the JavaScript build and verification pipeline for the MPV Playlist Organizer extension.
  Load this skill whenever creating or editing JavaScript files (especially `utils/*.module.js` and
  `background/`), updating transpile mappings in `testing_tools/generate_js.py`, running verification
  via `verify_changes.py`, managing `pycache_watchdog.py`, or reviewing code comments and documentation standards.
---

# JavaScript Build, Verification & Documentation Standards

This skill governs the ES-module-to-content-script transpilation pipeline, the `verify_changes.py` verification gate, and code comment conventions.

> [!IMPORTANT]
> For the full `utils/*.module.js` transpilation table, hand-written vs. generated file inventory, `pycache_watchdog.py` CLI, and component reloading matrix, see [references/BUILD_AND_RELOAD_MATRIX.md](references/BUILD_AND_RELOAD_MATRIX.md).

---

## 1. The Golden Build Rule (`testing_tools/generate_js.py`)

Chrome Content Scripts cannot natively import ES Modules across extension scripts without bundling. `testing_tools/generate_js.py` transpiles shared `utils/*.module.js` sources into namespaced IIFE globals (`window.MPV_INTERNAL` and `window.MPV_SECURITY`).

- **Always edit `utils/*.module.js` source files** for transpiled modules (`SystemLogger`, `anilist_renderer`, `commUtils`, `security`, `nativeConnection`, `MpvInterface`, `domUtils`).
- **Never edit their generated `utils/*.js` outputs directly**—they are overwritten on every build and verification run.
- All other `utils/*.js` files are hand-written sources and are safe to edit directly (see [references/BUILD_AND_RELOAD_MATRIX.md](references/BUILD_AND_RELOAD_MATRIX.md)).
- For a fast transpile-only build without running the test suite:
  ```bash
  python3 testing_tools/generate_js.py
  ```

---

## 2. Verification Workflow (`verify_changes.py`)

Run the unified verification gate from the repository root:

```bash
python3 verify_changes.py
```

### When to Run vs. Skip
- **DO run `verify_changes.py`:** After modifying any Python backend code, JavaScript source (`utils/`, `background/`, `popup/`, `yt-tools/`), Lua/shell scripts, test scripts, or build/extension configs (`manifest.json`, `testing_tools/`).
- **DO NOT run `verify_changes.py`:** For docs-only edits (`README.md`, `GEMINI.md`, `.gemini/skills/`), `.gitignore` updates, git-only operations, or read-only exploration.

### Verification Pipeline Stages
1. **Pycache Watchdog (`testing_tools/pycache_watchdog.py`):** Ensures the background bytecode-cleanup daemon is active.
2. **JS Transpilation (`testing_tools/generate_js.py`):** Rebuilds all transpiled `utils/*.js` targets from `utils/*.module.js`.
3. **Concurrent Test & Static Analysis Suite (`testing_tools/run_suite.py`):**
   - **Parallel Python Pool (`PYTHON_TEST_FILES`):** Executes all registered Python test modules concurrently via `ThreadPoolExecutor`.
   - **Concurrent `run_js_batch()`:**
     - Synchronizes `testing_tools/scripts/bridge_contract.js` via `testing_tools/generate_bridge_contract.py`.
     - Auto-discovers and runs all `testing_tools/scripts/test_*.js` Node test suites.
     - Runs `node --check` syntax validation and the JS empty/comment-only `catch {}` regex gate (`js_empty_catch_regex`).
     - Runs Python AST static checks forbidding syntax errors, bare `except:`, and silent `except ...: pass` (`_is_silent_pass`).
     - Executes `ruff`, `biome`, `luac -p`, `luacheck`, `shellcheck`, and `pyright` when available on `PATH` (excluding `yt-tools-legacy`, `yt-tools-standalone`, and `mpv-playlist-organizer-release`).

---

## 3. Code Comment Standards

**Core Principle:** Code explains the *Action*; comments explain the *Intent*.

- **Permitted Comments:**
  1. **Functional Logic-Guards:** Explain boundary conditions, index guards, and race-condition mitigations so future edits do not remove critical checks.
  2. **Architectural Context:** Explain non-obvious workarounds for OS quirks, browser CSP/sandbox limits, or MPV IPC timing.
- **Prohibited Comments:**
  - Never add redundant narration of self-explanatory code (`# Loop through items`, `# Return result`).
  - Do not restyle existing comments purely for phrasing preferences.
