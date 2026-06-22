import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createMdocsCore } from '../../src/core';

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-commands-'));
}

describe('MdocsCommandRegistry', () => {
  test('runs aggregate initiative.create through core commands', async () => {
    const projectDir = tempProject();
    const core = createMdocsCore(projectDir);
    core.lifecycle.ensureInitialized();

    const result = await core.commands.execute('initiative.create', {
      id: 'cmd-created',
      title: 'Command Created',
      owner: 'agent',
      tags: ['commands'],
      relatedWiki: [],
      objective: 'Create from core command registry',
      plan: ['Write test', { description: 'Implement registry', status: 'done' }]
    });

    const today = new Date().toISOString().split('T')[0];
    expect(result).toEqual({ success: true, filename: `cmd-created--${today}.md`, id: 'cmd-created' });
    expect(fs.existsSync(path.join(projectDir, 'mdocs', 'initiatives', `cmd-created--${today}.md`))).toBe(true);
  });

  test('returns supported commands for unsupported command names', async () => {
    const projectDir = tempProject();
    const core = createMdocsCore(projectDir);

    const result = await core.commands.execute('missing.command', {});

    expect(result).toMatchObject({
      error: 'Unsupported mdocs command: missing.command'
    });
    expect(result.supportedCommands).toContain('initiative.create');
    expect(result.supportedCommands).toContain('wiki.create');
    expect(result.supportedCommands).toContain('index.sync');
  });

  test('workflow.advance drives the workflow state machine forward', async () => {
    const projectDir = tempProject();
    const core = createMdocsCore(projectDir);
    core.lifecycle.ensureInitialized();
    expect(core.managers.workflow.getCurrentStep()).toBe('IDLE');

    const r1 = await core.commands.execute('workflow.advance', { step: 'UNDERSTAND' });
    expect(r1).toMatchObject({ success: true, currentStep: 'UNDERSTAND' });
    expect(core.managers.workflow.getCurrentStep()).toBe('UNDERSTAND');

    for (const step of ['DISCOVER', 'CONTEXT', 'PLAN']) {
      await core.commands.execute('workflow.advance', { step });
    }
    // write tools unblock once at PLAN
    expect(core.managers.workflow.canExecuteTool('write', { filePath: '/repo/src/app.ts' })).toBe(true);
  });

  test('workflow.advance rejects invalid transitions', async () => {
    const core = createMdocsCore(tempProject());

    const skip = await core.commands.execute('workflow.advance', { step: 'PLAN' });
    expect(skip.error).toMatch(/skip|back|invalid/i);

    const missing = await core.commands.execute('workflow.advance', {});
    expect(missing.error).toMatch(/step/i);

    const bad = await core.commands.execute('workflow.advance', { step: 'NOPE' });
    expect(bad.error).toBeDefined();
  });
});
