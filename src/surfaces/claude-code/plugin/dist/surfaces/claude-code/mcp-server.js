#!/usr/bin/env node
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildMcpServer = buildMcpServer;
exports.startMcpServer = startMcpServer;
/**
 * Claude Code MCP server — stdio transport. Started via `mdocs mcp`.
 *
 * Design rules (see 03-mcp-server.md):
 *   - create core PER TOOL CALL (state files mutate between calls)
 *   - project root via shared resolveProjectRoot (MDOCS_PROJECT_DIR > walk-up to nearest mdocs/ > process.cwd())
 *   - every handler returns toMcpResult/toMcpError; never throws past the boundary
 *   - stdout is the JSON-RPC channel — diagnostics go to stderr only
 */
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const zod_1 = require("zod");
const core_1 = require("../../core");
const ops = __importStar(require("../../core/operations"));
const result_1 = require("./result");
/**
 * Resolve the project root via the shared helper so the MCP server agrees
 * with the PreToolUse / PostToolUse hooks on the same mdocs root. The helper
 * honors MDOCS_PROJECT_DIR internally, walks up from cwd to a `mdocs/`
 * ancestor, and falls back to process.cwd().
 */
function resolveProjectDir() {
    return (0, core_1.resolveProjectRoot)(process.cwd());
}
/** Fresh core per call so workflow/initiative state is never stale. */
function core() {
    return (0, core_1.createMdocsCore)(resolveProjectDir());
}
/** Run a handler with a uniform error boundary. */
async function guard(fn) {
    try {
        return (0, result_1.toMcpResult)(await fn(core()));
    }
    catch (err) {
        return (0, result_1.toMcpError)(err);
    }
}
/**
 * Build and register all mdocs tools on a fresh McpServer.
 * Exported so registration can be unit-tested without owning stdio.
 */
function buildMcpServer() {
    const server = new mcp_js_1.McpServer({ name: 'mdocs', version: '1.0.0' });
    // --- Aggregate: source of truth -----------------------------------------
    server.tool('mdocs', 'Run any mdocs core command (initiative.*, wiki.*, validate, index.sync).', {
        command: zod_1.z.string().describe('Command name, e.g. initiative.create'),
        args: zod_1.z.record(zod_1.z.string(), zod_1.z.any()).optional().describe('Command payload')
    }, async ({ command, args }) => guard(c => c.commands.execute(command, args ?? {})));
    // --- Convenience tools ----------------------------------------------------
    server.tool('mdocs_init', 'Initialize the ./mdocs structure.', async () => guard(c => { c.managers.mdocs.init(); return { success: true }; }));
    server.tool('mdocs_status', 'Current workflow state and active initiative.', async () => guard(c => ops.status(c)));
    server.tool('mdocs_validate', 'Validate initiatives, wiki, and graph links.', async () => guard(c => c.commands.validationResult()));
    server.tool('mdocs_search', 'Search initiatives and wiki memory.', { query: zod_1.z.string() }, async ({ query }) => guard(c => ({ results: c.managers.search.query(query) })));
    server.tool('mdocs_lookup', 'Resolve an initiative by id, title, or slug.', { query: zod_1.z.string() }, async ({ query }) => guard(c => ops.lookup(c, query)));
    server.tool('mdocs_dispatch', 'Assemble subagent context for an initiative.', { initiativeId: zod_1.z.string().optional() }, async ({ initiativeId }) => guard(c => ops.dispatch(c, initiativeId)));
    server.tool('mdocs_audit', 'Query the audit log.', {
        initiativeId: zod_1.z.string().optional(),
        type: zod_1.z.string().optional(),
        limit: zod_1.z.number().optional()
    }, async (a) => guard(c => ops.audit(c, a)));
    server.tool('mdocs_index_check', 'Check (or repair) index consistency.', { repair: zod_1.z.boolean().optional() }, async ({ repair }) => guard(c => ops.indexCheck(c, repair ?? false)));
    server.tool('mdocs_resume', 'Resume an active initiative.', { initiativeId: zod_1.z.string().optional() }, async ({ initiativeId }) => guard(c => ops.resume(c, initiativeId)));
    server.tool('mdocs_reset', 'Reset the workflow to IDLE and clear the active initiative (full clean slate). Use to abandon an initiative mid-flight, force-reset for testing, or begin a fresh initiative cycle after COMPLETE.', async () => guard(c => ops.reset(c)));
    server.tool('mdocs_advance', 'Advance the workflow to the next step (UNDERSTAND, DISCOVER, CONTEXT, PLAN, EXECUTE, VERIFY, REPORT, COMPLETE). Drives the gates that block Write/Edit before PLAN.', { step: zod_1.z.string().describe('Next workflow step, e.g. PLAN') }, async ({ step }) => guard(c => c.commands.execute('workflow.advance', { step })));
    server.tool('mdocs_ingest', 'Batch-compose wiki pages + compiled views (overview.md/log.md) from caller-supplied operations. Records only what the caller supplies — never auto-generates prose. Composes wiki.* atomically under a lock.', { operations: zod_1.z.array(zod_1.z.record(zod_1.z.string(), zod_1.z.any())), note: zod_1.z.string().optional() }, async ({ operations, note }) => guard(c => c.commands.execute('wiki.ingest', { operations, note })));
    return server;
}
async function startMcpServer() {
    const server = buildMcpServer();
    const transport = new stdio_js_1.StdioServerTransport();
    await server.connect(transport); // owns stdio; resolves when the client disconnects
}
/* istanbul ignore next -- process entrypoint boundary; startMcpServer is unit-tested with SDK mocks. */
if (require.main === module) {
    startMcpServer().catch(err => {
        process.stderr.write(`mdocs mcp failed: ${err?.message || err}\n`);
        process.exit(1);
    });
}
//# sourceMappingURL=mcp-server.js.map