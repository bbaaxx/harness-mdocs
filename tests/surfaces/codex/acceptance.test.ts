import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CliResult, runMdocsCli } from '../../../src/cli';

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-codex-'));
}

function parse<T = any>(result: CliResult): T {
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout) as T;
}

async function command(projectDir: string, name: string, payload: Record<string, unknown>) {
  return runMdocsCli(['command', name, '--json', JSON.stringify(payload)], projectDir);
}

describe('Codex CLI acceptance workflow', () => {
  test('exercises create/update/wiki/validate/resume through CLI-backed command access', async () => {
    const projectDir = tempProject();

    const init = await runMdocsCli(['init'], projectDir);
    expect(init.exitCode).toBe(0);
    expect(parse(init)).toEqual({ success: true });
    expect(fs.existsSync(path.join(projectDir, 'mdocs', 'initiatives', 'INDEX.md'))).toBe(true);

    const initialStatus = await runMdocsCli(['status'], projectDir);
    expect(initialStatus.exitCode).toBe(0);
    expect(parse(initialStatus)).toMatchObject({
      currentStep: 'IDLE',
      activeInitiative: null,
      stepHistory: []
    });

    const created = await command(projectDir, 'initiative.create', {
      id: 'codex-acceptance',
      title: 'Codex Acceptance',
      objective: 'Prove Codex can drive mdocs through CLI commands.',
      tags: ['codex', 'acceptance'],
      relatedWiki: ['guides/codex-acceptance'],
      plan: [
        'Create an initiative through the mdocs CLI.',
        'Attach wiki knowledge through the mdocs CLI.',
        'Validate and resume the workflow through the mdocs CLI.'
      ],
      nextAction: 'Create the linked wiki entry.'
    });

    expect(created.exitCode).toBe(0);
    expect(parse(created)).toMatchObject({ success: true, id: 'codex-acceptance' });

    const updated = await command(projectDir, 'initiative.update', {
      id: 'codex-acceptance',
      updates: { nextAction: 'Validate Codex CLI acceptance.' },
      progressNote: '[codex acceptance] Updated by CLI command access'
    });

    expect(updated.exitCode).toBe(0);
    expect(parse(updated)).toMatchObject({ success: true, id: 'codex-acceptance' });

    const wiki = await command(projectDir, 'wiki.create', {
      category: 'guides',
      id: 'codex-acceptance',
      title: 'Codex Acceptance Fixture',
      content: 'Acceptance fixture confirms Codex v1 uses mdocs CLI commands for workflow state.',
      tags: ['codex', 'acceptance'],
      relatedInitiatives: ['codex-acceptance']
    });

    expect(wiki.exitCode).toBe(0);
    expect(parse(wiki)).toMatchObject({ success: true, id: 'codex-acceptance' });

    const validation = await runMdocsCli(['validate'], projectDir);
    expect(validation.exitCode).toBe(0);
    expect(parse(validation)).toMatchObject({
      initiatives: { valid: true },
      wiki: { valid: true },
      graph: { valid: true },
      valid: true
    });

    const lookup = await runMdocsCli(['lookup', 'codex-acceptance'], projectDir);
    expect(lookup.exitCode).toBe(0);
    expect(parse(lookup)).toMatchObject({
      type: 'initiative',
      id: 'codex-acceptance',
      title: 'Codex Acceptance'
    });

    const dispatch = await runMdocsCli(['dispatch', 'codex-acceptance'], projectDir);
    expect(dispatch.exitCode).toBe(0);
    const dispatchPayload = parse<{ context: string; initiativeId: string; relatedWikiCount: number }>(dispatch);
    expect(dispatchPayload).toMatchObject({ initiativeId: 'codex-acceptance', relatedWikiCount: 1 });
    expect(dispatchPayload.context).toContain('# Initiative: Codex Acceptance');
    expect(dispatchPayload.context).toContain('Codex Acceptance Fixture');
    expect(dispatchPayload.context).toContain('Updated by CLI command access');
    expect(dispatchPayload.context).not.toContain('OpenCode');

    const resume = await runMdocsCli(['resume', 'codex-acceptance'], projectDir);
    expect(resume.exitCode).toBe(0);
    expect(parse(resume)).toMatchObject({
      initiative: { id: 'codex-acceptance', title: 'Codex Acceptance', status: 'active' },
      nextAction: 'Validate Codex CLI acceptance.',
      blockers: [],
      validation: { valid: true }
    });
  });
});
