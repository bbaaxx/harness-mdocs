---
id: "fix-done-active-initiative-state"
title: "Fix Done Active Initiative State"
status: "done"
created: "2026-06-10"
updated: "2026-06-10"
owner: ""
tags: ["bug","workflow","codex-dogfood"]
related_wiki: ["testing/codex-repo-dogfood"]
priority: "medium"
phase: "done"
next_action: "No follow-up required; completed initiatives no longer remain active in CLI workflow state."
---

## Objective
Prevent mdocs status and resume from treating completed initiatives as active workflow state after initiative.done.

## Plan
- [x] Reproduce stale active initiative behavior.
- [x] Add failing coverage for done initiative active state cleanup or filtering.
- [x] Implement minimal workflow-state fix.
- [x] Run targeted and full verification.
- [x] Update progress and close initiative.

## Progress Log
- [2026-06-10T14:49:49.426Z] Created initiative via mdocs command
- [2026-06-10T15:25:00Z] Reproduced stale workflow behavior: mdocs status could report a done initiative as active after completion. Added CLI regression tests for initiative.done clearing active state and status self-healing legacy stale done pointers. Implemented fix: initiative.done clears matching workflow.activeInitiative; CLI status/resume/dispatch sanitize implicit active IDs and clear missing or non-active initiatives. Rebuilt and confirmed this repo status now reports activeInitiative null.
- [2026-06-10T15:35:00Z] Final verification: npm run test:codex passed (2 suites, 4 tests); npm run build passed; npm test -- --runInBand passed (20 suites, 187 tests); plugin validator passed; mdocs validate passed with no errors or warnings. Confirmed rebuilt mdocs status self-healed this repo workflow state from activeInitiative codex-dogfood-end-to-end to null.
- [2026-06-10T14:52:27.924Z] Marked done via mdocs command

## Artifacts
- `src/core/commands/registry.ts` - clears matching active workflow state when `initiative.done` completes an initiative.
- `src/cli/index.ts` - self-heals stale implicit active initiative IDs for status, resume, and dispatch.
- `tests/core/cli.test.ts` - regression coverage for active-state cleanup and stale-state migration.
