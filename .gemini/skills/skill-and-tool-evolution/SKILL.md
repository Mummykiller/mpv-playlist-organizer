---
name: skill-and-tool-evolution
description: >-
  Meta-skill governing passive friction detection during normal tasks, on-demand audits of
  `.gemini/skills/` and `mcp_server/`, strict auto-apply vs. proposal boundaries, sub-skill
  splitting criteria, MCP tool promotion/guardrails, and `.gemini/proposals/` staging. Load
  when auditing skills or MCP tools, or when staging a friction proposal.
---

# Skill & Tool Evolution

Governs how `.gemini/skills/` and `mcp_server/` evolve over time through passive friction detection and on-demand audits.
Complements `.gemini/skills/skills-maintenance/SKILL.md` (authoring templates and code-sync playbooks) by regulating sub-skill splitting, pruning, MCP tool promotion, and proposal staging.

---

## 1. Activation Modes

### Passive Detection (During Any Normal Task)
- Watch for repeated friction during normal work:
  - Stale file or symbol paths in an active skill.
  - A skill pulling in unrelated instructions for narrow tasks.
  - A shell workflow repeated 3+ times with noisy or high-token output.
  - An existing MCP tool missing a useful `mode` or `action`.
- **Do not derail the current task.** If a proposal is needed, write it silently to `.gemini/proposals/` (or apply only a trivial fix per Section 2) and append a single 1-line note at the end of your response.

### On-Demand Audit
- When explicitly asked to audit skills or MCP tools:
  1. Inspect `.gemini/skills/*/SKILL.md` and `GEMINI.md` routing entries for line bloat, mixed domains, drift, or false routing.
  2. Inspect `mcp_server/server.py` and `mcp_server/tools_impl.py` for tool schemas, usage patterns, and missing deterministic helpers.
  3. Stage proposals in `.gemini/proposals/` for anything needing refactoring, splitting, pruning, or MCP promotion.

---

## 2. Change Authority (Strict Boundary)

| Authority Level | Permitted Scope | Approval & Reporting |
| :--- | :--- | :--- |
| **Auto-apply allowed (trivial only)** | Fixing broken/moved file paths, renamed function/script names, or minor typos inside `.gemini/skills/*/SKILL.md` or `GEMINI.md`. | Apply directly without a proposal; mention the fix in 1 line. |
| **Proposal-required (everything else)** | Creating, splitting, merging, or deleting skills; changing behavioral rules or `GEMINI.md` invariants; adding/modifying `mcp_server/` tools, parameters, or guardrails. | **Never apply without explicit user approval.** Stage in `.gemini/proposals/`. |

---

## 3. Skill Evolution & Sub-Skill Splitting Criteria

- **No hard cap on total skills:** This is a large repo—prefer focused, narrowly routed skills over monolithic ones.
- **Trigger a split proposal when a skill:**
  1. Exceeds **~150 lines**, OR
  2. Mixes **2+ distinct workflows/subsystems** that are rarely needed together, OR
  3. Causes **false routing** or loads excessive irrelevant context for narrow tasks.
- **How to split:**
  - Extract cohesive sub-domains into sibling skills (`.gemini/skills/<domain>-<subtopic>/SKILL.md`) or convert the original into a short router (`<40 lines`) pointing to sub-skills.
  - Include the exact updated `GEMINI.md` routing lines with crisp, non-overlapping trigger conditions.
- **Pruning / Merging:**
  - Flag skills whose target files were removed, overlap heavily with another skill, or duplicate logic now handled deterministically by an MCP tool.

---

## 4. MCP Server Evolution (`mcp_server/`)

- **Promotion criteria:**
  - Propose moving a workflow into `mcp_server/` when a deterministic read, verify, lint, or diagnostic command is run repeatedly, requires multi-step shell parsing, or produces noisy/high-token stdout.
- **Keep tool schemas lean:**
  - Prefer extending an existing MCP tool with a new `mode` or `action` parameter when it fits cleanly.
  - Treat **~10–12 top-level tools** as a soft schema-budget threshold—justify any new top-level tool against token overhead.
- **Non-negotiable MCP guardrails (carry forward in every proposal):**
  - **Read-only / non-destructive by default:** Never propose tools that kill `mpv`, edit browser `NativeMessagingHosts`/`Preferences`, run installers/release builders, delete `DATA_DIR`, or leak `MPV_PLAYLIST_TOKEN`/cookies.
  - **Output & runtime hygiene:** Compact JSON output (`mcp_server/tools_impl.py:compact_json`), ANSI stripped, bounded output with `truncated` flags, stderr-only logging (`mcp_server/server.py`), and `PYTHONDONTWRITEBYTECODE=1`.
  - **Tests & verification:** Every MCP change proposal must include updates to `mcp_server/test_smoke.py` and verification via `python3 verify_changes.py`.

---

## 5. Proposal Staging & Chat Output Rule (Mandatory)

- **Staging location:** Write every non-trivial proposal to `.gemini/proposals/<YYYY-MM-DD>-<short-slug>.md`.
- **Chat output rule:** **Never print the proposal content in chat.** Only output a single notification line:
  `Proposal written: .gemini/proposals/<filename>.md — <1-line summary>`
- **Post-approval cleanup:** Once the user approves and changes are implemented and verified, delete the applied proposal file from `.gemini/proposals/`.

### Proposal File Template

Use this structure for every file staged in `.gemini/proposals/`:

```markdown
# Proposal: <Short Title>

- **Type:** `skill-split` | `skill-update` | `skill-new` | `skill-prune` | `mcp-extend` | `mcp-new-tool`
- **Trigger / Evidence:** <Concrete friction, line count, drift, or repeated workflow observed.>
- **Token / Workflow Impact:** <Why this saves tokens or prevents errors.>
- **Proposed Changes:**
  - <Exact files to create/edit/delete and concise diffs or outlines>
  - <Updated `GEMINI.md` routing lines for skill splits, additions, or prunes>
  - <Guardrail & schema-budget confirmation for `mcp-extend` / `mcp-new-tool` proposals>
- **Verification Plan:**
  - `mcp_server/test_smoke.py` (required for all MCP changes)
  - `python3 verify_changes.py`
  - `check_repo_drift`
```

### Authoring Hygiene
- Follow `.gemini/skills/skills-maintenance/SKILL.md`: cite `file:symbol` (never line numbers) and avoid hardcoded total skill or tool counts.
