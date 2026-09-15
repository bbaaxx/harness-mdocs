---
id: "fix-pre-release-dogfood-findings-gitsha-cli-create-activation-cli-output-contract"
title: "Fix pre-release dogfood findings (gitSha, CLI create activation, CLI output contract)"
status: "active"
created: "2026-09-15"
updated: "2026-09-15"
owner: ""
tags: ["pre-release","dogfood","cli","bug"]
related_wiki: []
priority: "medium"
---

## Objective
Fix three dogfood findings from pre-release e2e: (1) gitSha null in packed build (--version shows {version: 0.8.1, gitSha: null} — build-time SHA not embedded in dist); (2) BUG unless surface limitation: CLI `initiative.create` does not activate initiative — leaves step IDLE and activeInitiative null, requires explicit `resume <id>`; MCP path activates. Investigate whether intentional surface constraint, else fix; (3) CLI contract inconsistency: `step` emits human text on error but JSON on success — pick one output mode. All block 2.0 release.

## Plan


## Progress Log
- [2026-09-15T20:12:28.292Z] Created initiative via mdocs command
- Created from manual dogfood of packed HEAD (fbd5181) in scratch repo. Evidence: (1) `npx mdocs --version` → gitSha null from tgz install; (2) `mdocs command initiative.create` returned success but status stayed IDLE/activeInitiative null until `resume dogfood-second`; (3) `mdocs step DISCOVER` from IDLE printed 'Cannot skip from IDLE to DISCOVER' plain text exit 1, while successful steps print JSON. Blocks release-2-0-0.
- All three findings resolved by cavecrew team (2 investigators, 7 builders, 1 reviewer). (1) gitSha: scripts/write-build-info.js generates src/core/build-info.ts (BUILD_GIT_SHA+BUILD_VERSION) at build; buildInfo() priority BUILD_*→pkg.gitHead→git→null. Verified from packed tgz: gitSha fbd5181. (2) create-activation: NOT a bug — no surface activates on create; activation lives in resume by design. Added hint field to create result pointing at resume. (3) step errors now JSON {error,currentStep} via registry, incl. bare-step usage with validSteps; exit 1 preserved. Reviewer found + fixed 2 reds of same class (version resolution 0.0.0 in bundled plugin → BUILD_VERSION now preferred in operations.ts and mcp-server.ts), runtime-git cwd fallback, gitignore for generated file, plugin/dist build-info staged. Full suite 1546/1546. Non-blocking leftovers: CANONICAL_TOOL_NAMES cross-test import (pre-existing), pi tools.md description omits workflow.reset, pkg.gitHead 7-char assumption.

## Artifacts
