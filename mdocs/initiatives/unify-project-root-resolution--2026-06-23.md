---
id: "unify-project-root-resolution"
title: "Project-root resolution: unify cwd vs MDOCS_PROJECT_DIR"
status: "active"
created: "2026-06-23"
updated: "2026-06-23"
owner: ""
tags: ["claude-code","mcp","hooks","project-root","multi-project","0.4.3"]
related_wiki: []
---

## Objective
Unify project-root resolution across the MCP server and PreToolUse/PostToolUse hooks so every surface resolves the same mdocs root even when cwd and MDOCS_PROJECT_DIR disagree.

## Plan
- [ ] Define shared helper precedence MDOCS_PROJECT_DIR then walk-up from cwd to nearest mdocs/ then process.cwd() in src/core/
- [ ] Apply the helper in src/surfaces/claude-code/mcp-server.ts
- [ ] Apply the helper in src/cli/hooks/pre-tool-use.ts and src/cli/hooks/post-tool-use.ts
- [ ] Apply the helper in new src/cli/hooks/session-start.ts from G1
- [ ] Document multi-project behavior and resolution order in README.md
- [ ] Add test proving hook and MCP resolve identical roots for same env and cwd

## Context
Source: Gap Closure Spec (0.4.3 / 0.5.0) G6. `src/surfaces/claude-code/mcp-server.ts` uses `MDOCS_PROJECT_DIR || process.cwd()` while `src/cli/hooks/pre-tool-use.ts` uses `payload.cwd || process.cwd()` and ignores `MDOCS_PROJECT_DIR`. In multi-repo workspaces this makes the gate and MCP operate on different mdocs roots. Hotspots: `src/surfaces/claude-code/mcp-server.ts`, `src/cli/hooks/pre-tool-use.ts`, `src/cli/hooks/post-tool-use.ts`, the new `src/cli/hooks/session-start.ts` from G1, and `README.md`.

## Acceptance Criteria
- One shared helper implements precedence `MDOCS_PROJECT_DIR` → walk up from `cwd` to nearest `mdocs/` → `process.cwd()`.
- MCP server and all hooks resolve the same root for any combination of env var and cwd.
- README documents the precedence and the single-root-per-session limit.
- Test verifies hook and MCP produce identical roots.

## Progress Log
- [2026-06-23T03:38:11.599Z] Created initiative via mdocs command

## Artifacts
