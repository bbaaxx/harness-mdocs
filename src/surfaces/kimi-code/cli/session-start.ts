#!/usr/bin/env node
/**
 * Kimi Code SessionStart hook entrypoint, invoked via the plugin manifest:
 *   node ./dist/hooks/session-start.js        (cwd = plugin root)
 *
 * Contract (verified against the Kimi Code hooks documentation):
 *   stdin  = SessionStart payload JSON (hook_event_name, cwd, source, model,
 *            profile, ...) — matcher "startup|resume"
 *   stdout = plain text appended to the session context on exit 0. Unlike
 *            Claude Code there is no additionalContext JSON envelope; any
 *            stdout from an exit-0 SessionStart hook may be appended to
 *            context, so the orientation banner is emitted as markdown.
 *   exit 0 = always (SessionStart has no blocking control).
 *
 * FAIL OPEN: any error exits 0 with NO stdout so the session starts clean.
 * The orientation banner is best-effort.
 */
import { createMdocsCore, resolveProjectRoot, sessionContext } from '../../../core';
import { parseHookStdin } from '../translate';
import { formatOrientationBanner } from '../orientation';

function readStdin(): Promise<string> {
  return new Promise(resolve => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

export async function runSessionStart(): Promise<void> {
  const raw = await readStdin();
  // parseHookStdin returns null on malformed JSON — we still emit orientation
  // (cwd is the only field we need, and it is optional). Fail-open is handled
  // by the top-level catch.
  const payload = parseHookStdin(raw) || {};

  // Project root via the shared helper so the hook agrees with the MCP
  // server and PreToolUse/PostToolUse on the same mdocs root.
  const projectDir = resolveProjectRoot(payload.cwd || process.cwd());
  const core = createMdocsCore(projectDir);

  const ctx = sessionContext(core);
  process.stdout.write(formatOrientationBanner(ctx));
}

if (require.main === module) {
  runSessionStart()
    .then(() => process.exit(0))
    .catch(() => {
      // Fail open: never wedge the session start. Exit 0 with no output.
      process.exit(0);
    });
}
