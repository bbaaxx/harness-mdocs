#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runPreCompact = runPreCompact;
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
const core_1 = require("../../core");
const translate_1 = require("../../surfaces/claude-code/translate");
const session_start_1 = require("./session-start");
function readStdin() {
    return new Promise(resolve => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => { data += chunk; });
        process.stdin.on('end', () => resolve(data));
        process.stdin.on('error', () => resolve(data));
    });
}
async function runPreCompact() {
    const raw = await readStdin();
    const payload = (0, translate_1.parseHookStdin)(raw) || {};
    const projectDir = (0, core_1.resolveProjectRoot)(payload.cwd || process.cwd());
    const core = (0, core_1.createMdocsCore)(projectDir);
    const ctx = (0, core_1.sessionContext)(core);
    const additionalContext = (0, session_start_1.formatOrientationBanner)(ctx);
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
//# sourceMappingURL=pre-compact.js.map