---
id: "prepare-release-0-6-0"
title: "Prepare release 0.6.0"
status: "active"
created: "2026-06-26"
updated: "2026-06-26"
owner: ""
tags: ["release","0.6.0","packaging","pi"]
related_wiki: ["release/harness-mdocs-0-6-0"]
---

## Objective
Prepare harness-mdocs 0.6.0 release from staging, including version bump, release notes, validation, and packaging checks.

## Plan
- [x] Bump package.json and package-lock.json from 0.5.3 to 0.6.0.
- [x] Bump Claude plugin marketplace and plugin manifest versions to 0.6.0.
- [x] Add release wiki entry for harness-mdocs 0.6.0.
- [x] Run `npm run release:check`.
- [ ] Commit release metadata on staging.
- [ ] Open/merge release PR to main, then tag `v0.6.0` and push to trigger publish workflow.


## Progress Log
- [2026-06-26T03:00:34.300Z] Created initiative via mdocs command
- [2026-06-26] Started release prep from staging after pi surface PR #6 merged and staging CI passed.
- [2026-06-26] Bumped package metadata to 0.6.0 and added release wiki entry.
- [2026-06-26] `npm run release:check` passed: build:claude-plugin, lint/typecheck, 459 Jest tests, coverage, mdocs validate, and pack dry-run (`harness-mdocs-0.6.0.tgz`, 298 files, 765.4 kB package size).

## Artifacts
