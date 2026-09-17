import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createKimiCodeAdapter } from '../../../src/surfaces/kimi-code/adapter';
import { createMdocsCore } from '../../../src/core';

function tempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-kimi-adapter-'));
}

describe('Kimi Code adapter', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = tempProject();
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  test('returns a core plus translated hook handlers', () => {
    const adapter = createKimiCodeAdapter(projectDir);
    expect(adapter.core).toBeDefined();
    expect(typeof adapter.preToolUse).toBe('function');
    expect(typeof adapter.postToolUse).toBe('function');
  });

  test('preToolUse allows read tools and reports the current step', () => {
    const adapter = createKimiCodeAdapter(projectDir);
    const result = adapter.preToolUse({
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { path: '/repo/src/app.ts' },
      cwd: projectDir
    });
    expect(result.allowed).toBe(true);
    expect(result.step).toBe('IDLE');
  });

  test('preToolUse denies Write outside ./mdocs/ once the workflow has started', () => {
    const adapter = createKimiCodeAdapter(projectDir);
    adapter.core.managers.workflow.advance('UNDERSTAND');

    const result = adapter.preToolUse({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { path: '/repo/src/app.ts', content: 'x' },
      cwd: projectDir
    });
    expect(result.allowed).toBe(false);
    expect(result.step).toBe('UNDERSTAND');
    expect(result.reason).toContain('"write"');
    expect(result.reason).toContain('blocked at step UNDERSTAND');
  });

  test('preToolUse allows Write under ./mdocs/ even before PLAN', () => {
    const adapter = createKimiCodeAdapter(projectDir);
    adapter.core.managers.workflow.advance('UNDERSTAND');

    const result = adapter.preToolUse({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { path: 'mdocs/initiatives/x.md', content: 'x' },
      cwd: projectDir
    });
    expect(result.allowed).toBe(true);
  });

  test('postToolUse appends an audit entry with the translated tool name', () => {
    const adapter = createKimiCodeAdapter(projectDir);
    adapter.core.managers.workflow.advance('UNDERSTAND');

    adapter.postToolUse({
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { path: 'mdocs/initiatives/x.md', old_string: 'a', new_string: 'b' },
      cwd: projectDir
    });

    const entries = adapter.core.managers.audit.query({ type: 'tool', limit: 1 });
    const entry = entries[entries.length - 1];
    expect(entry).toBeDefined();
    expect(entry.details.toolName).toBe('edit');
    expect(entry.step).toBe('UNDERSTAND');
  });

  test('adapter core agrees with a independently constructed core on project root', () => {
    const adapter = createKimiCodeAdapter(projectDir);
    const independent = createMdocsCore(projectDir);
    expect(adapter.core.mdocsRoot).toBe(independent.mdocsRoot);
  });
});
