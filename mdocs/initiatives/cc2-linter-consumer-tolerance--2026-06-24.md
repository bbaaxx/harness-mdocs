---
id: "cc2-linter-consumer-tolerance"
title: "cc2 linter tolerance for metadata-only initiatives + consumer wiki frontmatter"
status: "done"
created: "2026-06-24"
updated: "2026-06-25"
owner: ""
tags: ["core","linter","compat","wiki","lifecycle"]
related_wiki: ["reference/consumer-schema-compat"]
priority: "medium"
---

## Objective
Make `MdocsLinter` tolerant of the consumer schema. For metadata-only initiatives, skip the body-section requirements (Objective/Plan/Context/Acceptance/Progress Log) and the id/title/created required-field errors, while still emitting lifecycle telemetry warnings (using `readExpectedDurationRaw`). For wiki pages, derive expected `category` from the parent directory and accept a singular/plural match (e.g. `system` matches dir `systems`), make `created` optional (fallback `updated`), and keep the missing-`tags` check informational. Depends on cc0. Default `full` mode unchanged.

## Plan
- [x] In `src/core/validation/linter.ts` `lintInitiative` (lines ~232-306): when the linter's contract is `metadata-only`, gate off the body-section and required-field deductions; keep lifecycle telemetry (lines ~308-347) and switch the expected-duration read at line ~314 to `readExpectedDurationRaw`.
- [x] In `lintWiki` (lines ~368-423): derive expected category from the parent dir and accept singular/plural equality; make `created` optional with `updated` fallback; demote the missing-`tags` consequence to non-fatal.
- [x] Update `tests/core/linter.test.ts` and `tests/core/lifecycle-lint.test.ts` for the new tolerant outcomes; add cases for a metadata-only initiative scoring pass and a singular-category wiki page not warning.

## Progress Log
- [2026-06-24] IMPLEMENTED + verified. lintInitiative metadata-only skips body-section + required-field deductions, keeps lifecycle telemetry (long-running-active/stale-complete/graduation-due, no score deduction) via readExpectedDurationRaw; lintWiki derives expected category from parent dir with singular/plural tolerance, optional created (updated fallback), non-fatal missing-tags. Default full mode unchanged. +tests in linter.test.ts, lifecycle-lint.test.ts.
- [2026-06-25T08:52:17.593Z] Marked done via mdocs command
- [2026-06-25] State healed: implementation re-verified; linked stable consumer-schema compatibility wiki.

## Artifacts
