/**
 * MCP result translation for the Claude Code surface.
 *
 * Core commands return `{ error: string }` for normal failures (see
 * core/commands/registry.ts). MCP must flag those with isError:true so the
 * model treats the call as failed and self-corrects, instead of reading an
 * error blob as a successful result.
 */
export interface McpToolResult {
    content: Array<{
        type: 'text';
        text: string;
    }>;
    isError?: boolean;
    [key: string]: unknown;
}
export declare function toMcpResult(value: unknown): McpToolResult;
/** Wrap a thrown error (programmer error) as an MCP error result. */
export declare function toMcpError(err: unknown): McpToolResult;
