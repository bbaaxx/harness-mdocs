---
id: "workflow-enforcement-dogfood-friction-log"
title: "Workflow enforcement dogfood — friction log (G7)"
category: "docs"
created: "2026-06-23"
updated: "2026-06-23"
related_initiatives: ["dogfood-enforcement-end-to-end","configurable-workflow-enforcement"]
tags: ["claude-code","workflow","enforcement","dogfood","friction","0.4.3"]
lifecycle: "stable"
---

# Workflow enforcement dogfood — friction log (G7)

Source: initiative `dogfood-enforcement-end-to-end` (G7). Drove real initiative `remove-self-referential-devdependency` (G9) through all nine workflow steps in a live Claude Code session on 2026-06-23. Gates verified by piping crafted PreToolUse payloads to the actual hook binary (`dist/cli/hooks/pre-tool-use.js`) and observing exit code + stderr reason.

## Gate verification (all PASS)

| Gate | Step | Result |
|---|---|---|
| Write/Edit non-mdocs blocked | UNDERSTAND, DISCOVER, CONTEXT | exit 2 + reason ✓ |
| Write/Edit allowed | PLAN+ | exit 0 ✓ |
| mdocs/ paths always allowed | any step | exit 0 ✓ |
| Read/Glob/Grep always allowed | any step | exit 0 ✓ |
| Non-destructive bash (`npm test`) | VERIFY | exit 0 ✓ |
| Destructive bash (`git commit`, `rm -rf`) | VERIFY | exit 2 ✓ |
| Destructive bash opens | COMPLETE | exit 0 ✓ |
| PostToolUse parallel (12 concurrent) | VERIFY | audit 12/12, progress RMW 12/12 under `withLock`, zero lost updates ✓ |

All nine steps driven: IDLE→UNDERSTAND→DISCOVER→CONTEXT→PLAN→EXECUTE→VERIFY→REPORT→COMPLETE.

## Friction findings (feed into G3 `configurable-workflow-enforcement`)

### F1 — IDLE is a full escape hatch (HIGH)
`canExecuteTool` returns `true` for every tool when `currentStep === 'IDLE'` (engine.ts L126). Enforcement binds ONLY after the first `mdocs_advance`. An agent (or user tool call) that never advances stays ungated — every Write/Edit/Bash runs free.

**Decision (adopted 2026-06-23):**
- **F1-A — IDLE read-only, config-gated.** New setting `mdocs.enforcement.idle` ∈ `{readonly, open}`. Default **`open`** (= current 0.4.2 behaviour, non-breaking). Under `readonly`, IDLE permits only read tools (`read`/`glob`/`grep`/`list`) plus any `./mdocs/` path; Write/Edit/Bash are blocked with the same reason string used at UNDERSTAND. Implementation: in `canExecuteTool`, move the `currentStep === 'IDLE'` short-circuit behind the flag — when `readonly`, fall through to the normal write/bash gate checks.
- **F1-D — `resume()` auto-advances out of IDLE.** `resume(initiativeId)` sets currentStep to `UNDERSTAND` when currently `IDLE`, so any resumed initiative is immediately inside the gated region. (Pairs with F9's reset work — both touch lifecycle entry/exit.)
- **Rationale:** only `readonly` makes enforcement real by default; the `open` default preserves the 0.4.2 no-break contract required by G3. A+D together: the common path to start work is `resume` → you land gated; the rare never-resume session stays `open`/unconstrained unless the user opts into `readonly`.
- **Config precedence:** env > file > detected contract (per G3 spec). Env var `MDOCS_ENFORCEMENT_IDLE=readonly|open`, file key `mdocs.enforcement.idle`.

### F2 — DESTRUCTIVE_BASH blacklist matches keywords anywhere in the command string (HIGH, correctness)
The regex (`engine.ts` L24) is applied to the whole command via `.test()`. It matches destructive verbs appearing as **data**, not real invocations: quoted echo payloads, `grep` patterns, argument values, test scripts. During this dogfood the LIVE session hook blocked a legitimate verification command because the command string literally contained `git commit` and `rm -rf` as echoed test data. Real-world hits: `grep -r "git commit" .`, `echo "then rm the file"`, any script quoting these words. The engine.ts comment acknowledges this class for `>`/`>>` redirects but not for embedded keywords.

**Decision (adopted 2026-06-23): delete the destructive-bash gate.** Remove the `DESTRUCTIVE_BASH` regex constant and its `canExecuteTool` branch entirely. Bash falls through to the default allow (audited, but ungated by content). Enforcement narrows to **Write/Edit only** (still blocked before PLAN). Rationale: (1) the Write/Edit gate already enforces "plan before mutation" — the real guardrail; (2) the destructive-bash gate was only ever a soft nudge against early commit, never real safety (an agent can `Write` a script or edit `.git` regardless); (3) the nudge's cost (false-positives blocking builds/tests/qa — the exact thing observed here) exceeds its value; (4) the audit log still records every bash call. The "don't commit before COMPLETE" guidance moves to the agent prompt/docs (G8), not a regex. Non-breaking: defaults get looser, never stricter. Also dissolves F3.

### F3 — Dogfooding/QA the gate is itself gated (MEDIUM, ops)
Consequence of F2: any test harness that mentions destructive commands literally is blocked before COMPLETE. Workaround used here = pipe payloads from files / build strings via `printf` so the live command string stays clean.

**Resolution (2026-06-23): dissolved by the F2 decision.** With the destructive-bash gate deleted, test/qa scripts are no longer false-positive-blocked. The `MDOCS_ENFORCEMENT=off` escape-hatch idea is retained as an optional standalone nicety for fully-trusted CI (would bypass the Write/Edit gate too), but it is no longer motivated by F3.

### F4 — PLAN and EXECUTE are gate-indistinguishable (MEDIUM, design)
Both allow Write/Edit (engine L128: `['PLAN','EXECUTE','VERIFY','REPORT','COMPLETE']`). The model can perform ALL execution at PLAN and treat EXECUTE as a no-op pass-through. Steps are advisory, not semantically enforced.

**Decision (adopted 2026-06-23): doc-only, no code.** No engine change — the gate deliberately treats PLAN/EXECUTE/VERIFY/REPORT/COMPLETE as one "edits allowed" band. Document this explicitly in G8 (consumer docs) and the `mdocs-workflow` skill so users do not expect the engine to enforce plan-vs-execute discipline; that discipline lives in the agent prompt, not the gate.

### F5 — `advance()` state mutation is unlocked (LOW)
`WorkflowEngine.advance()` does a plain read-modify-write on `.workflow-state.json` with no lock, unlike PostToolUse which wraps initiative RMW in `withLock`. Concurrent advances would race / lose updates. Low practical risk (advances are agent-driven, sequential) but inconsistent with the PostToolUse locking discipline.

**Decision (adopted 2026-06-23): accept + document.** Do not add a lock. Advances are inherently sequential (one agent, one currentStep); the race requires concurrent `mdocs_advance` calls on the same state file, which is not a real access pattern. Adding `withLock` would import lock-file infra into the engine for near-zero benefit. Document the assumption ("advance is single-writer by design") in engine.ts. Revisit only if a multi-writer surface is introduced.

### F6 — PostToolUse logs every tool call to the initiative progress log (MEDIUM, UX)
The hook appends `[ts] <tool> executed at step <step>` on EVERY PostToolUse. During this short session the G9 progress log accumulated 24+ such lines, duplicating detail already in `mdocs/audit.log`. Real initiatives will bloat fast and bury human-authored progress notes.

**Decision (adopted 2026-06-23): A — stop per-tool progress writes entirely.** PostToolUse no longer pushes to the initiative `progressLog`. The exhaustive per-tool trail already lives in `mdocs/audit.log` (with args); the initiative progress log becomes **intentional notes only** (authored via `initiative.update` `progressNote`). Rationale: two stores, two roles — audit = machine trail, progress = human/agent notes; no duplication, no noise burying real notes. Side-effect: the only initiative file-write in PostToolUse was that push, so the whole `withLock(initiative-progress)` block is deleted too (audit uses atomic `appendFileSync`, needs no lock) — removes lock overhead from the hot path. A future read-side "what happened in step X" summary, if wanted, is built from audit, not auto-written.

### F7 — Block reason echoes raw tool_name casing (TRIVIAL)
Reason string shows `"Write"` / `"Bash"` (payload casing) rather than normalised lowercase. Cosmetic.

**Decision (adopted 2026-06-23): do it.** Normalise the tool name to lowercase in the block-reason string (`pre-tool-use.ts`): emit `"write"` / `"bash"`. Trivial, free polish, makes reasons match the internal gate vocabulary.

### F8 — Stale INDEX.md entries surface as validation warnings (LOW, data hygiene)
`resume()` validation reported `INDEX.md lists missing initiative file: index.md` and `log.md`. Pre-existing index drift, unrelated to the gate, but surfaced during dogfood. Feeds G5 (index ownership).

**Decision (adopted 2026-06-23): defer entirely to G5.** Out of scope for G3/enforcement — this is index-integrity work (G5 owns index ownership/repair). G3 only notes it; no action here.

### F9 — No way to start a new initiative cycle after COMPLETE (HIGH, blocks multi-initiative sessions)
`WorkflowEngine.advance()` enforces no-skip/no-back; COMPLETE is terminal. `resumeAt(step)` exists on the engine but is **not exposed via any MCP tool or CLI command** (only `advance` is wired to `mdocs_advance` / `mdocs step`). `resume(id)` sets the active initiative but does not move the step. So once a session reaches COMPLETE it cannot cleanly begin the next initiative — the only escape is hand-editing `.workflow-state.json` (or a process restart). This directly blocks the gap-closure execution order, which drives many initiatives in one session.

**Decision (adopted 2026-06-23): D = A+B.**
- **F9-A — `resume(id)` auto-resets on terminal/IDLE.** When `resume` is called and `currentStep` is `COMPLETE` or `IDLE`, set it to `IDLE` (clean slate); the F1-D logic then advances to `UNDERSTAND` so the resumed initiative lands gated. If `currentStep` is any mid-flight step (UNDERSTAND…REPORT), preserve it (mid-flight resume of in-progress work unchanged). Covers the normal "finish one → resume next" path invisibly, no extra command.
- **F9-B — explicit `mdocs_reset` MCP/CLI command.** New tool resets to `IDLE` and clears `activeInitiative` (full clean slate). Wire the existing engine `resumeAt(step)` behind it (or a sibling `mdocs_resume_at(step)` for arbitrary jump). Use cases: abandon an initiative mid-flight, force-reset for testing, or "I want out now."
- **Reset target = IDLE** (F1-D advances onward); non-breaking (new behaviour only on terminal/explicit trigger). Pairs with F1-D and the G4 lifecycle work.

## Recommendation summary for G3

Decisions adopted 2026-06-23 (F1, F2, F3 resolved; others open):

1. **F1 — DECIDED.** Add `mdocs.enforcement.idle` ∈ `{readonly, open}`, default `open` (0.4.2, non-breaking). Under `readonly`, IDLE = read-tools + `./mdocs/` only. Plus `resume(id)` auto-advances IDLE→UNDERSTAND so resumed initiatives land gated.
2. **F2 — DECIDED.** Delete the destructive-bash gate (`DESTRUCTIVE_BASH` + its branch). Enforcement = Write/Edit only. **F3 dissolved** by this; `MDOCS_ENFORCEMENT=off` retained as optional CI nicety.
3. Keep defaults non-breaking (0.4.2 behaviour); expose strictness via the new config flag only.
4. Document config precedence: env > file > detected contract (already required by G3 spec).
5. **F6 — DECIDED.** Delete PostToolUse's per-tool push to the initiative progress log (and the now-dead `withLock` block). Audit.log = exhaustive trail; progress log = intentional notes only.
6. **F9 — DECIDED.** `resume(id)` auto-resets to IDLE when currentStep is COMPLETE/IDLE (mid-flight preserved); new explicit `mdocs_reset` command (→ IDLE, clears activeInitiative) backed by engine `resumeAt`. Pairs with F1-D and G4 lifecycle.
7. **F4 — DECIDED (doc-only, → G8).** No code; document that PLAN/EXECUTE/VERIFY/REPORT/COMPLETE are one "edits allowed" band and the engine does not enforce plan-vs-execute.
8. **F5 — DECIDED (accept + document).** No lock on `advance()`; document single-writer assumption in engine.ts. No change unless a multi-writer surface appears.
9. **F7 — DECIDED (do it).** Normalise tool name to lowercase in the block-reason string.
10. **F8 — DECIDED (defer to G5).** INDEX.md drift is index-integrity work, not enforcement.

## Evidence
- Workflow state captured at each step via `mdocs_status` / `mdocs_advance`.
- Gate behaviour captured via 9 PreToolUse payload tests against the live hook binary.
- Parallel-lock evidence: `grep '2026-06-23T04:15:40' mdocs/audit.log` → 12 edit entries; G9 progress log → 12 matching lines.


## Referenced By

*Auto-generated by mdocs*

- dogfood-enforcement-end-to-end
- configurable-workflow-enforcement
