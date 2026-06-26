"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createClaudeCodeAdapter = createClaudeCodeAdapter;
const core_1 = require("../../core");
const hooks_1 = require("./hooks");
/**
 * Surface runtime for Claude Code. Wraps createMdocsCore and exposes the
 * translated hook handlers. Mirrors the loose codex/opencode adapter style.
 *
 * The MCP server (mcp-server.ts) constructs its own core per tool call and is
 * not threaded through this adapter; this adapter is for programmatic/hook use.
 */
function createClaudeCodeAdapter(projectDir, options = {}) {
    const core = (0, core_1.createMdocsCore)(projectDir, {
        standaloneCategories: options.standaloneCategories,
        bootstrap: {
            installInitiativeTitle: 'Install and Configure claude-code-mdocs'
        }
    });
    return {
        core,
        ...(0, hooks_1.createClaudeCodeHooks)(core)
    };
}
//# sourceMappingURL=adapter.js.map