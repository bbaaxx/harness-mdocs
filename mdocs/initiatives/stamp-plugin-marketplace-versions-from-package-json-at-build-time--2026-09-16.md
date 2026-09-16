---
id: "stamp-plugin-marketplace-versions-from-package-json-at-build-time"
title: "Stamp plugin + marketplace versions from package.json at build time"
status: "done"
created: "2026-09-16"
updated: "2026-09-16"
owner: ""
tags: ["release","build","drift","tech-debt"]
related_wiki: ["release/version-stamping"]
priority: "medium"
---

## Objective
Eliminate manual version duplication across manifests. v2.0.0 release required hand-editing package.json, src/surfaces/claude-code/plugin/.claude-plugin/plugin.json, and .claude-plugin/marketplace.json — same class of drift bug as the gitSha finding (fixed via build-time stamping). Goal: single source of truth (package.json version), everything else stamped or validated at build/release time.

## Plan


## Progress Log
- [2026-09-16T05:57:46.087Z] Created initiative via mdocs command
- [2026-09-16T08:45:58.790Z] mdocs_resume executed at step COMPLETE
- [2026-09-16T08:46:18.840Z] read executed at step COMPLETE
- [2026-09-16T08:46:35.930Z] mdocs_advance executed at step COMPLETE
- [2026-09-16T08:46:37.469Z] bash executed at step COMPLETE
- [2026-09-16T08:47:46.772Z] mdocs_advance executed at step UNDERSTAND
- [2026-09-16T08:48:07.961Z] mdocs_advance executed at step DISCOVER
- [2026-09-16T08:48:08.000Z] read executed at step DISCOVER
- [2026-09-16T08:48:08.015Z] read executed at step DISCOVER
- [2026-09-16T08:48:08.030Z] read executed at step DISCOVER
- [2026-09-16T08:48:34.786Z] mdocs_advance executed at step CONTEXT
- [2026-09-16T08:48:35.109Z] bash executed at step CONTEXT
- [2026-09-16T08:48:55.325Z] bash executed at step CONTEXT
- [2026-09-16T08:49:09.872Z] bash executed at step CONTEXT
- [2026-09-16T08:49:36.475Z] mdocs_advance executed at step PLAN
- [2026-09-16T08:49:41.166Z] edit executed at step PLAN
- [2026-09-16T08:49:53.915Z] mdocs_advance executed at step EXECUTE
- [2026-09-16T08:50:06.176Z] write executed at step EXECUTE
- [2026-09-16T08:50:30.956Z] edit executed at step EXECUTE
- [2026-09-16T08:50:31.088Z] edit executed at step EXECUTE
- [2026-09-16T08:50:33.709Z] edit executed at step EXECUTE
- [2026-09-16T08:50:43.915Z] mdocs_advance executed at step VERIFY
- [2026-09-16T08:50:46.171Z] bash executed at step VERIFY
- [2026-09-16T08:51:06.721Z] bash executed at step VERIFY
- [2026-09-16T08:51:28.602Z] bash executed at step VERIFY
- [2026-09-16T08:52:50.444Z] bash executed at step VERIFY
- [2026-09-16T08:53:14.205Z] bash executed at step VERIFY
- [2026-09-16T08:53:37.517Z] read executed at step VERIFY
- [2026-09-16T08:54:07.232Z] edit executed at step VERIFY
- [2026-09-16T08:54:27.866Z] mdocs_advance executed at step REPORT
- [2026-09-16T08:54:36.670Z] mdocs executed at step REPORT
- [2026-09-16T08:54:57.838Z] edit executed at step REPORT
- Implemented scripts/stamp-versions.js (idempotent surgical stamp of package.json version into plugin.json + marketplace.json; --check mode for CI). Wired: build runs it after write-build-info; new check:versions added to quality. Verified: in-sync no-op, drift detection exit=1, restore, git clean; npm run build + 1546 tests pass. Docs note added to docs/packaging-strategy.md publish checklist. Wiki release/version-stamping created.
- [2026-09-16T08:54:58.091Z] mdocs executed at step REPORT
- [2026-09-16T08:55:11.429Z] mdocs_validate executed at step REPORT
- [2026-09-16T08:55:26.528Z] mdocs_advance executed at step COMPLETE
- [2026-09-16T09:03:59.107Z] Marked done via mdocs command

## Artifacts
