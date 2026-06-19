---
id: "implement-directory-v2-compatibility"
title: "Implement directory-v2 mdocs compatibility"
status: "active"
created: "2026-06-19"
updated: "2026-06-19"
owner: "openagent"
tags: ["compatibility","directory-v2","index-policy","wiki","initiatives"]
related_wiki: ["architecture/directory-v2-compatibility-evaluation"]
priority: "medium"
phase: "implementation"
next_action: "Review first slice, then continue with InitiativeStore adapter and directory-v2 read support."
---

## Objective
Make harness-mdocs contract-aware so it supports both existing flat-v1 projects and agents-workspace-style directory-v2 mdocs without clobbering canonical lowercase wiki indexes or directory initiative structure. Source request: https://gist.github.com/EdM-WAG/7ef35c6102ced034864e0c77abb592ec

## Plan
- [ ] Add mdocs contract detection and explicit compatibility config overrides.
- [ ] Refactor initiative access behind an InitiativeStore adapter shared by status, lookup, search, dispatch, validation, archive, and index checks.
- [ ] Implement directory-v2 initiative adapter for folder/_status.md initiatives, _archive/, legacy flat-file coexistence, status aliases, and safe writes.
- [ ] Add index ownership policy so canonical lowercase wiki/index.md is external-owned and generated uppercase INDEX.md files are disabled unless explicitly configured.
- [ ] Update wiki store/list/search/validation to include root wiki pages and resolve category/id plus root references safely.
- [ ] Update graph validation for sources, source_initiatives, related_wiki, related_initiatives, lifecycle: stable, and complete/done aliases.
- [ ] Add optional Obsidian refresh hook detection without treating _obsidian/ as canonical data.
- [ ] Add directory-v2 fixture and regression tests proving no unwanted INDEX.md generation or wiki/index.md clobbering.

## Progress Log
- [2026-06-19T05:25:28.457Z] Created initiative via mdocs command
- Created from gist compatibility handoff. Key constraints: support flat-v1 and directory-v2; preserve directory initiatives; treat lowercase wiki/index.md as canonical/external; include root wiki pages; avoid generated uppercase INDEX.md files in directory-v2; add fixture/regression tests.
- Brainstorm/evaluation complete. Findings saved in wiki architecture/directory-v2-compatibility-evaluation. Minimal first PR should prioritize clobber prevention: contract detection/config, exists() compatibility, safe index ownership, index.sync no-op/report-only for directory-v2 external indices, and regression fixture/tests proving lowercase wiki/index.md unchanged and uppercase INDEX.md files absent.
- Implemented first clobber-prevention slice: added contract detection/config (`src/core/contract.ts`), wired compatibility options through core factory, made `MdocsManager.exists()` accept canonical lowercase wiki index/directory-style initiatives, made `WikiManager` skip generated index writes/checks when wiki index owner is external, and added directory-v2 fixture/regression tests. Verified with `npm run build` and `npm test -- tests/core --no-cache` (135 tests passing).

## Artifacts
- [Directory-v2 compatibility evaluation](../wiki/architecture/directory-v2-compatibility-evaluation.md)
