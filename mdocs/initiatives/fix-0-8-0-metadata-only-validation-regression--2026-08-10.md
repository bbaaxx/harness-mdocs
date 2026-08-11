---
id: "fix-0-8-0-metadata-only-validation-regression"
title: "Fix 0.8.0 metadata-only validation compatibility regression"
status: "done"
created: "2026-08-10"
updated: "2026-08-10"
owner: "openagent"
tags: ["bugfix","validation","metadata-only","directory-v2","github-issue-8","0.8.1"]
related_wiki: ["architecture/directory-v2-validation-diagnostics"]
priority: "medium"
handoff_summary: "Issue #8 post-0.8.0 validation regression fixed. Metadata-only directory records no longer require id/title; known semantic root compiled views preserve bare identity. Full suite 45/502, lint/typecheck, diff check pass; final review has no findings."
next_action: "Offer commit, issue response, and 0.8.1 patch-release preparation."
---

## Objective
Restore directory-v2 metadata-only and compiled-root compatibility after 0.8.0 without weakening genuine self-link diagnostics; add regression coverage and document behavior.

## Plan
- [ ] Inspect prior issue #8 initiatives, release context, validation implementation, and existing fixtures.
- [ ] Reproduce metadata-only id/title and root compiled-category false errors with focused tests.
- [ ] Implement configuration-aware initiative and wiki validation compatibility while retaining genuine integrity diagnostics.
- [ ] Run targeted tests, full test suite, lint, and validation; review resulting diff for regressions.
- [ ] Record stable compatibility behavior and progress, then prepare issue response and release recommendation.

## Progress Log
- [2026-08-10T23:25:27.138Z] Created initiative via mdocs command
- [2026-08-10T23:25:39.861Z] mdocs_resume executed at step COMPLETE
- [2026-08-10T23:25:48.709Z] read executed at step COMPLETE
- [2026-08-10T23:25:48.735Z] read executed at step COMPLETE
- [2026-08-10T23:25:48.744Z] glob executed at step COMPLETE
- [2026-08-10T23:25:48.760Z] glob executed at step COMPLETE
- [2026-08-10T23:25:48.768Z] glob executed at step COMPLETE
- Reviewed GitHub issue #8 end-user regression report plus prior P1 and consumer-tolerance initiatives. Scope confirmed: metadata-only manager id/title false errors and root compiled-view category/identity false errors; preserve genuine self-link diagnostics.
- [2026-08-10T23:25:55.755Z] mdocs executed at step COMPLETE
- [2026-08-10T23:26:01.105Z] mdocs_dispatch executed at step COMPLETE
- [2026-08-10T23:26:07.442Z] todowrite executed at step COMPLETE
- [2026-08-10T23:26:34.075Z] glob executed at step COMPLETE
- [2026-08-10T23:26:34.083Z] glob executed at step COMPLETE
- [2026-08-10T23:26:34.090Z] glob executed at step COMPLETE
- [2026-08-10T23:26:34.099Z] bash executed at step COMPLETE
- [2026-08-10T23:26:34.122Z] grep executed at step COMPLETE
- [2026-08-10T23:26:41.686Z] bash executed at step COMPLETE
- [2026-08-10T23:26:41.698Z] read executed at step COMPLETE
- [2026-08-10T23:26:41.706Z] read executed at step COMPLETE
- [2026-08-10T23:26:41.719Z] read executed at step COMPLETE
- [2026-08-10T23:26:41.732Z] read executed at step COMPLETE
- [2026-08-10T23:26:41.740Z] read executed at step COMPLETE
- [2026-08-10T23:26:51.050Z] read executed at step COMPLETE
- [2026-08-10T23:26:51.074Z] read executed at step COMPLETE
- [2026-08-10T23:26:51.099Z] read executed at step COMPLETE
- [2026-08-10T23:26:51.106Z] read executed at step COMPLETE
- [2026-08-10T23:26:51.116Z] glob executed at step COMPLETE
- [2026-08-10T23:26:51.123Z] grep executed at step COMPLETE
- [2026-08-10T23:27:00.138Z] read executed at step COMPLETE
- [2026-08-10T23:27:00.146Z] read executed at step COMPLETE
- [2026-08-10T23:27:00.157Z] read executed at step COMPLETE
- [2026-08-10T23:27:00.171Z] read executed at step COMPLETE
- [2026-08-10T23:27:00.178Z] read executed at step COMPLETE
- [2026-08-10T23:27:00.194Z] read executed at step COMPLETE
- [2026-08-10T23:27:00.203Z] grep executed at step COMPLETE
- [2026-08-10T23:27:06.763Z] read executed at step COMPLETE
- [2026-08-10T23:27:06.772Z] glob executed at step COMPLETE
- [2026-08-10T23:27:06.780Z] grep executed at step COMPLETE
- [2026-08-10T23:27:06.792Z] read executed at step COMPLETE
- [2026-08-10T23:27:06.802Z] read executed at step COMPLETE
- [2026-08-10T23:27:10.727Z] read executed at step COMPLETE
- [2026-08-10T23:27:25.639Z] read executed at step COMPLETE
- [2026-08-10T23:27:25.670Z] grep executed at step COMPLETE
- [2026-08-10T23:27:26.650Z] bash executed at step COMPLETE
- [2026-08-10T23:27:45.974Z] read executed at step COMPLETE
- [2026-08-10T23:27:46.008Z] read executed at step COMPLETE
- [2026-08-10T23:27:46.026Z] read executed at step COMPLETE
- [2026-08-10T23:27:46.051Z] grep executed at step COMPLETE
- [2026-08-10T23:28:09.693Z] apply_patch executed at step COMPLETE
- [2026-08-10T23:28:16.973Z] bash executed at step COMPLETE
- [2026-08-10T23:28:52.523Z] apply_patch executed at step COMPLETE
- [2026-08-10T23:28:57.542Z] bash executed at step COMPLETE
- [2026-08-10T23:29:16.324Z] apply_patch executed at step COMPLETE
- [2026-08-10T23:29:23.881Z] bash executed at step COMPLETE
- [2026-08-10T23:29:29.466Z] bash executed at step COMPLETE
- [2026-08-10T23:29:30.652Z] bash executed at step COMPLETE
- [2026-08-10T23:29:37.668Z] bash executed at step COMPLETE
- [2026-08-10T23:29:44.220Z] bash executed at step COMPLETE
- [2026-08-10T23:29:44.231Z] bash executed at step COMPLETE
- [2026-08-10T23:29:45.428Z] bash executed at step COMPLETE
- [2026-08-10T23:30:12.066Z] apply_patch executed at step COMPLETE
- [2026-08-10T23:30:16.976Z] bash executed at step COMPLETE
- [2026-08-10T23:30:35.548Z] apply_patch executed at step COMPLETE
- [2026-08-10T23:30:43.450Z] bash executed at step COMPLETE
- [2026-08-10T23:30:44.690Z] bash executed at step COMPLETE
- [2026-08-10T23:30:52.147Z] bash executed at step COMPLETE
- [2026-08-10T23:31:09.088Z] bash executed at step COMPLETE
- [2026-08-10T23:31:21.483Z] bash executed at step COMPLETE
- [2026-08-10T23:31:21.493Z] bash executed at step COMPLETE
- [2026-08-10T23:31:21.530Z] grep executed at step COMPLETE
- [2026-08-10T23:31:31.273Z] task executed at step COMPLETE
- [2026-08-10T23:31:36.954Z] todowrite executed at step COMPLETE
- Implemented scoped compatibility fixes: metadata-only directory initiative manager validation derives identity from directory; metadata-only canonical root wiki views accept matching semantic root categories while preserving bare root identity. Added regression/default-mode/mismatch tests and README documentation. Subagent reports 500 tests, typecheck/lint, and diff check passing.
- [2026-08-10T23:31:41.083Z] mdocs executed at step COMPLETE
- [2026-08-10T23:31:46.361Z] read executed at step COMPLETE
- [2026-08-10T23:31:46.398Z] bash executed at step COMPLETE
- [2026-08-10T23:31:59.535Z] read executed at step COMPLETE
- [2026-08-10T23:31:59.543Z] read executed at step COMPLETE
- [2026-08-10T23:31:59.550Z] read executed at step COMPLETE
- [2026-08-10T23:31:59.560Z] grep executed at step COMPLETE
- [2026-08-10T23:32:04.132Z] read executed at step COMPLETE
- [2026-08-10T23:32:10.050Z] bash executed at step COMPLETE
- [2026-08-10T23:32:11.198Z] bash executed at step COMPLETE
- [2026-08-10T23:32:15.539Z] bash executed at step COMPLETE
- [2026-08-10T23:32:20.539Z] todowrite executed at step COMPLETE
- [2026-08-10T23:32:22.890Z] mdocs_dispatch executed at step COMPLETE
- [2026-08-10T23:32:34.118Z] skill executed at step COMPLETE
- [2026-08-10T23:32:37.427Z] bash executed at step COMPLETE
- [2026-08-10T23:32:46.566Z] bash executed at step COMPLETE
- [2026-08-10T23:32:46.574Z] bash executed at step COMPLETE
- [2026-08-10T23:32:46.582Z] bash executed at step COMPLETE
- [2026-08-10T23:32:46.597Z] bash executed at step COMPLETE
- [2026-08-10T23:32:55.829Z] bash executed at step COMPLETE
- [2026-08-10T23:32:55.850Z] bash executed at step COMPLETE
- [2026-08-10T23:32:55.859Z] bash executed at step COMPLETE
- [2026-08-10T23:32:55.879Z] bash executed at step COMPLETE
- [2026-08-10T23:33:00.403Z] bash executed at step COMPLETE
- [2026-08-10T23:33:06.990Z] bash executed at step COMPLETE
- [2026-08-10T23:33:30.316Z] bash executed at step COMPLETE
- [2026-08-10T23:33:30.360Z] bash executed at step COMPLETE
- [2026-08-10T23:33:30.400Z] bash executed at step COMPLETE
- [2026-08-10T23:33:36.632Z] bash executed at step COMPLETE
- [2026-08-10T23:33:36.640Z] bash executed at step COMPLETE
- [2026-08-10T23:33:36.647Z] bash executed at step COMPLETE
- [2026-08-10T23:33:39.587Z] bash executed at step COMPLETE
- [2026-08-10T23:33:43.032Z] bash executed at step COMPLETE
- [2026-08-10T23:33:51.955Z] bash executed at step COMPLETE
- [2026-08-10T23:34:43.998Z] task executed at step COMPLETE
- [2026-08-10T23:34:55.463Z] todowrite executed at step COMPLETE
- Independent review found two scope defects: compatibility was unnecessarily tied to canonical-lowercase index mode, and matching category/stem was accepted for arbitrary root pages. Re-entering implementation: gate on directory metadata-only and restrict exemption to known compiled-view stems.
- [2026-08-10T23:34:59.539Z] mdocs executed at step COMPLETE
- [2026-08-10T23:35:01.818Z] mdocs_dispatch executed at step COMPLETE
- [2026-08-10T23:35:17.068Z] read executed at step COMPLETE
- [2026-08-10T23:35:17.090Z] read executed at step COMPLETE
- [2026-08-10T23:35:31.115Z] grep executed at step COMPLETE
- [2026-08-10T23:35:54.147Z] apply_patch executed at step COMPLETE
- [2026-08-10T23:36:00.920Z] read executed at step COMPLETE
- [2026-08-10T23:36:01.079Z] read executed at step COMPLETE
- [2026-08-10T23:36:01.240Z] read executed at step COMPLETE
- [2026-08-10T23:36:01.257Z] read executed at step COMPLETE
- [2026-08-10T23:36:14.219Z] task executed at step COMPLETE
- [2026-08-10T23:36:20.273Z] bash executed at step COMPLETE
- [2026-08-10T23:36:21.515Z] bash executed at step COMPLETE
- [2026-08-10T23:36:22.133Z] bash executed at step COMPLETE
- [2026-08-10T23:36:27.963Z] todowrite executed at step COMPLETE
- [2026-08-10T23:36:43.249Z] bash executed at step COMPLETE
- [2026-08-10T23:36:49.150Z] todowrite executed at step COMPLETE
- [2026-08-10T23:36:51.734Z] mdocs_dispatch executed at step COMPLETE
- [2026-08-10T23:37:02.893Z] skill executed at step COMPLETE
- [2026-08-10T23:37:05.826Z] bash executed at step COMPLETE
- [2026-08-10T23:37:13.821Z] bash executed at step COMPLETE
- [2026-08-10T23:37:13.830Z] bash executed at step COMPLETE
- [2026-08-10T23:37:13.846Z] bash executed at step COMPLETE
- [2026-08-10T23:38:30.037Z] bash executed at step COMPLETE
- [2026-08-10T23:38:42.534Z] task executed at step COMPLETE
- [2026-08-10T23:38:50.269Z] grep executed at step COMPLETE
- [2026-08-10T23:38:53.720Z] read executed at step COMPLETE
- [2026-08-10T23:39:07.711Z] mdocs_ingest executed at step COMPLETE
- Final implementation complete after review loop. Added metadata-only manager compatibility and strict known-root semantic category handling independent of index mode; preserved default strictness and genuine graph diagnostics. Focused 21 tests and full 45-suite/502-test run pass; lint/typecheck and diff check pass; final independent review reports no findings. Updated stable architecture learning.
- [2026-08-10T23:39:17.529Z] mdocs executed at step COMPLETE
- [2026-08-10T23:39:25.032Z] mdocs_validate executed at step COMPLETE
- [2026-08-10T23:39:25.097Z] bash executed at step COMPLETE
- Validation passed with no initiative/wiki errors. Removed context-only wiki references from related_wiki so graph tracks only stable artifact backlink; unrelated pre-existing release-0.7.1 learning warning remains.
- [2026-08-10T23:39:34.232Z] mdocs executed at step COMPLETE
- [2026-08-10T23:39:38.698Z] mdocs_validate executed at step COMPLETE
- [2026-08-10T23:39:43.593Z] todowrite executed at step COMPLETE
- [2026-08-10T23:39:46.085Z] Marked done via mdocs command

## Artifacts
