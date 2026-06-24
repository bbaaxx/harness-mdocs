import { MdocsCore } from '../../core';
import { findInitiativeFilename } from '../../core/commands/utils';
import { ClaudeHookPayload, toCore } from './translate';
import { withLock } from './lock';

/**
 * Adapter-level Claude Code hook definitions. These mirror the OpenCode hook
 * semantics (src/surfaces/opencode/hooks.ts) but operate on Claude Code hook
 * payloads (PascalCase tool names, snake_case args) which are first translated
 * to core conventions via translate.ts.
 *
 * The standalone CLI hook entrypoints (src/cli/hooks/*) implement the stdin/exit
 * contract; these handlers carry the same logic for programmatic adapter use.
 */
export function createClaudeCodeHooks(core: MdocsCore) {
  return {
    /**
     * PreToolUse gate. Returns { allowed, reason, step }. The CLI entrypoint
     * maps allowed=false to exit 2 + stderr.
     */
    preToolUse(payload: ClaudeHookPayload): { allowed: boolean; reason?: string; step: string } {
      const { toolName, toolArgs } = toCore(payload);
      const step = core.managers.workflow.getCurrentStep();
      const allowed = core.managers.workflow.canExecuteTool(toolName, toolArgs);
      if (allowed) return { allowed: true, step };
      return {
        allowed: false,
        step,
        reason:
          `mdocs workflow gate: "${payload.tool_name}" is blocked at step ${step}. ` +
          `Advance the workflow (e.g. reach PLAN before edits, COMPLETE before destructive bash), ` +
          `or operate on ./mdocs/ files which are always allowed.`
      };
    },

    /**
     * PostToolUse audit + progress. Audit append is unlocked (append-only);
     * the initiative read-modify-write is wrapped in withLock to survive the
     * parallel-tool race.
     */
    postToolUse(payload: ClaudeHookPayload): void {
      const { toolName } = toCore(payload);
      const step = core.managers.workflow.getCurrentStep();
      const activeInitiativeId = core.managers.workflow.status().activeInitiative;

      core.managers.audit.append({
        timestamp: new Date().toISOString(),
        type: 'tool',
        initiativeId: activeInitiativeId || undefined,
        step,
        details: { toolName, args: toCore(payload).toolArgs }
      });

      // Metadata-only mode: consumer `_status.md` is thin lifecycle metadata.
      // Skip the initiative read-modify-write progress-log mutation; the audit
      // entry above is the only record. Prevents injecting `## Progress Log`
      // into a prose-only body and preserves consumer formatting.
      if (core.contract.initiativeRecordMode === 'metadata-only') {
        return;
      }

      if (step !== 'IDLE' && activeInitiativeId) {
        withLock(core.mdocsRoot, 'initiative-progress', () => {
          const fileName = findInitiativeFilename(core.mdocsRoot, core.managers.initiatives, activeInitiativeId);
          if (!fileName) return;
          const initiative = core.managers.initiatives.read(fileName);
          if (!initiative) return;
          initiative.progressLog.push(`[${new Date().toISOString()}] ${toolName} executed at step ${step}`);
          initiative.updated = new Date().toISOString().split('T')[0];
          core.managers.initiatives.update(fileName, initiative);
        });
      }
    }
  };
}
