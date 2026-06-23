#!/usr/bin/env node
/**
 * Claude Code MCP server — stdio transport. Started via `mdocs mcp`.
 *
 * Design rules (see 03-mcp-server.md):
 *   - create core PER TOOL CALL (state files mutate between calls)
 *   - project root via shared resolveProjectRoot (MDOCS_PROJECT_DIR > walk-up to nearest mdocs/ > process.cwd())
 *   - every handler returns toMcpResult/toMcpError; never throws past the boundary
 *   - stdout is the JSON-RPC channel — diagnostics go to stderr only
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createMdocsCore, MdocsCore, resolveProjectRoot } from '../../core';
import * as ops from '../../core/operations';
import { toMcpResult, toMcpError, McpToolResult } from './result';

/**
 * Resolve the project root via the shared helper so the MCP server agrees
 * with the PreToolUse / PostToolUse hooks on the same mdocs root. The helper
 * honors MDOCS_PROJECT_DIR internally, walks up from cwd to a `mdocs/`
 * ancestor, and falls back to process.cwd().
 */
function resolveProjectDir(): string {
  return resolveProjectRoot(process.cwd());
}

/** Fresh core per call so workflow/initiative state is never stale. */
function core(): MdocsCore {
  return createMdocsCore(resolveProjectDir());
}

/** Run a handler with a uniform error boundary. */
async function guard(fn: (c: MdocsCore) => unknown | Promise<unknown>): Promise<McpToolResult> {
  try {
    return toMcpResult(await fn(core()));
  } catch (err) {
    return toMcpError(err);
  }
}

/**
 * Build and register all mdocs tools on a fresh McpServer.
 * Exported so registration can be unit-tested without owning stdio.
 */
export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: 'mdocs', version: '1.0.0' });

  // --- Aggregate: source of truth -----------------------------------------
  server.tool(
    'mdocs',
    'Run any mdocs core command (initiative.*, wiki.*, validate, index.sync).',
    {
      command: z.string().describe('Command name, e.g. initiative.create'),
      args: z.record(z.string(), z.any()).optional().describe('Command payload')
    },
    async ({ command, args }) => guard(c => c.commands.execute(command, args ?? {}))
  );

  // --- Convenience tools ----------------------------------------------------
  server.tool('mdocs_init', 'Initialize the ./mdocs structure.',
    async () => guard(c => { c.managers.mdocs.init(); return { success: true }; }));

  server.tool('mdocs_status', 'Current workflow state and active initiative.',
    async () => guard(c => ops.status(c)));

  server.tool('mdocs_validate', 'Validate initiatives, wiki, and graph links.',
    async () => guard(c => c.commands.validationResult()));

  server.tool('mdocs_search', 'Search initiatives and wiki memory.',
    { query: z.string() },
    async ({ query }) => guard(c => ({ results: c.managers.search.query(query) })));

  server.tool('mdocs_lookup', 'Resolve an initiative by id, title, or slug.',
    { query: z.string() },
    async ({ query }) => guard(c => ops.lookup(c, query)));

  server.tool('mdocs_dispatch', 'Assemble subagent context for an initiative.',
    { initiativeId: z.string().optional() },
    async ({ initiativeId }) => guard(c => ops.dispatch(c, initiativeId)));

  server.tool('mdocs_audit', 'Query the audit log.',
    {
      initiativeId: z.string().optional(),
      type: z.string().optional(),
      limit: z.number().optional()
    },
    async (a) => guard(c => ops.audit(c, a)));

  server.tool('mdocs_index_check', 'Check (or repair) index consistency.',
    { repair: z.boolean().optional() },
    async ({ repair }) => guard(c => ops.indexCheck(c, repair ?? false)));

  server.tool('mdocs_resume', 'Resume an active initiative.',
    { initiativeId: z.string().optional() },
    async ({ initiativeId }) => guard(c => ops.resume(c, initiativeId)));

  server.tool('mdocs_reset', 'Reset the workflow to IDLE and clear the active initiative (full clean slate). Use to abandon an initiative mid-flight, force-reset for testing, or begin a fresh initiative cycle after COMPLETE.',
    async () => guard(c => ops.reset(c)));

  server.tool('mdocs_advance', 'Advance the workflow to the next step (UNDERSTAND, DISCOVER, CONTEXT, PLAN, EXECUTE, VERIFY, REPORT, COMPLETE). Drives the gates that block Write/Edit before PLAN.',
    { step: z.string().describe('Next workflow step, e.g. PLAN') },
    async ({ step }) => guard(c => c.commands.execute('workflow.advance', { step })));

  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport); // owns stdio; resolves when the client disconnects
}

/* istanbul ignore next -- process entrypoint boundary; startMcpServer is unit-tested with SDK mocks. */
if (require.main === module) {
  startMcpServer().catch(err => {
    process.stderr.write(`mdocs mcp failed: ${err?.message || err}\n`);
    process.exit(1);
  });
}
