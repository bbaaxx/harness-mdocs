#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatOrientationBanner = formatOrientationBanner;
exports.runSessionStart = runSessionStart;
/**
 * Claude Code SessionStart hook entrypoint, invoked via:
 *   node <pkg>/dist/cli/hooks/session-start.js
 *
 * Contract (verified against https://code.claude.com/docs/en/hooks):
 *   stdin  = SessionStart payload JSON (session_id, cwd, source, transcript_path, ...)
 *   stdout = JSON in the form
 *            {"hookSpecificOutput":{"hookEventName":"SessionStart",
 *                                   "additionalContext":"<markdown string>"}}
 *            — the additionalContext string is injected into the session at
 *            the start of the conversation, before the first prompt. Output
 *            is only processed on exit 0. SessionStart also accepts plain
 *            stdout text as context, but we emit the JSON form so the shape
 *            is unambiguous and forward-compatible with other event fields.
 *   exit 0 = always (SessionStart has no blocking control).
 *
 * FAIL OPEN: any error in this hook exits 0 with NO additionalContext.
 * A translator/parser bug must never wedge the session by emitting broken
 * JSON or hanging on startup. The orientation banner is best-effort.
 */
const core_1 = require("../../core");
const translate_1 = require("../../surfaces/claude-code/translate");
function readStdin() {
    return new Promise(resolve => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => { data += chunk; });
        process.stdin.on('end', () => resolve(data));
        process.stdin.on('error', () => resolve(data));
    });
}
/**
 * Format the sessionContext snapshot as a compact markdown orientation
 * banner. Kept short — additionalContext is capped at 10,000 chars by
 * Claude Code, and SessionStart runs on every session so the banner should
 * be a pointer, not a full dump.
 */
function formatOrientationBanner(ctx) {
    const lines = ['## mdocs orientation'];
    const countParts = [];
    const totalInitiatives = Object.values(ctx.counts).reduce((a, b) => a + b, 0);
    if (totalInitiatives === 0) {
        countParts.push('0 initiatives');
    }
    else {
        for (const status of ['active', 'complete', 'done', 'archived']) {
            if (ctx.counts[status])
                countParts.push(`${ctx.counts[status]} ${status}`);
        }
        // Surface any unexpected statuses too (e.g. paused, blocked).
        for (const [status, n] of Object.entries(ctx.counts)) {
            if (!['active', 'complete', 'done', 'archived'].includes(status)) {
                countParts.push(`${n} ${status}`);
            }
        }
    }
    lines.push(`Initiatives: ${countParts.join(', ')} (workflow step: ${ctx.currentStep})`);
    if (ctx.activeInitiative) {
        lines.push(`Active: ${ctx.activeInitiative.title} (\`${ctx.activeInitiative.id}\`)`);
    }
    lines.push(`Wiki pages: ${ctx.wikiPageCount}`);
    lines.push('Use `mdocs_status` / see `mdocs/wiki/index.md` to resume work.');
    return lines.join('\n');
}
async function runSessionStart() {
    const raw = await readStdin();
    // parseHookStdin returns null on malformed JSON — we still emit orientation
    // (cwd is the only field we need, and it is optional). Fail-open is handled
    // by the top-level catch.
    const payload = (0, translate_1.parseHookStdin)(raw) || {};
    // Project root via the shared G6 helper so the hook agrees with the MCP
    // server and PreToolUse/PostToolUse on the same mdocs root.
    const projectDir = (0, core_1.resolveProjectRoot)(payload.cwd || process.cwd());
    const core = (0, core_1.createMdocsCore)(projectDir);
    const ctx = (0, core_1.sessionContext)(core);
    const additionalContext = formatOrientationBanner(ctx);
    // Verified SessionStart JSON shape. Exit 0 so the output is processed.
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext
        }
    }));
}
if (require.main === module) {
    runSessionStart()
        .then(() => process.exit(0))
        .catch(() => {
        // Fail open: never wedge the session start. Exit 0 with no output so
        // Claude Code processes the (empty) stdout without error.
        process.exit(0);
    });
}
//# sourceMappingURL=session-start.js.map