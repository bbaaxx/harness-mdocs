---
id: "cc3-wiki-id-and-emitters"
title: "cc3 wiki canonical id/ref tolerance + consumer overview/log emitter format"
status: "active"
created: "2026-06-24"
updated: "2026-06-24"
owner: ""
tags: ["core","wiki","compat","ingest","emitters"]
related_wiki: []
priority: "medium"
---

## Objective
Resolve wiki identity and references by filename stem + parent-dir category so a page with a path-style frontmatter `id` (`systems/foo`) or singular `category` still produces correct canonical refs and backlinks (`refFor` / `getReferencedBy` / `parseWikiEntry`). Make `appendLog` able to emit the consumer SCHEMA log heading `## [YYYY-MM-DD] {operation} | {subject}` when given operation/subject, falling back to the current `## {timestamp}` form otherwise. `updateOverviewSection` stays H2-section-replace (already compatible). Keep `wiki/index.md` external-owner protection intact. Depends on cc0.

## Plan
- [ ] In `src/core/managers/wiki.ts`, normalize canonical id/ref derivation to filename stem + parent-dir category, tolerating path-style frontmatter `id` and singular `category` in `parseWikiEntry` (line ~129), `refFor` (line ~116), and `getReferencedBy` (line ~249) so initiative `related_wiki` backlinks resolve.
- [ ] Extend `appendLog` (line ~913) to accept `{ date?, operation?, subject?, content }`; when operation+subject present, write `## [YYYY-MM-DD] {operation} | {subject}` then content; otherwise keep `## {timestamp}`. Preserve byte-stable behavior for existing callers.
- [ ] Keep `updateOverviewSection` and the canonical-lowercase external-owner no-op behavior unchanged.
- [ ] Update `tests/core/wiki.test.ts`, `tests/core/wiki-overview-log.test.ts`, `tests/core/wiki-ingest*.test.ts`: add path-style-id + singular-category resolution cases and an `appendLog` operation/subject heading case; assert existing timestamp-form and index-protection tests still pass.

## Acceptance Criteria
- A page at `wiki/systems/foo.md` with `id: systems/foo, category: system` resolves backlinks from an initiative `related_wiki: ["systems/foo"]`.
- `appendLog` emits the `## [date] op | subject` heading when given op/subject; timestamp form preserved otherwise; `wiki/index.md` never written under external owner.

## Progress Log
- [2026-06-24] IMPLEMENTED + verified. wiki canonical id/ref resolved by filename stem + parent-dir category (tolerates path-style frontmatter id like systems/foo and singular category) in parseWikiEntry/refFor/getReferencedBy; appendLog emits `## [YYYY-MM-DD] op | subject` when operation+subject present, else byte-stable legacy `## {timestamp}` form; types WikiIngestOp appendLog entry extended. wiki/index.md external-owner protection intact; updateOverviewSection unchanged. +tests.

## Artifacts
