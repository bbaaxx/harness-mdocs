import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { createMdocsCore, sessionContext } from '../../../src/core';
import { formatOrientationBanner } from '../../../src/cli/hooks/session-start';
import { WorkflowEngine, STEPS } from '../../../src/core/workflow/engine';

const hookPath = path.resolve(__dirname, '../../../dist/cli/hooks/session-start.js');
const preCompactHookPath = path.resolve(__dirname, '../../../dist/cli/hooks/pre-compact.js');

/**
 * G1: SessionStart orientation hook. Proves the contract end-to-end by
 * spawning the compiled hook binary with a SessionStart-shaped payload and
 * asserting the stdout JSON shape from the Claude Code hook docs:
 *   {"hookSpecificOutput":{"hookEventName":"SessionStart",
 *                          "additionalContext":"<markdown>"}}
 *
 * Docs source: https://code.claude.com/docs/en/hooks (SessionStart decision
 * control section + "Add context for Claude" section). Output is only
 * processed on exit 0; additionalContext is capped at 10,000 chars.
 */
function runHook(binary: string, payload: object, env: NodeJS.ProcessEnv = {}): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  try {
    const stdout = execFileSync('node', [binary], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      env: { ...process.env, ...env }
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err: any) {
    return { status: err.status ?? null, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

function makeProjectDir(opts: { withInitiative?: boolean; withWiki?: boolean; activeId?: string; step?: any }): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-session-start-'));
  const mdocsRoot = path.join(projectDir, 'mdocs');
  fs.mkdirSync(path.join(mdocsRoot, 'initiatives'), { recursive: true });
  fs.mkdirSync(path.join(mdocsRoot, 'wiki'), { recursive: true });

  if (opts.withInitiative) {
    // Write a flat-file initiative (default contract roots at the project
    // dir; the InitiativeManager reads .md files under initiatives/).
    const fileName = 'active-feature--2026-06-23.md';
    const content = `---
id: "active-feature"
title: "Active Feature Work"
status: "active"
created: "2026-06-23"
updated: "2026-06-23"
owner: ""
tags: ["feature"]
related_wiki: []
---

## Objective
Ship the feature.

## Plan
- [ ] Do the thing

## Progress Log

## Artifacts
`;
    fs.writeFileSync(path.join(mdocsRoot, 'initiatives', fileName), content, 'utf8');
  }

  if (opts.withWiki) {
    fs.writeFileSync(
      path.join(mdocsRoot, 'wiki', 'INDEX.md'),
      '# Wiki\n\n## Categories\n\n- [systems](systems/INDEX.md)\n',
      'utf8'
    );
    fs.mkdirSync(path.join(mdocsRoot, 'wiki', 'systems'), { recursive: true });
    fs.writeFileSync(
      path.join(mdocsRoot, 'wiki', 'systems', 'INDEX.md'),
      '# systems\n\n- [system-page](system-page.md)\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(mdocsRoot, 'wiki', 'systems', 'system-page.md'),
      '---\nid: "system-page"\ntitle: "System Page"\ncategory: "systems"\ncreated: "2026-06-23"\nupdated: "2026-06-23"\nrelated_initiatives: []\ntags: []\n---\n\n## Overview\n\nA page.\n',
      'utf8'
    );
  }

  if (opts.activeId || opts.step) {
    const engine = new WorkflowEngine(mdocsRoot);
    if (opts.step) {
      // advance is no-skip/no-back; walk from IDLE to the target step.
      const targetIndex = STEPS.indexOf(opts.step);
      for (let i = 1; i <= targetIndex; i++) {
        engine.advance(STEPS[i]);
      }
    }
    if (opts.activeId) engine.setActiveInitiative(opts.activeId);
  }

  return projectDir;
}

describe('Claude Code SessionStart orientation hook (G1)', () => {
  describe('sessionContext(core) + formatOrientationBanner', () => {
    test('populated project: counts initiatives by status + surfaces active initiative', () => {
      const projectDir = makeProjectDir({ withInitiative: true, withWiki: true, activeId: 'active-feature', step: 'UNDERSTAND' });
      try {
        const core = createMdocsCore(projectDir);
        const ctx = sessionContext(core);
        expect(ctx.counts.active).toBe(1);
        expect(ctx.activeInitiative).toEqual({ id: 'active-feature', title: 'Active Feature Work' });
        expect(ctx.currentStep).toBe('UNDERSTAND');
        expect(ctx.wikiPageCount).toBe(1);

        const banner = formatOrientationBanner(ctx);
        expect(banner).toContain('mdocs orientation');
        expect(banner).toContain('1 active');
        expect(banner).toContain('workflow step: UNDERSTAND');
        expect(banner).toContain('Active Feature Work');
        expect(banner).toContain('`active-feature`');
        expect(banner).toContain('Wiki pages: 1');
        expect(banner).toContain('mdocs_status');
      } finally {
        fs.rmSync(projectDir, { recursive: true, force: true });
      }
    });

    test('empty project: zero counts, no active initiative, banner still emits', () => {
      const projectDir = makeProjectDir({});
      try {
        const core = createMdocsCore(projectDir);
        const ctx = sessionContext(core);
        expect(ctx.counts).toEqual({});
        expect(ctx.activeInitiative).toBeNull();
        expect(ctx.currentStep).toBe('IDLE');
        expect(ctx.wikiPageCount).toBe(0);

        const banner = formatOrientationBanner(ctx);
        expect(banner).toContain('mdocs orientation');
        expect(banner).toContain('0 initiatives');
        expect(banner).toContain('workflow step: IDLE');
        expect(banner).toContain('Wiki pages: 0');
        // Pointer line is always present.
        expect(banner).toContain('mdocs_status');
      } finally {
        fs.rmSync(projectDir, { recursive: true, force: true });
      }
    });

    test('done status activeId not surfaced as active (status guard)', () => {
      const projectDir = makeProjectDir({});
      try {
        // Create initiative, mark activeId in workflow, but initiative status
        // is active so it IS surfaced — flip it to done to prove the guard.
        const fileName = 'done-init--2026-06-23.md';
        fs.writeFileSync(
          path.join(projectDir, 'mdocs', 'initiatives', fileName),
          '---\nid: "done-init"\ntitle: "Done Work"\nstatus: "done"\ncreated: "2026-06-23"\nupdated: "2026-06-23"\nowner: ""\ntags: []\nrelated_wiki: []\n---\n\n## Objective\nDone.\n\n## Plan\n- [x] Done\n\n## Progress Log\n\n## Artifacts\n',
          'utf8'
        );
        const engine = new WorkflowEngine(path.join(projectDir, 'mdocs'));
        // advance is no-skip/no-back; walk from IDLE to PLAN.
        for (let i = 1; i <= STEPS.indexOf('PLAN'); i++) {
          engine.advance(STEPS[i]);
        }
        engine.setActiveInitiative('done-init');

        const core = createMdocsCore(projectDir);
        const ctx = sessionContext(core);
        expect(ctx.counts.done).toBe(1);
        // activeInitiative is null because the initiative status is not "active".
        expect(ctx.activeInitiative).toBeNull();
      } finally {
        fs.rmSync(projectDir, { recursive: true, force: true });
      }
    });
  });

  describe('compiled hook binary (populated fixture)', () => {
    test('emits valid SessionStart JSON with non-empty additionalContext', () => {
      const projectDir = makeProjectDir({ withInitiative: true, withWiki: true, activeId: 'active-feature', step: 'UNDERSTAND' });
      try {
        const result = runHook(hookPath, {
          session_id: 'test-session',
          cwd: projectDir,
          hook_event_name: 'SessionStart',
          source: 'startup'
        });

        expect(result.status).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.hookSpecificOutput).toBeDefined();
        expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
        expect(typeof parsed.hookSpecificOutput.additionalContext).toBe('string');
        expect(parsed.hookSpecificOutput.additionalContext.length).toBeGreaterThan(0);
        expect(parsed.hookSpecificOutput.additionalContext).toContain('Active Feature Work');
        expect(parsed.hookSpecificOutput.additionalContext).toContain('1 active');
        expect(parsed.hookSpecificOutput.additionalContext).toContain('mdocs_status');
      } finally {
        fs.rmSync(projectDir, { recursive: true, force: true });
      }
    });
  });

  describe('compiled hook binary (empty fixture)', () => {
    test('still emits valid SessionStart JSON, exit 0, no crash', () => {
      const projectDir = makeProjectDir({});
      try {
        const result = runHook(hookPath, {
          session_id: 'empty-session',
          cwd: projectDir,
          hook_event_name: 'SessionStart',
          source: 'startup'
        });

        expect(result.status).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
        expect(typeof parsed.hookSpecificOutput.additionalContext).toBe('string');
        expect(parsed.hookSpecificOutput.additionalContext).toContain('0 initiatives');
        expect(parsed.hookSpecificOutput.additionalContext).toContain('mdocs_status');
      } finally {
        fs.rmSync(projectDir, { recursive: true, force: true });
      }
    });
  });

  describe('fail-open behavior', () => {
    test('malformed stdin still exits 0 (uses cwd fallback)', () => {
      const projectDir = makeProjectDir({});
      try {
        // Pass garbage stdin; parseHookStdin returns null -> we still emit
        // using process.cwd() resolution. The key assertion is exit 0 and
        // valid JSON (never wedge the session).
        let result: { status: number | null; stdout: string; stderr: string };
        try {
          const stdout = execFileSync('node', [hookPath], {
            input: 'this is not json',
            encoding: 'utf8',
            env: { ...process.env, MDOCS_PROJECT_DIR: projectDir }
          });
          result = { status: 0, stdout, stderr: '' };
        } catch (err: any) {
          result = { status: err.status ?? null, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
        }
        expect(result.status).toBe(0);
        // Output must be either empty or valid JSON (never a partial/hang).
        if (result.stdout.trim()) {
          const parsed = JSON.parse(result.stdout);
          expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
        }
      } finally {
        fs.rmSync(projectDir, { recursive: true, force: true });
      }
    });

    test('hook missing from disk would not be tested — instead prove fail-open via MDOCS_PROJECT_DIR pointing nowhere still exits 0', () => {
      // Point at a non-existent dir; resolveProjectRoot falls through to
      // cwd. Either way the hook must exit 0 and emit valid JSON.
      const result = runHook(hookPath, {
        session_id: 'x',
        cwd: '/definitely/not/a/real/path/xyz123',
        hook_event_name: 'SessionStart',
        source: 'startup'
      });
      expect(result.status).toBe(0);
      // The hook creates mdocs/ lazily via createMdocsCore, so it should
      // still emit valid JSON. If it ever fails, fail-open guarantees exit 0
      // with empty stdout (top-level catch).
      if (result.stdout.trim()) {
        expect(() => JSON.parse(result.stdout)).not.toThrow();
      }
    });
  });

  describe('PreCompact hook (compaction survival)', () => {
    test('re-emits the same orientation banner with PreCompact event name', () => {
      const projectDir = makeProjectDir({ withInitiative: true, withWiki: true, activeId: 'active-feature', step: 'PLAN' });
      try {
        const result = runHook(preCompactHookPath, {
          session_id: 'compact-session',
          cwd: projectDir,
          hook_event_name: 'PreCompact'
        });

        expect(result.status).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.hookSpecificOutput.hookEventName).toBe('PreCompact');
        expect(parsed.hookSpecificOutput.additionalContext).toContain('Active Feature Work');
        expect(parsed.hookSpecificOutput.additionalContext).toContain('workflow step: PLAN');
      } finally {
        fs.rmSync(projectDir, { recursive: true, force: true });
      }
    });
  });

  describe('plugin.json + settings-patch.json registrations', () => {
    test('plugin.json registers SessionStart + PreCompact pointing at dist/cli/hooks', () => {
      const REPO_ROOT = path.resolve(__dirname, '../../..');
      const pluginJson = JSON.parse(
        fs.readFileSync(path.join(REPO_ROOT, 'src/surfaces/claude-code/plugin/.claude-plugin/plugin.json'), 'utf8')
      );
      expect(pluginJson.hooks.SessionStart).toBeDefined();
      expect(pluginJson.hooks.SessionStart[0].hooks[0].command).toContain('${CLAUDE_PLUGIN_ROOT}/dist/cli/hooks/session-start.js');
      expect(pluginJson.hooks.PreCompact).toBeDefined();
      expect(pluginJson.hooks.PreCompact[0].hooks[0].command).toContain('${CLAUDE_PLUGIN_ROOT}/dist/cli/hooks/pre-compact.js');
    });

    test('settings-patch.json registers SessionStart + PreCompact pointing at node_modules path', () => {
      const REPO_ROOT = path.resolve(__dirname, '../../..');
      const patchJson = JSON.parse(
        fs.readFileSync(path.join(REPO_ROOT, 'src/surfaces/claude-code/assets/templates/settings-patch.json'), 'utf8')
      );
      expect(patchJson.hooks.SessionStart).toBeDefined();
      expect(patchJson.hooks.SessionStart[0].hooks[0].command).toContain('dist/cli/hooks/session-start.js');
      expect(patchJson.hooks.PreCompact).toBeDefined();
      expect(patchJson.hooks.PreCompact[0].hooks[0].command).toContain('dist/cli/hooks/pre-compact.js');
    });
  });
});
