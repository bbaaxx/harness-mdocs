---
id: "improve-test-coverage-and-lint-cleanliness"
title: "Improve test coverage and lint cleanliness"
status: "done"
created: "2026-06-19"
updated: "2026-06-19"
owner: ""
tags: ["tests","coverage","lint","quality","cleanup"]
related_wiki: ["testing/coverage-cleanup-2026-06-19","testing/branch-coverage-80-threshold","testing/coverage-thresholds-80-all-metrics"]
priority: "medium"
---

## Objective
Improve harness-mdocs test coverage and clean up lint/test warnings surfaced by local quality tooling, without adding CI/CD integration in this initiative.

## Plan


## Progress Log
- [2026-06-19T20:13:58.449Z] Created initiative via mdocs command
- Baseline `npm run quality` passed. Current coverage: 87.99% statements, 74.74% branches, 87.19% funcs, 91.29% lines. Test output has noisy DEBUG console.log in tests/core/wiki.test.ts. Weakest areas: src/cli/index.ts, src/surfaces/claude-code/mcp-server.ts, src/surfaces/opencode/tools.ts/hooks.ts, src/core/managers/mdocs.ts.
- Implemented focused coverage cleanup. Added CLI tests for unknown commands, invalid JSON parse errors, and MCP/hook delegation. Added Claude Code MCP convenience-tool test covering status, validate, search, lookup, dispatch, audit, index check/repair, and resume. Removed stray DEBUG console.log from wiki tests and ignored CLI executable wrapper as process side-effect boundary. `npm run quality` passed with 272 tests. Coverage improved from 87.99/74.74/87.19/91.29 to 89.59/75.49/93.16/92.58 (statements/branches/functions/lines).
- User approved working toward >80% branch coverage. Continuing this initiative with a focused branch-coverage sub-goal; CI/CD remains out of scope.
- Raised global branch coverage above 80% and added a Jest global branch threshold of 80. Added focused tests for core parsing/frontmatter, mdocs manager compatibility/index-meta branches, search filters/snippet branches, Claude Code MCP guard/startup branches, and OpenCode hook/status/tool catch branches. `npm run quality` passed with 285 tests and coverage 92.71% statements, 80.83% branches, 96.98% functions, 95.67% lines.
- Expanded coverage gate target from branch-only to all global coverage metrics >80: statements, branches, functions, and lines.
- Added Jest global coverage gates for all metrics at 80: statements, branches, functions, and lines. `npm run quality` passed with coverage 92.71% statements, 80.83% branches, 96.98% functions, 95.67% lines and 285 passing tests.
- [2026-06-19T20:47:50.051Z] Marked done via mdocs command

## Artifacts
