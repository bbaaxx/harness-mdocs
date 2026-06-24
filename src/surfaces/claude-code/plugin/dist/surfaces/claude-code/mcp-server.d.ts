#!/usr/bin/env node
/**
 * Claude Code MCP server — stdio transport. Started via `mdocs mcp`.
 *
 * Design rules (see 03-mcp-server.md):
 *   - create core PER TOOL CALL (state files mutate between calls)
 *   - project root via shared resolveProjectRoot (MDOCS_PROJECT_DIR > walk-up to nearest mdocs/ > process.cwd())
 *   - every handler returns toMcpResult/toMcpError; never throws past the boundary
 *   - stdout is the JSON-RPC channel — diagnostics go to stderr only
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
/**
 * Build and register all mdocs tools on a fresh McpServer.
 * Exported so registration can be unit-tested without owning stdio.
 */
export declare function buildMcpServer(): McpServer;
export declare function startMcpServer(): Promise<void>;
