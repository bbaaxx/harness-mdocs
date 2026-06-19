---
id: "fix-github-actions-node-runtime-warning"
title: "Fix GitHub Actions Node runtime warning"
status: "active"
created: "2026-06-19"
updated: "2026-06-19"
owner: ""
tags: ["ci","github-actions","node","warning"]
related_wiki: []
priority: "medium"
---

## Objective
Remove GitHub Actions Node runtime deprecation warnings by updating workflow action versions and include Node 24 in CI coverage while preserving Node 18 minimum compatibility.

## Plan


## Progress Log
- [2026-06-19T23:34:24.561Z] Created initiative via mdocs command
- Updated workflows to use `actions/checkout@v5` and `actions/setup-node@v5`, which addresses the GitHub action runtime deprecation warning. Added Node 24 to CI matrix while preserving Node 18 and 20. Updated release check to run on Node 24. Validation passed: actionlint, npm run quality, and mdocs_validate.

## Artifacts
