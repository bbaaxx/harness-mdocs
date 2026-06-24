import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
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

  test('at UNDERSTAND: allows a destructive Bash command (F2: bash ungated by content)', () => {
    // F2 (workflow-enforcement-dogfood-friction-log): the destructive-bash
    // gate was deleted — it matched destructive verbs appearing as quoted
    // data / grep patterns / test scripts and blocked builds and qa. Bash is
    // now audited (PostToolUse) but NEVER blocked by content at any step.
    // Enforcement narrows to Write/Edit only. `rm -rf` used to be blocked at
    // UNDERSTAND; it is now allowed.
    const engine = new WorkflowEngine(tempMdocsRoot());
    engine.advance('UNDERSTAND');
    expect(gate(engine, 'Bash', { command: 'rm -rf /repo/src' })).toBe(true);
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

describe('block-reason uses lowercase tool name (F7)', () => {
  // F7 (workflow-enforcement-dogfood-friction-log): the block-reason string
  // emitted on stderr must use the normalised lowercase tool name ("write"),
  // not the raw payload casing ("Write"). Proven by spawning the compiled
  // hook binary with a blocking payload (the same method used in the G7
  // dogfood gate verification) and asserting exit 2 + stderr content.
  const hookPath = path.resolve(__dirname, '../../../dist/cli/hooks/pre-tool-use.js');

  function runHook(payload: object): { status: number | null; stderr: string } {
    try {
      execFileSync('node', [hookPath], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        // Inherit nothing that would let the hook find a real project.
        env: { ...process.env, MDOCS_ENFORCEMENT: '' }
      });
      return { status: 0, stderr: '' };
    } catch (err: any) {
      return { status: err.status ?? null, stderr: err.stderr ?? '' };
    }
  }

  test('blocked Write emits reason with lowercase "write"', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-f7-'));
    const mdocsRoot = path.join(projectDir, 'mdocs');
    // Advance the workflow to UNDERSTAND so Write is blocked.
    const engine = new WorkflowEngine(mdocsRoot);
    engine.advance('UNDERSTAND');

    const result = runHook({
      cwd: projectDir,
      tool_name: 'Write',
      tool_input: { file_path: '/repo/src/app.ts', content: 'x' }
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('"write"');
    // The raw payload casing ("Write") must NOT appear in the reason.
    expect(result.stderr).not.toContain('"Write"');
    expect(result.stderr).toMatch(/blocked at step UNDERSTAND/);

    fs.rmSync(projectDir, { recursive: true, force: true });
  });
});
