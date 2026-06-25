/**
 * pi tool result translation.
 *
 * Core commands return `{ error: string }` for normal failures (see
 * core/commands/registry.ts). pi tool `execute` returns an `AgentToolResult`:
 *   { content: Array<{ type: 'text'; text: string }>, details: unknown, terminate?: boolean }
 * We surface `{ error }` payloads with `isError: true` so the model treats the
 * call as failed and self-corrects, instead of reading an error blob as a
 * successful result. This mirrors the Claude Code MCP surface (result.ts).
 *
 * Note on pi's error model: pi's `AgentToolResult` type does not declare
 * `isError`, and pi's docs state that throwing is the canonical failure signal
 * while returning a value never sets the error flag. We surface the structured
 * error content as text AND include `isError: true` on the returned object for
 * parity with the MCP surface and so downstream `tool_result` handlers /
 * renderers that inspect the field can see it. The error text is always
 * present in `content` regardless, so the model sees the failure even if a
 * host ignores the extra `isError` field. `details` is always present (pi's
 * type requires it) — we keep it as an empty object placeholder.
 */

export interface PiToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details: unknown;
  terminate?: boolean;
  isError?: boolean;
  [key: string]: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function toPiToolResult(value: unknown): PiToolResult {
  const isError = isPlainObject(value) && typeof value.error === 'string';

  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);

  return isError
    ? { content: [{ type: 'text', text }], details: {}, isError: true }
    : { content: [{ type: 'text', text }], details: {} };
}

/** Wrap a thrown error (programmer error) as a pi error result. */
export function toPiToolError(err: unknown): PiToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }, null, 2) }],
    details: {},
    isError: true
  };
}
