/**
 * MCP result translation for the Kimi Code surface.
 *
 * Kimi Code acts as an MCP client; the result contract is identical to the
 * Claude Code surface (same shared MCP server), so the implementation is
 * re-exported rather than duplicated.
 */
export { toMcpResult, toMcpError } from '../claude-code/result';
export type { McpToolResult } from '../claude-code/result';
