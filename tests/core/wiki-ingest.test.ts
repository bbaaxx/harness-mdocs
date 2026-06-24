import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createMdocsCore } from '../../src/core';

function tempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-wiki-ingest-'));
}

function rmDir(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
}

describe('wiki.ingest command', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = tempProject();
  });

  afterEach(() => {
    rmDir(projectDir);
  });

  function makeCore(dir: string) {
    const core = createMdocsCore(dir, {
      wiki: { compatibility: { wikiIndexMode: 'canonical-lowercase' } }
    });
    core.managers.mdocs.init();
    return core;
  }

  test('batch applies atomically: createPage + updateOverviewSection + appendLog', async () => {
    const core = makeCore(projectDir);

    const result = await core.commands.execute('wiki.ingest', {
      note: 'ship d1',
      operations: [
        { type: 'createPage', category: 'decisions', id: 'd1', title: 'D1', content: 'decide X' },
        { type: 'updateOverviewSection', section: 'Status', body: 'green' },
        { type: 'appendLog', entry: 'shipped d1' }
      ]
    });

    expect(result).toMatchObject({ success: true, applied: 3 });
    expect(result.changedFiles.length).toBeGreaterThan(0);
    expect(result.note).toBe('ship d1');

    // d1.md exists with caller content.
    const d1Path = path.join(core.mdocsRoot, 'wiki', 'decisions', 'd1.md');
    expect(fs.existsSync(d1Path)).toBe(true);
    expect(fs.readFileSync(d1Path, 'utf8')).toContain('decide X');

    // overview.md has ## Status + green.
    const overviewPath = path.join(core.mdocsRoot, 'wiki', 'overview.md');
    const overview = fs.readFileSync(overviewPath, 'utf8');
    expect(overview).toContain('## Status');
    expect(overview).toContain('green');

    // log.md has shipped d1.
    const logPath = path.join(core.mdocsRoot, 'wiki', 'log.md');
    const log = fs.readFileSync(logPath, 'utf8');
    expect(log).toContain('shipped d1');
  });

  test('no-prose guarantee: files contain EXACTLY caller text plus structural shell', async () => {
    const core = makeCore(projectDir);

    const result = await core.commands.execute('wiki.ingest', {
      note: 'verbatim-note',
      operations: [
        { type: 'updateOverviewSection', section: 'Status', body: 'green' },
        { type: 'appendLog', entry: 'shipped d1' },
        { type: 'createPage', category: 'decisions', id: 'd1', title: 'D1', content: 'decide X' }
      ]
    });

    expect(result.note).toBe('verbatim-note');

    // Overview body is exactly 'green' (no synthesized sentence appended).
    const overview = fs.readFileSync(path.join(core.mdocsRoot, 'wiki', 'overview.md'), 'utf8');
    // The section body should appear, and no extra prose beyond 'green'.
    const statusBlock = overview.split('## Status')[1] || '';
    // The body up to the next heading (or EOF) must be 'green' plus surrounding newlines only.
    const bodyAfterHeading = statusBlock.split('\n')[0] === '' ? statusBlock.split('\n').slice(1).join('\n') : statusBlock;
    const bodyUpToNext = bodyAfterHeading.split(/\n## /)[0];
    expect(bodyUpToNext.trim()).toBe('green');

    // Log content is exactly 'shipped d1'.
    const log = fs.readFileSync(path.join(core.mdocsRoot, 'wiki', 'log.md'), 'utf8');
    const logContentBlock = log.split(/## \d{4}-\d{2}-\d{2}T[\d:.Z+-]+\n\n/).pop() || '';
    expect(logContentBlock.trim()).toBe('shipped d1');

    // Manifest round-trips the note verbatim and carries only structural metadata.
    expect(JSON.stringify(result)).toContain('"note":"verbatim-note"');
    // No synthesized descriptive sentence appears in the manifest.
    expect(result).not.toHaveProperty('summary');
    expect(result).not.toHaveProperty('description');
  });

  test('external owner -> index.md byte-stable', async () => {
    // dir-v2 default owner is 'external'; pre-create wiki/index.md with known content.
    const wikiDir = path.join(projectDir, 'wiki');
    fs.mkdirSync(wikiDir, { recursive: true });
    const indexPath = path.join(wikiDir, 'index.md');
    const externalIndex = '# Wiki\n\nExternally maintained index.\n';
    fs.writeFileSync(indexPath, externalIndex, 'utf8');

    const core = makeCore(projectDir);
    expect((core.managers.wiki as any).contract.wikiIndexOwner).toBe('external');

    await core.commands.execute('wiki.ingest', {
      operations: [
        { type: 'createPage', category: 'decisions', id: 'd1', title: 'D1', content: 'decide X' },
        { type: 'updateOverviewSection', section: 'Status', body: 'green' },
        { type: 'appendLog', entry: 'shipped d1' }
      ]
    });

    // index.md is unchanged.
    expect(fs.readFileSync(indexPath, 'utf8')).toBe(externalIndex);
  });

  test('per-op error isolation: missing updatePage records error, subsequent createPage still applies', async () => {
    const core = makeCore(projectDir);

    const result = await core.commands.execute('wiki.ingest', {
      operations: [
        { type: 'updatePage', category: 'decisions', id: 'missing', content: 'nope' },
        { type: 'createPage', category: 'decisions', id: 'd2', title: 'D2', content: 'yes' }
      ]
    });

    expect(result).toMatchObject({ success: true });
    expect(result.applied).toBe(2);
    const updateOp = result.operations.find((o: any) => o.type === 'updatePage');
    expect(updateOp).toMatchObject({ ok: false, error: 'not found' });
    const createOp = result.operations.find((o: any) => o.type === 'createPage');
    expect(createOp).toMatchObject({ ok: true });

    // d2 was created despite the prior op failing.
    const d2Path = path.join(core.mdocsRoot, 'wiki', 'decisions', 'd2.md');
    expect(fs.existsSync(d2Path)).toBe(true);
  });

  test('validation: empty/non-array operations returns error and writes nothing', async () => {
    const core = makeCore(projectDir);

    const empty = await core.commands.execute('wiki.ingest', { operations: [] });
    expect(empty).toHaveProperty('error');
    expect(empty.success).toBeUndefined();

    const nonArray = await core.commands.execute('wiki.ingest', { operations: 'not-an-array' });
    expect(nonArray).toHaveProperty('error');

    // Nothing was written under wiki/.
    const wikiDir = path.join(core.mdocsRoot, 'wiki');
    if (fs.existsSync(wikiDir)) {
      const entries = fs.readdirSync(wikiDir);
      // Only the externally pre-created index (if any) may be present; no overview/log/decisions.
      expect(entries).not.toContain('overview.md');
      expect(entries).not.toContain('log.md');
      expect(entries).not.toContain('decisions');
    }
  });

  test('lock hygiene: no lingering lock dir after success; two sequential ingests both apply', async () => {
    const core = makeCore(projectDir);

    await core.commands.execute('wiki.ingest', {
      operations: [{ type: 'appendLog', entry: 'first ingest' }]
    });

    const lockDir = path.join(core.mdocsRoot, '.wiki-ingest.lock');
    expect(fs.existsSync(lockDir)).toBe(false);

    const second = await core.commands.execute('wiki.ingest', {
      operations: [{ type: 'appendLog', entry: 'second ingest' }]
    });
    expect(second).toMatchObject({ success: true });

    const log = fs.readFileSync(path.join(core.mdocsRoot, 'wiki', 'log.md'), 'utf8');
    expect(log).toContain('first ingest');
    expect(log).toContain('second ingest');
    // Lock still released.
    expect(fs.existsSync(lockDir)).toBe(false);
  });
});
