import { MdocsCore } from '../../core';
import { KimiHookPayload, toCore } from './translate';

/**
 * Adapter-level Kimi Code hook handlers. These mirror the Claude Code hook
 * semantics (src/surfaces/claude-code/hooks.ts) but operate on Kimi Code hook
 * payloads (PascalCase tool names, snake_case args on stdin JSON) which are
 * first translated to core conventions via translate.ts.
 *
 * The standalone hook entrypoints (src/surfaces/kimi-code/cli/*) implement the
 * stdin/exit-code contract Kimi Code documents (exit 2 + stderr = block);
 * these handlers carry the same logic for programmatic adapter use.
 */
export function createKimiCodeHooks(core: MdocsCore) {
  return {
    /**
     * PreToolUse gate. Returns { allowed, reason, step }. The CLI entrypoint
     * maps allowed=false to exit 2 + stderr, which is how Kimi Code blocks a
     * tool call (or the hookSpecificOutput permissionDecision JSON form).
     */
    preToolUse(payload: KimiHookPayload): { allowed: boolean; reason?: string; step: string } {
      const { toolName, toolArgs } = toCore(payload);
      const step = core.managers.workflow.getCurrentStep();
      const allowed = core.managers.workflow.canExecuteTool(toolName, toolArgs);
      if (allowed) return { allowed: true, step };
      return {
        allowed: false,
        step,
        reason:
          `mdocs workflow gate: "${toolName}" is blocked at step ${step}. ` +
          `Advance the workflow (e.g. reach PLAN before edits, COMPLETE before destructive bash), ` +
          `or operate on ./mdocs/ files which are always allowed.`
      };
    },

    /**
     * PostToolUse audit. Audit append only — the exhaustive per-tool trail
     * lives in mdocs/audit.log; the initiative progress log is intentional
     * notes only (authored via initiative.update progressNote). See the
     * workflow-enforcement-dogfood-friction-log F6 in the Claude Code surface.
     */
    postToolUse(payload: KimiHookPayload): void {
      const { toolName, toolArgs } = toCore(payload);
      const step = core.managers.workflow.getCurrentStep();
      const activeInitiativeId = core.managers.workflow.status().activeInitiative;

      core.managers.audit.append({
        timestamp: new Date().toISOString(),
        type: 'tool',
        initiativeId: activeInitiativeId || undefined,
        step,
        details: { toolName, args: toolArgs }
      });
    }
  };
}
