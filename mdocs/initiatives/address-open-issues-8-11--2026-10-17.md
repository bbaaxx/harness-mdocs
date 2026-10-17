---
id: "address-open-issues-8-11"
title: "Address open issues 8 through 11"
status: "done"
created: "2026-10-17"
updated: "2026-10-17"
owner: ""
tags: ["bugfix","github-issue-8","github-issue-9","github-issue-10","github-issue-11"]
related_wiki: ["architecture/mutation-and-surface-boundary-hardening"]
next_action: "Review changes and choose release split/version; confirm reporting consumer and Kimi host before closing issues."
phase: "verification"
handoff_summary: "Implemented issues #11/#10/#9 and remaining opt-in targeted compiled-view work for #8. Final npm run release:check passed 77 suites/1659 tests, coverage gates, typecheck, packaging and zero-warning mdocs validation. Actual packed artifact smoke passed both bundled MCP surfaces, flat preservation, invalid-command rejection and targeted registration. Version remains 2.1.0; nothing committed, pushed, published or closed. Dedicated typed tools (#9 P1) deferred; real consumer/Kimi host confirmation still needed."
graduated: "2026-10-17"
---

## Objective
Fix lossless flat initiative updates, Kimi MCP launch, command schema hardening, and opt-in targeted compiled views; verify artifacts without publishing.

## Plan
- [x] Fix flat-file preservation with regressions
- [x] Fix Kimi launch from project cwd
- [x] Share command allowlist and invalid-command errors
- [x] Implement opt-in targeted compiled-view registration and truthful sync results
- [x] Run quality and release checks; document results

## Progress Log
- [2026-10-17T03:52:28.753Z] Created initiative via mdocs command
- Implemented lossless flat-file writes with stable paths and atomic replacement (#11), portable managed Kimi launcher (#10), canonical command enums and INVALID_COMMAND result (#9), opt-in targeted compiled-view registrations plus explicit creation follow-ups (#8). Focused regressions and typecheck pass. Added CRLF/wiki body preservation regressions; testing virtual provider timeout isolation for the known CI settlement flake.
- Final verification passed: npm run release:check (77 suites, 1659 tests in normal and coverage runs), generated assets, version stamps, typecheck, all coverage thresholds, npm pack dry-run. Packed 619-file artifact smoke passed flat preservation, invalid-command zero mutation, external default skip/targeted registrations, and both bundled MCP surfaces (13 tools, canonical enum, correct project). Resolved five existing memory hygiene warnings. Corrected CI test virtualizes only replacement deadline, preserving real hung-attempt timeouts. No production authority changes or publication.
- [2026-10-17T04:16:55.655Z] Marked done via mdocs command

## Artifacts
- docs/issue-8-acceptance.md
- docs/user-manual.md — targeted registration, preserving updates, command validation
- docs/agent-manual.md — external ownership and invalid-command handling
- docs/kimi-code.md — managed launcher and reinstall/reload behavior
- tests/core/flat-initiative-preservation.test.ts
- tests/core/compiled-views.test.ts
- tests/core/markdown.test.ts
- tests/surfaces/command-schema.test.ts
- tests/surfaces/kimi-code/launch.test.ts
- Local smoke artifact: /private/var/folders/6p/bhp33vz103gcx_v02y26ch3m0000gn/T/opencode/mdocs-artifact-smoke-IEjWZ7/harness-mdocs-2.1.0.tgz
