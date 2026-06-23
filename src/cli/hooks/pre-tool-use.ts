#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook entrypoint, invoked via:
 *   node <pkg>/dist/cli/hooks/pre-tool-use.js
 *
 * Contract:
 *   stdin  = PreToolUse payload JSON (tool_name, tool_input, cwd, ...)
 *   exit 2 = BLOCK; stderr text shown to the model as the reason
 *   exit 0 = allow
 *
 * FAIL OPEN: any error in this hook exits 0. A translator bug must never wedge
 * the session by blocking every tool. Only an explicit, successful gate denial
 * produces exit 2.
 */
import { createMdocsCore, resolveProjectRoot } from '../../core';
import { parseHookStdin, toCore } from '../../surfaces/claude-code/translate';

function readStdin(): Promise<string> {
  return new Promise(resolve => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

export async function runPreToolUse(): Promise<void> {
  const raw = await readStdin();
  const payload = parseHookStdin(raw);
  if (!payload) return; // malformed -> fail open

  const { toolName, toolArgs } = toCore(payload);

  // Project root via the shared helper so the hook agrees with the MCP
  // server on the same mdocs root. The helper honors MDOCS_PROJECT_DIR,
  // walks up to the nearest mdocs/ ancestor, and falls back to the cwd.
  const projectDir = resolveProjectRoot(payload.cwd || process.cwd());
  const core = createMdocsCore(projectDir);

  const allowed = core.managers.workflow.canExecuteTool(toolName, toolArgs);
  if (allowed) return; // exit 0

  // Explicit, successful denial: block via exit 2 + stderr reason.
  const step = core.managers.workflow.getCurrentStep();
  const blockedTool = String(payload.tool_name || toolName).toLowerCase();
  process.stderr.write(
    `mdocs workflow gate: "${blockedTool}" is blocked at step ${step}. ` +
    `Advance the workflow (e.g. reach PLAN before edits), ` +
    `or operate on ./mdocs/ files which are always allowed.\n`
  );
  process.exit(2);
}

if (require.main === module) {
  runPreToolUse().catch(() => {
    // Fail open on any unexpected error.
    process.exit(0);
  });
}
