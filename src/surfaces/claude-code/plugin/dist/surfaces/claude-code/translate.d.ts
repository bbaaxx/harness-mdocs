/**
 * Pure Claude Code <-> core translation. No fs, no core imports.
 * Unit-testable in isolation.
 *
 * Why this exists: core WorkflowEngine.canExecuteTool / isMdocsOperation were
 * written for OpenCode conventions (lowercase tool names, camelCase args).
 * Claude Code emits PascalCase tool names and snake_case tool_input keys.
 * Without translation the gate silently never blocks. See 02-hook-payload-translation.md.
 */
export declare function translateToolName(claudeToolName: string): string;
export declare function translateArgs(toolInput: Record<string, unknown> | undefined): Record<string, unknown>;
export interface ClaudeHookPayload {
    hook_event_name?: string;
    tool_name?: string;
    tool_input?: Record<string, unknown>;
    tool_response?: Record<string, unknown>;
    cwd?: string;
    prompt?: string;
    session_id?: string;
}
/**
 * Parse raw stdin into a payload. Returns null on malformed input so callers
 * can FAIL OPEN (never block the user's tool because the translator choked).
 */
export declare function parseHookStdin(raw: string): ClaudeHookPayload | null;
/** Convenience: translate a full payload into core (toolName, toolArgs). */
export declare function toCore(payload: ClaudeHookPayload): {
    toolName: string;
    toolArgs: Record<string, unknown>;
};
