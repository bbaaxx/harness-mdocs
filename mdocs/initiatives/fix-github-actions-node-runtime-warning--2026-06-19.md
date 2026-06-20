---
id: "fix-github-actions-node-runtime-warning"
title: "Fix GitHub Actions Node runtime warning"
status: "done"
created: "2026-06-19"
updated: "2026-06-20"
owner: ""
tags: ["ci","github-actions","node","warning"]
related_wiki: ["release/ci-warning-log-hygiene"]
priority: "medium"
---

## Objective
Remove GitHub Actions Node runtime deprecation warnings by updating workflow action versions and include Node 24 in CI coverage while preserving Node 18 minimum compatibility.

## Plan
1. Update workflow actions to current runtimes.
2. Preserve package Node 18 compatibility while adding Node 24 CI coverage.
3. Run local workflow and quality validation.
4. Verify GitHub Actions runs pass and original runtime warning is absent.
5. Record stable learning and mark done.

## Progress Log
- [2026-06-19T23:34:24.561Z] Created initiative via mdocs command
- Updated workflows to use `actions/checkout@v5` and `actions/setup-node@v5`, which addresses the GitHub action runtime deprecation warning. Added Node 24 to CI matrix while preserving Node 18 and 20. Updated release check to run on Node 24. Validation passed: actionlint, npm run quality, and mdocs_validate.
- Quick review confirmed objective is complete. Workflows use `actions/checkout@v5` and `actions/setup-node@v5`; CI matrix covers Node 18.x, 20.x, and 24.x; release check runs on Node 24.x. Latest GitHub Actions passed: Release Check 27853916272 and CI 27853916874. Log scan found no `forced to run`, `Node.js 20`, `Node.js 24`, `punycode`, or `url.parse` runtime warning text.
- [2026-06-20T04:39:56.085Z] Marked done via mdocs command

## Artifacts
