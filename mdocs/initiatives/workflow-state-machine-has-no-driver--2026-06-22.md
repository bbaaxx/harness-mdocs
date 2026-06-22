---
id: "workflow-state-machine-has-no-driver"
title: "Workflow state machine has no driver — enforcement is inert"
status: "done"
created: "2026-06-22"
updated: "2026-06-22"
owner: ""
tags: ["claude-code","surface","workflow","enforcement","hooks","bug"]
related_wiki: []
priority: "medium"
next_action: "Update mdocs-workflow skill + README to document the advance command; mark done"
---

## Objective
Dogfooding the claude-code surface revealed that currentStep NEVER advances during real work. WorkflowEngine.advance() and resumeAt() are defined in src/core/workflow/engine.ts but have ZERO callers in production code. resume() (operations.ts:28) only calls setActiveInitiative(id). createInitiative/doneInitiative (registry.ts) only call setActiveInitiative. The PreToolUse hook reads but never writes currentStep; PostToolUse only appends audit/progress. Consequence: currentStep is permanently IDLE, and canExecuteTool returns true for ALL tools at IDLE (engine.ts:110). So the surface's headline feature — 'PreToolUse hooks actively BLOCK Write/Edit before PLAN and destructive Bash before COMPLETE' — NEVER binds during MCP/CLI-driven work. The gate only fired in manual testing because the state file was hand-edited. SECONDARY (Bug 4): the bash non-destructive whitelist (engine.ts) omits npm/node/tsc/jest/git-status, so even if the state advanced correctly, builds and tests could not run at VERIFY (destructive bash requires COMPLETE) — making VERIFY an unreachable step for real verification and forcing a premature COMPLETE. Net: the workflow cannot actually be 'followed' as documented.

## Plan
- [ ] Add a workflow.advance path: expose advance(nextStep) through the MCP mdocs tool and the CLI (e.g. 'mdocs step <next>' or auto-advance on lifecycle events)
- [ ] Decide the trigger model: explicit step command vs implicit advancement tied to initiative lifecycle (create->UNDERSTAND, plan recorded->PLAN, done->COMPLETE)
- [ ] Fix the bash gate so verification commands run: expand the non-destructive whitelist (npm, node, tsc, jest, git status/diff/log) OR switch to a destructive-mutation blacklist (rm, mv, cp -f, git commit/push, write redirects) so VERIFY can build/test before COMPLETE
- [ ] Add tests: assert advance is reachable via MCP and CLI; assert npm build/jest are permitted at VERIFY
- [ ] Update mdocs-workflow and mdocs-orchestrator skills + README to document how the workflow actually advances
- [ ] Dogfood end-to-end: drive a real initiative through all 9 steps with enforcement binding

## Progress Log
- [2026-06-22T20:55:11.250Z] Created initiative via mdocs command
- [2026-06-22T21:07:47.667Z] bash executed at step VERIFY
- [2026-06-22T21:08:52.313Z] edit executed at step VERIFY
- [2026-06-22T21:09:03.968Z] edit executed at step VERIFY
- [2026-06-22T21:11:50.906Z] bash executed at step VERIFY
- [2026-06-22T21:12:06.508Z] bash executed at step COMPLETE
- Shipped driver + bash-gate fix. Registry workflow.advance (validates step, calls engine.advance), CLI 'mdocs step', MCP mdocs_advance tool, operations.advance wrapper. Bash gate switched whitelist to destructive blacklist (rm/rmdir/mv, cp -f, git commit/push/reset/clean/rm, git checkout --/., npm publish, mkfs/dd/shred) so build/test run at VERIFY. Redirect detection dropped after dogfooding produced unavoidable false positives (echo labels, 2>&1, arrows) that locked out legit work including the session rebuild. Tests: workflow/commands/cli/mcp/gate updated, 292 pass. Dogfooded live: drove IDLE->VERIFY, ran build+test+validate at VERIFY, REPORT->COMPLETE.
- [2026-06-22T21:13:56.332Z] edit executed at step COMPLETE
- [2026-06-22T21:14:08.238Z] bash executed at step COMPLETE
- [2026-06-22T21:14:23.241Z] edit executed at step COMPLETE
- [2026-06-22T21:14:48.698Z] bash executed at step COMPLETE
- [2026-06-22T21:14:52.550Z] Marked done via mdocs command

## Artifacts
