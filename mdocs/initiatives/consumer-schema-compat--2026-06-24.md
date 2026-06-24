---
id: "consumer-schema-compat"
title: "Honor consumer wiki/initiative schema without migration"
status: "active"
created: "2026-06-24"
updated: "2026-06-24"
owner: ""
tags: ["orchestrator","core","compat","contract","consumer-schema"]
related_wiki: ["reference/consumer-layering"]
priority: "high"
---

## Objective
Make harness-mdocs operate correctly on a consumer mdocs tree that uses a thin metadata-only `_status.md` (lifecycle frontmatter + prose, artifacts in sibling files) and wiki pages with path-style `id` (`systems/foo`), singular `category` (`system`), and hyphenated `expected-duration`, WITHOUT the consumer migrating any data. Every change is opt-in behind a `.mdocs.json` / contract flag whose default reproduces today's behavior, so the existing suite stays green. Orchestrate the five child initiatives in dependency order and gate each on `npm run release:check` + `mdocs_validate`.

## Plan
- [ ] Land cc0-config-and-contract-foundation first (config-file loader, `initiativeRecordMode` contract flag, `readExpectedDurationRaw` helper, expose `core.contract`, thread contract into MdocsLinter). All later children depend on these interfaces.
- [ ] Land cc1-metadata-only-initiative (store + manager + PostToolUse honor metadata-only writes) and cc2-linter-consumer-tolerance and cc3-wiki-id-and-emitters in parallel (disjoint files: initiative-store/manager/hooks vs validation/linter.ts vs managers/wiki.ts).
- [ ] Land cc4-docs-and-dogfood (README, claude-md-snippet, CLAUDE.md, package mdocs initiative + wiki ingest).
- [ ] Run `npm run build && npm run build:claude-plugin && npm test && npm run coverage && npm run mdocs:validate` green before opening the PR.
- [x] Open PR feat/consumer-schema-compat -> main (#5).

## Acceptance Criteria
- Done when a consumer `.mdocs.json` of `{ "compatibility": { "initiativeRecordMode": "metadata-only", "enforcementMode": "advisory" }, "standaloneCategories": ["repos","systems","glossary"] }` drives the package over a thin-`_status.md` + path-style-wiki tree with: no spurious `_status.md` mutation, `mdocs_validate` valid:true, correct wiki backlink resolution, lifecycle lint honoring hyphenated `expected-duration`, and zero consumer file migrations.
- Existing 385 tests remain green with defaults; new code paths covered to the 80% threshold.

## Progress Log
- [2026-06-24] cc0, cc1, cc2, cc3 LANDED + verified on feat/consumer-schema-compat. Baseline 385 -> 414 tests green, tsc clean. Parallel executor agents for cc1/cc2/cc3 (disjoint files) + coordinator fixes (cc1 markDone completed-key bug; cc1 hook test added). cc4 (docs + dogfood) next, then full gate (build/build:claude-plugin/test/coverage/mdocs:validate) + PR.
- [2026-06-24] cc4 LANDED + verified. Docs updated (snippet, CLAUDE.md, README, docs/consumer-layering.md); dogfood wiki entries created (reference/consumer-schema-compat stable + session-log). mdocs_validate valid:true. Running full gate next.

## Artifacts
