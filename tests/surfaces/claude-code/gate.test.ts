import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkflowEngine } from '../../../src/core/workflow/engine';
import { toCore } from '../../../src/surfaces/claude-code/translate';

function tempMdocsRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-cc-gate-'));
  return path.join(dir, 'mdocs');
}

/**
 * Proves the translation fix end-to-end: a real WorkflowEngine advanced to
 * UNDERSTAND must block Claude Code's PascalCase Write while allowing reads
 * and mdocs-path writes. Without translate.ts the gate would silently never
 * block because canExecuteTool expects lowercase names / camelCase args.
 */
function gate(engine: WorkflowEngine, toolName: string, toolInput: Record<string, unknown>): boolean {
  const { toolName: t, toolArgs } = toCore({ tool_name: toolName, tool_input: toolInput });
  return engine.canExecuteTool(t, toolArgs);
}

describe('Claude Code workflow gate (translated payloads)', () => {
  test('at UNDERSTAND: blocks translated Write to a source file', () => {
    const engine = new WorkflowEngine(tempMdocsRoot());
    engine.advance('UNDERSTAND');
    expect(gate(engine, 'Write', { file_path: '/repo/src/app.ts', content: 'x' })).toBe(false);
  });

  test('at UNDERSTAND: allows Write to an mdocs path', () => {
    const engine = new WorkflowEngine(tempMdocsRoot());
    engine.advance('UNDERSTAND');
    expect(gate(engine, 'Write', { file_path: '/repo/mdocs/initiatives/x.md', content: 'x' })).toBe(true);
    expect(gate(engine, 'Write', { file_path: 'mdocs/notes.md', content: 'x' })).toBe(true);
  });

  test('at UNDERSTAND: always allows Read', () => {
    const engine = new WorkflowEngine(tempMdocsRoot());
    engine.advance('UNDERSTAND');
    expect(gate(engine, 'Read', { file_path: '/repo/src/app.ts' })).toBe(true);
  });

  test('at UNDERSTAND: blocks a destructive Bash command', () => {
    const engine = new WorkflowEngine(tempMdocsRoot());
    engine.advance('UNDERSTAND');
    expect(gate(engine, 'Bash', { command: 'rm -rf /repo/src' })).toBe(false);
  });

  test('at UNDERSTAND: allows a non-destructive Bash command', () => {
    const engine = new WorkflowEngine(tempMdocsRoot());
    engine.advance('UNDERSTAND');
    expect(gate(engine, 'Bash', { command: 'ls -la' })).toBe(true);
  });

  test('after PLAN: allows a translated Write to a source file', () => {
    const engine = new WorkflowEngine(tempMdocsRoot());
    engine.advance('UNDERSTAND');
    engine.advance('DISCOVER');
    engine.advance('CONTEXT');
    engine.advance('PLAN');
    expect(gate(engine, 'Write', { file_path: '/repo/src/app.ts', content: 'x' })).toBe(true);
  });
});
