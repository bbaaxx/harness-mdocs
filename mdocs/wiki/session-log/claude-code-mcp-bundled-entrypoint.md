---
id: "claude-code-mcp-bundled-entrypoint"
title: "Claude Code MCP bundled entrypoint fix"
category: "session-log"
created: "2026-06-24"
updated: "2026-06-24"
related_initiatives: ["fix-claude-code-mcp-dependency-bundling"]
tags: ["claude-code","mcp","packaging","dependencies"]
---

# Claude Code MCP bundled entrypoint fix

Issue: Claude Code plugin cache copies plugin files but does not run npm install. Published 0.5.2 plugin cache therefore lacked node_modules/package.json; MCP startup via dist/cli/index.js mcp imported dist/surfaces/claude-code/mcp-server.js, which runtime-required @modelcontextprotocol/sdk and zod, causing `Cannot find module '@modelcontextprotocol/sdk/server/mcp.js'`.

Fix: build process now bundles src/surfaces/claude-code/mcp-server.ts with esbuild into src/surfaces/claude-code/plugin/dist/cli/mcp-server.js and plugin.json points mcpServers.mdocs directly at that standalone file. Tests assert manifest path, bundled file existence, and absence of external SDK/zod require strings.

Verification: `npm run build:claude-plugin`; `node -e "require(process.argv[1])" <temp-plugin>/dist/cli/mcp-server.js` outside repo; `npm pack --dry-run`; `npm run lint`; targeted Claude Code plugin/MCP tests; full `npm test` (415 pass); `npm run mdocs:validate` valid with existing warnings only.
