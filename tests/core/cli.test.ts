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
});
