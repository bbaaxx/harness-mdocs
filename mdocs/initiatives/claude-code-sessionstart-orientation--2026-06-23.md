---
id: "claude-code-sessionstart-orientation"
title: "SessionStart orientation hook (+ PreCompact)"
status: "done"
created: "2026-06-23"
updated: "2026-06-23"
owner: ""
tags: ["claude-code","surface","hooks","orientation","sessionstart","0.4.3"]
related_wiki: ["reference/sessionstart-orientation-hook"]
priority: "medium"
---

## Objective
Add a SessionStart hook to the Claude Code plugin that emits compact mdocs orientation context at the start of every fresh session, plus an optional PreCompact re-emit so orientation survives compaction.

## Plan
- [ ] Add src/cli/hooks/session-start.ts mirroring the stdin/fail-open contract in src/cli/hooks/pre-tool-use.ts
- [ ] Add sessionContext(core) to src/core/operations.ts returning counts plus active summaries
- [ ] Emit SessionStart additionalContext JSON on stdout and fail open with exit 0 on error
- [ ] Register the hook in src/surfaces/claude-code/plugin/.claude-plugin/plugin.json under hooks.SessionStart
- [ ] Add the same SessionStart entry to src/surfaces/claude-code/assets/templates/settings-patch.json
- [ ] Add optional src/cli/hooks/pre-compact.ts and register hooks.PreCompact
- [ ] Update README.md Claude Code Usage section
- [ ] Add tests under tests/surfaces/claude-code/ for populated and empty fixtures

## Progress Log
- [2026-06-23T03:37:42.810Z] Created initiative via mdocs command
- [2026-06-23] G1 IMPLEMENTED + VERIFIED via executor. New src/cli/hooks/session-start.ts: reads SessionStart stdin payload, resolves root via G6 resolveProjectRoot, calls new sessionContext(core), emits stdout JSON {hookSpecificOutput:{hookEventName:'SessionStart',additionalContext:<markdown>}} (verified vs https://code.claude.com/docs/en/hooks), fail-open (exit 0 no output on error). New src/cli/hooks/pre-compact.ts (PreCompact re-emit, not deferred). sessionContext(core) op added (operations.ts) = counts by status + active initiative id/title + currentStep + wikiPageCount + pointer. plugin.json + settings-patch.json register SessionStart (matcher startup|resume|clear|compact) + PreCompact (matcher *). README L223. Tests: tests/surfaces/claude-code/session-start.test.ts (populated+empty fixtures, stdout shape, fail-open). 328 tests pass. build+lint+test exit 0.
- [2026-06-23T14:18:47.704Z] Marked done via mdocs command

## Artifacts
