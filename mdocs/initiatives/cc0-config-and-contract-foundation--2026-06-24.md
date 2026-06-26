---
id: "cc0-config-and-contract-foundation"
title: "cc0 config-file loader + initiativeRecordMode contract flag + shared helpers"
status: "done"
created: "2026-06-24"
updated: "2026-06-25"
owner: ""
tags: ["core","config","contract","compat","foundation"]
related_wiki: ["reference/consumer-schema-compat"]
priority: "high"
---

## Objective
Establish the shared interfaces the rest of the work consumes: a `.mdocs.json` config-file loader wired into `createMdocsCore` (the documented "file" precedence tier does not currently exist in the runtime path), an opt-in `initiativeRecordMode` contract flag (default `full` = current behavior), a shared `readExpectedDurationRaw` helper that also reads the hyphenated `expected-duration`, exposing the resolved `contract` on `MdocsCore`, and threading the contract into `MdocsLinter`. No consumer-facing behavior changes by default.

## Plan
- [x] Add `src/core/config.ts` exporting `loadProjectConfig(mdocsRoot: string): MdocsCoreOptions` that reads `<mdocsRoot>/.mdocs.json`, returns `{}` on missing/invalid (never throws), and recognizes `compatibility`, `standaloneCategories`, `mdocsDirName`.
- [x] In `src/core/factory.ts`, load the file config and merge so explicit `options` win over file and file wins over default; add `contract` to the `MdocsCore` interface + returned object; pass the contract (or `initiativeRecordMode`) into `new MdocsLinter(...)`.
- [x] In `src/core/types.ts`, add `readExpectedDurationRaw(front): any` returning `front.expected_duration ?? front.expectedDuration ?? front['expected-duration']`.
- [x] In `src/core/contract.ts`, add `initiativeRecordMode?: 'full'|'metadata-only'` to `MdocsCompatibilityConfig`, add required `initiativeRecordMode` to `MdocsContract`, and resolve it in `detectMdocsContract` as `config.initiativeRecordMode ?? 'full'` (no auto-detect).
- [x] Add `tests/core/config.test.ts` (valid/missing/malformed/merge-precedence) and extend `tests/core/compatibility.test.ts` for the new flag default + override and `core.contract` exposure.

## Progress Log
- [2026-06-24] IMPLEMENTED + verified on feat/consumer-schema-compat. src/core/config.ts loadProjectConfig (never throws); contract.initiativeRecordMode 'full'|'metadata-only' (default full); types.readExpectedDurationRaw; factory exposes core.contract + .mdocs.json file-precedence merge (explicit > file > default); MdocsLinter {initiativeRecordMode} param. tsc clean; +10 tests (tests/core/config.test.ts, compatibility.test.ts).
- [2026-06-25T08:52:11.145Z] Marked done via mdocs command
- [2026-06-25] State healed: implementation re-verified; linked stable consumer-schema compatibility wiki.

## Artifacts
