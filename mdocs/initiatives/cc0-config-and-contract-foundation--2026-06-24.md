---
id: "cc0-config-and-contract-foundation"
title: "cc0 config-file loader + initiativeRecordMode contract flag + shared helpers"
status: "active"
created: "2026-06-24"
updated: "2026-06-24"
owner: ""
tags: ["core","config","contract","compat","foundation"]
related_wiki: []
priority: "high"
---

## Objective
Establish the shared interfaces the rest of the work consumes: a `.mdocs.json` config-file loader wired into `createMdocsCore` (the documented "file" precedence tier does not currently exist in the runtime path), an opt-in `initiativeRecordMode` contract flag (default `full` = current behavior), a shared `readExpectedDurationRaw` helper that also reads the hyphenated `expected-duration`, exposing the resolved `contract` on `MdocsCore`, and threading the contract into `MdocsLinter`. No consumer-facing behavior changes by default.

## Plan
- [ ] Add `src/core/config.ts` exporting `loadProjectConfig(mdocsRoot: string): MdocsCoreOptions` that reads `<mdocsRoot>/.mdocs.json`, returns `{}` on missing/invalid (never throws), and recognizes `compatibility`, `standaloneCategories`, `mdocsDirName`.
- [ ] In `src/core/factory.ts`, load the file config and merge so explicit `options` win over file and file wins over default; add `contract` to the `MdocsCore` interface + returned object; pass the contract (or `initiativeRecordMode`) into `new MdocsLinter(...)`.
- [ ] In `src/core/types.ts`, add `readExpectedDurationRaw(front): any` returning `front.expected_duration ?? front.expectedDuration ?? front['expected-duration']`.
- [ ] In `src/core/contract.ts`, add `initiativeRecordMode?: 'full'|'metadata-only'` to `MdocsCompatibilityConfig`, add required `initiativeRecordMode` to `MdocsContract`, and resolve it in `detectMdocsContract` as `config.initiativeRecordMode ?? 'full'` (no auto-detect).
- [ ] Add `tests/core/config.test.ts` (valid/missing/malformed/merge-precedence) and extend `tests/core/compatibility.test.ts` for the new flag default + override and `core.contract` exposure.

## Acceptance Criteria
- `loadProjectConfig`, `readExpectedDurationRaw`, `MdocsCore.contract`, the `MdocsLinter` contract param, and `contract.initiativeRecordMode` exist with the signatures above.
- `createMdocsCore(projectDir)` (no options) picks up `<mdocsRoot>/.mdocs.json`; explicit options still win.
- Defaults unchanged: full existing suite green; `npx tsc --noEmit` clean.

## Progress Log
- [2026-06-24] IMPLEMENTED + verified on feat/consumer-schema-compat. src/core/config.ts loadProjectConfig (never throws); contract.initiativeRecordMode 'full'|'metadata-only' (default full); types.readExpectedDurationRaw; factory exposes core.contract + .mdocs.json file-precedence merge (explicit > file > default); MdocsLinter {initiativeRecordMode} param. tsc clean; +10 tests (tests/core/config.test.ts, compatibility.test.ts).

## Artifacts
