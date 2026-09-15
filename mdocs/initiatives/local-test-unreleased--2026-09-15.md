---
id: "local-test-unreleased"
title: "Local test of unreleased build before v2.0.0"
status: "done"
created: "2026-09-15"
updated: "2026-09-15"
owner: ""
tags: ["testing","release-prep"]
related_wiki: []
priority: "medium"
---

## Objective
Install the latest unreleased harness-mdocs version in this workspace and run local tests to confirm it works, as a prerequisite for the v2.0.0 release.

## Plan


## Progress Log
- [2026-09-15T06:02:38.066Z] Created initiative via mdocs command
- [2026-09-15T06:02:50.526Z] mdocs_resume executed at step COMPLETE
- [2026-09-15T06:34:38.697Z] glob executed at step COMPLETE
- [2026-09-15T06:34:38.733Z] bash executed at step COMPLETE
- [2026-09-15T06:35:10.052Z] read executed at step COMPLETE
- [2026-09-15T06:35:49.513Z] bash executed at step COMPLETE
- [2026-09-15T06:36:25.834Z] bash executed at step COMPLETE
- [2026-09-15T06:37:00.669Z] bash executed at step COMPLETE
- [2026-09-15T06:38:31.994Z] bash executed at step COMPLETE
- [2026-09-15T06:40:03.743Z] bash executed at step COMPLETE
- Step 1-3 complete. HEAD fbd5181 (29 commits past v0.8.1, manifest still 0.8.1). Rebuilt dist/ via `npm run build` (tsc clean). Full jest suite: 64/64 suites, 1539/1539 tests pass in ~59s. Smoke checks: `node dist/cli/index.js validate` clean; MCP server boots and answers initialize handshake (serverInfo mdocs@1.0.0). Workspace consumes unreleased build via .mcp.json → dist/cli/index.js. No regressions found; unreleased build verified and installed for v2.0.0 prep.
- [2026-09-15T06:40:35.287Z] mdocs executed at step COMPLETE
- [2026-09-15T06:40:58.601Z] Marked done via mdocs command

## Artifacts
