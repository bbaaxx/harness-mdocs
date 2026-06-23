---
id: "remove-self-referential-devdependency"
title: "Package hygiene: self-referential devDependency"
status: "active"
created: "2026-06-23"
updated: "2026-06-23"
owner: ""
tags: ["packaging","hygiene","dependencies","0.4.3"]
related_wiki: []
---

## Objective
Remove the self-referential harness-mdocs devDependency from package.json and confirm the build, tests, and release checks remain clean.

## Plan
- [ ] Remove the harness-mdocs entry from package.json devDependencies
- [ ] Confirm no test or build file imports the package by its published name
- [ ] Run npm run quality and confirm it passes
- [ ] Run npm run release:check and confirm it passes

## Context
Source: Gap Closure Spec (0.4.3 / 0.5.0) G9. `package.json` lists `harness-mdocs: ^0.1.1` under `devDependencies`, a self-reference to an old published version that can resolve a stale copy into `node_modules`. Hotspots: `package.json`, `npm run quality`, `npm run release:check`.

## Acceptance Criteria
- Self-referential `harness-mdocs` entry is removed from `devDependencies`.
- No test or build file imports the package by its published name (imports use relative `src/`/`dist/` or `.agents/bin/mdocs`).
- `npm run quality` passes.
- `npm run release:check` passes.

## Progress Log
- [2026-06-23T03:38:23.889Z] Created initiative via mdocs command

## Artifacts
