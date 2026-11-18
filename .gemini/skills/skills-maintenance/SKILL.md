---
name: skills-maintenance
description: Procedure for auditing and updating .gemini/skills/ and GEMINI.md after a major refactor, module extraction/deletion, security limit change, or new subsystem so skills never go stale.
---

# Skills Maintenance & Post-Refactor Sync

Use this skill after any major refactor, module split/deletion, security limit update, test-runner change, or new subsystem so agent skills stay accurate and trustworthy.

## When to Run This Checklist
- A module or doc referenced by a skill is renamed, moved, split, or deleted.
- A new subsystem or sub-extension is added (e.g. a new `SKILL.md` is needed).
- Security limits, protocol actions, storage keys, or `verify_changes.py` / `run_suite.py` gates change.

## Post-Refactor Audit Steps
1. **Find Affected Skills**: Search `.gemini/skills/` with `rg` for the moved/renamed/deleted filenames, symbols, or constants.
2. **Verify File Paths & Symbols**: Confirm every file path and symbol name in the affected `SKILL.md` (and any `references/` files) exists in the current repo. Remove dead links and stale doc references.
3. **Check Constants & Limits**: Cross-check any documented numbers (max lengths, folder/item caps, timeouts, retry counts) against the actual source (e.g. `utils/security.module.js`, `utils/security.py`).
4. **Sync Build & Test Docs**: Verify `js-build-and-verification/SKILL.md` and `testing-and-test-authoring/SKILL.md` match `verify_changes.py` and `testing_tools/run_suite.py` (test suites, AST gates, linters, excluded directories).
5. **Update Index & Routing**:
   - Ensure `GEMINI.md` lists every active skill under `## Modular Skills Index`.
   - Ensure `lead-architect/SKILL.md` reflects the current skill count and domain mapping.
6. **Respect Docs-Only Rule**: Per `GEMINI.md`, do **not** run `python3 verify_changes.py` when only `.gemini/skills/` or `GEMINI.md` changed.

## Authoring Standards
- Keep YAML frontmatter (`name`, `description`) intact and concise.
- Prefer exact repo-relative paths and symbol names over vague descriptions.
- Avoid duplicating long invariants verbatim across multiple skills—link to the canonical skill or `GEMINI.md` instead.
