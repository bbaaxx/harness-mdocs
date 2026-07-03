---
id: "sync-plugin-validation-runtime"
title: "Sync plugin validation runtime with initiative INDEX parser fix"
status: "done"
created: "2026-07-03"
updated: "2026-07-03"
owner: ""
tags: ["validation","plugin","mdocs","runtime"]
related_wiki: []
priority: "medium"
---

## Objective
Ensure runtime mdocs validation surfaces use the same initiative INDEX filename-field parser as source, and record stable wiki learning so completed validation initiative passes graph lint.

## Plan


## Progress Log
- [2026-07-03T19:41:38.586Z] Created initiative via mdocs command
- Corrected runtime validation follow-up. Shared INDEX row parser now handles titles containing em dashes and `.md` tokens; both validate() and checkConsistency() use it. Regenerated Claude Code plugin dist and bundled MCP server so next tool process uses fixed parser. Added stable wiki learning `docs/initiative-index-filename-validation` sourced from prior completed initiative. Verification passed: npm run build:claude-plugin; npm test -- tests/core/initiative.test.ts; npm run typecheck; npm run build; node dist/cli/index.js validate --human returned clean. Current in-process mdocs_validate still reports old false positives because this MCP process was loaded before rebuilt plugin/runtime.
- [2026-07-03T19:45:13.592Z] Marked done via mdocs command

## Artifacts
