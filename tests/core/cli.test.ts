import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runMdocsCli } from '../../src/cli';
import { startMcpServer } from '../../src/surfaces/claude-code/mcp-server';
import { runPostToolUse } from '../../src/cli/hooks/post-tool-use';
import { runPreToolUse } from '../../src/cli/hooks/pre-tool-use';

jest.mock('../../src/surfaces/claude-code/mcp-server', () => ({
  startMcpServer: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../../src/cli/hooks/pre-tool-use', () => ({
  runPreToolUse: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../../src/cli/hooks/post-tool-use', () => ({
  runPostToolUse: jest.fn().mockResolvedValue(undefined)
}));

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-cli-'));
}

describe('mdocs CLI', () => {
  test('init creates mdocs structure', async () => {
    const projectDir = tempProject();
    const result = await runMdocsCli(['init'], projectDir);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ success: true });
    expect(fs.existsSync(path.join(projectDir, 'mdocs', 'initiatives', 'INDEX.md'))).toBe(true);
  });

  test('command executes aggregate core command', async () => {
    const projectDir = tempProject();
    await runMdocsCli(['init'], projectDir);

    const result = await runMdocsCli(
      [
        'command',
        'initiative.create',
        '--json',
        '{"id":"cli-created","title":"CLI Created"}'
      ],
      projectDir
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ success: true, id: 'cli-created' });
  });

  test('step advances the workflow state machine', async () => {
    const projectDir = tempProject();
    await runMdocsCli(['init'], projectDir);

    const result = await runMdocsCli(['step', 'UNDERSTAND'], projectDir);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).currentStep).toBe('UNDERSTAND');
  });

  test('step rejects invalid transitions with nonzero exit', async () => {
    const projectDir = tempProject();
    await runMdocsCli(['init'], projectDir);

    const result = await runMdocsCli(['step', 'PLAN'], projectDir); // skip from IDLE
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/skip|back|invalid/i);
  });

  test('usage lists the mcp, step, and reset subcommands', async () => {
    const result = await runMdocsCli(['nope'], tempProject());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('mcp');
    expect(result.stderr).toContain('step <step>');
    expect(result.stderr).toContain('reset');
  });

  test('command help documents payload shapes and examples', async () => {
    const result = await runMdocsCli(['command', '--help'], tempProject());

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Usage: mdocs command <name> --json');
    expect(result.stdout).toContain('mdocs command initiative.create --json');
    expect(result.stdout).toContain('mdocs command initiative.update --json');
    expect(result.stdout).toContain('Metadata changes may be nested under updates');
    expect(result.stdout).toContain('mdocs command wiki.create --json');
    expect(result.stdout).toContain('mdocs command wiki.update --json');
    expect(result.stdout).toContain('Changed fields go at the top level after category and id');
    expect(result.stdout).toContain('Do not use an updates wrapper');
  });

  test('command-specific help documents wiki.update top-level fields', async () => {
    const result = await runMdocsCli(['command', 'wiki.update', '--help'], tempProject());

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage: mdocs command wiki.update --json');
    expect(result.stdout).toContain('Payload: { category, id, title?, content?');
    expect(result.stdout).toContain('Do not use an updates wrapper');
    expect(result.stdout).toContain('mdocs command wiki.update --json');
  });

  test('unsupported command names still return registry JSON', async () => {
    const result = await runMdocsCli(['command', 'missing.command'], tempProject());

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: 'Unsupported mdocs command: missing.command',
      supportedCommands: expect.arrayContaining(['initiative.create', 'wiki.create', 'index.sync'])
    });
  });

  test('convenience commands expose lookup, search, resume, dispatch, and index repair', async () => {
    const projectDir = tempProject();
    await runMdocsCli(['init'], projectDir);
    await runMdocsCli(
      [
        'command',
        'initiative.create',
        '--json',
        '{"id":"cli-work","title":"CLI Work","objective":"Exercise CLI","tags":["cli"],"relatedWiki":[]}'
      ],
      projectDir
    );

    const lookup = await runMdocsCli(['lookup', 'cli-work'], projectDir);
    const search = await runMdocsCli(['search', 'Exercise'], projectDir);
    const resume = await runMdocsCli(['resume', 'cli-work'], projectDir);
    const dispatch = await runMdocsCli(['dispatch', 'cli-work'], projectDir);
    const check = await runMdocsCli(['index', 'check'], projectDir);
    const repair = await runMdocsCli(['index', 'repair'], projectDir);

    expect(lookup.exitCode).toBe(0);
    expect(JSON.parse(lookup.stdout)).toMatchObject({ id: 'cli-work', filename: expect.stringContaining('cli-work') });
    expect(search.exitCode).toBe(0);
    expect(JSON.parse(search.stdout).results[0]).toMatchObject({ id: 'cli-work' });
    expect(resume.exitCode).toBe(0);
    expect(JSON.parse(resume.stdout).initiative).toMatchObject({ id: 'cli-work' });
    expect(dispatch.exitCode).toBe(0);
    expect(JSON.parse(dispatch.stdout)).toMatchObject({ initiativeId: 'cli-work', relatedWikiCount: 0 });
    expect(check.exitCode).toBe(0);
    expect(JSON.parse(check.stdout)).toHaveProperty('consistent');
    expect(repair.exitCode).toBe(0);
    expect(JSON.parse(repair.stdout)).toMatchObject({ repaired: expect.any(Boolean) });
  });

  test('initiative.done clears a matching active workflow initiative', async () => {
    const projectDir = tempProject();
    await runMdocsCli(['init'], projectDir);
    await runMdocsCli(
      [
        'command',
        'initiative.create',
        '--json',
        '{"id":"finish-active","title":"Finish Active","objective":"Exercise active cleanup","tags":["cli"],"relatedWiki":[]}'
      ],
      projectDir
    );

    const resume = await runMdocsCli(['resume', 'finish-active'], projectDir);
    expect(resume.exitCode).toBe(0);

    const activeStatus = await runMdocsCli(['status'], projectDir);
    expect(JSON.parse(activeStatus.stdout)).toMatchObject({ activeInitiative: 'finish-active' });

    const done = await runMdocsCli(
      ['command', 'initiative.done', '--json', '{"id":"finish-active"}'],
      projectDir
    );
    expect(done.exitCode).toBe(0);

    const status = await runMdocsCli(['status'], projectDir);
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ activeInitiative: null });
  });

  test('mdocs reset clears active initiative and returns the workflow to IDLE (F9-B)', async () => {
    // F9-B: explicit `mdocs_reset` (CLI: `mdocs reset`) → IDLE + clears
    // activeInitiative (full clean slate). Use cases: abandon mid-flight,
    // force-reset for testing, begin a fresh initiative cycle after COMPLETE.
    const projectDir = tempProject();
    await runMdocsCli(['init'], projectDir);
    await runMdocsCli(
      [
        'command',
        'initiative.create',
        '--json',
        '{"id":"abandon-me","title":"Abandon Me","objective":"Exercise reset","tags":["cli"],"relatedWiki":[]}'
      ],
      projectDir
    );
    await runMdocsCli(['resume', 'abandon-me'], projectDir);
    // resume lands at UNDERSTAND; walk forward to a mid-flight PLAN state so
    // reset has something non-trivial to clear.
    await runMdocsCli(['step', 'DISCOVER'], projectDir);
    await runMdocsCli(['step', 'CONTEXT'], projectDir);
    await runMdocsCli(['step', 'PLAN'], projectDir);
    const beforeReset = await runMdocsCli(['status'], projectDir);
    expect(JSON.parse(beforeReset.stdout)).toMatchObject({
      activeInitiative: 'abandon-me',
      currentStep: 'PLAN'
    });

    const reset = await runMdocsCli(['reset'], projectDir);
    expect(reset.exitCode).toBe(0);
    expect(JSON.parse(reset.stdout)).toMatchObject({
      activeInitiative: null,
      currentStep: 'IDLE'
    });

    const statusAfter = await runMdocsCli(['status'], projectDir);
    expect(JSON.parse(statusAfter.stdout)).toMatchObject({
      activeInitiative: null,
      currentStep: 'IDLE'
    });
  });

  test('resume(id) auto-resets to UNDERSTAND when currentStep is IDLE (F1-D/F9-A)', async () => {
    // F1-D / F9-A: resume(id) auto-advances out of IDLE. When currentStep is
    // IDLE, resume lands at UNDERSTAND so the resumed initiative is inside the
    // gated region immediately. The active initiative is preserved (not
    // wiped) — this is the resume path, NOT the mdocs_reset path.
    const projectDir = tempProject();
    await runMdocsCli(['init'], projectDir);
    await runMdocsCli(
      [
        'command',
        'initiative.create',
        '--json',
        '{"id":"resume-from-idle","title":"Resume From Idle","objective":"Exercise F1-D","tags":["cli"],"relatedWiki":[]}'
      ],
      projectDir
    );

    // At IDLE (fresh init), resume should land at UNDERSTAND.
    const resume = await runMdocsCli(['resume', 'resume-from-idle'], projectDir);
    expect(resume.exitCode).toBe(0);
    expect(JSON.parse(resume.stdout).currentStep).toBe('UNDERSTAND');

    const status = await runMdocsCli(['status'], projectDir);
    expect(JSON.parse(status.stdout)).toMatchObject({
      activeInitiative: 'resume-from-idle',
      currentStep: 'UNDERSTAND'
    });
  });

  test('resume(id) auto-resets to UNDERSTAND when currentStep is COMPLETE (F9-A)', async () => {
    // F9-A: when currentStep is terminal (COMPLETE), resume resets to IDLE
    // then advances to UNDERSTAND so the next initiative cycle can begin
    // cleanly without hand-editing .workflow-state.json.
    const projectDir = tempProject();
    await runMdocsCli(['init'], projectDir);
    await runMdocsCli(
      [
        'command',
        'initiative.create',
        '--json',
        '{"id":"first-cycle","title":"First Cycle","objective":"Reach complete","tags":["cli"],"relatedWiki":[]}'
      ],
      projectDir
    );
    await runMdocsCli(['resume', 'first-cycle'], projectDir); // IDLE -> UNDERSTAND
    // Walk to COMPLETE.
    for (const step of ['DISCOVER', 'CONTEXT', 'PLAN', 'EXECUTE', 'VERIFY', 'REPORT', 'COMPLETE']) {
      await runMdocsCli(['step', step], projectDir);
    }
    const atComplete = await runMdocsCli(['status'], projectDir);
    expect(JSON.parse(atComplete.stdout).currentStep).toBe('COMPLETE');

    // Now create a second initiative and resume it — should reset out of
    // COMPLETE and land at UNDERSTAND with the new initiative active.
    await runMdocsCli(
      [
        'command',
        'initiative.create',
        '--json',
        '{"id":"second-cycle","title":"Second Cycle","objective":"Begin after complete","tags":["cli"],"relatedWiki":[]}'
      ],
      projectDir
    );
    const resume = await runMdocsCli(['resume', 'second-cycle'], projectDir);
    expect(resume.exitCode).toBe(0);
    expect(JSON.parse(resume.stdout).currentStep).toBe('UNDERSTAND');
    expect(JSON.parse(resume.stdout).initiative.id).toBe('second-cycle');

    const status = await runMdocsCli(['status'], projectDir);
    expect(JSON.parse(status.stdout)).toMatchObject({
      activeInitiative: 'second-cycle',
      currentStep: 'UNDERSTAND'
    });
  });

  test('resume(id) preserves a mid-flight currentStep (F9-A: mid-flight unchanged)', async () => {
    // F9-A: if currentStep is any mid-flight step (UNDERSTAND…REPORT), resume
    // preserves it — mid-flight resume of in-progress work is unchanged.
    const projectDir = tempProject();
    await runMdocsCli(['init'], projectDir);
    await runMdocsCli(
      [
        'command',
        'initiative.create',
        '--json',
        '{"id":"mid-flight","title":"Mid Flight","objective":"Exercise preserve","tags":["cli"],"relatedWiki":[]}'
      ],
      projectDir
    );
    await runMdocsCli(['resume', 'mid-flight'], projectDir); // -> UNDERSTAND
    await runMdocsCli(['step', 'DISCOVER'], projectDir);
    await runMdocsCli(['step', 'CONTEXT'], projectDir);
    await runMdocsCli(['step', 'PLAN'], projectDir);
    await runMdocsCli(['step', 'EXECUTE'], projectDir);
    await runMdocsCli(['step', 'VERIFY'], projectDir);

    // Resuming a different initiative mid-flight preserves VERIFY.
    await runMdocsCli(
      [
        'command',
        'initiative.create',
        '--json',
        '{"id":"mid-flight-2","title":"Mid Flight 2","objective":"Exercise preserve","tags":["cli"],"relatedWiki":[]}'
      ],
      projectDir
    );
    const resume = await runMdocsCli(['resume', 'mid-flight-2'], projectDir);
    expect(resume.exitCode).toBe(0);
    expect(JSON.parse(resume.stdout).currentStep).toBe('VERIFY');
    expect(JSON.parse(resume.stdout).initiative.id).toBe('mid-flight-2');
  });

  test('status clears a stale active workflow initiative when it is done', async () => {
    const projectDir = tempProject();
    await runMdocsCli(['init'], projectDir);
    await runMdocsCli(
      [
        'command',
        'initiative.create',
        '--json',
        '{"id":"stale-done","title":"Stale Done","objective":"Exercise stale cleanup","tags":["cli"],"relatedWiki":[]}'
      ],
      projectDir
    );
    await runMdocsCli(['command', 'initiative.done', '--json', '{"id":"stale-done"}'], projectDir);
    fs.writeFileSync(
      path.join(projectDir, 'mdocs', '.workflow-state.json'),
      JSON.stringify({ currentStep: 'IDLE', activeInitiative: 'stale-done', stepHistory: [] }, null, 2),
      'utf8'
    );

    const status = await runMdocsCli(['status'], projectDir);

    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ activeInitiative: null });
    expect(JSON.parse(fs.readFileSync(path.join(projectDir, 'mdocs', '.workflow-state.json'), 'utf8'))).toMatchObject({
      activeInitiative: null
    });
  });

  test('unknown commands return usage on stderr', async () => {
    const result = await runMdocsCli(['unknown'], tempProject());

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Usage: mdocs init');
  });

  test('invalid command JSON returns parse errors on stderr', async () => {
    const result = await runMdocsCli(['command', 'initiative.create', '--json'], tempProject());

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('--json requires a JSON object string');
  });

  test('delegates MCP and hook entrypoints without stdout', async () => {
    const mcp = await runMdocsCli(['mcp'], tempProject());
    const pre = await runMdocsCli(['hooks', 'pre-tool-use'], tempProject());
    const post = await runMdocsCli(['hooks', 'post-tool-use'], tempProject());

    expect(startMcpServer).toHaveBeenCalledTimes(1);
    expect(runPreToolUse).toHaveBeenCalledTimes(1);
    expect(runPostToolUse).toHaveBeenCalledTimes(1);
    expect(mcp).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    expect(pre).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    expect(post).toEqual({ exitCode: 0, stdout: '', stderr: '' });
  });
});
