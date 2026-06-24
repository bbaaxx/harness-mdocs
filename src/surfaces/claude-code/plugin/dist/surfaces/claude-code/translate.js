"use strict";
/**
 * Pure Claude Code <-> core translation. No fs, no core imports.
 * Unit-testable in isolation.
 *
 * Why this exists: core WorkflowEngine.canExecuteTool / isMdocsOperation were
 * written for OpenCode conventions (lowercase tool names, camelCase args).
 * Claude Code emits PascalCase tool names and snake_case tool_input keys.
 * Without translation the gate silently never blocks. See 02-hook-payload-translation.md.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.translateToolName = translateToolName;
exports.translateArgs = translateArgs;
exports.parseHookStdin = parseHookStdin;
exports.toCore = toCore;
/** Claude Code PascalCase tool name -> core lowercase name. */
const TOOL_NAME_MAP = {
    Read: 'read',
    Glob: 'glob',
    Grep: 'grep',
    LS: 'list',
    List: 'list',
    Write: 'write',
    Edit: 'edit',
    MultiEdit: 'edit',
    NotebookEdit: 'edit',
    Bash: 'bash',
    // Subagent dispatch tool name varies by Claude Code version/client
    // (`Task` historically, `Agent` in some builds). Both map to a non-gated
    // pass-through; mapping both keeps audit matching robust either way.
    Task: 'task',
    Agent: 'task'
};
/** Claude Code tool_input key -> core toolArgs key. */
const ARG_KEY_MAP = {
    file_path: 'filePath',
    notebook_path: 'filePath',
    path: 'path',
    pattern: 'pattern',
    command: 'command'
};
function translateToolName(claudeToolName) {
    if (claudeToolName in TOOL_NAME_MAP)
        return TOOL_NAME_MAP[claudeToolName];
    // Safe default: lowercase verbatim. Unknown tools fall through to the
    // engine's final `return true`, matching "allow unless explicitly gated".
    return claudeToolName.toLowerCase();
}
function translateArgs(toolInput) {
    const out = {};
    if (!toolInput)
        return out;
    for (const [key, value] of Object.entries(toolInput)) {
        const mapped = ARG_KEY_MAP[key] ?? key; // preserve unknown keys verbatim
        // First mapped write wins so an explicit core-shaped key isn't clobbered.
        if (!(mapped in out))
            out[mapped] = value;
    }
    return out;
}
/**
 * Parse raw stdin into a payload. Returns null on malformed input so callers
 * can FAIL OPEN (never block the user's tool because the translator choked).
 */
function parseHookStdin(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object')
            return parsed;
        return null;
    }
    catch {
        return null;
    }
}
/** Convenience: translate a full payload into core (toolName, toolArgs). */
function toCore(payload) {
    return {
        toolName: translateToolName(payload.tool_name ?? ''),
        toolArgs: translateArgs(payload.tool_input)
    };
}
//# sourceMappingURL=translate.js.map