import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runMdocsCli } from '../../src/cli';

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
});
