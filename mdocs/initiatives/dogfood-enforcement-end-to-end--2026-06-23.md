---
id: "dogfood-enforcement-end-to-end"
title: "End-to-end enforcement dogfood on a real multi-step initiative"
status: "active"
created: "2026-06-23"
updated: "2026-06-23"
owner: ""
tags: ["claude-code","workflow","enforcement","dogfood","verification","0.4.3"]
related_wiki: []
---

## Objective
Drive a real non-trivial initiative through every workflow step in a live Claude Code session to validate the enforcement gate binds correctly and capture friction notes that inform G3.

## Plan
- [ ] Select a real multi-step initiative already tracked in mdocs
- [ ] Drive the initiative through all nine steps using mdocs_advance
- [ ] Confirm Write and Edit tools are blocked before PLAN and allowed after
- [ ] Confirm non-destructive build/test bash runs at VERIFY and destructive bash is blocked until COMPLETE
- [ ] Confirm PostToolUse progress and audit append under lock without lost updates under parallel calls
- [ ] Record friction points and feed them into initiative configurable-workflow-enforcement

## Context
Source: Gap Closure Spec (0.4.3 / 0.5.0) G7. The workflow driver only became functional in commit `ccf2f0d` (2026-06-22) via initiative `workflow-state-machine-has-no-driver`. The headline enforcement feature has had near-zero real-world exercise and must be validated before building on top. This is a verification initiative, not a code change.

## Acceptance Criteria
- One real multi-step initiative is driven through all nine workflow steps in a live Claude Code session.
- Write/Edit are blocked before PLAN and allowed after; the block reason reaches the model.
- Non-destructive build/test bash runs at VERIFY; destructive bash (`rm`, `git commit`) is blocked until COMPLETE.
- PostToolUse progress and audit append under lock with no lost updates under parallel calls.
- Friction notes are recorded and referenced from `configurable-workflow-enforcement`.

## Progress Log
- [2026-06-23T03:38:16.436Z] Created initiative via mdocs command

## Artifacts
