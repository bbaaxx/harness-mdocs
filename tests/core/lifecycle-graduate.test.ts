import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createMdocsCore } from '../../src/core';
import { Initiative } from '../../src/core/types';

// ---------- shared helpers (mirror lifecycle-status-parity.test.ts) ----------

function copyDir(source: string, target: string) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) copyDir(sourcePath, targetPath);
    else fs.copyFileSync(sourcePath, targetPath);
  }
}

function makeDirV2ProjectDir(prefix: string): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const fixtureRoot = path.resolve(__dirname, '../fixtures/directory-v2-mdocs');
  copyDir(fixtureRoot, projectDir);
  return projectDir;
}

function baseInitiative(overrides: Partial<Initiative> = {}): Initiative {
  return {
    id: 'grad-test',
    title: 'Grad Test',
    status: 'active',
    created: '2026-06-23',
    updated: '2026-06-23',
    owner: 'tests',
    tags: [],
    relatedWiki: [],
    objective: 'verify lifecycle.graduate',
    plan: [],
    progressLog: [],
    artifacts: [],
    ...overrides,
  };
}

function today(): string {
  return new Date().toISOString().split('T')[0];
}

describe('lifecycle.graduate', () => {
  test('graduates a completed initiative: writes overview/log and stamps graduated', async () => {
    const projectDir = makeDirV2ProjectDir('harness-mdocs-grad-ok-');
    const core = createMdocsCore(projectDir);
    // canonical-lowercase so overview/log are produced
    expect(core.managers.wiki['contract'].wikiIndexMode).toBe('canonical-lowercase');

    const created = core.managers.initiatives.create(baseInitiative({ id: 'grad-ok', title: 'Grad Ok' }));
    const key = path.basename(created);
    core.managers.initiatives.markDone(key);
    expect(core.managers.initiatives.findById('grad-ok')?.status).toBe('complete');

    const wikiDir = path.join(projectDir, 'mdocs', 'wiki');
    const overviewPath = path.join(wikiDir, 'overview.md');
    const logPath = path.join(wikiDir, 'log.md');

    const result: any = await core.commands.execute('lifecycle.graduate', {
      id: 'grad-ok',
      sections: [{ section: 'Recently Shipped', body: 'ship notes' }],
      logEntry: 'graduated foo'
    });

    expect(result.success).toBe(true);
    expect(result.initiativeId).toBe('grad-ok');
    expect(result.graduated).toBe(today());
    expect(result.wrote.overviewSections[0]).toMatchObject({ section: 'Recently Shipped', ok: true });
    expect(result.wrote.logEntry).toMatchObject({ ok: true });

    // overview.md has the section heading + caller body verbatim.
    const overview = fs.readFileSync(overviewPath, 'utf8');
    expect(overview).toContain('## Recently Shipped');
    expect(overview).toContain('ship notes');

    // log.md has the caller content verbatim.
    const log = fs.readFileSync(logPath, 'utf8');
    expect(log).toContain('graduated foo');

    // Re-reading the initiative shows graduated stamped to today.
    const readBack = core.managers.initiatives.findById('grad-ok');
    expect(readBack?.graduated).toBe(today());
  });

  test('rejects a non-completed (active) initiative and writes nothing', async () => {
    const projectDir = makeDirV2ProjectDir('harness-mdocs-grad-active-');
    const core = createMdocsCore(projectDir);

    core.managers.initiatives.create(baseInitiative({ id: 'grad-active', title: 'Grad Active' }));
    // still active — not done

    const wikiDir = path.join(projectDir, 'mdocs', 'wiki');
    const overviewPath = path.join(wikiDir, 'overview.md');
    const logPath = path.join(wikiDir, 'log.md');

    const result: any = await core.commands.execute('lifecycle.graduate', {
      id: 'grad-active',
      sections: [{ section: 'Status', body: 'should not land' }],
      logEntry: 'should not land'
    });

    expect(result).toMatchObject({ error: expect.stringContaining('Only completed initiatives can be graduated') });
    expect(result.error).toContain('current status: active');

    // Nothing was written.
    expect(fs.existsSync(overviewPath)).toBe(false);
    expect(fs.existsSync(logPath)).toBe(false);

    // graduated is NOT stamped.
    const readBack = core.managers.initiatives.findById('grad-active');
    expect(readBack?.graduated).toBeUndefined();
  });

  test('bare graduate (no sections/logEntry) still stamps graduated and creates no overview/log', async () => {
    const projectDir = makeDirV2ProjectDir('harness-mdocs-grad-bare-');
    const core = createMdocsCore(projectDir);

    const created = core.managers.initiatives.create(baseInitiative({ id: 'grad-bare', title: 'Grad Bare' }));
    const key = path.basename(created);
    core.managers.initiatives.markDone(key);

    const wikiDir = path.join(projectDir, 'mdocs', 'wiki');
    const overviewPath = path.join(wikiDir, 'overview.md');
    const logPath = path.join(wikiDir, 'log.md');

    const result: any = await core.commands.execute('lifecycle.graduate', { id: 'grad-bare' });

    expect(result.success).toBe(true);
    expect(result.graduated).toBe(today());
    // No overview/log file created by the call (nothing to write).
    expect(fs.existsSync(overviewPath)).toBe(false);
    expect(fs.existsSync(logPath)).toBe(false);

    const readBack = core.managers.initiatives.findById('grad-bare');
    expect(readBack?.graduated).toBe(today());
  });

  test('no-prose: overview section body and log content equal exactly the caller text', async () => {
    const projectDir = makeDirV2ProjectDir('harness-mdocs-grad-noprose-');
    const core = createMdocsCore(projectDir);

    const created = core.managers.initiatives.create(baseInitiative({ id: 'grad-noprose', title: 'Grad Noprose' }));
    const key = path.basename(created);
    core.managers.initiatives.markDone(key);

    const wikiDir = path.join(projectDir, 'mdocs', 'wiki');

    await core.commands.execute('lifecycle.graduate', {
      id: 'grad-noprose',
      sections: [{ section: 'NoProse Section', body: 'exact body text' }],
      logEntry: 'exact log text'
    });

    // Overview section body equals exactly the caller body up to the next heading.
    const overview = fs.readFileSync(path.join(wikiDir, 'overview.md'), 'utf8');
    const sectionBlock = overview.split('## NoProse Section')[1] || '';
    const bodyAfterHeading = sectionBlock.split('\n')[0] === '' ? sectionBlock.split('\n').slice(1).join('\n') : sectionBlock;
    const bodyUpToNext = bodyAfterHeading.split(/\n## /)[0];
    expect(bodyUpToNext.trim()).toBe('exact body text');

    // Log entry content equals exactly the caller text.
    const log = fs.readFileSync(path.join(wikiDir, 'log.md'), 'utf8');
    const logContentBlock = log.split(/## \d{4}-\d{2}-\d{2}T[\d:.Z+-]+\n\n/).pop() || '';
    expect(logContentBlock.trim()).toBe('exact log text');
  });

  test('idempotent-ish: graduating twice still succeeds and graduated remains set', async () => {
    const projectDir = makeDirV2ProjectDir('harness-mdocs-grad-twice-');
    const core = createMdocsCore(projectDir);

    const created = core.managers.initiatives.create(baseInitiative({ id: 'grad-twice', title: 'Grad Twice' }));
    const key = path.basename(created);
    core.managers.initiatives.markDone(key);

    const first: any = await core.commands.execute('lifecycle.graduate', {
      id: 'grad-twice',
      sections: [{ section: 'First', body: 'first body' }],
      logEntry: 'first log'
    });
    expect(first.success).toBe(true);

    const second: any = await core.commands.execute('lifecycle.graduate', {
      id: 'grad-twice',
      sections: [{ section: 'Second', body: 'second body' }],
      logEntry: 'second log'
    });
    expect(second.success).toBe(true);
    expect(second.graduated).toBe(today());

    // graduated remains set.
    const readBack = core.managers.initiatives.findById('grad-twice');
    expect(readBack?.graduated).toBe(today());
  });
});
