#!/usr/bin/env node
/**
 * Kimi Code PostToolUse hook entrypoint, invoked via the plugin manifest:
 *   node ./dist/hooks/post-tool-use.js       (cwd = plugin root)
 *
 * Contract:
 *   stdin  = hook payload JSON (hook_event_name, tool_name, tool_input, cwd)
 *   exit 0 = always (PostToolUse is observation-only; it cannot block)
 *
 * Audit append only. The exhaustive per-tool trail lives in mdocs/audit.log
 * (with args); the initiative progress log is intentional notes only (authored
 * via initiative.update progressNote). See the Claude Code surface's
 * workflow-enforcement-dogfood-friction-log F6.
 */
import { createMdocsCore, resolveProjectRoot } from '../../../core';
import { parseHookStdin, toCore } from '../translate';

function readStdin(): Promise<string> {
  return new Promise(resolve => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

export async function runPostToolUse(): Promise<void> {
  const raw = await readStdin();
  const payload = parseHookStdin(raw);
  if (!payload) return; // malformed -> no-op

  const { toolName, toolArgs } = toCore(payload);
  // Project root via the shared helper so the post hook agrees with the MCP
  // server and PreToolUse on the same mdocs root.
  const projectDir = resolveProjectRoot(payload.cwd || process.cwd());
  const core = createMdocsCore(projectDir);

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

if (require.main === module) {
  runPostToolUse()
    .then(() => process.exit(0))
    .catch(() => process.exit(0)); // never block on failure
}
