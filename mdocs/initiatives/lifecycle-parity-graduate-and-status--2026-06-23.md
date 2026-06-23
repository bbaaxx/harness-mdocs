---
id: "lifecycle-parity-graduate-and-status"
title: "Lifecycle parity: complete status, graduate, long-running warnings"
status: "active"
created: "2026-06-23"
updated: "2026-06-23"
owner: ""
tags: ["core","lifecycle","validation","initiative-status","0.5.0"]
related_wiki: []
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

## Context
Source: Gap Closure Spec (0.4.3 / 0.5.0) G4. `src/core/initiative-store.ts` collapses status to `active | paused | done`. A mature process needs `complete` surfaced distinctly, graduation after 4 weeks, and expected-duration long-running warnings. Hotspots: `src/core/initiative-store.ts`, `src/core/managers/initiative.ts`, `src/core/validation/linter.ts`, and `src/core/commands/registry.ts`.

## Acceptance Criteria
- `complete` is a distinct surfaced state for directory-v2; flat-v1 `done` alias remains unchanged.
- `expectedDuration` (`normal`/`long`/`suppress`) is read/written and respected by long-running warnings.
- `mdocs validate` reports `long-running-active`, `stale-complete`, and `graduation-due` with fixtures proving each fires and clears.
- `lifecycle.graduate` moves the initiative entry between overview sections and appends `graduate | <slug>` to `log.md` without touching other pages.

## Progress Log
- [2026-06-23T03:38:01.199Z] Created initiative via mdocs command

## Artifacts
