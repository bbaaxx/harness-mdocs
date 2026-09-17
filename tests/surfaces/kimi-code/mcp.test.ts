import { buildKimiMcpServer } from '../../../src/surfaces/kimi-code/mcp-server';

describe('Kimi Code MCP server', () => {
  test('registers the aggregate tool plus convenience tools', () => {
    const server: any = buildKimiMcpServer();
    const tools = server._registeredTools ?? server.server?._registeredTools ?? {};
    const names = Object.keys(tools);
    expect(names).toContain('mdocs');
    expect(names).toContain('mdocs_status');
    expect(names).toContain('mdocs_advance');
    expect(names).toContain('mdocs_ingest');
    expect(names.length).toBe(13);
  });
});
