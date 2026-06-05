import { WorkflowEngine } from '../../src/core/workflow/engine';
import * as fs from 'fs';
import * as path from 'path';

const testDir = path.join(__dirname, 'test-workflow');

beforeEach(() => {
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true });
  }
  fs.mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true });
  }
});

describe('WorkflowEngine', () => {
  test('starts at IDLE', () => {
    const engine = new WorkflowEngine(testDir);
    expect(engine.getCurrentStep()).toBe('IDLE');
  });

  test('advances through steps', () => {
    const engine = new WorkflowEngine(testDir);
    engine.advance('UNDERSTAND');
    expect(engine.getCurrentStep()).toBe('UNDERSTAND');
    
    engine.advance('DISCOVER');
    expect(engine.getCurrentStep()).toBe('DISCOVER');
    
    engine.advance('CONTEXT');
    expect(engine.getCurrentStep()).toBe('CONTEXT');
    
    engine.advance('PLAN');
    expect(engine.getCurrentStep()).toBe('PLAN');
  });

  test('cannot skip steps', () => {
    const engine = new WorkflowEngine(testDir);
    expect(() => engine.advance('PLAN')).toThrow('Cannot skip');
  });

  test('cannot go backwards', () => {
    const engine = new WorkflowEngine(testDir);
    engine.advance('UNDERSTAND');
    expect(() => engine.advance('IDLE')).toThrow('Cannot go back');
  });

  test('allows read tools always', () => {
    const engine = new WorkflowEngine(testDir);
    expect(engine.canExecuteTool('read')).toBe(true);
    expect(engine.canExecuteTool('glob')).toBe(true);
    expect(engine.canExecuteTool('grep')).toBe(true);
    expect(engine.canExecuteTool('list')).toBe(true);
  });

  test('blocks write tools before PLAN', () => {
    const engine = new WorkflowEngine(testDir);
    expect(engine.canExecuteTool('write')).toBe(true); // IDLE allows all
    
    engine.advance('UNDERSTAND');
    expect(engine.canExecuteTool('write')).toBe(false);
    
    engine.advance('DISCOVER');
    engine.advance('CONTEXT');
    engine.advance('PLAN');
    expect(engine.canExecuteTool('write')).toBe(true);
  });

  test('allows non-destructive bash commands before COMPLETE', () => {
    const engine = new WorkflowEngine(testDir);
    engine.advance('UNDERSTAND');
    
    expect(engine.canExecuteTool('bash', { command: 'ls -la' })).toBe(true);
    expect(engine.canExecuteTool('bash', { command: 'cat file.txt' })).toBe(true);
    expect(engine.canExecuteTool('bash', { command: 'echo hello' })).toBe(true);
    expect(engine.canExecuteTool('bash', { command: 'pwd' })).toBe(true);
  });

  test('blocks destructive bash commands before COMPLETE', () => {
    const engine = new WorkflowEngine(testDir);
    engine.advance('UNDERSTAND');
    
    expect(engine.canExecuteTool('bash', { command: 'rm -rf /' })).toBe(false);
    expect(engine.canExecuteTool('bash', { command: 'git commit -m "msg"' })).toBe(false);
    expect(engine.canExecuteTool('bash', { command: 'mv old new' })).toBe(false);
    
    // After reaching COMPLETE, destructive commands are allowed
    engine.advance('DISCOVER');
    engine.advance('CONTEXT');
    engine.advance('PLAN');
    engine.advance('EXECUTE');
    engine.advance('VERIFY');
    engine.advance('REPORT');
    engine.advance('COMPLETE');
    expect(engine.canExecuteTool('bash', { command: 'git commit -m "msg"' })).toBe(true);
  });

  test('allows write/edit on absolute mdocs paths regardless of step', () => {
    const engine = new WorkflowEngine(testDir);
    engine.advance('UNDERSTAND');
    
    // Absolute paths with /mdocs/
    expect(engine.canExecuteTool('write', { filePath: '/project/mdocs/initiatives/test.md' })).toBe(true);
    expect(engine.canExecuteTool('edit', { filePath: '/project/mdocs/wiki/entry.md' })).toBe(true);
    expect(engine.canExecuteTool('write', { filePath: '/project/mdocs/.workflow-state.json' })).toBe(true);
    
    // But non-mdocs paths should still be blocked
    expect(engine.canExecuteTool('write', { filePath: '/project/src/index.ts' })).toBe(false);
    expect(engine.canExecuteTool('edit', { filePath: '/project/README.md' })).toBe(false);
  });

  test('allows write/edit on relative mdocs paths regardless of step', () => {
    const engine = new WorkflowEngine(testDir);
    engine.advance('UNDERSTAND');
    
    // Relative paths starting with mdocs/
    expect(engine.canExecuteTool('write', { filePath: 'mdocs/initiatives/test.md' })).toBe(true);
    expect(engine.canExecuteTool('edit', { filePath: 'mdocs/wiki/entry.md' })).toBe(true);
    
    // Non-mdocs relative paths should be blocked
    expect(engine.canExecuteTool('write', { filePath: 'src/index.ts' })).toBe(false);
  });

  test('allows read on mdocs paths regardless of step', () => {
    const engine = new WorkflowEngine(testDir);
    engine.advance('UNDERSTAND');
    
    expect(engine.canExecuteTool('read', { filePath: '/project/mdocs/initiatives/INDEX.md' })).toBe(true);
    expect(engine.canExecuteTool('glob', { pattern: 'mdocs/**/*.md' })).toBe(true);
    expect(engine.canExecuteTool('grep', { pattern: 'test', path: '/project/mdocs' })).toBe(true);
  });

  test('allows bash commands on mdocs paths regardless of step', () => {
    const engine = new WorkflowEngine(testDir);
    engine.advance('UNDERSTAND');
    
    expect(engine.canExecuteTool('bash', { command: 'ls /project/mdocs/initiatives' })).toBe(true);
    expect(engine.canExecuteTool('bash', { command: 'cat /project/mdocs/wiki/test.md' })).toBe(true);
    
    // Non-mdocs bash should still respect gates
    expect(engine.canExecuteTool('bash', { command: 'git commit -m "msg"' })).toBe(false);
  });

  test('persists state to file', () => {
    const engine = new WorkflowEngine(testDir);
    engine.advance('UNDERSTAND');
    
    const statePath = path.join(testDir, '.workflow-state.json');
    expect(fs.existsSync(statePath)).toBe(true);
    
    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(saved.currentStep).toBe('UNDERSTAND');
  });

  test('can set active initiative and reset workflow for resume', () => {
    const workflow = new WorkflowEngine(testDir);

    workflow.setActiveInitiative('dispatch');
    workflow.resumeAt('CONTEXT');

    expect(workflow.status().activeInitiative).toBe('dispatch');
    expect(workflow.status().currentStep).toBe('CONTEXT');
    expect(workflow.status().stepHistory.at(-1)?.step).toBe('CONTEXT');
  });
});
