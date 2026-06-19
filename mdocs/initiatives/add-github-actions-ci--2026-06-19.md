---
id: "add-github-actions-ci"
title: "Add GitHub Actions CI"
status: "done"
created: "2026-06-19"
updated: "2026-06-19"
owner: ""
tags: ["ci","github-actions","quality","coverage","automation"]
related_wiki: ["release/github-actions-phase-1-ci"]
priority: "medium"
---

## Objective
Add phased GitHub Actions CI/CD for harness-mdocs. Phase 1 gates developer integration through staging and pre-publish validation through release without publishing. Phase 2 will add actual package publishing on version tags.

## Plan


## Progress Log
- [2026-06-19T22:00:01.431Z] Created initiative via mdocs command
- User clarified CI/CD rollout should be phased: Phase 1 handles staging integration and release/pre-publish validation without publishing; Phase 2 handles actual publishing. Developers integrate on staging, main freezes version, publishing happens when tagging a version.
- Implemented Phase 1 GitHub Actions CI/CD. Added `.github/workflows/ci.yml` for PRs targeting staging and pushes to staging; staging pushes use the `staging` environment and run `npm run quality` on Node 18/20. Added `.github/workflows/release-check.yml` for pushes to main, `v*` tags, and manual dispatch; release checks use the `release` environment and run `npm run release:check` without publishing. Documented flow in README and docs/packaging-strategy.md. Validation passed: actionlint, npm run quality, npm run release:check, and mdocs_validate.
- [2026-06-19T23:20:38.082Z] Marked done via mdocs command
- Initial GitHub Actions test failed on clean checkout. Root causes: `npm run quality` did not generate Claude plugin dist before tests, and stale-index tests relied on filesystem mtime granularity. Fixed by making `quality` run `build:claude-plugin` first and setting future mtimes in stale index tests. Local `npm run quality` and `mdocs_validate` pass after fix.

## Artifacts
