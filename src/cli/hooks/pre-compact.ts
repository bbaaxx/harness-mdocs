#!/usr/bin/env node
/**
 * Claude Code PreCompact hook entrypoint, invoked via:
 *   node <pkg>/dist/cli/hooks/pre-compact.js
 *
 * Contract (verified against https://code.claude.com/docs/en/hooks):
 *   stdin  = PreCompact payload JSON (session_id, cwd, ...)
 *   stdout = JSON in the form
 *            {"hookSpecificOutput":{"hookEventName":"PreCompact",
 *                                   "additionalContext":"<markdown string>"}}
 *            — additionalContext is injected into the post-compaction context
 *            so the mdocs orientation survives compaction. Exit 2 would block
 *            compaction; we NEVER exit 2 (fail-open). Output processed on
 *            exit 0.
 *   exit 0 = always.
 *
 * Re-emits the same compact orientation banner as session-start.ts so a
 * compacted session keeps its mdocs bearings (active initiative, counts,
 * workflow step) without the model having to re-call mdocs_status.
 *
 * FAIL OPEN: any error exits 0 with no additionalContext. Compaction must
 * never be blocked or wedged by this hook.
 */
import { createMdocsCore, resolveProjectRoot, sessionContext } from '../../core';
import { parseHookStdin } from '../../surfaces/claude-code/translate';
import { formatOrientationBanner } from './session-start';

function readStdin(): Promise<string> {
  return new Promise(resolve => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

export async function runPreCompact(): Promise<void> {
  const raw = await readStdin();
  const payload = parseHookStdin(raw) || {};

  const projectDir = resolveProjectRoot(payload.cwd || process.cwd());
  const core = createMdocsCore(projectDir);

  const ctx = sessionContext(core);
  const additionalContext = formatOrientationBanner(ctx);

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreCompact',
      additionalContext
    }
  }));
}

if (require.main === module) {
  runPreCompact()
    .then(() => process.exit(0))
    .catch(() => {
      // Fail open: never block compaction or wedge the session.
      process.exit(0);
    });
}
