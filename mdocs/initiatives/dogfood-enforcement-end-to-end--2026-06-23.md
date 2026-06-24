---
id: "dogfood-enforcement-end-to-end"
title: "End-to-end enforcement dogfood on a real multi-step initiative"
status: "done"
created: "2026-06-23"
updated: "2026-06-23"
owner: ""
tags: ["claude-code","workflow","enforcement","dogfood","verification","0.4.3"]
related_wiki: ["docs/workflow-enforcement-dogfood-friction-log"]
priority: "medium"
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

## Progress Log
- [2026-06-23T03:38:16.436Z] Created initiative via mdocs command
- [2026-06-23T04:21:54.337Z] Marked done via mdocs command

## Artifacts
