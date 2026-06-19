---
id: "add-local-quality-tooling"
title: "Add local quality tooling"
status: "done"
created: "2026-06-19"
updated: "2026-06-19"
owner: ""
tags: ["tooling","lint","tests","coverage","quality"]
related_wiki: ["testing/local-quality-tooling"]
priority: "medium"
---

## Objective
Add simple local quality tooling for a single-developer open source project: linting, test orchestration, coverage reporting, and optionally lightweight complexity analysis if it adds little maintenance burden. Keep CI/CD integration out of scope for this initiative.

## Plan


## Progress Log
- [2026-06-19T19:08:19.384Z] Created initiative via mdocs command
- Inventory complete via subagent. Existing tooling has build/test scripts, Jest with ts-jest but no coverage config, TS strict config over src only, README Development section available. Plan updated to add simple local tooling and defer complexity analysis.
- Implemented local tooling: added typecheck/lint, surface test script for Claude Code, coverage, mdocs lint/validate, pack check, local quality aggregate, and release check scripts. Added Jest coverage config and README Development docs. Complexity analysis deferred to avoid extra dependencies. Verification passed: npm run quality and npm run release:check both completed successfully; coverage baseline all files 87.99% statements, 74.74% branches, 87.19% funcs, 91.29% lines.
- [2026-06-19T20:11:15.177Z] Marked done via mdocs command

## Artifacts
