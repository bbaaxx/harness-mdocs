import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import opencodePlugin from '../../../src/surfaces/opencode';
import { createOpencodeAdapter } from '../../../src/surfaces/opencode/adapter';

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-opencode-'));
}

describe('opencode adapter', () => {
  test('default export returns opencode plugin with mdocs tools', async () => {
    const directory = tempProject();
    const plugin = await opencodePlugin({ client: {}, project: {}, directory });

    expect(plugin.tool.mdocs).toBeDefined();
    expect(plugin.tool.mdocs_init).toBeDefined();
    expect(plugin.tool.mdocs_status).toBeDefined();
    expect(plugin.tool.mdocs_validate).toBeDefined();
  });

  test('tool results are wrapped with output string and metadata', async () => {
    const directory = tempProject();
    const plugin = await opencodePlugin({ client: {}, project: {}, directory });

    await plugin.tool.mdocs_init.execute({});
    const result = await plugin.tool.mdocs.execute({
      command: 'initiative.create',
      args: { id: 'wrapped', title: 'Wrapped Result' }
    });

    expect(typeof result.output).toBe('string');
    expect(result.metadata).toMatchObject({ success: true, id: 'wrapped' });
  });

  test('config hook initializes mdocs and registers bootstrap initiative', () => {
    const directory = tempProject();
    const adapter = createOpencodeAdapter(directory);
    const cfg: any = {};

    adapter.config(cfg);

    const today = new Date().toISOString().split('T')[0];
    expect(fs.existsSync(path.join(directory, 'mdocs', 'initiatives', `install-mdocs--${today}.md`))).toBe(true);
    expect(cfg.agent['mdocs-orchestrator']).toBeDefined();
  });
});
