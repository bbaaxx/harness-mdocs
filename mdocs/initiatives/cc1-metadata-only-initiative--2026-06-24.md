---
id: "cc1-metadata-only-initiative"
title: "cc1 metadata-only initiative writes (store + manager + PostToolUse)"
status: "active"
created: "2026-06-24"
updated: "2026-06-24"
owner: ""
tags: ["core","initiative","compat","hooks"]
related_wiki: []
priority: "high"
---

## Objective
When `contract.initiativeRecordMode === 'metadata-only'`, treat a consumer `_status.md` as lifecycle metadata only: never inject `## Objective / ## Plan / ## Progress Log` into a prose-only body, never add `id/title/owner/related_wiki` keys that were not already present, preserve inline `tags: [a, b]` formatting (do not JSON-stringify), and rewrite only existing lifecycle keys in place. Suppress PostToolUse progress-log mutation (audit only) in this mode. Depends on cc0. Default `full` mode keeps current behavior.

## Plan
- [ ] In `src/core/initiative-store.ts`, gate `updateStatusFile` / `frontmatterUpdates` / `formatStatusFile` on `metadata-only`: surgical lifecycle-key-only frontmatter merge, no body-section injection, preserve inline array formatting; switch the expected-duration read at line ~245 to `readExpectedDurationRaw`.
- [ ] In `src/core/managers/initiative.ts`, ensure the directory-mode `update` path (line ~225) does not append progress sections under metadata-only; switch expected-duration read at line ~220 to `readExpectedDurationRaw`.
- [ ] In `src/surfaces/claude-code/hooks.ts` `postToolUse` (and `src/cli/hooks/post-tool-use.ts` if it carries logic), when `core.contract.initiativeRecordMode === 'metadata-only'` skip the initiative read-modify-write progressLog block; still append to the audit log.
- [ ] Tests: extend `tests/core/initiative.test.ts` with metadata-only cases proving a thin `_status.md` (frontmatter + one prose paragraph, `tags` inline) survives `initiative.update` / `markDone` / graduate-stamp with its shape and tags formatting intact and no injected sections. Add a hook test that metadata-only suppresses the progressLog write.

## Acceptance Criteria
- A thin `_status.md` round-trips through update/markDone with no new frontmatter keys, no injected body sections, inline `tags` preserved, only lifecycle keys changed.
- PostToolUse under metadata-only writes audit only, no `_status.md` mutation.
- `full` mode behavior and its tests unchanged.

## Progress Log
- [2026-06-24] IMPLEMENTED + verified. initiative-store metadata-only path: core lifecycle keys (status/updated/completed/graduated) add-or-update; optional next_action update-only-if-present; no body-section injection; inline tags preserved. managers/initiative + hooks postToolUse early-return (audit-only) under metadata-only. Fixed markDone adding the completed key; added tests/surfaces/claude-code-hooks.test.ts. Default full mode unchanged.

## Artifacts
