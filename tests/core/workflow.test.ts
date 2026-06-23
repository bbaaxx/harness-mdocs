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

  test('bash is ungated by content at every step (F2: destructive-bash gate deleted)', () => {
    // F2 (workflow-enforcement-dogfood-friction-log): the DESTRUCTIVE_BASH
    // regex was deleted because it matched destructive verbs appearing as
    // quoted data / grep patterns / test scripts, blocking builds and qa.
    // Bash is now audited (PostToolUse) but NEVER blocked by content at any
    // step. Enforcement narrows to Write/Edit only. This test proves the new
    // model: commands that USED to be blocked (`rm`, `git commit`, `mv`) are
    // now allowed at UNDERSTAND — the Write/Edit gate is the real guardrail.
    const engine = new WorkflowEngine(testDir);
    engine.advance('UNDERSTAND');

    expect(engine.canExecuteTool('bash', { command: 'rm -rf /' })).toBe(true);
    expect(engine.canExecuteTool('bash', { command: 'git commit -m "msg"' })).toBe(true);
    expect(engine.canExecuteTool('bash', { command: 'mv old new' })).toBe(true);

    // Still allowed after reaching COMPLETE — bash was never step-gated to
    // begin with under the new model; COMPLETE doesn't unlock anything new
    // for bash because there was nothing to unlock.
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

  test('allows bash commands on mdocs paths and non-mdocs paths regardless of step', () => {
    // F2: bash is ungated by content at every step, on mdocs paths AND
    // non-mdocs paths. (Previously this test coupled its last assertion to the
    // destructive-bash check; that gate is deleted, so `git commit` is now
    // allowed too. The mdocs-path allowance still holds and is asserted
    // first; the non-mdocs allowance is the new behaviour.)
    const engine = new WorkflowEngine(testDir);
    engine.advance('UNDERSTAND');

    expect(engine.canExecuteTool('bash', { command: 'ls /project/mdocs/initiatives' })).toBe(true);
    expect(engine.canExecuteTool('bash', { command: 'cat /project/mdocs/wiki/test.md' })).toBe(true);

    // Non-mdocs bash is also allowed — bash is never blocked by content.
    expect(engine.canExecuteTool('bash', { command: 'git commit -m "msg"' })).toBe(true);
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

  test('allows build/test commands at VERIFY (non-destructive)', () => {
    const engine = new WorkflowEngine(testDir);
    engine.advance('UNDERSTAND');
    engine.advance('DISCOVER');
    engine.advance('CONTEXT');
    engine.advance('PLAN');
    engine.advance('EXECUTE');
    engine.advance('VERIFY');

    // Build/test tooling must run at VERIFY so verification is reachable
    // before COMPLETE. F2 deleted the destructive-bash gate, so ALL bash
    // commands are allowed at VERIFY (and every other step); these build/test
    // commands are the legitimate subset we most care about.
    expect(engine.canExecuteTool('bash', { command: 'npm run build' })).toBe(true);
    expect(engine.canExecuteTool('bash', { command: 'npm test' })).toBe(true);
    expect(engine.canExecuteTool('bash', { command: 'npx jest' })).toBe(true);
    expect(engine.canExecuteTool('bash', { command: 'node dist/cli/index.js status' })).toBe(true);
    expect(engine.canExecuteTool('bash', { command: 'tsc --noEmit' })).toBe(true);
    expect(engine.canExecuteTool('bash', { command: 'git status' })).toBe(true);
    expect(engine.canExecuteTool('bash', { command: 'git diff' })).toBe(true);
    // /dev/null redirection is benign noise suppression, not a destructive overwrite
    expect(engine.canExecuteTool('bash', { command: 'node dist/cli/index.js status >/dev/null' })).toBe(true);
    expect(engine.canExecuteTool('bash', { command: 'npm test 2>/dev/null' })).toBe(true);
    // File redirects are allowed too — bash is ungated by content (F2).
    expect(engine.canExecuteTool('bash', { command: 'echo x > /tmp/out.txt' })).toBe(true);
  });

  test('bash commands are allowed at VERIFY and COMPLETE (F2: bash ungated by content)', () => {
    // F2: destructive-bash gate deleted. Commands that USED to require
    // COMPLETE (`rm`, `git commit`, `git push`, `npm publish`, `cp -f`) are
    // now allowed at VERIFY — bash is audited but never blocked by content.
    // The "don't commit before COMPLETE" guidance moved to the agent prompt,
    // not a regex. Compare against the Write/Edit gate which DOES still block
    // before PLAN.
    const engine = new WorkflowEngine(testDir);
    engine.advance('UNDERSTAND');
    engine.advance('DISCOVER');
    engine.advance('CONTEXT');
    engine.advance('PLAN');
    engine.advance('EXECUTE');
    engine.advance('VERIFY');

    // Bash ungated at VERIFY — would have been blocked under the old model.
    expect(engine.canExecuteTool('bash', { command: 'rm -rf dist' })).toBe(true);
    expect(engine.canExecuteTool('bash', { command: 'git commit -m "x"' })).toBe(true);
    expect(engine.canExecuteTool('bash', { command: 'git push' })).toBe(true);
    expect(engine.canExecuteTool('bash', { command: 'npm publish' })).toBe(true);
    expect(engine.canExecuteTool('bash', { command: 'cp -f a b' })).toBe(true);

    engine.advance('REPORT');
    engine.advance('COMPLETE');
    expect(engine.canExecuteTool('bash', { command: 'git commit -m "x"' })).toBe(true);
    expect(engine.canExecuteTool('bash', { command: 'npm publish' })).toBe(true);
  });
});

describe('WorkflowEngine — configurable enforcement (G3)', () => {
  describe('IDLE strictness (F1-A)', () => {
    test('under idle=open (default), IDLE allows Write/Edit/Bash like 0.4.2', () => {
      // F1-A: `open` is the default and preserves 0.4.2 behaviour — every
      // tool is allowed at IDLE so existing installs see no change.
      const engine = new WorkflowEngine(testDir, { idle: 'open' });
      expect(engine.getCurrentStep()).toBe('IDLE');
      expect(engine.canExecuteTool('write', { filePath: '/repo/src/app.ts' })).toBe(true);
      expect(engine.canExecuteTool('edit', { filePath: '/repo/src/app.ts' })).toBe(true);
      expect(engine.canExecuteTool('bash', { command: 'rm -rf /' })).toBe(true);
      // Read tools and mdocs paths remain allowed.
      expect(engine.canExecuteTool('read')).toBe(true);
      expect(engine.canExecuteTool('write', { filePath: '/repo/mdocs/x.md' })).toBe(true);
    });

    test('under idle=readonly, IDLE blocks Write/Edit/Bash until the first advance', () => {
      // F1-A: `readonly` makes enforcement real before the first advance —
      // IDLE permits only read tools plus any ./mdocs/ path; Write/Edit/Bash
      // are blocked with the same reason used at UNDERSTAND.
      const engine = new WorkflowEngine(testDir, { idle: 'readonly' });
      expect(engine.getCurrentStep()).toBe('IDLE');
      expect(engine.canExecuteTool('write', { filePath: '/repo/src/app.ts' })).toBe(false);
      expect(engine.canExecuteTool('edit', { filePath: '/repo/src/app.ts' })).toBe(false);
      expect(engine.canExecuteTool('bash', { command: 'npm test' })).toBe(false);
      // Read tools stay allowed at IDLE under readonly.
      expect(engine.canExecuteTool('read')).toBe(true);
      expect(engine.canExecuteTool('glob')).toBe(true);
      expect(engine.canExecuteTool('grep')).toBe(true);
      expect(engine.canExecuteTool('list')).toBe(true);
      // mdocs paths are always allowed regardless of idle mode.
      expect(engine.canExecuteTool('write', { filePath: '/repo/mdocs/x.md' })).toBe(true);

      // After advancing past IDLE, the normal band rules apply: Write/Edit
      // still blocked until PLAN, bash ungated.
      engine.advance('UNDERSTAND');
      expect(engine.canExecuteTool('write', { filePath: '/repo/src/app.ts' })).toBe(false);
      expect(engine.canExecuteTool('bash', { command: 'rm -rf /' })).toBe(true);
    });

    test('idle defaults to open when the option is omitted', () => {
      const engine = new WorkflowEngine(testDir);
      expect(engine.canExecuteTool('write', { filePath: '/repo/src/app.ts' })).toBe(true);
    });
  });

  describe('enforcement mode (gate/advisory/off)', () => {
    test('advisory mode allows writes/edits before PLAN (audited, not blocked)', () => {
      // Advisory: writes/edits allowed (no block) but every tool call is still
      // recorded in the audit log. For teams that want the trail without the
      // friction.
      const engine = new WorkflowEngine(testDir, { enforcementMode: 'advisory' });
      engine.advance('UNDERSTAND');
      expect(engine.canExecuteTool('write', { filePath: '/repo/src/app.ts' })).toBe(true);
      expect(engine.canExecuteTool('edit', { filePath: '/repo/src/app.ts' })).toBe(true);
      // Reads and bash remain allowed.
      expect(engine.canExecuteTool('read')).toBe(true);
      expect(engine.canExecuteTool('bash', { command: 'rm -rf /' })).toBe(true);
    });

    test('off mode disables enforcement entirely (CI escape hatch)', () => {
      // `off` — no enforcement at all. CI escape hatch (MDOCS_ENFORCEMENT=off).
      const engine = new WorkflowEngine(testDir, { enforcementMode: 'off' });
      engine.advance('UNDERSTAND');
      expect(engine.canExecuteTool('write', { filePath: '/repo/src/app.ts' })).toBe(true);
      expect(engine.canExecuteTool('edit', { filePath: '/repo/src/app.ts' })).toBe(true);
      expect(engine.canExecuteTool('bash', { command: 'git commit' })).toBe(true);
      // Even under idle=readonly + off, the off escape hatch wins.
      const permissive = new WorkflowEngine(testDir, { enforcementMode: 'off', idle: 'readonly' });
      expect(permissive.canExecuteTool('write', { filePath: '/repo/src/app.ts' })).toBe(true);
    });

    test('gate mode (default) blocks Write/Edit before PLAN', () => {
      const engine = new WorkflowEngine(testDir, { enforcementMode: 'gate' });
      engine.advance('UNDERSTAND');
      expect(engine.canExecuteTool('write', { filePath: '/repo/src/app.ts' })).toBe(false);
      expect(engine.canExecuteTool('edit', { filePath: '/repo/src/app.ts' })).toBe(false);
    });
  });

  describe('reset primitive (F9-B)', () => {
    test('reset() returns the engine to IDLE and clears the active initiative', () => {
      const engine = new WorkflowEngine(testDir);
      engine.setActiveInitiative('some-init');
      engine.advance('UNDERSTAND');
      engine.advance('DISCOVER');

      engine.reset();

      expect(engine.getCurrentStep()).toBe('IDLE');
      expect(engine.status().activeInitiative).toBeNull();
      // The reset transition is recorded in the step history trail.
      expect(engine.status().stepHistory.at(-1)?.step).toBe('IDLE');
    });
  });
});
