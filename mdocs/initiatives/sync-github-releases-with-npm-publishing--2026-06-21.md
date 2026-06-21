---
id: "sync-github-releases-with-npm-publishing"
title: "Sync GitHub Releases with npm publishing"
status: "done"
created: "2026-06-21"
updated: "2026-06-21"
owner: ""
tags: ["release","github-actions","github-releases","npm","publishing"]
related_wiki: ["release/tag-based-npm-publishing","release/harness-mdocs-0-4-1"]
priority: "medium"
---

## Objective
Ensure tag-based npm publishing also creates the matching GitHub Release, and backfill the missing v0.4.1 GitHub Release.

## Plan
1. Check whether GitHub Release v0.4.1 exists.
2. Update publish workflow to create a GitHub Release after npm publish succeeds.
3. Create missing GitHub Release v0.4.1 with generated notes.
4. Validate workflow syntax and mdocs integrity.
5. Commit and push workflow/docs changes.
6. Verify GitHub Actions and release visibility.
7. Record result and mark done.

## Progress Log
- [2026-06-21T13:47:06.418Z] Created initiative via mdocs command
- Confirmed GitHub Release `v0.4.1` was missing. Updated `.github/workflows/publish.yml` so successful tag publish also creates the matching GitHub Release with `gh release create --generate-notes`. Changed workflow `contents` permission to `write`, retained `id-token: write`, and made npm publication status check idempotent so reruns skip `npm publish` when version already exists but still create a missing GitHub Release. Manually backfilled GitHub Release `v0.4.1`: https://github.com/bbaaxx/harness-mdocs/releases/tag/v0.4.1. `actionlint` passed.
- Committed and pushed workflow/docs change `e8c0484 ci: create GitHub Releases on publish`. GitHub checks passed: Release Check 27906404963 and CI 27906405624. Verified GitHub Release `v0.4.1` exists, is not draft/prerelease, and is visible at https://github.com/bbaaxx/harness-mdocs/releases/tag/v0.4.1.
- [2026-06-21T13:51:00.326Z] Marked done via mdocs command

## Artifacts
