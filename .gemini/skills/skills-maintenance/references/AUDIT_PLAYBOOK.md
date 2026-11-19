# Skill Auditing & Refactoring Playbook

Use this playbook when updating skills after code changes (`git diff`) or conducting a periodic audit of `.gemini/skills/`.

---

## 1. Post-Change Sync Audit (`git diff` Workflow)

Whenever a feature, bugfix, or refactor modifies code, limits, protocol actions, or build/lint configs:

1. **Identify Changed Files & Symbols:**
   ```bash
   git status --short
   git diff --stat
   ```
2. **Find Referencing Skills:**
   Search `.gemini/skills/` and `GEMINI.md` for any touched filenames, functions, classes, or constants:
   ```bash
   rg --hidden "<filename_or_symbol>" .gemini/skills/ GEMINI.md
   ```
3. **Verify Implementation Parity:**
   - **Limits & Constants:** Cross-check numbers in the skill against actual constants (e.g., `utils/security.py:SECURITY_LIMITS`, `utils/security.module.js:SECURITY_LIMITS`, `native_host.py:MAX_OUTBOUND_MESSAGE_SIZE`).
   - **JS vs. Python Behavior:** If a validation or normalization helper exists in both languages (e.g., `sanitizeString` vs. `sanitize_string`, `isSafeUrl` vs. `is_safe_url`, `normalizeYouTubeUrl` vs. `normalize_url`), verify both implementations and document any intentional differences.
   - **Locks, Timeouts & Edge Cases:** Confirm lock acquisition order (`FileLock`), retry counts, timeout values, and fail-closed conditions in the source files.

---

## 2. Full-Repository Skill Health Audit

Run these checks when auditing `.gemini/skills/` for staleness or bloat:

### Step 1: Detect Fragile Line Numbers & Hardcoded Collection Counts
Skills and `references/*.md` files must never contain hardcoded line numbers or brittle total counts of skills, files, modules, or rules:
```bash
# 1. Detect fragile line numbers
rg --hidden "(#L\d+|\.(py|js|lua|sh|css|html):\d+)" .gemini/skills/ GEMINI.md

# 2. Detect hardcoded collection counts (skills, modules, tests, files, rules, invariants)
rg --hidden -i "\b(all \d+|\d+ (transpiled|modular|domain|skills|modules|scripts|rules|invariants|files))\b" .gemini/skills/ GEMINI.md
```
Replace line numbers with `path/to/file.ext:symbol_name` and replace hardcoded counts with dynamic references to their source of truth (e.g., "all active skills listed in `GEMINI.md`").

### Step 2: Check `SKILL.md` Line Counts (Progressive Disclosure Candidates)
```bash
wc -l .gemini/skills/*/SKILL.md
```
- **Target range:** 60–150 lines per `SKILL.md`.
- **Refactor threshold (>160 lines):** If a `SKILL.md` exceeds ~160 lines because of large tables, schemas, or multi-step checklists, extract the detailed reference material into `.gemini/skills/<skill-name>/references/<TOPIC>.md` and link to it from a `> [!IMPORTANT]` or `> [!NOTE]` callout at the top of `SKILL.md`.

### Step 3: Verify Referenced File Paths Exist
Check that every repo-relative file path mentioned in `.gemini/skills/` exists on disk, and remove or update references to deleted/moved files (such as legacy root configs that moved into `testing_tools/`).

### Step 4: Verify Security & Test Suite Parity
1. **Security Claims:** Confirm that `testing_tools/scripts/test_security_claims.py` and `.gemini/skills/security-and-diagnostics/` agree on every allowlist, blocked flag, SSRF rule, and path sandbox.
2. **Test & Linter Runner:** Confirm that `.gemini/skills/js-build-and-verification/SKILL.md`, `.gemini/skills/linting-and-static-analysis/SKILL.md`, and `.gemini/skills/testing-and-test-authoring/SKILL.md` match:
   - `verify_changes.py`
   - `testing_tools/run_suite.py` (`PYTHON_TEST_FILES`, `run_js_batch`, AST gates, linter invocations)
   - `testing_tools/generate_js.py` (transpiled `utils/*.module.js` modules)
3. **Router Synchronization:**
   - Every skill folder in `.gemini/skills/` must be listed in `GEMINI.md` under `## Modular Skills Index`.
   - Domain skills must be mapped to their architectural domain in `.gemini/skills/lead-architect/SKILL.md` (`Step 1: Skill & Constraint Mapping`).
