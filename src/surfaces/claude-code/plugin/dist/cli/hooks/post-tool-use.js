#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runPostToolUse = runPostToolUse;
/**
 * Claude Code PostToolUse hook entrypoint, invoked via:
 *   node <pkg>/dist/cli/hooks/post-tool-use.js
 *
 * Contract:
 *   stdin  = PostToolUse payload JSON (tool_name, tool_input, tool_response, cwd)
 *   exit 0 = always (post hooks never block)
 *
 * Audit append only. The exhaustive per-tool trail lives in mdocs/audit.log
 * (with args); the initiative progress log is intentional notes only (authored
 * via initiative.update progressNote), so this hook no longer touches it.
 * See workflow-enforcement-dogfood-friction-log F6.
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
async function runPostToolUse() {
    const raw = await readStdin();
    const payload = (0, translate_1.parseHookStdin)(raw);
    if (!payload)
        return; // malformed -> no-op
    const { toolName, toolArgs } = (0, translate_1.toCore)(payload);
    // Project root via the shared helper so the post hook agrees with the MCP
    // server and PreToolUse on the same mdocs root.
    const projectDir = (0, core_1.resolveProjectRoot)(payload.cwd || process.cwd());
    const core = (0, core_1.createMdocsCore)(projectDir);
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
//# sourceMappingURL=post-tool-use.js.map