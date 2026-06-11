import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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
});
