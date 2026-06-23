---
id: "claude-code-sessionstart-orientation"
title: "SessionStart orientation hook (+ PreCompact)"
status: "active"
created: "2026-06-23"
updated: "2026-06-23"
owner: ""
tags: ["claude-code","surface","hooks","orientation","sessionstart","0.4.3"]
related_wiki: []
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

## Context
Source: Gap Closure Spec (0.4.3 / 0.5.0) G1. Hotspots: `src/surfaces/claude-code/plugin/.claude-plugin/plugin.json` (only PreToolUse/PostToolUse hooks exist today), `src/cli/hooks/pre-tool-use.ts` (stdin/fail-open contract to mirror), `src/core/operations.ts` (status listing to reuse), `src/surfaces/claude-code/assets/templates/settings-patch.json`, and `README.md`.

## Acceptance Criteria
- Fresh Claude Code session receives injected orientation banner with initiative counts by status, active initiative ids/titles, wiki page count, and a pointer to `mdocs_status` / `mdocs/wiki/index.md`.
- Hook errors are fail-open: exit 0 and inject no additionalContext.
- Optional PreCompact hook re-emits orientation so it survives compaction.
- All tests under `tests/surfaces/claude-code/` pass for populated and empty fixtures.

## Progress Log
- [2026-06-23T03:37:42.810Z] Created initiative via mdocs command

## Artifacts
