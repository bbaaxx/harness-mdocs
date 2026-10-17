import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

describe('issue #10: installed Kimi MCP launch', () => {
  test('manifest starts from unrelated project cwd and uses that project memory', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdocs-kimi-launch-'));
    const home = path.join(root, 'custom kimi home');
    const project = path.join(root, 'unrelated project');
    const managed = path.join(home, 'plugins', 'managed', 'mdocs');
    const plugin = path.resolve(__dirname, '../../../src/surfaces/kimi-code/plugin');
    fs.mkdirSync(managed, { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    fs.cpSync(plugin, managed, { recursive: true });
    const manifest = JSON.parse(fs.readFileSync(path.join(managed, 'kimi.plugin.json'), 'utf8'));
    const config = manifest.mcpServers.mdocs;
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    delete env.MDOCS_PROJECT_DIR;
    env.KIMI_CODE_HOME = home;
    const transport = new StdioClientTransport({ command: config.command, args: config.args, cwd: project, env, stderr: 'pipe' });
    const client = new Client({ name: 'mdocs-launch-regression', version: '1.0.0' });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(13);
      const result = await client.callTool({ name: 'mdocs', arguments: { command: 'initiative.create', args: { id: 'project-proof', title: 'Project proof' } } });
      expect(result.isError).not.toBe(true);
      const status = await client.callTool({ name: 'mdocs_status', arguments: {} });
      expect(status.isError).not.toBe(true);
      expect(fs.readdirSync(path.join(project, 'mdocs', 'initiatives')).some(file => file.startsWith('project-proof--'))).toBe(true);
      expect(fs.existsSync(path.join(managed, 'mdocs'))).toBe(false);
    } finally {
      await client.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
});
