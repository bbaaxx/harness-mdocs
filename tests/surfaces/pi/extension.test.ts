import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import createPiExtension from '../../../src/surfaces/pi/extension';
import { createMockExtensionAPI, createFakeCtx, MockExtensionAPI } from './mock';

function tempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-pi-ext-'));
  return dir;
}

function loadExtension(projectDir: string): { api: MockExtensionAPI; cleanup: () => void } {
  const prevCwd = process.cwd();
  process.chdir(projectDir);
  const api = createMockExtensionAPI();
  createPiExtension(api as any);
  return { api, cleanup: () => process.chdir(prevCwd) };
}

function getTool(api: MockExtensionAPI, name: string): any {
  return api.tools.find((t: any) => t.name === name);
}

async function runTool(api: MockExtensionAPI, name: string, params: any = {}): Promise<any> {
  const tool = getTool(api, name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return tool.execute('call-id', params, undefined, undefined, createFakeCtx(process.cwd()));
}

function handler(api: MockExtensionAPI, event: string) {
  const h = api.handlerFor(event);
  if (!h) throw new Error(`no handler for ${event}`);
  return h;
}

function readInitiativeFile(projectDir: string, idFragment: string): { file: string; content: string } | null {
  const dir = path.join(projectDir, 'mdocs', 'initiatives');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md') && f !== 'INDEX.md' && f.includes(idFragment));
  if (files.length === 0) return null;
  const file = files[0];
  return { file, content: fs.readFileSync(path.join(dir, file), 'utf8') };
}

describe('pi extension tool_call gate', () => {
  test('blocks write at UNDERSTAND', async () => {
    const projectDir = tempProject();
    const { api, cleanup } = loadExtension(projectDir);
    try {
      await runTool(api, 'mdocs_advance', { step: 'UNDERSTAND' });
      const res = await handler(api, 'tool_call')(
        { toolName: 'write', input: { path: '/repo/src/app.ts', content: 'x' } },
        createFakeCtx(projectDir)
      );
      expect(res).toEqual({ block: true, reason: expect.stringContaining('blocked at step UNDERSTAND') });
    } finally {
      cleanup();
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('allows write at PLAN', async () => {
    const projectDir = tempProject();
    const { api, cleanup } = loadExtension(projectDir);
    try {
      for (const step of ['UNDERSTAND', 'DISCOVER', 'CONTEXT', 'PLAN']) {
        await runTool(api, 'mdocs_advance', { step });
      }
      const res = await handler(api, 'tool_call')(
        { toolName: 'write', input: { path: '/repo/src/app.ts', content: 'x' } },
        createFakeCtx(projectDir)
      );
      expect(res).toBeUndefined();
    } finally {
      cleanup();
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('always allows write to ./mdocs/ paths', async () => {
    const projectDir = tempProject();
    const { api, cleanup } = loadExtension(projectDir);
    try {
      await runTool(api, 'mdocs_advance', { step: 'UNDERSTAND' });
      const res = await handler(api, 'tool_call')(
        { toolName: 'write', input: { path: 'mdocs/notes.md', content: 'x' } },
        createFakeCtx(projectDir)
      );
      expect(res).toBeUndefined();
    } finally {
      cleanup();
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('always allows read', async () => {
    const projectDir = tempProject();
    const { api, cleanup } = loadExtension(projectDir);
    try {
      await runTool(api, 'mdocs_advance', { step: 'UNDERSTAND' });
      const res = await handler(api, 'tool_call')(
        { toolName: 'read', input: { path: '/repo/src/app.ts' } },
        createFakeCtx(projectDir)
      );
      expect(res).toBeUndefined();
    } finally {
      cleanup();
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

describe('pi extension tool_result audit + progress', () => {
  test('appends an audit event and a progress-log entry in full mode', async () => {
    const projectDir = tempProject();
    const { api, cleanup } = loadExtension(projectDir);
    try {
      await runTool(api, 'mdocs', { command: 'initiative.create', args: { title: 'Test init', id: 'test-init' } });
      await runTool(api, 'mdocs_resume', { initiativeId: 'test-init' });
      await runTool(api, 'mdocs_advance', { step: 'UNDERSTAND' });

      await handler(api, 'tool_result')(
        { toolName: 'write', input: { path: '/repo/src/app.ts' } },
        createFakeCtx(projectDir)
      );

      const audit = await runTool(api, 'mdocs_audit', {});
      const parsed = JSON.parse(audit.content[0].text);
      expect(parsed.events.length).toBeGreaterThan(0);
      expect(parsed.events.some((e: any) => e.details.toolName === 'write')).toBe(true);

      const init = readInitiativeFile(projectDir, 'test-init');
      expect(init).not.toBeNull();
      expect(init!.content).toMatch(/write executed at step UNDERSTAND/);
    } finally {
      cleanup();
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('skips progress-log mutation in metadata-only mode but still audits', async () => {
    const projectDir = tempProject();
    fs.mkdirSync(path.join(projectDir, 'mdocs'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'mdocs', '.mdocs.json'),
      JSON.stringify({ compatibility: { initiativeRecordMode: 'metadata-only' } })
    );
    const { api, cleanup } = loadExtension(projectDir);
    try {
      await runTool(api, 'mdocs', { command: 'initiative.create', args: { title: 'Meta only', id: 'meta-only' } });
      await runTool(api, 'mdocs_resume', { initiativeId: 'meta-only' });
      await runTool(api, 'mdocs_advance', { step: 'UNDERSTAND' });

      await handler(api, 'tool_result')(
        { toolName: 'write', input: { path: '/repo/src/app.ts' } },
        createFakeCtx(projectDir)
      );

      // Audit still recorded.
      const audit = await runTool(api, 'mdocs_audit', {});
      const parsed = JSON.parse(audit.content[0].text);
      expect(parsed.events.some((e: any) => e.details.toolName === 'write')).toBe(true);

      // No progress-log mutation in metadata-only mode.
      const init = readInitiativeFile(projectDir, 'meta-only');
      expect(init).not.toBeNull();
      expect(init!.content).not.toMatch(/write executed at step UNDERSTAND/);
    } finally {
      cleanup();
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

describe('pi extension before_agent_start orientation', () => {
  test('appends an orientation banner to the system prompt', async () => {
    const projectDir = tempProject();
    const { api, cleanup } = loadExtension(projectDir);
    try {
      const res = await handler(api, 'before_agent_start')(
        { systemPrompt: 'BASE PROMPT' },
        createFakeCtx(projectDir)
      );
      expect(res.systemPrompt).toContain('BASE PROMPT');
      expect(res.systemPrompt).toContain('mdocs — Initiative and Wiki Memory');
      expect(res.systemPrompt).toContain('mdocs_status');
    } finally {
      cleanup();
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

describe('pi extension session_start notification', () => {
  test('notifies the user when UI is present', async () => {
    const projectDir = tempProject();
    const { api, cleanup } = loadExtension(projectDir);
    try {
      const ctx = createFakeCtx(projectDir, { hasUI: true });
      await handler(api, 'session_start')({}, ctx);
      expect(ctx.ui.notify).toHaveBeenCalled();
      const [msg, level] = ctx.ui.notify.mock.calls[0];
      expect(msg).toMatch(/mdocs active/);
      expect(level).toBe('info');
    } finally {
      cleanup();
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('does not throw when UI is absent (fail open)', async () => {
    const projectDir = tempProject();
    const { api, cleanup } = loadExtension(projectDir);
    try {
      const ctx = createFakeCtx(projectDir, { hasUI: false });
      await expect(handler(api, 'session_start')({}, ctx)).resolves.toBeUndefined();
      expect(ctx.ui.notify).not.toHaveBeenCalled();
    } finally {
      cleanup();
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

describe('pi extension fail-open', () => {
  test('tool_call handler never throws on a malformed event', async () => {
    const projectDir = tempProject();
    const { api, cleanup } = loadExtension(projectDir);
    try {
      await expect(handler(api, 'tool_call')(null, createFakeCtx(projectDir))).resolves.toBeUndefined();
      await expect(handler(api, 'tool_call')({ toolName: 'write', input: null }, createFakeCtx(projectDir))).resolves.toBeUndefined();
    } finally {
      cleanup();
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('tool_result handler never throws on a malformed event', async () => {
    const projectDir = tempProject();
    const { api, cleanup } = loadExtension(projectDir);
    try {
      await expect(handler(api, 'tool_result')(null, createFakeCtx(projectDir))).resolves.toBeUndefined();
    } finally {
      cleanup();
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('before_agent_start never throws on a malformed event', async () => {
    const projectDir = tempProject();
    const { api, cleanup } = loadExtension(projectDir);
    try {
      await expect(handler(api, 'before_agent_start')(null, createFakeCtx(projectDir))).resolves.toBeUndefined();
    } finally {
      cleanup();
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
