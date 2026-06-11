/**
 * MCP result translation for the Claude Code surface.
 *
 * Core commands return `{ error: string }` for normal failures (see
 * core/commands/registry.ts). MCP must flag those with isError:true so the
 * model treats the call as failed and self-corrects, instead of reading an
 * error blob as a successful result.
 */

export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  // The MCP SDK's CallToolResult carries an open index signature; mirroring it
  // keeps our results structurally assignable to the SDK tool-callback return.
  [key: string]: unknown;
}

export function toMcpResult(value: unknown): McpToolResult {
  const isError =
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { error?: unknown }).error === 'string';

  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);

  return isError
    ? { content: [{ type: 'text', text }], isError: true }
    : { content: [{ type: 'text', text }] };
}

/** Wrap a thrown error (programmer error) as an MCP error result. */
export function toMcpError(err: unknown): McpToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }, null, 2) }], isError: true };
}
