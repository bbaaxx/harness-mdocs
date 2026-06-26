import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createMdocsCore, MdocsCore, resolveProjectRoot, withLock } from '../../core';
import { findInitiativeFilename } from '../../core/commands/utils';
import { createPiTools } from './tools';
import { formatOrientationBanner, formatOrientationNotify } from './orientation';
import { toCore } from './translate';

/**
 * pi extension factory for the mdocs surface.
 *
 * Registered via the `pi` manifest in package.json:
 *   "pi": { "extensions": ["./dist/surfaces/pi/extension.js"], ... }
 *
 * Loads one `MdocsCore` per extension load. pi extensions are reloaded on
 * session switch/reload, so state naturally refreshes. The project root is
 * resolved with the shared `resolveProjectRoot` helper so the pi surface
 * agrees with the MCP server and CLI hooks when the session starts in a
 * subdirectory (honors `MDOCS_PROJECT_DIR`, walks up to a `mdocs/` ancestor,
 * falls back to cwd).
 *
 * Fail open: every event handler is wrapped in try/catch and never throws. A
 * thrown handler can wedge the agent, so errors are swallowed and the tool
 * call / result proceeds unchanged. Only `import type` is used from
 * `@earendil-works/pi-coding-agent` — no runtime value import from pi.
 */
export default function (pi: ExtensionAPI): void {
  let core: MdocsCore;
  try {
    const projectDir = resolveProjectRoot(process.cwd());
    core = createMdocsCore(projectDir, {
      bootstrap: { installInitiativeTitle: 'Install and Configure pi-mdocs' }
    });
  } catch {
    // If core construction fails, register nothing and bail. Tools/events
    // are simply absent rather than wedging the session.
    return;
  }

  try {
    core.lifecycle.ensureInitialized();
  } catch {
    // fail open — continue without a bootstrapped install initiative
  }

  // --- tool_call gate ------------------------------------------------------
  // Block write/edit before PLAN (allowed PLAN..COMPLETE). ./mdocs/ paths are
  // always allowed because core already whitelists them. Bash is audited but
  // not gated by content.
  pi.on('tool_call', async (event: any, _ctx: any) => {
    try {
      const { toolName, toolArgs } = toCore(event);
      if (!core.managers.workflow.canExecuteTool(toolName, toolArgs)) {
        const step = core.managers.workflow.getCurrentStep();
        return {
          block: true,
          reason:
            `mdocs workflow gate: "${toolName}" is blocked at step ${step}. ` +
            `Advance the workflow (e.g. mdocs_advance to PLAN before edits), ` +
            `or operate on ./mdocs/ files which are always allowed.`
        };
      }
    } catch {
      // fail open — never block because the gate itself choked
    }
    return undefined;
  });

  // --- tool_result audit + progress ---------------------------------------
  // Audit append is unlocked (append-only). The initiative read-modify-write
  // is wrapped in withLock to survive pi's parallel tool execution.
  pi.on('tool_result', async (event: any, _ctx: any) => {
    try {
      const { toolName, toolArgs } = toCore(event);
      const step = core.managers.workflow.getCurrentStep();
      const activeInitiativeId = core.managers.workflow.status().activeInitiative;

      core.managers.audit.append({
        timestamp: new Date().toISOString(),
        type: 'tool',
        initiativeId: activeInitiativeId || undefined,
        step,
        details: { toolName, args: toolArgs }
      });

      // Metadata-only mode: consumer `_status.md` is thin lifecycle metadata.
      // Skip the progress-log mutation; the audit entry above is the only
      // record. Prevents injecting a Progress Log into a prose-only body.
      if (core.contract.initiativeRecordMode === 'metadata-only') {
        return undefined;
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
    } catch {
      // fail open — audit/progress must never break the tool result
    }
    return undefined;
  });

  // --- before_agent_start orientation banner -------------------------------
  // Append a compact markdown banner to the system prompt every turn. Kept
  // small (~1 KB) to avoid prompt noise.
  pi.on('before_agent_start', async (event: any, _ctx: any) => {
    try {
      const banner = formatOrientationBanner(core);
      const base = typeof event.systemPrompt === 'string' ? event.systemPrompt : '';
      return { systemPrompt: base + '\n\n' + banner };
    } catch {
      // fail open — leave the system prompt untouched
    }
    return undefined;
  });

  // --- session_start user notification -------------------------------------
  pi.on('session_start', async (_event: any, ctx: any) => {
    try {
      if (ctx?.hasUI && typeof ctx?.ui?.notify === 'function') {
        ctx.ui.notify(formatOrientationNotify(core), 'info');
      }
    } catch {
      // fail open — notification is best-effort
    }
    return undefined;
  });

  // --- custom tools --------------------------------------------------------
  for (const def of createPiTools(core)) {
    try {
      pi.registerTool(def as any);
    } catch {
      // fail open — a single failing registration must not abort the rest
    }
  }
}
