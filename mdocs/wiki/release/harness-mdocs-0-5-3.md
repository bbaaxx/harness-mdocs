---
id: "harness-mdocs-0-5-3"
title: "harness-mdocs 0.5.3"
category: "release"
created: "2026-06-24"
updated: "2026-06-24"
related_initiatives: ["fix-claude-code-mcp-dependency-bundling"]
tags: ["release","0.5.3","claude-code","mcp","packaging"]
---

# harness-mdocs 0.5.3

Patch release for Claude Code plugin MCP startup.

## Fix
- Bundles Claude Code MCP server into `src/surfaces/claude-code/plugin/dist/cli/mcp-server.js` using esbuild.
- Plugin manifest now launches the standalone bundled MCP entrypoint directly.
- Removes runtime dependency on plugin-cache `node_modules` for MCP transport (`@modelcontextprotocol/sdk`, `zod`).

## Verification
- `npm run release:check` passed.
- 415 Jest tests passed.
- Coverage passed.
- `npm pack --dry-run` produced `harness-mdocs-0.5.3.tgz` and included bundled MCP entrypoint.
