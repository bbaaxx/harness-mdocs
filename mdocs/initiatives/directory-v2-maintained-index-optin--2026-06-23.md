---
id: "directory-v2-maintained-index-optin"
title: "Maintained lowercase index.md/log.md in directory-v2 (opt-in)"
status: "done"
created: "2026-06-23"
updated: "2026-06-23"
owner: ""
tags: ["core","wiki","index","directory-v2","contract","0.4.3"]
related_wiki: ["architecture/wiki-index-ownership"]
priority: "medium"
---

## Objective
Provide an opt-in mode for harness-mdocs to maintain the lowercase canonical wiki/index.md in directory-v2 projects while keeping external ownership as the safe default.

## Plan
- [ ] Allow wikiIndexMode canonical-lowercase plus explicit wikiIndexOwner harness override in src/core/contract.ts
- [ ] Implement a lowercase-canonical index generator in src/core/managers/wiki.ts matching the grouped status-tagged format
- [ ] Make index.sync regenerate lowercase index.md only when owner equals harness and no-op when external
- [ ] Add directory-v2 fixture test for opt-in regeneration and default byte-stable no-op

## Progress Log
- [2026-06-23T03:38:06.130Z] Created initiative via mdocs command
- [2026-06-23] G5 IMPLEMENTED + VERIFIED via executor. contract.ts: WikiIndexMode adds 'canonical-lowercase'; IndexOwner='harness'|'external'|'none'; wikiIndexOwner field + validateWikiIndexOwner (harness permitted for generated-uppercase+canonical-lowercase; external only canonical-lowercase; default external for dir-v2). wiki.ts: every index.sync path gated on wikiIndexOwner!=='harness' => no-op (L362/529/650); generateLowercaseCanonicalIndex() (L696) matches existing grouped/status-tagged format (no consumer churn). Tests extended: tests/core/directory-v2-writes.test.ts + compatibility.test.ts (opt-in regeneration + default byte-stable no-op). 330 tests pass. release:check RC_EXIT=0 (build:plugin+lint+test+coverage+mdocs:validate+pack). Non-breaking (default external=no-op). Note: WIKI index ownership; does not touch initiatives/INDEX.md drift (separate data-hygiene item).
- [2026-06-23T18:55:33.310Z] Marked done via mdocs command

## Artifacts
