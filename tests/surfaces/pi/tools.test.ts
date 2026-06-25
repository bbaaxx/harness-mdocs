import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createMdocsCore } from '../../../src/core';
import { createPiTools, PI_TOOL_NAMES } from '../../../src/surfaces/pi/tools';
import { createFakeCtx } from './mock';

function tempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-pi-tools-'));
  return dir;
}

function setup() {
  const projectDir = tempProject();
  const core = createMdocsCore(projectDir, { bootstrap: { installInitiativeTitle: 'Install and Configure pi-mdocs' } });
  core.lifecycle.ensureInitialized();
  const tools = createPiTools(core);
  const byName = (name: string) => tools.find(t => t.name === name)!;
  const run = async (name: string, params: any = {}) =>
    byName(name).execute('id', params, undefined, undefined, createFakeCtx(projectDir));
  return { projectDir, core, tools, byName, run, cleanup: () => fs.rmSync(projectDir, { recursive: true, force: true }) };
}

describe('pi tools registration', () => {
  test('registers every expected tool', () => {
    const { tools, cleanup } = setup();
    try {
      const names = tools.map(t => t.name);
      for (const name of PI_TOOL_NAMES) {
        expect(names).toContain(name);
      }
      expect(tools.length).toBe(PI_TOOL_NAMES.length);
    } finally {
      cleanup();
    }
  });
});

describe('pi tool execution', () => {
  test('mdocs runs a core command and returns pi-shaped content', async () => {
    const { run, cleanup } = setup();
    try {
      const r = await run('mdocs', { command: 'initiative.create', args: { title: 'Auth', id: 'auth' } });
      expect(r.content[0].type).toBe('text');
      expect(r.details).toBeDefined();
      const parsed = JSON.parse(r.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.id).toBe('auth');
    } finally {
      cleanup();
    }
  });

  test('mdocs surfaces {error} with isError:true', async () => {
    const { run, cleanup } = setup();
    try {
      const r = await run('mdocs', { command: 'bogus.command' });
      expect(r.isError).toBe(true);
      const parsed = JSON.parse(r.content[0].text);
      expect(parsed.error).toContain('Unsupported mdocs command');
    } finally {
      cleanup();
    }
  });

  test('mdocs_init initializes and returns success', async () => {
    const { run, cleanup } = setup();
    try {
      const r = await run('mdocs_init');
      const parsed = JSON.parse(r.content[0].text);
      expect(parsed.success).toBe(true);
    } finally {
      cleanup();
    }
  });

  test('mdocs_status returns workflow state', async () => {
    const { run, cleanup } = setup();
    try {
      const r = await run('mdocs_status');
      const parsed = JSON.parse(r.content[0].text);
      expect(parsed.workflow).toBeDefined();
      expect(parsed.workflow.currentStep).toBe('IDLE');
    } finally {
      cleanup();
    }
  });

  test('mdocs_validate returns a validation result', async () => {
    const { run, cleanup } = setup();
    try {
      const r = await run('mdocs_validate');
      const parsed = JSON.parse(r.content[0].text);
      expect(parsed).toHaveProperty('initiatives');
      expect(parsed).toHaveProperty('wiki');
    } finally {
      cleanup();
    }
  });

  test('mdocs_search returns results array', async () => {
    const { run, cleanup } = setup();
    try {
      await run('mdocs', { command: 'initiative.create', args: { title: 'Searchable thing', id: 'search-thing' } });
      const r = await run('mdocs_search', { query: 'searchable' });
      const parsed = JSON.parse(r.content[0].text);
      expect(Array.isArray(parsed.results)).toBe(true);
    } finally {
      cleanup();
    }
  });

  test('mdocs_lookup resolves a created initiative', async () => {
    const { run, cleanup } = setup();
    try {
      await run('mdocs', { command: 'initiative.create', args: { title: 'Lookup me', id: 'lookup-me' } });
      const r = await run('mdocs_lookup', { query: 'lookup-me' });
      const parsed = JSON.parse(r.content[0].text);
      expect(parsed.type).toBe('initiative');
      expect(parsed.id).toBe('lookup-me');
    } finally {
      cleanup();
    }
  });

  test('mdocs_lookup with field resolves by slug', async () => {
    const { run, cleanup } = setup();
    try {
      await run('mdocs', { command: 'initiative.create', args: { title: 'Slug target', id: 'slug-target' } });
      const r = await run('mdocs_lookup', { query: 'slug-target', field: 'slug' });
      const parsed = JSON.parse(r.content[0].text);
      expect(parsed.id).toBe('slug-target');
    } finally {
      cleanup();
    }
  });

  test('mdocs_dispatch assembles context for an initiative', async () => {
    const { run, cleanup } = setup();
    try {
      await run('mdocs', { command: 'initiative.create', args: { title: 'Dispatch me', id: 'dispatch-me' } });
      const r = await run('mdocs_dispatch', { initiativeId: 'dispatch-me' });
      const parsed = JSON.parse(r.content[0].text);
      expect(parsed.initiativeId).toBe('dispatch-me');
      expect(parsed.context).toBeDefined();
    } finally {
      cleanup();
    }
  });

  test('mdocs_dispatch errors when initiative is missing', async () => {
    const { run, cleanup } = setup();
    try {
      const r = await run('mdocs_dispatch', { initiativeId: 'no-such-init' });
      expect(r.isError).toBe(true);
    } finally {
      cleanup();
    }
  });

  test('mdocs_ingest requires operations', async () => {
    const { run, cleanup } = setup();
    try {
      const r = await run('mdocs_ingest', { operations: [] });
      expect(r.isError).toBe(true);
    } finally {
      cleanup();
    }
  });

  test('mdocs_ingest applies a createPage op', async () => {
    const { run, cleanup } = setup();
    try {
      const r = await run('mdocs_ingest', {
        operations: [{ type: 'createPage', category: 'architecture', id: 'flow', title: 'Flow', content: 'x' }]
      });
      const parsed = JSON.parse(r.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.applied).toBe(1);
    } finally {
      cleanup();
    }
  });

  test('mdocs_audit returns events', async () => {
    const { run, cleanup } = setup();
    try {
      const r = await run('mdocs_audit', { limit: 5 });
      const parsed = JSON.parse(r.content[0].text);
      expect(Array.isArray(parsed.events)).toBe(true);
    } finally {
      cleanup();
    }
  });

  test('mdocs_index_check reports consistency', async () => {
    const { run, cleanup } = setup();
    try {
      const r = await run('mdocs_index_check', { mode: 'check' });
      const parsed = JSON.parse(r.content[0].text);
      expect(parsed).toHaveProperty('consistent');
    } finally {
      cleanup();
    }
  });

  test('mdocs_resume lists resumable initiatives without an id', async () => {
    const { run, cleanup } = setup();
    try {
      await run('mdocs', { command: 'initiative.create', args: { title: 'Resumable', id: 'resumable' } });
      const r = await run('mdocs_resume');
      const parsed = JSON.parse(r.content[0].text);
      expect(Array.isArray(parsed.resumable)).toBe(true);
      expect(parsed.resumable.some((i: any) => i.id === 'resumable')).toBe(true);
    } finally {
      cleanup();
    }
  });

  test('mdocs_advance moves the workflow forward', async () => {
    const { run, core, cleanup } = setup();
    try {
      const r = await run('mdocs_advance', { step: 'UNDERSTAND' });
      const parsed = JSON.parse(r.content[0].text);
      expect(parsed.success).toBe(true);
      expect(core.managers.workflow.getCurrentStep()).toBe('UNDERSTAND');
    } finally {
      cleanup();
    }
  });

  test('mdocs_advance rejects an invalid step with isError', async () => {
    const { run, cleanup } = setup();
    try {
      const r = await run('mdocs_advance', { step: 'NOPE' });
      expect(r.isError).toBe(true);
    } finally {
      cleanup();
    }
  });

  test('mdocs_reset returns to IDLE and clears active initiative', async () => {
    const { run, core, cleanup } = setup();
    try {
      await run('mdocs', { command: 'initiative.create', args: { title: 'Reset me', id: 'reset-me' } });
      await run('mdocs_resume', { initiativeId: 'reset-me' });
      await run('mdocs_advance', { step: 'UNDERSTAND' });
      const r = await run('mdocs_reset');
      const parsed = JSON.parse(r.content[0].text);
      expect(parsed.currentStep).toBe('IDLE');
      expect(core.managers.workflow.status().activeInitiative).toBeNull();
    } finally {
      cleanup();
    }
  });
});
