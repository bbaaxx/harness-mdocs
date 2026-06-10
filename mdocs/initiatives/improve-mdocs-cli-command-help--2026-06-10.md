---
id: "improve-mdocs-cli-command-help"
title: "Improve mdocs CLI Command Help"
status: "done"
created: "2026-06-10"
updated: "2026-06-10"
owner: ""
tags: ["cli","docs","usability","mdocs"]
related_wiki: ["testing/mdocs-cli-command-help"]
priority: "medium"
phase: "done"
next_action: "No follow-up required; mdocs command help now documents aggregate command payload shapes."
---

## Objective
Make mdocs CLI help clearer for command subcommands, especially payload shapes for initiative.update, wiki.create, and wiki.update.

## Plan
- [ ] Inspect current CLI help and command dispatch behavior
- [ ] Define expected help output for mdocs command --help and common subcommands
- [ ] Implement concise CLI help text without changing command semantics
- [ ] Add or update tests for help output and payload-shape guidance
- [ ] Run targeted Codex/CLI tests, build, and mdocs validate

## Progress Log
- [2026-06-10T15:29:03.284Z] Created initiative via mdocs command
- [2026-06-10T16:05:00Z] PASS: Implemented concise CLI help for mdocs command --help and command-specific --help paths. Behavior: help exits 0 with plain text examples for initiative.create, initiative.update, wiki.create, and wiki.update; unsupported command names without --help still return the existing registry JSON error. Clarified that initiative.update supports metadata changes under updates while progressNote remains top-level, and wiki.update uses top-level changed fields rather than an updates wrapper. Files changed: src/cli/index.ts, tests/core/cli.test.ts, plus mdocs initiative/wiki memory. Verification: npm test -- tests/core/cli.test.ts --runInBand PASS (8 tests); npm run test:codex PASS (2 suites, 4 tests); npm run build PASS; PATH=$PWD/.agents/bin:$PATH mdocs command --help PASS; PATH=$PWD/.agents/bin:$PATH mdocs command wiki.update --help PASS; PATH=$PWD/.agents/bin:$PATH mdocs validate PASS before memory updates. Follow-ups: none.
- [2026-06-10T15:32:19.191Z] Marked done via mdocs command

## Artifacts
