---
id: "fix-claude-code-mcp-dependency-bundling"
title: "Fix Claude Code MCP package dependency bundling"
status: "done"
created: "2026-06-24"
updated: "2026-06-24"
owner: ""
tags: ["claude-code","mcp","packaging","dependencies","0.5.3"]
related_wiki: ["architecture/claude-code-plugin-mcp-bundling","session-log/claude-code-mcp-bundled-entrypoint","release/harness-mdocs-0-5-3"]
priority: "medium"
next_action: "Commit, push main, tag v0.5.3, and push tag for release."
---

## Objective
Make published Claude Code MCP server self-contained so plugin installs can start without manual npm install in Claude plugin cache.

## Plan
- [x] Inspect package/build config and published-file model for Claude Code surface
- [x] Identify runtime external imports in dist/surfaces/claude-code/mcp-server.js and packaging omissions
- [x] Implement durable bundling or bundled dependency fix for MCP server
- [x] Verify local build/package contains resolvable MCP runtime dependencies
- [x] Record findings and next release notes

## Progress Log
- [2026-06-24T17:05:42.398Z] Created initiative via mdocs command
- Implemented durable Claude Code MCP packaging fix. Added esbuild dev dependency and build:claude-plugin:mcp script, bundles src/surfaces/claude-code/mcp-server.ts to plugin/dist/cli/mcp-server.js, points plugin manifest at standalone entrypoint, documents plugin cache behavior, and adds regression tests for manifest path + no external SDK/zod requires. Verification: build:claude-plugin green; temp plugin outside repo can require bundled entrypoint; npm pack --dry-run includes bundled file; lint green; targeted plugin/MCP tests green; full npm test 415 pass; mdocs:validate valid with pre-existing warnings.
- Bumped package, lockfile, Claude plugin manifest, and marketplace metadata to 0.5.3. Ran `npm run release:check` successfully: build:claude-plugin, lint, tests, coverage, mdocs validate, and npm pack dry-run all passed. Tarball includes bundled MCP entrypoint.
- [2026-06-24T17:53:32.288Z] Marked done via mdocs command
- Added stable architecture wiki entry documenting Claude Code plugin cache no-install behavior and bundled MCP entrypoint contract.

## Artifacts
