---
id: "unify-project-root-resolution"
title: "Project-root resolution: unify cwd vs MDOCS_PROJECT_DIR"
status: "done"
created: "2026-06-23"
updated: "2026-06-23"
owner: ""
tags: ["claude-code","mcp","hooks","project-root","multi-project","0.4.3"]
related_wiki: ["architecture/project-root-resolution"]
priority: "medium"
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

## Progress Log
- [2026-06-23T03:38:11.599Z] Created initiative via mdocs command
- [2026-06-23] G6 IMPLEMENTED + VERIFIED via executor. New src/core/project-root.ts resolveProjectRoot(cwd): precedence (a) MDOCS_PROJECT_DIR if set+existing dir (honored even before mdocs/ bootstrapped, preserves set-env->init flow), (b) walk up cwd to nearest ancestor containing mdocs/, (c) fallback cwd. Exported from core index. Applied to all 3 surfaces: mcp-server.ts L25, pre-tool-use.ts L38, post-tool-use.ts L36 (all now resolveProjectRoot(...)). README section added (L242). Tests: tests/core/project-root.test.ts + tests/surfaces/claude-code/project-root-unified.test.ts (hook+MCP identical-root parity). 318 tests pass. build+lint+test exit 0. Non-breaking (no env+cwd-has-mdocs => root==cwd). session-start.ts application deferred to G1.
- [2026-06-23T14:04:59.771Z] Marked done via mdocs command

## Artifacts
