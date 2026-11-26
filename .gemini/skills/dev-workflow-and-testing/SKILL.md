---
name: dev-workflow-and-testing
description: >-
  Governs JS ES-module transpilation (`testing_tools/generate_js.py`), the unified verification gate
  (`verify_changes.py`, `testing_tools/run_suite.py`), multi-language linters (Ruff, Pyright, Biome,
  Luacheck, ShellCheck), test authoring (`testing_tools/scripts/`), and static AST exception gates.
  Load whenever editing `utils/*.module.js`, `testing_tools/`, linter configs, or writing tests.
---

# Dev Workflow, Linting & Testing Architecture

> [!IMPORTANT]
> - For the `utils/*.module.js` transpilation table, hand-written vs. generated file inventory, and component reload matrix, see [references/BUILD_AND_RELOAD_MATRIX.md](references/BUILD_AND_RELOAD_MATRIX.md).
> - For `BaseTestCase` fixture boilerplate, JSDOM setup, valid/invalid `try/except` examples, and the risk-area regression matrix, see [references/TEST_PATTERNS_AND_FIXTURES.md](references/TEST_PATTERNS_AND_FIXTURES.md).

---

## 1. Golden Build Rule (`testing_tools/generate_js.py`)
- Chrome Content Scripts cannot import ES Modules directly; `generate_js.py` transpiles shared `utils/*.module.js` sources into namespaced IIFE globals (`window.MPV_INTERNAL`, `window.MPV_SECURITY`).
- **Always edit `utils/*.module.js`** for transpiled modules (`SystemLogger`, `anilist_renderer`, `commUtils`, `security`, `nativeConnection`, `MpvInterface`, `domUtils`). Never edit their generated `utils/*.js` outputs directly.
- Fast transpile-only build: `PYTHONDONTWRITEBYTECODE=1 python3 -B testing_tools/generate_js.py` (or `verify_repo(mode="build")`).

---

## 2. Unified Verification Pipeline (`verify_changes.py` & `testing_tools/run_suite.py`)
Run via `verify_repo(mode="build"|"lint"|"test"|"targeted"|"fix"|"full")` or `PYTHONDONTWRITEBYTECODE=1 python3 -B verify_changes.py` (skip for docs-only, `.gitignore`, or read-only tasks):
1. **JS Transpilation (`testing_tools/generate_js.py`):** Rebuilds all transpiled `utils/*.js` targets.
2. **Concurrent Suite (`testing_tools/run_suite.py`):**
   - **Parallel Python Pool (`discover_python_test_files`):** Auto-discovers and runs all `testing_tools/scripts/test_*.py` modules (including `test_mcp_server.py`) concurrently via `ThreadPoolExecutor`.
   - **Concurrent `run_js_batch()`:**
     - Syncs `testing_tools/scripts/bridge_contract.js` via `testing_tools/generate_bridge_contract.py`.
     - Auto-discovers and runs `testing_tools/scripts/test_*.js` in Node.
     - Runs `node --check`, the JS empty/comment-only `catch {}` gate (`js_empty_catch_regex`), and the Python AST gate (forbidding bare `except:` and silent `except ...: pass` via `_is_silent_pass`).
     - Executes all installed linters below (excluding `yt-tools-legacy`, `yt-tools-standalone`, `mpv-playlist-organizer-release`, and `mcp_server/.venv`).

---

## 3. Linter Toolchain & Config Invariants

| Domain | Tool | Config | Key Conventions |
| :--- | :--- | :--- | :--- |
| **Python Lint** | `ruff` | `testing_tools/pyproject.toml` | `E, F, W, B`. Ignores `E402` (`sys.dont_write_bytecode = True` before local imports), `E501`, `E701`; `yt-tools/*.py` allows tab indent (`W191`). |
| **Python Types** | `pyright` | `testing_tools/pyrightconfig.json` | Errors on missing imports, undefined vars, incompatible overrides, operator issues. Covers `mcp_server/` (excluding `mcp_server/.venv`). Optional deps (`watchdog`, `mcp`) use `# type: ignore[import-not-found]`. |
| **JS / CSS** | `biome` | `testing_tools/biome.json` | Biome 2.6.8 schema; excludes generated `utils/*.js`, `bridge_contract.js`, `.md`, `.html`. Formatter/assist disabled (correctness-only). |
| **Lua** | `luac -p` + `luacheck` | `testing_tools/.luacheckrc` | Covers `mpv_scripts/*.lua`. Declares MPV's `mp` global; catches accidental globals (use `local function`) and unused callback args (prefix `_`). |
| **Shell** | `shellcheck` | *(CLI in `run_suite.py`)* | Covers all `.sh` files outside excluded build/venv folders. |

---

## 4. Testing, Comments & Release Guardrails
1. **Regression tests required:** Every bugfix and security change ships with a test in `testing_tools/scripts/`. Update `testing_tools/scripts/test_security_claims.py` whenever a security allowlist or limit changes. For repeatable bug classes, log them via MCP (`log_bug_pattern`) and graduate them (`graduate_bug_pattern` with `test_ref`) once covered by tests or static checks.
2. **Isolate test state:** Inherit from `testing_tools/base_test.py:BaseTestCase` (`self.test_dir`) so tests never touch live `DATA_DIR` or leak log handlers, subprocesses, sockets, or temp dirs.
3. **No skipped/ignored linter errors:** Any error from an installed linter is a hard failure.
4. **Release hygiene (`testing_tools/create_release.py`):** Excludes `*.log`, `*.tmp`, `*.bak`, `data`, `flags`, `.gemini*`, `.agents`, `vulkan_fallback.lua`, `mcp_server`, `testing_tools`, `yt-tools-legacy`, and `yt-tools-standalone*`.
5. **Code comments:** Explain *intent* (logic guards, race mitigations, OS/CSP/IPC workarounds), never narrate obvious code.
