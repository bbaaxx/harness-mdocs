---
id: "fresh-codex-thread-plugin-smoke-test"
title: "Fresh Codex Thread Plugin Smoke Test"
status: "done"
created: "2026-06-10"
updated: "2026-06-10"
owner: ""
tags: ["codex","plugin","smoke-test"]
related_wiki: ["testing/codex-repo-dogfood"]
priority: "medium"
phase: "done"
next_action: "No remaining follow-up for the smoke-tested path; keep CLI-backed Codex v1 wording honest in future docs."
---

## Objective
Smoke-test the installed harness-mdocs Codex plugin in a fresh Codex thread and confirm the v1 plugin skills plus CLI-backed workflow are usable from startup.

## Plan
- [ ] Confirm installed Mdocs skills are visible from fresh thread
- [ ] Run required baseline status, validate, and plugin-list checks
- [ ] Exercise CLI-backed initiative create/update, wiki create/update, lookup/search, dispatch/resume, and validate
- [ ] Record deviations and implement small fixes only if clearly needed
- [ ] Run appropriate verification commands
- [ ] Update durable mdocs records and mark initiative done if fully validated

## Progress Log
- [2026-06-10T14:55:12.752Z] Created initiative via mdocs command
- [2026-06-10T14:56:00Z] Fresh thread can read installed Mdocs skills from mdocs@harness-mdocs-local, including mdocs-orchestrator. Baseline commands passed: PATH=$PWD/.agents/bin:$PATH mdocs status returned IDLE with no active initiative; PATH=$PWD/.agents/bin:$PATH mdocs validate returned valid:true; codex plugin list showed mdocs@harness-mdocs-local installed and enabled. Deviation observed: codex plugin list emitted a PATH alias warning under sandboxed execution but still completed.
- [2026-06-10T14:58:00Z] PASS: CLI-backed workflow smoke tested from fresh Codex thread. Commands exercised: mdocs status, validate, command initiative.create/update, command wiki.create/update, lookup, search, dispatch, resume. Dispatch assembled initiative context plus related wiki; resume returned active initiative with validation payload. Finding fixed: mdocs-initiative skill docs did not show wiki.create/wiki.update examples and did not clarify that wiki.update fields are top-level, unlike initiative.update metadata changes under updates.
- [2026-06-10T14:57:30Z] Verification passed: npm run test:codex (2 suites, 4 tests), npm run build (tsc), and PATH=$PWD/.agents/bin:$PATH mdocs validate (valid:true with no warnings). Full npm test -- --runInBand was not run because the only source change was a narrow Codex skill documentation clarification. Files changed: mdocs initiative/wiki records and src/surfaces/codex/plugin/skills/mdocs-initiative/SKILL.md. Remaining follow-up: consider adding CLI help examples for wiki.update, since command --help currently returns an unsupported-command JSON payload rather than detailed subcommand usage.
- [2026-06-10T14:57:15.957Z] Marked done via mdocs command

## Artifacts
