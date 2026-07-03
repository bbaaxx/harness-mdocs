---
id: "fix-initiative-index-validation-false-positive"
title: "Fix initiative INDEX validation false positives for markdown filenames in titles"
status: "done"
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
- [2026-07-03T19:30:27.532Z] bash executed at step COMPLETE
- [2026-07-03T19:32:03.794Z] skill executed at step COMPLETE
- [2026-07-03T19:32:07.413Z] mdocs_status executed at step COMPLETE
- [2026-07-03T19:32:07.555Z] mdocs_lookup executed at step COMPLETE
- [2026-07-03T19:32:13.230Z] todowrite executed at step COMPLETE
- [2026-07-03T19:32:19.793Z] mdocs_resume executed at step COMPLETE
- [2026-07-03T19:32:19.996Z] mdocs_dispatch executed at step COMPLETE
- [2026-07-03T19:32:20.056Z] glob executed at step COMPLETE
- [2026-07-03T19:32:20.065Z] glob executed at step COMPLETE
- [2026-07-03T19:32:25.754Z] read executed at step COMPLETE
- [2026-07-03T19:32:25.786Z] read executed at step COMPLETE
- [2026-07-03T19:32:28.970Z] read executed at step COMPLETE
- [2026-07-03T19:32:34.932Z] skill executed at step COMPLETE
- [2026-07-03T19:32:40.368Z] todowrite executed at step COMPLETE
- [2026-07-03T19:32:59.194Z] mdocs_status executed at step COMPLETE
- [2026-07-03T19:33:07.039Z] read executed at step COMPLETE
- [2026-07-03T19:33:07.058Z] read executed at step COMPLETE
- [2026-07-03T19:33:16.186Z] read executed at step COMPLETE
- [2026-07-03T19:33:47.158Z] apply_patch executed at step COMPLETE
- [2026-07-03T19:33:52.898Z] read executed at step COMPLETE
- [2026-07-03T19:33:52.922Z] read executed at step COMPLETE
- [2026-07-03T19:34:07.371Z] apply_patch executed at step COMPLETE
- [2026-07-03T19:34:13.897Z] read executed at step COMPLETE
- [2026-07-03T19:34:13.917Z] read executed at step COMPLETE
- [2026-07-03T19:34:18.553Z] task executed at step COMPLETE
- [2026-07-03T19:34:24.115Z] read executed at step COMPLETE
- [2026-07-03T19:34:24.187Z] read executed at step COMPLETE
- [2026-07-03T19:34:31.508Z] todowrite executed at step COMPLETE
- [2026-07-03T19:34:41.088Z] bash executed at step COMPLETE
- [2026-07-03T19:34:47.084Z] bash executed at step COMPLETE
- [2026-07-03T19:34:49.089Z] bash executed at step COMPLETE
- [2026-07-03T19:34:56.547Z] bash executed at step COMPLETE
- [2026-07-03T19:35:03.623Z] mdocs_validate executed at step COMPLETE
- [2026-07-03T19:35:03.674Z] bash executed at step COMPLETE
- [2026-07-03T19:35:14.052Z] bash executed at step COMPLETE
- Implemented INDEX filename-field parsing in InitiativeManager.validate(); added regression coverage for markdown filenames in INDEX row titles and for genuinely missing filename fields. Verification passed: npm test -- tests/core/initiative.test.ts; npm run typecheck; npm run build && node dist/cli/index.js validate --human. Built CLI validation no longer reports overview.md/log.md/index.md false positives; it reports one unrelated existing warning for workflow-state-machine-has-no-driver--2026-06-22.md missing from INDEX.
- [2026-07-03T19:35:34.078Z] mdocs executed at step COMPLETE
- [2026-07-03T19:35:39.651Z] mdocs_status executed at step COMPLETE
- [2026-07-03T19:35:39.701Z] bash executed at step COMPLETE
- [2026-07-03T19:37:20.737Z] skill executed at step COMPLETE
- [2026-07-03T19:37:24.409Z] todowrite executed at step COMPLETE
- [2026-07-03T19:37:30.835Z] Marked done via mdocs command

## Artifacts
