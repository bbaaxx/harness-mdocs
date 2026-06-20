---
id: "add-tag-based-npm-publishing"
title: "Add tag based npm publishing"
status: "done"
created: "2026-06-19"
updated: "2026-06-20"
owner: ""
tags: ["ci","publishing","npm","release","github-actions"]
related_wiki: ["release/tag-based-npm-publishing"]
priority: "medium"
---

## Objective
Add Phase 2 GitHub Actions publishing for harness-mdocs so version tags publish the package after release environment approval and successful pre-publish checks.

## Plan
1. Add a tag-triggered publish workflow for `v*` tags.
2. Require the existing `release` environment before publishing.
3. Run `npm run release:check` in the publish job before `npm publish`.
4. Verify the pushed tag matches `package.json` version.
5. Configure npm auth with `NPM_TOKEN` and npm provenance via `id-token: write`.
6. Keep `release-check.yml` for main/manual pre-publish checks and avoid duplicate tag workflows.
7. Validate workflow syntax and local release checks, then document required GitHub/NPM setup.

## Progress Log
- [2026-06-19T23:14:20.350Z] Created initiative via mdocs command
- Started Phase 2 publishing work. Current npm package version is 0.4.0 and already published. Current release-check workflow handles main/tags as pre-publish only; publishing workflow should take over `v*` tags to avoid duplicate tag runs and approvals.
- Implemented Phase 2 publishing locally. Added `.github/workflows/publish.yml` for `v*` tags and manual dispatch with tag input. Publish job uses the `release` environment, Node 24, npm registry setup, `NPM_TOKEN`, `id-token: write`, tag/package version guard, existing-version guard, `npm run release:check`, then `npm publish --provenance --access public`. Removed `v*` tag trigger from `release-check.yml` to avoid duplicate tag workflows/approvals. Added stable wiki `release/tag-based-npm-publishing` and updated Phase 1 CI wiki. Validation passed: actionlint, npm run release:check, and mdocs_validate.
- [2026-06-20T18:58:04.435Z] Marked done via mdocs command

## Artifacts
