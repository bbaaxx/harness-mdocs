---
id: "cc3-wiki-id-and-emitters"
title: "cc3 wiki canonical id/ref tolerance + consumer overview/log emitter format"
status: "done"
created: "2026-06-24"
updated: "2026-06-25"
owner: ""
tags: ["core","wiki","compat","ingest","emitters"]
related_wiki: ["reference/consumer-schema-compat"]
priority: "medium"
---

## Objective
Resolve wiki identity and references by filename stem + parent-dir category so a page with a path-style frontmatter `id` (`systems/foo`) or singular `category` still produces correct canonical refs and backlinks (`refFor` / `getReferencedBy` / `parseWikiEntry`). Make `appendLog` able to emit the consumer SCHEMA log heading `## [YYYY-MM-DD] {operation} | {subject}` when given operation/subject, falling back to the current `## {timestamp}` form otherwise. `updateOverviewSection` stays H2-section-replace (already compatible). Keep `wiki/index.md` external-owner protection intact. Depends on cc0.

## Plan
- [x] In `src/core/managers/wiki.ts`, normalize canonical id/ref derivation to filename stem + parent-dir category, tolerating path-style frontmatter `id` and singular `category` in `parseWikiEntry` (line ~129), `refFor` (line ~116), and `getReferencedBy` (line ~249) so initiative `related_wiki` backlinks resolve.
- [x] Extend `appendLog` (line ~913) to accept `{ date?, operation?, subject?, content }`; when operation+subject present, write `## [YYYY-MM-DD] {operation} | {subject}` then content; otherwise keep `## {timestamp}`. Preserve byte-stable behavior for existing callers.
- [x] Keep `updateOverviewSection` and the canonical-lowercase external-owner no-op behavior unchanged.
- [x] Update `tests/core/wiki.test.ts`, `tests/core/wiki-overview-log.test.ts`, `tests/core/wiki-ingest*.test.ts`: add path-style-id + singular-category resolution cases and an `appendLog` operation/subject heading case; assert existing timestamp-form and index-protection tests still pass.

## Progress Log
- [2026-06-24] IMPLEMENTED + verified. wiki canonical id/ref resolved by filename stem + parent-dir category (tolerates path-style frontmatter id like systems/foo and singular category) in parseWikiEntry/refFor/getReferencedBy; appendLog emits `## [YYYY-MM-DD] op | subject` when operation+subject present, else byte-stable legacy `## {timestamp}` form; types WikiIngestOp appendLog entry extended. wiki/index.md external-owner protection intact; updateOverviewSection unchanged. +tests.
- [2026-06-25T08:52:17.604Z] Marked done via mdocs command
- [2026-06-25] State healed: implementation re-verified; linked stable consumer-schema compatibility wiki.

## Artifacts
