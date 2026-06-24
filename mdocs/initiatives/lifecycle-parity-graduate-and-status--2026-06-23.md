---
id: "lifecycle-parity-graduate-and-status"
title: "Lifecycle parity: complete status, graduate, long-running warnings"
status: "done"
created: "2026-06-23"
updated: "2026-06-24"
owner: ""
tags: ["core","lifecycle","validation","initiative-status","0.5.0"]
related_wiki: ["docs/lifecycle-parity-complete-graduate"]
priority: "medium"
---

## Objective
Extend the initiative lifecycle to support complete as a distinct surfaced state, expected durations, graduation of recently completed initiatives, and long-running/stale warnings in validation output.

## Plan
- [ ] Recognize complete as a distinct surfaced state in src/core/initiative-store.ts for directory-v2 while keeping done alias for flat-v1
- [ ] Add expectedDuration normal/long/suppress to read/write in src/core/managers/initiative.ts and initiative-store.ts
- [ ] Add lint checks in src/core/validation/linter.ts for long-running-active, stale-complete, and graduation-due
- [ ] Add lifecycle.graduate command in src/core/commands/registry.ts that moves overview sections and appends to log.md
- [ ] Update skills and README to document complete, expectedDuration, and graduate
- [ ] Add fixtures proving each lint rule fires and clears and graduate moves overview without touching other pages

## Progress Log
- [2026-06-23T03:38:01.199Z] Created initiative via mdocs command
- [2026-06-23] 0.4.3 checkpoint complete. G4 is 0.5.0, AFTER G2 (graduate moves overview.md sections + appends log.md = the grammar G2a introduces). Do not start until G2a lands. Scope: complete as distinct surfaced state (dir-v2) keeping done alias (flat-v1) in initiative-store.ts; expectedDuration normal/long/suppress in initiative.ts; 3 lint rules (long-running-active, stale-complete, graduation-due) in linter.ts; lifecycle.graduate command in registry.ts; skills+README docs; fixtures for each rule + graduate.
- [2026-06-24T01:24:36.074Z] Marked done via mdocs command

## Artifacts
