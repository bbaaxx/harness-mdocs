---
id: "publish-harness-mdocs-0-4-1"
title: "Publish harness-mdocs 0.4.1"
status: "active"
created: "2026-06-20"
updated: "2026-06-20"
owner: ""
tags: ["release","npm","version-0.4.1","publishing"]
related_wiki: []
priority: "medium"
---

## Objective
Publish harness-mdocs version 0.4.1 to npm using the new tag-based Trusted Publishers workflow.

## Plan
1. Bump package version to 0.4.1 without creating a local npm tag.
2. Run local release validation.
3. Commit and push version/release metadata to main and staging.
4. Create and push git tag v0.4.1.
5. Approve and watch GitHub Publish workflow.
6. Verify npm shows harness-mdocs@0.4.1.
7. Record release result and mark initiative done.

## Progress Log
- [2026-06-20T19:28:36.177Z] Created initiative via mdocs command
- Bumped package version to 0.4.1 using `npm version 0.4.1 --no-git-tag-version`. Confirmed `harness-mdocs@0.4.1` is not currently on npm. Initial `npm run release:check` failed because Claude plugin metadata still had 0.4.0. Updated `.claude-plugin/marketplace.json` and `src/surfaces/claude-code/plugin/.claude-plugin/plugin.json` to 0.4.1. Reran `npm run release:check`; it passed, including tests, coverage, mdocs validation, and pack dry-run for `harness-mdocs-0.4.1.tgz`.

## Artifacts
