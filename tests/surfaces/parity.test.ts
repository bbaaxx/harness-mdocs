import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createMdocsCore } from '../../src/core';
import { createOpencodeTools } from '../../src/surfaces/opencode/tools';
import { createPiTools, PI_TOOL_NAMES } from '../../src/surfaces/pi/tools';
import { buildMcpServer } from '../../src/surfaces/claude-code/mcp-server';

/**
 * Surface-parity contract: every tool-bearing surface must register the same
 * canonical tool set. A surface that drifts (adds late, omits) fails CI here
 * instead of surfacing mid-session as a missing tool.
 *
 * Codex is intentionally excluded: it is a CLI+skills surface with no tool
 * registration by design (see src/surfaces/codex/index.ts capabilities).
 */
export const CANONICAL_TOOL_NAMES = [
  'mdocs',
  'mdocs_init',
  'mdocs_status',
  'mdocs_validate',
  'mdocs_search',
  'mdocs_lookup',
  'mdocs_dispatch',
  'mdocs_ingest',
  'mdocs_audit',
  'mdocs_index_check',
  'mdocs_resume',
  'mdocs_advance',
  'mdocs_reset'
] as const;

function tempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-parity-'));
}

function mcpToolNames(): string[] {
  const server: any = buildMcpServer();
  const tools = server._registeredTools ?? server.server?._registeredTools ?? {};
  return Object.keys(tools);
}

describe('surface tool parity', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = tempProject();
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  test('opencode registers the canonical tool set', () => {
    const core = createMdocsCore(projectDir);
    const names = Object.keys(createOpencodeTools(core));
    expect([...names].sort()).toEqual([...CANONICAL_TOOL_NAMES].sort());
  });

  test('pi registers the canonical tool set', () => {
    expect([...PI_TOOL_NAMES].sort()).toEqual([...CANONICAL_TOOL_NAMES].sort());
    const core = createMdocsCore(projectDir);
    const names = createPiTools(core).map(t => t.name);
    expect([...names].sort()).toEqual([...CANONICAL_TOOL_NAMES].sort());
  });

  test('claude-code MCP registers the canonical tool set', () => {
    expect(mcpToolNames().sort()).toEqual([...CANONICAL_TOOL_NAMES].sort());
  });
});
