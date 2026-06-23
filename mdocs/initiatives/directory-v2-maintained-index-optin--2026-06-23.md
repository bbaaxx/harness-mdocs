---
id: "directory-v2-maintained-index-optin"
title: "Maintained lowercase index.md/log.md in directory-v2 (opt-in)"
status: "active"
created: "2026-06-23"
updated: "2026-06-23"
owner: ""
tags: ["core","wiki","index","directory-v2","contract","0.4.3"]
related_wiki: []
---

## Objective
Provide an opt-in mode for harness-mdocs to maintain the lowercase canonical wiki/index.md in directory-v2 projects while keeping external ownership as the safe default.

## Plan
- [ ] Allow wikiIndexMode canonical-lowercase plus explicit wikiIndexOwner harness override in src/core/contract.ts
- [ ] Implement a lowercase-canonical index generator in src/core/managers/wiki.ts matching the grouped status-tagged format
- [ ] Make index.sync regenerate lowercase index.md only when owner equals harness and no-op when external
- [ ] Add directory-v2 fixture test for opt-in regeneration and default byte-stable no-op

## Context
Source: Gap Closure Spec (0.4.3 / 0.5.0) G5. In directory-v2 the contract sets `wikiIndexOwner: 'external'` in `src/core/contract.ts` and `index.sync` leaves lowercase `wiki/index.md` untouched. There is currently no opt-in for harness to maintain it. Hotspots: `src/core/contract.ts`, `src/core/managers/wiki.ts`, and directory-v2 fixture tests.

## Acceptance Criteria
- `wikiIndexMode: 'canonical-lowercase'` plus explicit `wikiIndexOwner: 'harness'` is accepted in the contract.
- `index.sync` regenerates lowercase `wiki/index.md` only when owner equals `harness`; default external owner remains a no-op.
- Generated format matches grouped/status-tagged style so it does not churn diffs for consumers already using that style.
- Directory-v2 fixture proves opt-in regeneration and default byte-stable no-op.

## Progress Log
- [2026-06-23T03:38:06.130Z] Created initiative via mdocs command

## Artifacts
