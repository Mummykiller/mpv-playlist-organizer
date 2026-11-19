---
name: skills-maintenance
description: >-
  Meta-skill governing how skills in `.gemini/skills/` are created, updated, audited against
  code changes, and refactored using progressive disclosure. Load this skill whenever creating
  a new skill, auditing existing skills against `git diff` or codebase implementations, splitting
  bloated `SKILL.md` files into `references/`, or updating `GEMINI.md` and `lead-architect/SKILL.md`.
---

# Skills Authoring, Auditing & Maintenance Architecture

This meta-skill standardizes how architectural skills in `.gemini/skills/` are scoped, authored, progressively disclosed, and audited so agent instructions remain lean, accurate, and durable.

> [!NOTE]
> - For starter templates and frontmatter/citation examples, see [references/SKILL_TEMPLATE.md](references/SKILL_TEMPLATE.md).
> - For `git diff` sync workflows and full-repo audit commands, see [references/AUDIT_PLAYBOOK.md](references/AUDIT_PLAYBOOK.md).

---

## 1. Structure & Progressive Disclosure (`SKILL.md` vs. `references/`)

Every skill resides in `.gemini/skills/<skill-name>/` and follows a two-tier progressive disclosure model:

| Tier | File Location | Target Size | Purpose & Contents |
| :--- | :--- | :--- | :--- |
| **Tier 1: Entry Skill** | `.gemini/skills/<name>/SKILL.md` | **60–150 lines** | YAML frontmatter (`name`, trigger-rich `description`), high-level architecture, key entry points, actionable workflows, and non-negotiable guardrails. |
| **Tier 2: Deep Reference** | `.gemini/skills/<name>/references/<TOPIC>.md` | **Unbounded** *(optional)* | Exhaustive limit/allowlist tables, protocol schemas, platform matrices, or deep audit checklists linked from `SKILL.md` (e.g., `security-and-diagnostics/references/SECURITY.md`). |

### Modularity Guidelines
- **Default to a single `SKILL.md`:** Most domain skills fit cleanly in a single 60–150 line `SKILL.md`. Do not create empty or boilerplate `references/` folders unless a skill has dense reference material.
- **When to extract to `references/`:** Create a `references/*.md` file when `SKILL.md` exceeds ~160 lines, or when detailed specification tables (such as security allowlists, multi-tier limits, or templates) would obscure the high-level workflow.
- **When to create a new skill vs. extend an existing one:** Only create a new top-level skill when a subsystem has a distinct trigger boundary and file ownership (e.g., `youtube-tools-subextension`, `linting-and-static-analysis`). If a feature extends an existing domain, update that domain's `SKILL.md` or add a focused file under its `references/` directory.

---

## 2. Durability & Accuracy Rules

1. **Zero Fragile Line Numbers:**
   - **Never** cite line numbers (e.g., `utils/security.py:416-448` or `#L14-L32`) inside `SKILL.md` or `references/*.md`. Line numbers go stale on the very next edit.
   - **Always** cite exact repo-relative file paths paired with the module, class, function, method, or constant name (e.g., `utils/security.py:sanitize_string`, `utils/file_lock.py:FileLock.__enter__`, `native_host.py:MAX_OUTBOUND_MESSAGE_SIZE`).
2. **No Hardcoded Collection Counts:**
   - **Never** hardcode total counts of skills, files, modules, tests, or rules (e.g., "all 16 skills", "the 7 transpiled modules", "the 3 invariants").
   - **Always** reference the canonical source dynamically (e.g., "all active skills listed in `GEMINI.md`", "transpiled `utils/*.module.js` modules configured in `testing_tools/generate_js.py`") so counts never drift when items are added, split, or merged.
3. **Verify Against Live Code First:**
   - Never document an assumed threshold, regex, fallback, or CLI flag from memory. Read the actual implementation and compare JS vs. Python parity (e.g., `utils/security.module.js` vs. `utils/security.py`) so subtle differences are stated accurately.
4. **Single Source of Truth (No Invariant Duplication):**
   - Each rule or allowlist belongs to one canonical skill. Other skills should summarize the boundary in one line and link to the owning skill (or `GEMINI.md` for global invariants).
5. **Docs-Only Verification Exemption:**
   - Per `GEMINI.md` Invariant #1, **never** run `python3 verify_changes.py` when a task only creates or edits files in `.gemini/skills/` or `GEMINI.md`.

---

## 3. Workflow A: Creating a New Skill

1. **Scope & Overlap Check:**
   - Review `GEMINI.md` (`## Modular Skills Index`) and existing `.gemini/skills/*/SKILL.md` frontmatter to ensure no overlap with an existing skill.
2. **Codebase Inspection:**
   - Read all files owned by the new subsystem, identifying:
     - Entry points (files, classes, exported functions, IPC/bridge actions, storage keys).
     - Architectural invariants and failure modes (race conditions, timeouts, sandboxing, build/lint exclusions).
     - Existing test coverage in `testing_tools/scripts/`.
3. **Draft `SKILL.md` (and optional `references/`):**
   - Follow [references/SKILL_TEMPLATE.md](references/SKILL_TEMPLATE.md).
   - Write a multi-line `description: >-` in YAML frontmatter that explicitly lists both **what the skill governs** and **when to load it** (naming key files and tasks).
4. **Sync Routing Indexes:**
   - Add the new skill to `GEMINI.md` under `## Modular Skills Index`.
   - Map the skill and its core worker invariants in `.gemini/skills/lead-architect/SKILL.md` under `Step 1: Skill & Constraint Mapping`.

---

## 4. Workflow B: Updating & Auditing Existing Skills

Run this workflow after refactors, module extractions, limit/protocol updates, or when reviewing skill health (see [references/AUDIT_PLAYBOOK.md](references/AUDIT_PLAYBOOK.md) for shell commands):

1. **Diff-Driven Impact Scan:**
   - Inspect `git diff` / `git status` to identify modified files, renamed symbols, or changed constants.
   - Search `.gemini/skills/` (`rg --hidden "<symbol_or_file>" .gemini/skills/`) to locate every referencing skill.
2. **Implementation Cross-Check:**
   - Open every cited file and confirm that documented function signatures, constants, timeouts, lock orders, regexes, and default values match the current code.
   - Strip any hardcoded line numbers and deleted file/function references.
3. **Progressive Disclosure Refactoring:**
   - If an updated `SKILL.md` has grown bloated (>160 lines) with exhaustive specification tables or checklists, extract the deep reference material into `.gemini/skills/<name>/references/<TOPIC>.md` and keep `SKILL.md` focused on high-level architecture and guardrails.
4. **Test & Router Parity:**
   - If security claims, build scripts, or test batches changed, verify that `testing_tools/scripts/test_security_claims.py`, `js-build-and-verification/SKILL.md`, and `testing-and-test-authoring/SKILL.md` match `verify_changes.py` and `testing_tools/run_suite.py`.
