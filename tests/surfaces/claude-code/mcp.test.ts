import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ops from '../../../src/core/operations';
import { buildMcpServer } from '../../../src/surfaces/claude-code/mcp-server';

function tempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-cc-mcp-'));
}

/**
 * Reach into the registered tools on the McpServer. The SDK stores them on the
 * underlying server instance; we access the registration map directly so we can
 * unit-test registration + handler behavior without standing up stdio.
 */
function registeredTools(server: any): Record<string, any> {
  return server._registeredTools ?? server.server?._registeredTools ?? {};
}

async function callTool(server: any, name: string, args: Record<string, unknown> = {}) {
  const tools = registeredTools(server);
  const tool = tools[name];
  if (!tool) throw new Error(`tool ${name} not registered`);
  const cb = tool.callback ?? tool.handler;
  return cb(args, {});
}

const EXPECTED_TOOLS = [
  'mdocs',
  'mdocs_init',
  'mdocs_status',
  'mdocs_validate',
  'mdocs_search',
  'mdocs_lookup',
  'mdocs_dispatch',
  'mdocs_audit',
  'mdocs_index_check',
  'mdocs_resume'
];

describe('Claude Code MCP server registration', () => {
  test('registers all 10 mdocs tools', () => {
    const server = buildMcpServer();
    const names = Object.keys(registeredTools(server));
    for (const expected of EXPECTED_TOOLS) {
      expect(names).toContain(expected);
    }
    expect(EXPECTED_TOOLS.length).toBe(10);
  });
});

describe('Claude Code MCP aggregate tool', () => {
  const prevDir = process.env.MDOCS_PROJECT_DIR;

  afterEach(() => {
    if (prevDir === undefined) delete process.env.MDOCS_PROJECT_DIR;
    else process.env.MDOCS_PROJECT_DIR = prevDir;
  });

  test('executes initiative.create and returns success', async () => {
    const projectDir = tempProject();
    process.env.MDOCS_PROJECT_DIR = projectDir;
    const server = buildMcpServer();

    await callTool(server, 'mdocs_init');

    const result = await callTool(server, 'mdocs', {
      command: 'initiative.create',
      args: {
        id: 'cc-mcp-acceptance',
        title: 'Claude Code MCP Acceptance',
        objective: 'Prove the aggregate tool drives core commands.',
        plan: ['Inspect', 'Implement', 'Verify']
      }
    });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload).toMatchObject({ success: true, id: 'cc-mcp-acceptance' });
  });

  test('flags an unsupported command with isError:true', async () => {
    const projectDir = tempProject();
    process.env.MDOCS_PROJECT_DIR = projectDir;
    const server = buildMcpServer();

    const result = await callTool(server, 'mdocs', { command: 'does.not.exist', args: {} });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toContain('Unsupported mdocs command');
  });

  test('executes convenience tools against a fresh core per call', async () => {
    const projectDir = tempProject();
    process.env.MDOCS_PROJECT_DIR = projectDir;
    const server = buildMcpServer();

    await callTool(server, 'mdocs_init');
    await callTool(server, 'mdocs', {
      command: 'initiative.create',
      args: {
        id: 'cc-mcp-convenience',
        title: 'Claude Code MCP Convenience',
        objective: 'Exercise MCP convenience tools.',
        tags: ['mcp']
      }
    });

    const status = JSON.parse((await callTool(server, 'mdocs_status')).content[0].text);
    const validate = JSON.parse((await callTool(server, 'mdocs_validate')).content[0].text);
    const search = JSON.parse((await callTool(server, 'mdocs_search', { query: 'Convenience' })).content[0].text);
    const lookup = JSON.parse((await callTool(server, 'mdocs_lookup', { query: 'cc-mcp-convenience' })).content[0].text);
    const dispatch = JSON.parse((await callTool(server, 'mdocs_dispatch', { initiativeId: 'cc-mcp-convenience' })).content[0].text);
    const audit = JSON.parse((await callTool(server, 'mdocs_audit', { initiativeId: 'cc-mcp-convenience', limit: 5 })).content[0].text);
    const indexCheck = JSON.parse((await callTool(server, 'mdocs_index_check', { repair: false })).content[0].text);
    const indexRepair = JSON.parse((await callTool(server, 'mdocs_index_check', { repair: true })).content[0].text);
    const resume = JSON.parse((await callTool(server, 'mdocs_resume', { initiativeId: 'cc-mcp-convenience' })).content[0].text);

    expect(status).toMatchObject({ currentStep: 'IDLE' });
    expect(validate).toMatchObject({ valid: true });
    expect(search.results[0]).toMatchObject({ id: 'cc-mcp-convenience' });
    expect(lookup).toMatchObject({ id: 'cc-mcp-convenience' });
    expect(dispatch).toMatchObject({ initiativeId: 'cc-mcp-convenience' });
    expect(Array.isArray(audit)).toBe(true);
    expect(indexCheck).toHaveProperty('consistent');
    expect(indexRepair).toHaveProperty('repaired');
    expect(resume.initiative).toMatchObject({ id: 'cc-mcp-convenience' });
  });

  test('wraps thrown handler errors as MCP errors', async () => {
    const statusSpy = jest.spyOn(ops, 'status').mockImplementation(() => {
      throw new Error('status boom');
    });
    try {
      process.env.MDOCS_PROJECT_DIR = tempProject();
      const server = buildMcpServer();

      const result = await callTool(server, 'mdocs_status');

      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toEqual({ error: 'status boom' });
    } finally {
      statusSpy.mockRestore();
    }
  });
});

describe('Claude Code MCP stdio startup', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.dontMock('@modelcontextprotocol/sdk/server/mcp.js');
    jest.dontMock('@modelcontextprotocol/sdk/server/stdio.js');
  });

  test('connects server to stdio transport', async () => {
    await jest.isolateModulesAsync(async () => {
      const connect = jest.fn().mockResolvedValue(undefined);
      const tool = jest.fn();
      const transport = { transport: 'stdio' };
      const McpServer = jest.fn().mockImplementation(() => ({ tool, connect }));
      const StdioServerTransport = jest.fn().mockImplementation(() => transport);

      jest.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({ McpServer }));
      jest.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport }));
      const { startMcpServer } = await import('../../../src/surfaces/claude-code/mcp-server');

      await startMcpServer();

      expect(McpServer).toHaveBeenCalledWith({ name: 'mdocs', version: '1.0.0' });
      expect(StdioServerTransport).toHaveBeenCalledTimes(1);
      expect(connect).toHaveBeenCalledWith(transport);
    });
  });
});
