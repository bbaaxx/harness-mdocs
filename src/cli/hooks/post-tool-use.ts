#!/usr/bin/env node
/**
 * Claude Code PostToolUse hook entrypoint, invoked via:
 *   node <pkg>/dist/cli/hooks/post-tool-use.js
 *
 * Contract:
 *   stdin  = PostToolUse payload JSON (tool_name, tool_input, tool_response, cwd)
 *   exit 0 = always (post hooks never block)
 *
 * Audit append is unlocked (append-only). The initiative read-modify-write is
 * wrapped in withLock because Claude Code runs tools in parallel and would
 * otherwise lose updates. Project root resolves from payload.cwd.
 */
import { createMdocsCore } from '../../core';
import { findInitiativeFilename } from '../../core/commands/utils';
import { parseHookStdin, toCore } from '../../surfaces/claude-code/translate';
import { withLock } from '../../surfaces/claude-code/lock';

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
  const projectDir = payload.cwd || process.cwd();
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

if (require.main === module) {
  runPostToolUse()
    .then(() => process.exit(0))
    .catch(() => process.exit(0)); // never block on failure
}
