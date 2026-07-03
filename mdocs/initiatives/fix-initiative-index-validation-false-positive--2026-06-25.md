---
id: "fix-initiative-index-validation-false-positive"
title: "Fix initiative INDEX validation false positives for markdown filenames in titles"
status: "active"
created: "2026-06-25"
updated: "2026-07-03"
owner: ""
tags: ["validation","initiatives","index","bug","mdocs"]
related_wiki: []
priority: "medium"
phase: "planning"
next_action: "Patch InitiativeManager.validate() INDEX parsing so it extracts only the filename field from initiative INDEX bullet rows, then add regression tests and run targeted validation."
---

## Objective
Fix the initiative INDEX validator so it only validates actual initiative filename fields, not arbitrary `.md` tokens that appear in initiative titles such as `overview.md`, `log.md`, or `index.md`. Eliminate the current false warnings while preserving detection of genuinely missing initiative files.

## Plan
- [ ] Add a regression test in `tests/core/initiative.test.ts` (or closest existing initiative validation test) with an `mdocs/initiatives/INDEX.md` row whose title contains `overview.md`, `log.md`, and `index.md`, while the filename field is a real initiative file. Assert no missing-file warnings for those title tokens.
- [ ] Keep a negative regression in the same test: an INDEX row with an actual missing filename field such as `missing--2026-01-01.md` must still warn `INDEX.md lists missing initiative file: missing--2026-01-01.md`.
- [ ] Patch `src/core/managers/initiative.ts` around `InitiativeManager.validate()` lines ~462-471. Current code uses `/[\w.-]+\.md/g` over the entire INDEX, so markdown-looking words in titles are treated as initiative filenames. Replace with parsing for the documented flat-v1 row shape: `- **Title** (status) — filename.md — YYYY-MM-DD — [tags]`. Only collect the filename segment after the first em dash. Ignore non-matching prose lines.
- [ ] Consider preserving compatibility with simple markdown links if tests reveal legacy INDEX formats, but do not return to whole-file `.md` token scanning.
- [ ] Run `npm test -- tests/core/initiative.test.ts`, `npm run typecheck`, and `node dist/cli/index.js validate --human` (after build if needed). Acceptance: current repo validation no longer warns for `overview.md`, `log.md`, or `index.md`; real missing initiative files still warn.

## Progress Log
- [2026-06-25T12:57:19.061Z] Created initiative via mdocs command
- [2026-07-03] Handoff context added. Root cause located in `src/core/managers/initiative.ts:462-471`: INDEX validation scans every `.md` token in the entire INDEX via `/[\w.-]+\.md/g`, so title text such as `overview.md`, `log.md`, and `index.md` becomes a fake listed initiative file. Current repo symptom is `mdocs_validate` valid:true with exactly these three initiative warnings. Desired fix is to parse only actual filename fields from INDEX rows while preserving warnings for genuine missing listed files.
- [2026-07-03T19:30:03.234Z] read executed at step COMPLETE
- [2026-07-03T19:30:16.522Z] apply_patch executed at step COMPLETE

## Artifacts
