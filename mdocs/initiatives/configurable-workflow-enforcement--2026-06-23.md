---
id: "configurable-workflow-enforcement"
title: "Enforcement opt-in config + git-gating reconsidered"
status: "done"
created: "2026-06-23"
updated: "2026-06-23"
owner: ""
tags: ["claude-code","workflow","enforcement","config","hooks","0.4.3"]
related_wiki: ["docs/workflow-enforcement-dogfood-friction-log"]
priority: "medium"
---

## Objective
Add an enforcement compatibility setting (gate/advisory/off modes) and an IDLE-strictness flag so the workflow gate can be relaxed or tightened without changing default behavior for existing installs. Git-gating was reconsidered during the G7 dogfood and **dropped** (F2): enforcement narrows to Write/Edit only.

## Plan
- [ ] **[F2]** Delete the `DESTRUCTIVE_BASH` regex constant and its `canExecuteTool` branch. Bash falls through to default allow (audited, ungated by content). Enforcement = Write/Edit only.
- [ ] **[F1-A]** Add `mdocs.enforcement.idle` ∈ `{readonly, open}` (default `open`). Under `readonly`, remove the unconditional IDLE short-circuit so IDLE permits only read tools (`read`/`glob`/`grep`/`list`) + any `./mdocs/` path; Write/Edit/Bash blocked with the standard reason.
- [ ] **[F5]** Document the single-writer assumption on `advance()` (no lock, by design) in an engine.ts comment. No lock added.
- [ ] **[F7]** Normalise the blocked tool name to lowercase in the reason emitted by `src/cli/hooks/pre-tool-use.ts` (`"write"`/`"bash"`).
- [ ] **[F1-D / F9-A]** `resume(id)`: when `currentStep` is `COMPLETE` or `IDLE`, reset to `IDLE` then advance to `UNDERSTAND` (resumed initiative lands gated). Mid-flight steps (`UNDERSTAND`…`REPORT`) preserved unchanged.
- [ ] **[F9-B]** New `mdocs_reset` MCP tool + CLI command → sets `IDLE`, clears `activeInitiative` (full clean slate), backed by engine `resumeAt`. Optional sibling `mdocs_resume_at(step)` for arbitrary jump.
- [ ] Add the broader enforcement mode field (`gate`/`advisory`/`off`, default `gate`) to `MdocsCompatibilityConfig` and `MdocsContract`; thread into `canExecuteTool`.
- [ ] Surface `mdocs.enforcement.idle` + enforcement mode via env (`MDOCS_ENFORCEMENT_IDLE`, `MDOCS_ENFORCEMENT`) and config file. Document precedence: **env > file > detected contract**. Retain `MDOCS_ENFORCEMENT=off` as the CI escape hatch (F3 residual).
- [ ] **[F6]** Delete the `withLock(initiative-progress)` block that pushes per-tool lines to the initiative `progressLog`. Audit.log remains the exhaustive trail; progress log = intentional notes only.
- [ ] **[F4]** Document that PLAN/EXECUTE/VERIFY/REPORT/COMPLETE are one "edits allowed" band — the engine does not enforce plan-vs-execute discipline (that lives in the agent prompt).
- [ ] Document idle modes, `mdocs_reset`, Write/Edit-only enforcement, config precedence, and the dropped git-gating.
- [ ] IDLE `readonly` vs `open` (Write/Edit/Bash blocked at IDLE under readonly; allowed under open).
- [ ] `resume(id)` auto-reset on COMPLETE/IDLE → lands at UNDERSTAND; mid-flight preserved.
- [ ] `mdocs_reset` → IDLE + activeInitiative cleared.
- [ ] Destructive bash deletion: `git commit` / `rm` no longer blocked at VERIFY (regression test flips).
- [ ] PostToolUse no longer appends to initiative `progressLog` (audit still gets every call).
- [ ] Block-reason string uses lowercase tool name.
- [ ] All three enforcement modes (gate/advisory/off) + idle flag; config precedence env > file > contract.
- [ ] `npm run build`, `npm run quality`, `npm run release:check`, `mdocs_validate` all pass.
- [ ] Confirm defaults match 0.4.2 behavior (no breaking change for existing installs).

## Progress Log
- [2026-06-23T03:37:55.527Z] Created initiative via mdocs command
- [2026-06-23] G7 dogfood complete. Friction log captured in wiki/docs/workflow-enforcement-dogfood-friction-log.md. Top items for this initiative: (F1) IDLE is a full escape hatch — enforcement only binds after first advance; (F2) DESTRUCTIVE_BASH regex matches destructive keywords anywhere in the command string, including as quoted data / grep patterns / test scripts — needs token-aware matching or documented false-positive class; (F3) qa-of-the-gate is itself gated — consider MDOCS_ENFORCEMENT escape hatch for trusted CI; (F6) PostToolUse logs every tool call to progress log, duplicating audit — slim it. All defaults must remain 0.4.2 behaviour.
- [2026-06-23] F1 decision adopted (from dogfood friction log): F1-A add config `mdocs.enforcement.idle`={readonly|open}, default `open` (=0.4.2, non-breaking); under `readonly` IDLE permits only read tools + ./mdocs/ paths, Write/Edit/Bash blocked with standard reason. F1-D `resume(id)` auto-advances IDLE->UNDERSTAND so resumed initiatives land gated. Config precedence env>file>contract (MDOCS_ENFORCEMENT_IDLE). Pairs with F9 reset work for lifecycle entry/exit.
- [2026-06-23] F2 decision adopted (from dogfood friction log): DELETE the destructive-bash gate entirely - remove DESTRUCTIVE_BASH regex + its canExecuteTool branch. Bash becomes ungated-by-content (audited). Enforcement narrows to Write/Edit only (blocked before PLAN). Rationale: Write/Edit gate is the real mutation guardrail; destructive-bash was only a soft nudge, never real safety; false-positive cost (blocks builds/tests/qa) > nudge value; audit still records all bash. 'Don't commit before COMPLETE' guidance moves to agent prompt (G8). Non-breaking (looser defaults). F3 dissolved by this; MDOCS_ENFORCEMENT=off retained as optional CI escape.
- [2026-06-23] F9 decision adopted (from dogfood friction log): D = A+B. F9-A: resume(id) auto-resets currentStep to IDLE when terminal/IDLE (mid-flight UNDERSTAND..REPORT preserved); F1-D then advances to UNDERSTAND so resumed initiative lands gated. F9-B: new explicit mdocs_reset MCP/CLI command -> IDLE + clears activeInitiative, backed by engine resumeAt(step). Reset target IDLE. Non-breaking. Pairs with F1-D + G4 lifecycle. Unblocks multi-initiative sessions.
- [2026-06-23] F6 decision adopted (from dogfood friction log): A - PostToolUse no longer pushes per-tool lines to initiative progressLog. audit.log remains the exhaustive per-tool trail (with args); progress log = intentional notes only (via initiative.update progressNote). Delete the withLock(initiative-progress) block in post-tool-use.ts entirely (it was the only initiative write there; audit uses atomic appendFileSync, no lock). Non-breaking (progress log content changes, not schema).
- [2026-06-23] F4/F5/F7/F8 decided + G3 Plan finalized. F4=doc-only (G8: PLAN/EXEC/VERIFY/REPORT/COMPLETE one band, engine doesn't enforce plan-vs-execute). F5=accept+document (no lock on advance; single-writer by design). F7=do it (lowercase tool name in block reason). F8=defer to G5 (index integrity, not enforcement). All 9 dogfood findings now decided. Initiative Plan rewritten to executable checklist: engine deletes (F2 destructive, F6 progress push), idle flag (F1-A), resume auto-reset + mdocs_reset (F1-D/F9), config plumbing (modes + idle, env>file>contract), docs (F4), tests. Ready to execute.
- [2026-06-23T12:46:00.054Z] edit executed at step PLAN
- [2026-06-23T12:48:14.248Z] task executed at step PLAN
- [2026-06-23T12:48:28.283Z] task executed at step PLAN
- [2026-06-23T12:48:42.307Z] bash executed at step PLAN
- [2026-06-23T12:48:55.758Z] bash executed at step PLAN
- [2026-06-23T12:48:55.768Z] bash executed at step PLAN
- [2026-06-23T12:48:57.387Z] edit executed at step PLAN
- [2026-06-23T12:49:01.328Z] edit executed at step PLAN
- [2026-06-23T12:49:04.994Z] edit executed at step PLAN
- [2026-06-23T12:49:07.496Z] bash executed at step PLAN
- [2026-06-23T12:49:10.777Z] edit executed at step PLAN
- [2026-06-23T12:49:13.738Z] bash executed at step PLAN
- [2026-06-23T12:49:20.716Z] edit executed at step PLAN
- [2026-06-23T12:49:20.986Z] bash executed at step PLAN
- [2026-06-23T12:49:21.001Z] bash executed at step PLAN
- [2026-06-23T12:49:23.739Z] bash executed at step PLAN
- [2026-06-23T12:49:30.832Z] edit executed at step PLAN
- [2026-06-23T12:49:31.099Z] bash executed at step PLAN
- [2026-06-23T12:49:34.518Z] edit executed at step PLAN
- [2026-06-23T12:49:46.052Z] edit executed at step PLAN
- [2026-06-23T12:50:06.663Z] write executed at step PLAN
- [2026-06-23T12:50:07.218Z] edit executed at step PLAN
- [2026-06-23T12:50:11.138Z] edit executed at step PLAN
- [2026-06-23T12:50:19.959Z] edit executed at step PLAN
- [2026-06-23T12:50:21.408Z] edit executed at step PLAN
- [2026-06-23T12:50:23.973Z] bash executed at step PLAN
- [2026-06-23T12:50:34.191Z] edit executed at step PLAN
- [2026-06-23T12:50:45.794Z] edit executed at step PLAN
- [2026-06-23T12:50:46.748Z] bash executed at step PLAN
- [2026-06-23T12:50:50.072Z] bash executed at step PLAN
- [2026-06-23T12:50:56.034Z] edit executed at step PLAN
- [2026-06-23T12:51:01.034Z] bash executed at step PLAN
- [2026-06-23T12:51:09.642Z] edit executed at step PLAN
- [2026-06-23T12:51:11.827Z] edit executed at step PLAN
- [2026-06-23T12:51:19.235Z] edit executed at step PLAN
- [2026-06-23T12:51:31.987Z] edit executed at step PLAN
- [2026-06-23T12:51:41.946Z] edit executed at step PLAN
- [2026-06-23T12:51:58.968Z] edit executed at step PLAN
- [2026-06-23T12:52:06.182Z] edit executed at step PLAN
- [2026-06-23T12:52:14.709Z] edit executed at step PLAN
- [2026-06-23T12:52:25.371Z] edit executed at step PLAN
- [2026-06-23T12:52:28.772Z] bash executed at step PLAN
- [2026-06-23] G3 IMPLEMENTED + VERIFIED via subagents (executor=code, writer=docs, test-engineer=tests+fixes). Code: engine.ts [F2] deleted DESTRUCTIVE_BASH+branch (bash ungated), [F1-A] idle readonly/open gate (default open), [F5] single-writer comment, [F9-B] reset(); operations.ts [F1-D/F9-A] resume auto-reset COMPLETE/IDLE->UNDERSTAND (mid-flight preserved) + reset() op; contract.ts enforcement mode (gate/advisory/off default gate) + idle, resolveEnforcementMode/resolveIdleStrictness read MDOCS_ENFORCEMENT/MDOCS_ENFORCEMENT_IDLE (precedence env>config>default); factory.ts threads config->engine; mcp-server.ts mdocs_reset tool; cli/index.ts reset route; post-tool-use.ts [F6] deleted withLock progress-push (audit-only); pre-tool-use.ts [F7] lowercase tool name in reason. Docs: README, claude-md-snippet, mdocs-workflow skills (claude-code+codex), orchestrator agents, CLAUDE.md. Tests: 305 pass. Regression found+fixed: resume() change broke initiative.done-clears-active (cli.test #6) - fixed in code. release:check RC_EXIT=0 (build:plugin+lint+test+coverage+mdocs:validate+pack). Non-breaking defaults confirmed (gate/open).
- [2026-06-23T13:48:24.209Z] Marked done via mdocs command

## Artifacts
