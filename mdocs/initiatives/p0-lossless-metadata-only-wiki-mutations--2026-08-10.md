---
id: "p0-lossless-metadata-only-wiki-mutations"
title: "P0: Lossless metadata-only wiki mutations"
status: "done"
created: "2026-08-10"
updated: "2026-08-10"
owner: "bbaaxx"
tags: ["bugfix","metadata-only","github-issue-8"]
related_wiki: ["architecture/lossless-metadata-only-mutations"]
priority: "medium"
next_action: "Review diff; commit; close P0 initiative and start p1-stronger-validation-diagnostics"
---

## Objective
Make wiki and initiative mutations lossless, postcondition-verified, and ownership-aware over directory-v2 consumer schemas (metadata-only mode). GitHub issue #8 P0 items.

## Plan


## Progress Log
- [2026-08-10T17:28:19.931Z] Created initiative via mdocs command
- [2026-08-10T17:57:04.328Z] mdocs_resume executed at step COMPLETE
- [2026-08-10T17:57:13.147Z] mdocs_dispatch executed at step COMPLETE
- [2026-08-10T17:57:27.642Z] bash executed at step COMPLETE
- [2026-08-10T17:57:34.869Z] bash executed at step COMPLETE
- [2026-08-10T17:57:35.511Z] bash executed at step COMPLETE
- [2026-08-10T17:57:42.461Z] bash executed at step COMPLETE
- [2026-08-10T17:57:42.671Z] grep executed at step COMPLETE
- [2026-08-10T17:57:47.306Z] read executed at step COMPLETE
- [2026-08-10T17:57:53.005Z] read executed at step COMPLETE
- [2026-08-10T17:58:00.305Z] bash executed at step COMPLETE
- [2026-08-10T17:58:01.010Z] bash executed at step COMPLETE
- [2026-08-10T17:58:08.170Z] read executed at step COMPLETE
- [2026-08-10T17:58:17.090Z] read executed at step COMPLETE
- [2026-08-10T17:58:17.293Z] read executed at step COMPLETE
- [2026-08-10T17:58:29.340Z] read executed at step COMPLETE
- [2026-08-10T17:58:31.035Z] bash executed at step COMPLETE
- [2026-08-10T17:58:42.744Z] bash executed at step COMPLETE
- [2026-08-10T17:58:43.606Z] bash executed at step COMPLETE
- [2026-08-10T17:58:51.160Z] read executed at step COMPLETE
- [2026-08-10T17:58:52.086Z] bash executed at step COMPLETE
- [2026-08-10T17:59:01.223Z] bash executed at step COMPLETE
- [2026-08-10T17:59:01.912Z] bash executed at step COMPLETE
- [2026-08-10T18:00:22.153Z] task executed at step COMPLETE
- Research done (see subagent report). Lossy paths: WikiManager.update wiki.ts:206 (whitelist rebuild), parseWikiEntry wiki.ts:132 (schema-only projection), linkWiki initiative side dropped under metadata-only (initiative-store.ts:347), no snake_case normalization, no merge-frontmatter helper. Executing implementation in 3 slices: (1) lossless round trips via raw-frontmatter merge + status field, (2) reliable metadata-only links with rollback + self-backlink guard, (3) explicit mutation results with appliedFields/skippedFields/unsupportedFields.
- [2026-08-10T18:00:57.489Z] mdocs executed at step COMPLETE
- [2026-08-10T18:02:32.090Z] mdocs_status executed at step COMPLETE
- [2026-08-10T18:02:33.623Z] bash executed at step COMPLETE
- [2026-08-10T18:03:06.149Z] mdocs_resume executed at step COMPLETE
- [2026-08-10T18:03:07.070Z] read executed at step COMPLETE
- [2026-08-10T18:03:38.329Z] read executed at step COMPLETE
- [2026-08-10T18:04:12.106Z] read executed at step COMPLETE
- [2026-08-10T18:04:45.862Z] read executed at step COMPLETE
- [2026-08-10T18:05:21.457Z] read executed at step COMPLETE
- [2026-08-10T18:05:21.681Z] read executed at step COMPLETE
- [2026-08-10T18:05:52.984Z] read executed at step COMPLETE
- [2026-08-10T18:05:53.148Z] read executed at step COMPLETE
- [2026-08-10T18:06:25.829Z] bash executed at step COMPLETE
- [2026-08-10T18:06:26.418Z] read executed at step COMPLETE
- [2026-08-10T18:06:58.861Z] bash executed at step COMPLETE
- [2026-08-10T18:07:46.838Z] bash executed at step COMPLETE
- [2026-08-10T18:08:34.974Z] grep executed at step COMPLETE
- [2026-08-10T18:10:17.269Z] read executed at step COMPLETE
- [2026-08-10T18:10:18.078Z] read executed at step COMPLETE
- [2026-08-10T18:11:19.138Z] bash executed at step COMPLETE
- [2026-08-10T18:11:19.337Z] read executed at step COMPLETE
- [2026-08-10T18:12:11.935Z] read executed at step COMPLETE
- [2026-08-10T18:12:12.394Z] read executed at step COMPLETE
- [2026-08-10T18:14:58.953Z] bash executed at step COMPLETE
- [2026-08-10T18:16:00.385Z] bash executed at step COMPLETE
- [2026-08-10T18:16:01.122Z] read executed at step COMPLETE
- [2026-08-10T18:16:22.874Z] bash executed at step COMPLETE
- [2026-08-10T18:16:48.469Z] bash executed at step COMPLETE
- [2026-08-10T18:17:25.631Z] bash executed at step COMPLETE
- [2026-08-10T18:20:55.238Z] edit executed at step COMPLETE
- [2026-08-10T18:21:33.634Z] edit executed at step COMPLETE
- [2026-08-10T18:21:56.583Z] edit executed at step COMPLETE
- [2026-08-10T18:22:41.295Z] edit executed at step COMPLETE
- [2026-08-10T18:23:07.881Z] edit executed at step COMPLETE
- [2026-08-10T18:23:22.161Z] edit executed at step COMPLETE
- [2026-08-10T18:23:30.650Z] edit executed at step COMPLETE
- [2026-08-10T18:23:56.883Z] edit executed at step COMPLETE
- [2026-08-10T18:24:13.784Z] edit executed at step COMPLETE
- [2026-08-10T18:24:33.929Z] bash executed at step COMPLETE
- [2026-08-10T18:25:09.985Z] edit executed at step COMPLETE
- [2026-08-10T18:25:12.062Z] edit executed at step COMPLETE
- [2026-08-10T18:25:32.533Z] edit executed at step COMPLETE
- [2026-08-10T18:26:16.224Z] edit executed at step COMPLETE
- [2026-08-10T18:26:47.911Z] edit executed at step COMPLETE
- [2026-08-10T18:27:15.128Z] edit executed at step COMPLETE
- [2026-08-10T18:27:47.321Z] edit executed at step COMPLETE
- [2026-08-10T18:28:37.991Z] edit executed at step COMPLETE
- [2026-08-10T18:28:50.075Z] edit executed at step COMPLETE
- [2026-08-10T18:29:08.319Z] edit executed at step COMPLETE
- [2026-08-10T18:29:16.551Z] edit executed at step COMPLETE
- [2026-08-10T18:29:30.656Z] edit executed at step COMPLETE
- [2026-08-10T18:30:15.682Z] edit executed at step COMPLETE
- [2026-08-10T18:30:29.716Z] edit executed at step COMPLETE
- [2026-08-10T18:31:09.933Z] edit executed at step COMPLETE
- [2026-08-10T18:31:46.864Z] edit executed at step COMPLETE
- [2026-08-10T18:32:02.668Z] edit executed at step COMPLETE
- [2026-08-10T18:32:14.562Z] edit executed at step COMPLETE
- [2026-08-10T18:32:16.989Z] edit executed at step COMPLETE
- [2026-08-10T18:32:25.700Z] bash executed at step COMPLETE
- [2026-08-10T18:33:14.419Z] bash executed at step COMPLETE
- [2026-08-10T18:33:23.007Z] bash executed at step COMPLETE
- [2026-08-10T18:34:36.232Z] write executed at step COMPLETE
- [2026-08-10T18:34:50.789Z] bash executed at step COMPLETE
- [2026-08-10T18:35:14.289Z] edit executed at step COMPLETE
- [2026-08-10T18:35:23.014Z] bash executed at step COMPLETE
- [2026-08-10T18:35:31.976Z] bash executed at step COMPLETE
- [2026-08-10T18:36:11.821Z] edit executed at step COMPLETE
- [2026-08-10T18:36:34.953Z] edit executed at step COMPLETE
- [2026-08-10T18:36:50.160Z] bash executed at step COMPLETE
- [2026-08-10T18:37:07.473Z] bash executed at step COMPLETE
- [2026-08-10T18:37:35.180Z] bash executed at step COMPLETE
- [2026-08-10T18:38:20.585Z] bash executed at step COMPLETE
- [2026-08-10T18:38:55.342Z] bash executed at step COMPLETE
- [2026-08-10T18:39:31.896Z] bash executed at step COMPLETE
- [2026-08-10T18:40:28.264Z] edit executed at step COMPLETE
- [2026-08-10T18:40:48.639Z] edit executed at step COMPLETE
- [2026-08-10T18:41:01.404Z] bash executed at step COMPLETE
- [2026-08-10T18:41:22.637Z] edit executed at step COMPLETE
- [2026-08-10T18:41:37.626Z] bash executed at step COMPLETE
- [2026-08-10T18:41:57.761Z] edit executed at step COMPLETE
- [2026-08-10T18:42:22.453Z] bash executed at step COMPLETE
- [2026-08-10T18:42:42.741Z] edit executed at step COMPLETE
- [2026-08-10T18:42:45.337Z] edit executed at step COMPLETE
- [2026-08-10T18:43:07.351Z] bash executed at step COMPLETE
- Implemented issue #8 P0: (1) lossless wiki round trips — WikiEntry.status + rawFrontmatter capture + merge-instead-of-rebuild in WikiManager (aliases/path-ids/singular categories/unknown keys preserved); (2) reliable metadata-only links — surgical related_wiki array mutation in InitiativeStore, self-backlink guard, rollback + read-back postcondition in linkWiki; (3) explicit mutation results — snake→camel normalization, appliedFields/skippedFields/unsupportedFields on initiative.update/wiki.update/wiki.ingest updatePage, read-after-write postconditions. New tests tests/core/lossless-metadata-only-mutations.test.ts cover acceptance 1-4,7-9. Full suite 479/479 pass, tsc clean.
- [2026-08-10T18:43:25.386Z] mdocs executed at step COMPLETE
- [2026-08-10T18:43:25.851Z] bash executed at step COMPLETE
- [2026-08-10T18:43:59.211Z] task executed at step COMPLETE
- [2026-08-10T18:44:05.810Z] bash executed at step COMPLETE
- [2026-08-10T18:44:12.547Z] bash executed at step COMPLETE
- [2026-08-10T18:44:37.512Z] bash executed at step COMPLETE
- [2026-08-10T18:44:37.531Z] read executed at step COMPLETE
- [2026-08-10T18:44:48.139Z] bash executed at step COMPLETE
- [2026-08-10T18:44:52.806Z] bash executed at step COMPLETE
- [2026-08-10T18:44:56.703Z] bash executed at step COMPLETE
- [2026-08-10T18:45:00.993Z] bash executed at step COMPLETE
- [2026-08-10T18:45:01.748Z] bash executed at step COMPLETE
- [2026-08-10T18:46:56.351Z] bash executed at step COMPLETE
- [2026-08-10T18:46:56.790Z] bash executed at step COMPLETE
- [2026-08-10T18:47:56.655Z] bash executed at step COMPLETE
- [2026-08-10T18:47:58.553Z] bash executed at step COMPLETE
- [2026-08-10T18:48:10.238Z] bash executed at step COMPLETE
- [2026-08-10T18:48:12.224Z] bash executed at step COMPLETE
- [2026-08-10T18:48:22.396Z] bash executed at step COMPLETE
- [2026-08-10T18:48:26.592Z] bash executed at step COMPLETE
- [2026-08-10T18:49:12.637Z] bash executed at step COMPLETE
- [2026-08-10T18:49:13.835Z] task executed at step COMPLETE
- [2026-08-10T18:51:48.614Z] mdocs executed at step COMPLETE
- Implemented GitHub issue #8 P0. Added lossless raw-frontmatter merging and WikiEntry status support; surgical metadata-only related_wiki mutations; bidirectional link read-back, rollback, own-compiled-page self-link guard; snake_case normalization; explicit applied/skipped/unsupported mutation results. Added 9 acceptance tests. Independent verification: npm test 44 suites / 479 tests passing; npm run typecheck clean. Documented design in wiki/architecture/lossless-metadata-only-mutations.
- [2026-08-10T18:51:54.679Z] mdocs executed at step COMPLETE
- [2026-08-10T18:51:56.792Z] mdocs_validate executed at step COMPLETE
- [2026-08-10T18:52:04.254Z] mdocs executed at step COMPLETE
- [2026-08-10T18:52:06.232Z] mdocs_validate executed at step COMPLETE
- [2026-08-10T18:52:08.319Z] Marked done via mdocs command

## Artifacts
