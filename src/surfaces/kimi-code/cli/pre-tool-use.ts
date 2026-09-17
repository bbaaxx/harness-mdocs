#!/usr/bin/env node
/**
 * Kimi Code PreToolUse hook entrypoint, invoked via the plugin manifest:
 *   node ./dist/hooks/pre-tool-use.js        (cwd = plugin root)
 * or a manual [[hooks]] rule in config.toml.
 *
 * Contract (verified against the Kimi Code hooks documentation):
 *   stdin  = hook payload JSON (hook_event_name, tool_name, tool_input, cwd, ...)
 *   exit 2 = BLOCK; stderr text is written into the context as the reason
 *   exit 0 = allow
 *   (exit 2 may also carry a { hookSpecificOutput: { permissionDecision: "deny" } }
 *    JSON on stdout; the exit-code + stderr form is used here — it is the
 *    documented primary mechanism and keeps the reason visible.)
 *
 * FAIL OPEN: any error in this hook exits 0. Kimi Code already fails open on
 * hook errors/timeouts, and a translator bug must never wedge the session by
 * blocking every tool. Only an explicit, successful gate denial produces
 * exit 2.
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
  process.stderr.write(
    `mdocs workflow gate: "${toolName}" is blocked at step ${step}. ` +
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
