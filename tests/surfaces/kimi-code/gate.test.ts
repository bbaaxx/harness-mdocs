import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { WorkflowEngine } from '../../../src/core/workflow/engine';
import { toCore } from '../../../src/surfaces/kimi-code/translate';

function tempMdocsRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-kimi-gate-'));
  return path.join(dir, 'mdocs');
}

/**
 * Proves the translation end-to-end: a real WorkflowEngine advanced to
 * UNDERSTAND must block Kimi Code's PascalCase Write while allowing reads,
 * bash, and mdocs-path writes. Without translate.ts the gate would silently
 * never block because canExecuteTool expects lowercase names / camelCase args.
 */
function gate(engine: WorkflowEngine, toolName: string, toolInput: Record<string, unknown>): boolean {
  const { toolName: t, toolArgs } = toCore({ tool_name: toolName, tool_input: toolInput });
  return engine.canExecuteTool(t, toolArgs);
}

describe('Kimi Code workflow gate (translated payloads)', () => {
  test('at UNDERSTAND: blocks translated Write to a source file', () => {
    const engine = new WorkflowEngine(tempMdocsRoot());
    engine.advance('UNDERSTAND');
    expect(gate(engine, 'Write', { path: '/repo/src/app.ts', content: 'x' })).toBe(false);
  });

  test('at UNDERSTAND: blocks translated Edit to a source file', () => {
    const engine = new WorkflowEngine(tempMdocsRoot());
    engine.advance('UNDERSTAND');
    expect(gate(engine, 'Edit', { path: '/repo/src/app.ts', old_string: 'a', new_string: 'b' })).toBe(false);
  });

  test('at UNDERSTAND: allows Write to an mdocs path', () => {
    const engine = new WorkflowEngine(tempMdocsRoot());
    engine.advance('UNDERSTAND');
    expect(gate(engine, 'Write', { path: '/repo/mdocs/initiatives/x.md', content: 'x' })).toBe(true);
    expect(gate(engine, 'Write', { path: 'mdocs/notes.md', content: 'x' })).toBe(true);
  });

  test('at UNDERSTAND: always allows Read and Grep', () => {
    const engine = new WorkflowEngine(tempMdocsRoot());
    engine.advance('UNDERSTAND');
    expect(gate(engine, 'Read', { path: '/repo/src/app.ts' })).toBe(true);
    expect(gate(engine, 'Grep', { pattern: 'foo', path: '/repo/src' })).toBe(true);
  });

  test('at UNDERSTAND: allows Bash regardless of content (audited, never content-gated)', () => {
    const engine = new WorkflowEngine(tempMdocsRoot());
    engine.advance('UNDERSTAND');
    expect(gate(engine, 'Bash', { command: 'rm -rf /repo/src' })).toBe(true);
    expect(gate(engine, 'Bash', { command: 'ls -la' })).toBe(true);
  });

  test('after PLAN: allows a translated Write to a source file', () => {
    const engine = new WorkflowEngine(tempMdocsRoot());
    engine.advance('UNDERSTAND');
    engine.advance('DISCOVER');
    engine.advance('CONTEXT');
    engine.advance('PLAN');
    expect(gate(engine, 'Write', { path: '/repo/src/app.ts', content: 'x' })).toBe(true);
  });
});

describe('bundled PreToolUse hook binary (plugin/dist)', () => {
  // Mirrors the Claude Code surface's F7 test: spawn the actual bundled hook
  // with a blocking payload and assert the exit-code/stderr contract Kimi
  // Code documents (exit 2 = block, stderr = reason written into context).
  const hookPath = path.resolve(__dirname, '../../../src/surfaces/kimi-code/plugin/dist/hooks/pre-tool-use.js');

  function runHook(payload: object): { status: number | null; stderr: string } {
    try {
      execFileSync('node', [hookPath], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        env: { ...process.env, MDOCS_ENFORCEMENT: '' }
      });
      return { status: 0, stderr: '' };
    } catch (err: any) {
      return { status: err.status ?? null, stderr: err.stderr ?? '' };
    }
  }

  test('blocked Write emits exit 2 + reason with lowercase "write"', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-kimi-hook-'));
    const mdocsRoot = path.join(projectDir, 'mdocs');
    const engine = new WorkflowEngine(mdocsRoot);
    engine.advance('UNDERSTAND');

    const result = runHook({
      hook_event_name: 'PreToolUse',
      cwd: projectDir,
      tool_name: 'Write',
      tool_input: { path: '/repo/src/app.ts', content: 'x' }
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('"write"');
    expect(result.stderr).not.toContain('"Write"');
    expect(result.stderr).toMatch(/blocked at step UNDERSTAND/);

    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  test('allowed Read exits 0 with no stderr', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-kimi-hook-'));
    const mdocsRoot = path.join(projectDir, 'mdocs');
    const engine = new WorkflowEngine(mdocsRoot);
    engine.advance('UNDERSTAND');

    const result = runHook({
      hook_event_name: 'PreToolUse',
      cwd: projectDir,
      tool_name: 'Read',
      tool_input: { path: '/repo/src/app.ts' }
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');

    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  test('malformed stdin fails open (exit 0)', () => {
    const result = runHookRaw('this is not json');
    expect(result.status).toBe(0);
  });

  function runHookRaw(raw: string): { status: number | null; stderr: string } {
    try {
      execFileSync('node', [hookPath], { input: raw, encoding: 'utf8' });
      return { status: 0, stderr: '' };
    } catch (err: any) {
      return { status: err.status ?? null, stderr: err.stderr ?? '' };
    }
  }
});
