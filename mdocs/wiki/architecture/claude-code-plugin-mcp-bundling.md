---
id: "claude-code-plugin-mcp-bundling"
title: "Claude Code plugin MCP bundling"
category: "architecture"
created: "2026-06-24"
updated: "2026-06-24"
related_initiatives: ["fix-claude-code-mcp-dependency-bundling"]
tags: ["claude-code","mcp","plugin","packaging"]
lifecycle: "stable"
---

# Claude Code plugin MCP bundling

Claude Code plugin installs copy plugin files into `~/.claude/plugins/cache/...`; they do not run `npm install` inside that cache. Any plugin entrypoint executed from `${CLAUDE_PLUGIN_ROOT}` must therefore be self-contained or use only files bundled in the plugin directory.

For harness-mdocs, the plugin MCP server must not launch through `dist/cli/index.js mcp` if that path eventually requires external packages from a missing plugin-cache `node_modules`. Instead, `npm run build:claude-plugin` bundles `src/surfaces/claude-code/mcp-server.ts` with esbuild into `src/surfaces/claude-code/plugin/dist/cli/mcp-server.js`, and plugin.json points `mcpServers.mdocs.args` directly at that bundled file.

Regression checks live in `tests/surfaces/claude-code/plugin.test.ts`: manifest must use `dist/cli/mcp-server.js`, bundled file must exist, and bundled output must not contain external `require("@modelcontextprotocol/sdk...")` or `require("zod")` calls.
