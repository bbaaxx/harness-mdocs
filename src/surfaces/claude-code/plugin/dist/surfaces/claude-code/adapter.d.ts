import { MdocsCore } from '../../core';
export interface MdocsClaudeCodeOptions {
    standaloneCategories?: string[];
}
/**
 * Surface runtime for Claude Code. Wraps createMdocsCore and exposes the
 * translated hook handlers. Mirrors the loose codex/opencode adapter style.
 *
 * The MCP server (mcp-server.ts) constructs its own core per tool call and is
 * not threaded through this adapter; this adapter is for programmatic/hook use.
 */
export declare function createClaudeCodeAdapter(projectDir: string, options?: MdocsClaudeCodeOptions): {
    preToolUse(payload: import("./translate").ClaudeHookPayload): {
        allowed: boolean;
        reason?: string;
        step: string;
    };
    postToolUse(payload: import("./translate").ClaudeHookPayload): void;
    core: MdocsCore;
};
