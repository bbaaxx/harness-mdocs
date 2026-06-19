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
next_action: "Run final review, document remaining limitations, then consider marking initiative done after stable wiki learning is updated."
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
- Coordinated next slice with subagents. Investigator mapped flat-scan hotspots across InitiativeManager, operations, search, linter, command utils, registry, and opencode tools. Planner proposed InitiativeStore API and phased read-only directory-v2 rollout. Reviewer found first-slice issues; fixed generated-index defaults for directory-v2, merged compatibility overrides, and guarded InitiativeManager syncIndex/checkConsistency/updateIndex for directory mode. Began InitiativeStore read slice: added read-only InitiativeStore, status normalization, directory `_status.md` scanning, `_archive` support, legacy flat coexistence, manager read/list/findById/findByQuery delegation, lookup/search routing, and fixture tests. Verified with `npm run build` and `npm test -- tests/core --no-cache` (139 tests passing).
- Completed remaining read-routing/write-guard slice. Routed opencode status/lookup/resume/dispatch/index-check through InitiativeStore/core operations, updated linter graph to scan directory `_status.md` initiatives and normalize status aliases, and added directory-v2 write guards for initiative create/update/done/delete/archive plus wiki.link to prevent flat-file writes or partial wiki mutation. Added regression tests for command write guards, linter directory graph handling, and opencode directory-v2 tool behavior. Verified `npm run build`, `npm test -- tests/core --no-cache` (141 tests passing), and `npm test -- tests/surfaces/opencode --no-cache` (56 tests passing).
- Completed wiki root/provenance slice. WikiManager now treats root wiki markdown files as first-class entries, supports readByRef for root or category refs, includes root pages in list/find/search/validation, and scans directory `_status.md` initiatives for referenced wiki refs. Search indexes wiki entries via WikiManager.list() and handles root wiki snippets. Dispatch resolves root wiki refs. Linter scans root wiki pages, accepts root pages without frontmatter, and treats stable wiki pages with sources/source_initiatives as sufficient learning for done/complete initiatives. Added tests for searchable lowercase wiki/index.md without generated index writes, source provenance satisfying complete initiative learning, root wiki listing/validation, directory `_status.md` getReferencedBy, and linter provenance behavior. Verified `npm run build`, `npm test -- tests/core --no-cache` (146 tests passing), and `npm test -- tests/surfaces/opencode --no-cache` (56 tests passing).
- Completed final Obsidian/docs slice. Contract detection now records optional `mdocs/_obsidian/` visibility layer metadata plus explicit `obsidianRefreshCommand` config without scanning or running it. Wiki/linter category scans ignore `_obsidian` directories so Obsidian exports never become canonical wiki entries. README now documents directory-v2 read support, guarded writes, root wiki pages, provenance via sources/source_initiatives, and Obsidian visibility-layer behavior. Added tests for Obsidian detection, configured refresh command preservation, search ignoring `_obsidian`, and wiki list/validation ignoring `_obsidian`. Verified `npm run build`, `npm test -- tests/core --no-cache` (148 tests passing), and `npm test -- tests/surfaces/opencode --no-cache` (56 tests passing).
- Implemented directory-v2 native `initiative.done` and `initiative.archive`. `done` now updates the directory `_status.md` in place (`status: complete`, updated/completed dates, progress note) without creating flat files and clears active workflow state. `archive` moves the whole initiative folder to `initiatives/_archive/<slug>/`, updates status to archived, and preserves artifacts. Flat-v1 behavior remains unchanged; directory-v2 create/update/delete/wiki.link remain guarded. Added regression tests for done, active workflow clearing, archive folder move/preservation, and archive rejection for active initiatives. Verified `npm run build`, `npm test -- tests/core --no-cache` (152 tests passing), and `npm test -- tests/surfaces/opencode --no-cache` (56 tests passing).

## Artifacts
- [Directory-v2 compatibility evaluation](../wiki/architecture/directory-v2-compatibility-evaluation.md)
