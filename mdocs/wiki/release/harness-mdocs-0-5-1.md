---
id: "harness-mdocs-0-5-1"
title: "harness-mdocs 0.5.1"
category: "release"
created: "2026-06-24"
updated: "2026-06-24"
related_initiatives: []
tags: ["release","0.5.1","consumer-schema","compat"]
---

# harness-mdocs 0.5.1

Patch release shipping consumer-schema compatibility: harness-mdocs now operates on a consumer mdocs tree (thin metadata-only `_status.md`; path-style wiki `id`; singular `category`; hyphenated `expected-duration`) with no consumer data migration. All behavior is opt-in behind a `.mdocs.json` config file and an `initiativeRecordMode` contract flag; defaults reproduce prior behavior.

## Changes

- `.mdocs.json` config loader (`src/core/config.ts`, `loadProjectConfig`) establishing the file precedence tier (env > file > detected contract); resolved contract exposed on `MdocsCore.contract`.
- `initiativeRecordMode: "metadata-only"`: surgical lifecycle-key writes (no body-section injection, inline `tags` preserved, no new structural keys); PostToolUse audit-only; linter tolerance (skip body/required-field deductions, keep lifecycle telemetry).
- Wiki canonical id/ref by filename stem + parent-dir category (path-style id, singular category); `appendLog` consumer heading `## [date] op | subject` with byte-stable legacy fallback.
- Docs (`.mdocs.json` + `initiativeRecordMode`) in claude-md-snippet, CLAUDE.md, README, docs/consumer-layering.md.
- Scrubbed a captured contributor identity from the legacy-mdocs audit.log fixture.

## Verification

Baseline 385 -> 414 tests green; tsc clean; coverage >=80%; `npm run release:check` exit 0; `mdocs_validate` valid:true. Tarball `harness-mdocs-0.5.1.tgz` 161.2 kB.

Driven by the consumer-schema-compat initiative set (parent + cc0..cc4). Published via `publish.yml` on tag `v0.5.1`.