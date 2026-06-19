---
id: "quiet-ci-warning-logs"
title: "Quiet CI warning logs"
status: "active"
created: "2026-06-19"
updated: "2026-06-19"
owner: ""
tags: ["ci","dependencies","logs","warnings","maintenance"]
related_wiki: []
priority: "medium"
---

## Objective
Reduce non-actionable warnings in GitHub Actions logs, especially action-internal Node deprecation noise and npm deprecated dependency warnings, without hiding meaningful test or coverage failures.

## Plan


## Progress Log
- [2026-06-19T23:50:16.976Z] Created initiative via mdocs command
- Implemented warning reductions. Upgraded Jest from 29 to 30.4.2, which reduces old dependency usage and keeps ts-jest compatibility. Updated CI install steps to `npm ci --loglevel=error` to suppress non-actionable npm deprecated install warnings. Added `NODE_OPTIONS=--no-deprecation` only to checkout/setup-node action steps to suppress action-internal Node deprecation noise without hiding runtime/test warnings. Validation passed: actionlint, npm run quality, npm run release:check, and mdocs_validate.
- Reviewed final diff. Changes are scoped to GitHub workflow warning controls, Jest dependency upgrade, lockfile refresh, and mdocs initiative tracking. Remaining deprecated glob/inflight chain is isolated under ts-jest -> babel-plugin-istanbul -> test-exclude and is hidden from CI install output by npm loglevel without suppressing test/runtime failures.

## Artifacts
