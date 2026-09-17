#!/usr/bin/env node
/**
 * Kimi Code MCP server — stdio transport.
 *
 * Reuses the shared MCP registration from the Claude Code surface
 * (src/surfaces/claude-code/mcp-server.ts): same canonical 13-tool set, same
 * per-call core construction, same result translation. Kimi Code discovers it
 * via the plugin manifest's mcpServers declaration (or a manual
 * .kimi-code/mcp.json entry pointing at the bundled plugin/dist/mcp-server.js).
 *
 * This module is bundled with esbuild for the Kimi plugin (no external
 * requires), so the require.main guard below is the plugin's runtime entry.
 */
import { buildMcpServer, startMcpServer } from '../claude-code/mcp-server';

export { buildMcpServer, startMcpServer };

/** Kimi-named alias so surface parity tests exercise this surface's own export. */
export function buildKimiMcpServer() {
  return buildMcpServer();
}

/* istanbul ignore next -- process entrypoint boundary; bundled form is exercised via the plugin assets test. */
if (require.main === module) {
  startMcpServer().catch(err => {
    process.stderr.write(`mdocs kimi mcp failed: ${err?.message || err}\n`);
    process.exit(1);
  });
}
