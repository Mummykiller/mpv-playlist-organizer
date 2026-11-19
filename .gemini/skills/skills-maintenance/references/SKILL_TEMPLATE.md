# Skill Authoring Templates & Conventions

Use these templates when creating a new skill in `.gemini/skills/<skill-name>/` or refactoring an existing skill for progressive disclosure.

---

## 1. Frontmatter & Citation Conventions

### YAML Frontmatter Rules
- **`name`**: Lowercase `kebab-case` matching the parent folder name in `.gemini/skills/<name>/`.
- **`description`**: Use `description: >-` (folded block scalar, 2–5 lines). State:
  1. **What** architectural domain or subsystem the skill governs.
  2. **When** to load it, naming the exact files, directories, or operations that trigger it.

```yaml
---
name: example-subsystem
description: >-
  Governs the <Subsystem Name> architecture, state lifecycle, and error recovery.
  Load this skill whenever modifying `path/to/module.py`, `utils/example.module.js`,
  or adding new `<subsystem>` actions and tests.
---
```

### Durable Symbol Citations (No Line Numbers)
Always reference code using repo-relative paths and exact symbol names:

| Citation Type | Good (Durable) | Bad (Fragile — Never Use) |
| :--- | :--- | :--- |
| **Python Function / Method** | `utils/security.py:sanitize_string`<br>`utils/file_lock.py:FileLock.__enter__` | `utils/security.py:416-448`<br>`utils/file_lock.py#L58` |
| **JS Module / Function** | `utils/nativeConnection.module.js:callNativeHost`<br>`background/yt_tools_service.js:syncYtToolsRegistration` | `utils/nativeConnection.module.js (line 285)` |
| **Constant / Config Key** | `native_host.py:MAX_OUTBOUND_MESSAGE_SIZE`<br>`utils/security.py:ALLOWED_SETTINGS_KEYS` | `native_host.py:187` |

---

## 2. Template A: Standard Domain Skill (`SKILL.md` Only)

Use this template for self-contained domains that fit within **60–150 lines**.

```markdown
---
name: <domain-kebab-name>
description: >-
  Governs <concise domain summary>. Load this skill whenever modifying
  `<primary_file_1>`, `<primary_file_2>`, or working on <trigger tasks>.
---

# <Human-Readable Domain Title>

<1–2 sentence overview of the subsystem's role and architectural boundary.>

---

## 1. Core Architecture & Entry Points

| Component | File & Symbol | Responsibility |
| :--- | :--- | :--- |
| **<Component A>** | `path/to/file.py:ClassName` | <Brief responsibility> |
| **<Component B>** | `path/to/file.module.js:funcName` | <Brief responsibility> |

---

## 2. Key Workflows & Lifecycle

1. **<Step / Phase 1> (`file.py:func_a`):** <How data flows and what invariants hold.>
2. **<Step / Phase 2> (`file.js:func_b`):** <How state transitions or errors are handled.>

---

## 3. Invariants & Guardrails

1. **<Rule 1 Name>:** <Actionable constraint and why it exists.>
2. **<Rule 2 Name>:** <Actionable constraint and exact helper/lock/validator to use.>
3. **<Verification>:** <Which test script in `testing_tools/scripts/` covers this domain.>
```

---

## 3. Template B: Progressive-Disclosure Skill (`SKILL.md` + `references/`)

Use this structure when a domain requires extensive reference tables, protocol schemas, or audit checklists that would push `SKILL.md` past ~150 lines.

### `.gemini/skills/<domain-name>/SKILL.md` (Lean Entry File)
```markdown
---
name: <domain-kebab-name>
description: >-
  Governs <concise domain summary>. Load this skill whenever modifying
  `<primary_files>`, `references/<SPEC>.md`, or working on <trigger tasks>.
---

# <Human-Readable Domain Title>

<1–2 sentence overview of the high-level architecture and boundaries.>

> [!IMPORTANT]
> For the complete specification—including <exact tables/schemas/checklists>—read [references/<SPEC>.md](references/<SPEC>.md).

---

## 1. High-Level Boundaries & Entry Points

| Boundary | Entry Point | Enforcement / Behavior Summary |
| :--- | :--- | :--- |
| **<Boundary 1>** | `path/to/file.js:symbol` | <High-level summary> |
| **<Boundary 2>** | `path/to/file.py:symbol` | <High-level summary> |

---

## 2. Core Architectural Rules

- **<Category 1>:** <Concise summary of the invariant and key functions.>
- **<Category 2>:** <Concise summary of the invariant and key functions.>

---

## 3. Guardrails Checklist

1. **<Guardrail 1>:** <Actionable rule for contributors/agents.>
2. **<Guardrail 2>:** <Actionable rule for contributors/agents.>
```

### `.gemini/skills/<domain-name>/references/<SPEC>.md` (Deep Reference)
- Contains the exhaustive parameter tables, allowlists, edge-case rules, and platform-specific details.
- Still follows the **Zero Fragile Line Numbers** rule—cite `file.py:symbol_name` throughout.
