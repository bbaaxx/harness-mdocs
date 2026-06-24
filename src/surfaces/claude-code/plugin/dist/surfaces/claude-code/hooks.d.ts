import { MdocsCore } from '../../core';
import { ClaudeHookPayload } from './translate';
/**
 * Adapter-level Claude Code hook definitions. These mirror the OpenCode hook
 * semantics (src/surfaces/opencode/hooks.ts) but operate on Claude Code hook
 * payloads (PascalCase tool names, snake_case args) which are first translated
 * to core conventions via translate.ts.
 *
 * The standalone CLI hook entrypoints (src/cli/hooks/*) implement the stdin/exit
 * contract; these handlers carry the same logic for programmatic adapter use.
 */
export declare function createClaudeCodeHooks(core: MdocsCore): {
    /**
     * PreToolUse gate. Returns { allowed, reason, step }. The CLI entrypoint
     * maps allowed=false to exit 2 + stderr.
     */
    preToolUse(payload: ClaudeHookPayload): {
        allowed: boolean;
        reason?: string;
        step: string;
    };
    /**
     * PostToolUse audit + progress. Audit append is unlocked (append-only);
     * the initiative read-modify-write is wrapped in withLock to survive the
     * parallel-tool race.
     */
    postToolUse(payload: ClaudeHookPayload): void;
};
