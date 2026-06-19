---
id: "prepare-release-0-4-0"
title: "Prepare release 0.4.0"
status: "done"
created: "2026-06-19"
updated: "2026-06-19"
owner: ""
tags: ["release","npm","version-0.4.0"]
related_wiki: ["release/harness-mdocs-0-4-0"]
priority: "medium"
---

## Objective
Prepare repository for npm release version 0.4.0 without running publish command requiring 2FA.

## Plan
- [x] Inspect release metadata, scripts, and git state.
- [x] Update version and plugin metadata for 0.4.0.
- [x] Run build, tests, pack dry run, and mdocs validation.
- [x] Prepare release artifact and human publish instructions; do not run `npm publish`.
- [ ] Offer commit and mark initiative done after user confirms.

## Progress Log
- [2026-06-19T18:44:12.414Z] Created initiative via mdocs command
- Planned release preparation workflow; publish command excluded due npm 2FA.
- Prepared 0.4.0 release metadata. Bumped package.json and package-lock.json from 0.3.0 to 0.4.0, synchronized Claude plugin marketplace/plugin versions to 0.4.0 after test caught drift, and created release wiki artifact release/harness-mdocs-0-4-0. Verification passed: npm run build; npm test -- --runInBand (26 suites, 268 tests); npm --cache .npm-cache pack --dry-run (harness-mdocs-0.4.0.tgz, 227 files); mdocs_validate valid. Did not run npm publish due 2FA.
- User ran npm publish with 2FA successfully. Verified npm registry reports harness-mdocs latest/version as 0.4.0.
- [2026-06-19T18:49:17.993Z] Marked done via mdocs command

## Artifacts
- [[release/harness-mdocs-0-4-0]]