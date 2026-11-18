---
name: linting-and-static-analysis
description: >-
  Governs the multi-language static analysis and linting toolchain across Python,
  JavaScript/CSS, MPV Lua scripts, and shell scripts. Load this skill whenever
  configuring or troubleshooting Ruff, Pyright, Biome, Luacheck, ShellCheck,
  or adding new lint rules and config exclusions.
---

# Linting & Static Analysis Toolchain

All linters run automatically inside `testing_tools/run_suite.py` (invoked by `python3 verify_changes.py --verbose`) whenever their binaries are installed on `PATH`, and can also be run individually for targeted checks.

## Toolchain Overview

| Domain | Tool | Config File | Automatic Scope |
| :--- | :--- | :--- | :--- |
| **Python Linting** | `ruff` | [pyproject.toml](../../testing_tools/pyproject.toml) | All `.py` files (excluding generated standalone/release folders) |
| **Python Type Checking** | `pyright` | [pyrightconfig.json](../../testing_tools/pyrightconfig.json) | Root + `utils/` + `installer_src/` + `testing_tools/` |
| **JS / CSS Linting** | `biome` | [biome.json](../../testing_tools/biome.json) | Hand-written `.js` and `.css` files (excluding 7 generated `utils/*.js` outputs, `.md`, `.html`) |
| **Lua Syntax & Lint** | `luac -p` + `luacheck` | [.luacheckrc](../../testing_tools/.luacheckrc) | `mpv_scripts/*.lua` |
| **Shell Scripts** | `shellcheck` | *(CLI flags in `run_suite.py`)* | All `.sh` files (e.g. `run_native_host.sh`) |

---

## Standalone Commands

Run from the repository root (`/home/shinku/Documents/mpv-playlist-organizer`):

```bash
# Python lint (E, F, W, B bugbear)
ruff check --no-fix --config testing_tools/pyproject.toml .
ruff check --config testing_tools/pyproject.toml --fix .   # safe auto-fixes only

# Python type check
pyright -p testing_tools/pyrightconfig.json

# JS / CSS lint (warnings/infos are non-blocking advisories; errors fail the check)
biome check --config-path testing_tools/biome.json .

# Lua syntax + static analysis
luac -p mpv_scripts/*.lua
luacheck --config testing_tools/.luacheckrc mpv_scripts/*.lua

# Shell scripts
shellcheck run_native_host.sh
```

---

## Configuration Conventions & Invariants

1. **Ruff (`testing_tools/pyproject.toml`)**:
   - Enables `select = ["E", "F", "W", "B"]` (`pycodestyle`, `pyflakes`, whitespace, and `flake8-bugbear`).
   - Intentionally ignores `E402` (entry points set `sys.dont_write_bytecode = True` before local imports), `E501` (long log/HTML strings), and `E701` (compact single-line guard returns).
   - `yt-tools/*.py` uses tab indentation (`per-file-ignores` suppresses `W191` there).
   - Excludes `yt-tools-standalone`, `yt-tools-legacy`, and `mpv-playlist-organizer-release`.

2. **Pyright (`testing_tools/pyrightconfig.json`)**:
   - Enforces `reportMissingImports`, `reportUndefinedVariable`, `reportIncompatibleMethodOverride`, and `reportOperatorIssue` as errors.
   - Suppresses Linux-vs-Windows false positives (`winreg`, `subprocess.CREATE_NO_WINDOW`) and legacy `= None` dependency-injection warnings (`cli.py`) until those modules are fully typed.
   - Optional runtime dependencies (like `watchdog` in `testing_tools/`) or intentional fallback imports (`utils/fallback_sync.py`) use `# type: ignore[import-not-found]`.

3. **Biome (`testing_tools/biome.json`)**:
   - Targets Biome `2.6.8` schema (`files.includes` with `!` negations).
   - **Never lint generated files**: excludes the 7 transpiled `utils/*.js` outputs (`SystemLogger.js`, `anilist_renderer.js`, `commUtils.js`, `security.js`, `nativeConnection.js`, `MpvInterface.js`, `domUtils.js`) and `testing_tools/scripts/bridge_contract.js`. Fix issues in `utils/*.module.js` instead.
   - Disables formatter, `assist`, `.md`, and `.html` checks so `biome check` acts strictly as a JS/CSS correctness linter without failing on formatting or SVG/button HTML rules.

4. **Luacheck (`testing_tools/.luacheckrc`)**:
   - Declares MPV's injected `mp` global so `mp.*` calls are recognized.
   - Ignores formatting/whitespace codes (`611`-`614`, `max_line_length = false`) while catching real Lua bugs such as accidental global variables (always use `local function`) and unused callback arguments (prefix with `_`, e.g. `_name`).
