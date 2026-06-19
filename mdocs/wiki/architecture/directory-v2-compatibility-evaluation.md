---
id: "directory-v2-compatibility-evaluation"
title: "Directory-v2 compatibility evaluation"
category: "architecture"
created: "2026-06-19"
updated: "2026-06-19"
related_initiatives: ["implement-directory-v2-compatibility"]
tags: ["compatibility","directory-v2","architecture","index-policy"]
---

## Summary

Evaluation for initiative `implement-directory-v2-compatibility`.

Goal: make harness-mdocs support both flat-v1 and directory-v2 mdocs contracts without clobbering canonical lowercase wiki indexes or rewriting directory initiatives into flat files.

## Hotspots

- `src/core/managers/mdocs.ts`: init/exists assume uppercase `wiki/INDEX.md`.
- `src/core/managers/initiative.ts`: flat initiative CRUD, parsing, archive, index generation.
- `src/core/managers/wiki.ts`: category-only wiki pages and generated uppercase/category indices.
- `src/core/search.ts`: direct flat initiative and category wiki scans.
- `src/core/validation/linter.ts`: direct scans plus done-only lifecycle checks.
- `src/core/operations.ts`: lookup/status/resume/dispatch/index checks duplicate flat assumptions.
- `src/core/commands/utils.ts`: flat filename lookup.
- `src/surfaces/opencode/tools.ts`: direct flat scans in surface tools.

## Phasing

1. Add contract detection/config override with no behavior change.
2. Add safe index ownership policy early to prevent `wiki/index.md` clobber and unwanted `INDEX.md` generation.
3. Introduce InitiativeStore adapter and route core/surface reads through it.
4. Add directory-v2 initiative adapter for `_status.md`, `_archive/`, legacy flat coexistence, aliases, and safe writes.
5. Add WikiStore/root-page support and reference resolution.
6. Update search/validation/dispatch to consume stores and support `sources`, `source_initiatives`, `related_wiki`, `related_initiatives`, `complete` aliases.
7. Detect optional Obsidian refresh hook without treating `_obsidian/` as canonical.
8. Add fixtures and regression tests.

## Minimal first PR

Scope should prioritize clobber prevention:

- Add `src/core/contract.ts`.
- Add factory/core options for explicit override.
- Make `exists()` accept directory-v2 without uppercase `wiki/INDEX.md`.
- Make `WikiManager.syncIndices()/updateIndices()` honor index policy.
- Make `index.sync` no-op/report-only for external-owned directory-v2.
- Add directory-v2 fixture and tests proving no uppercase index generation and lowercase `wiki/index.md` remains byte-for-byte unchanged.

## Test assertions

- `wiki/index.md` unchanged after validate/index sync/wiki operations in directory-v2.
- `wiki/INDEX.md` absent unless explicit override enables generation.
- Category `INDEX.md` files absent unless explicit override enables generation.
- Directory initiatives are not migrated to flat files.
- `_obsidian/` ignored by canonical list/search/validation.

## Open questions

- Config source: API options only, repo config file, or both?
- Directory initiative ID precedence: frontmatter `id` or folder slug?
- Directory create/update semantics: `_status.md` only or auxiliary docs?
- Archive semantics: require complete first, or move then set `archived`?
- Root wiki reference syntax: `index`, `wiki/index`, `/index`, or filename stem?
- Obsidian refresh hook config name and invocation policy.
