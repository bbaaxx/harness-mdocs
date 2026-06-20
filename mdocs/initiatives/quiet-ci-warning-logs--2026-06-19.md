---
id: "quiet-ci-warning-logs"
title: "Quiet CI warning logs"
status: "done"
created: "2026-06-19"
updated: "2026-06-19"
owner: ""
tags: ["ci","dependencies","logs","warnings","maintenance"]
related_wiki: ["release/ci-warning-log-hygiene"]
priority: "medium"
---

## Objective
Reduce non-actionable warnings in GitHub Actions logs, especially action-internal Node deprecation noise and npm deprecated dependency warnings, without hiding meaningful test or coverage failures.

## Plan
1. Identify remaining CI warning sources.
2. Prefer dependency upgrades where safe; avoid broad suppression.
3. Update workflow install/action steps to quiet non-actionable warnings only.
4. Validate locally with actionlint, quality, release:check, and mdocs validation.
5. Commit, push main and staging, then verify GitHub Actions logs stay clean.

## Progress Log
- [2026-06-19T23:50:16.976Z] Created initiative via mdocs command
- Implemented warning reductions. Upgraded Jest from 29 to 30.4.2, which reduces old dependency usage and keeps ts-jest compatibility. Updated CI install steps to `npm ci --loglevel=error` to suppress non-actionable npm deprecated install warnings. Added `NODE_OPTIONS=--no-deprecation` only to checkout/setup-node action steps to suppress action-internal Node deprecation noise without hiding runtime/test warnings. Validation passed: actionlint, npm run quality, npm run release:check, and mdocs_validate.
- Reviewed final diff. Changes are scoped to GitHub workflow warning controls, Jest dependency upgrade, lockfile refresh, and mdocs initiative tracking. Remaining deprecated glob/inflight chain is isolated under ts-jest -> babel-plugin-istanbul -> test-exclude and is hidden from CI install output by npm loglevel without suppressing test/runtime failures.
- Pushed commit 0aa0d55 (`ci: quiet non-actionable warnings`) to main and staging. GitHub Actions passed: Release Check 27853760656 and CI 27853761186. Log scan confirmed npm deprecation warnings, action Node runtime warning, punycode, and url.parse warnings were gone. Found residual Git checkout init.defaultBranch hint, then added pre-checkout `git config --global init.defaultBranch main` in all workflow jobs and pushed commit 24dbf8b (`ci: suppress checkout branch hint`). Final GitHub Actions passed: Release Check 27853823150 and CI 27853823521. Final log scan found no target deprecation/npm/action warnings; only expected JSON `warnings: []` and tar flag text.
- [2026-06-19T23:59:21.096Z] Marked done via mdocs command
- Created stable wiki learning `release/ci-warning-log-hygiene` covering dependency-first warning cleanup, scoped action deprecation suppression, checkout initial-branch hint suppression, and GitHub log scan pattern.

## Artifacts
