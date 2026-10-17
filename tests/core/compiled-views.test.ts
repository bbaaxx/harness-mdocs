import fs = require('fs');
import * as os from 'os';
import * as path from 'path';
import { createMdocsCore } from '../../src/core';

describe('issue #8: opt-in targeted compiled views', () => {
  let project: string;
  let root: string;
  const registrations = [
    { type: 'initiative', id: 'example-active' },
    { type: 'wiki', ref: 'initiatives/example-active' },
    { type: 'overview', initiativeId: 'example-active' }
  ];
  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'mdocs-compiled-views-'));
    fs.cpSync(path.resolve(__dirname, '../fixtures/directory-v2-mdocs'), project, { recursive: true });
    root = path.join(project, 'mdocs');
    fs.mkdirSync(path.join(root, 'wiki', 'initiatives'), { recursive: true });
    fs.writeFileSync(path.join(root, 'wiki', 'initiatives', 'example-active.md'), '---\nid: initiatives/example-active\ntitle: Example Active\ncategory: initiative\nstatus: active\nsources: [example-active]\n---\n\nCompiled body.\n');
    fs.writeFileSync(path.join(root, 'wiki', 'overview.md'), '---\nid: overview\ncategory: overview\ncustom: keep-me\n---\n\n# Overview\n\nCurated overview prose.\n');
  });
  afterEach(() => fs.rmSync(project, { recursive: true, force: true }));
  const readViews = () => ['initiatives/INDEX.md', 'wiki/index.md', 'wiki/overview.md'].map(file => fs.readFileSync(path.join(root, file), 'utf8'));
  const targeted = () => createMdocsCore(project, { compatibility: { initiativeRecordMode: 'metadata-only', compiledViewMutationMode: 'targeted' } });

  test('default external ownership is byte-stable and explicitly skipped', async () => {
    const core = createMdocsCore(project);
    const before = readViews();
    const result = await core.commands.execute('index.sync', { registrations });
    expect(result).toMatchObject({ success: true, skipped: true, reason: 'external-owner', regenerated: [] });
    expect(readViews()).toEqual(before);
    const sync = await core.commands.execute('index.sync');
    expect(sync.regenerated).toEqual([]);
    expect(sync.skipped).toEqual(expect.arrayContaining([{ file: 'initiatives/INDEX.md', skipped: true, reason: 'external-owner' }, { file: 'wiki/index.md', skipped: true, reason: 'external-owner' }]));
  });

  test('targeted upserts preserve curated content, existing annotations, and CRLF', async () => {
    const core = targeted();
    for (const file of ['initiatives/INDEX.md', 'wiki/index.md', 'wiki/overview.md']) {
      const full = path.join(root, file);
      fs.writeFileSync(full, fs.readFileSync(full, 'utf8').replace(/\r?\n/g, '\r\n'));
    }
    const before = readViews();
    const result = await core.commands.execute('index.sync', { registrations });
    expect(result.success).toBe(true);
    expect(result.registrations.every((entry: any) => entry.verified)).toBe(true);
    const after = readViews();
    // Existing backticked initiative entry is curated, not replaced or duplicated.
    expect(after[0]).toBe(before[0]);
    expect(after[1].startsWith(before[1])).toBe(true);
    expect(after[2].startsWith(before[2])).toBe(true);
    expect(after[1]).toContain('[Example Active](initiatives/example-active.md)');
    expect(after[2]).toContain('[Example Active](initiatives/example-active.md)');
    expect(after[1].replace(/\r\n/g, '')).not.toContain('\n');
    const repeat = await core.commands.execute('index.sync', { registrations });
    expect(repeat.regenerated).toEqual([]);
    expect(readViews()).toEqual(after);
  });

  test('only package-marked row is refreshed; curated annotation remains unchanged', async () => {
    const core = targeted();
    await core.commands.execute('index.sync', { registrations: [registrations[1]] });
    const page = path.join(root, 'wiki', 'initiatives', 'example-active.md');
    fs.writeFileSync(page, fs.readFileSync(page, 'utf8').replace('status: active', 'status: complete'));
    const result = await core.commands.execute('index.sync', { registrations: [registrations[1]] });
    expect(result.success).toBe(true);
    const index = fs.readFileSync(path.join(root, 'wiki', 'index.md'), 'utf8');
    expect(index).toContain('status: complete <!-- mdocs:registration wiki:initiatives/example-active -->');
    expect(index.match(/mdocs:registration wiki:initiatives\/example-active/g)).toHaveLength(1);
  });

  test('discovers directory status records and registers a new initiative without whole-index rewrite', async () => {
    const core = targeted();
    const before = readViews();
    const created = await core.commands.execute('initiative.create', { id: 'new-project', title: 'New project' });
    expect(created.requiredFollowUps).toHaveLength(2);
    // Creation explicitly returns remaining operations; it never takes ownership.
    expect(readViews()).toEqual(before);
    for (const op of created.requiredFollowUps) expect(await core.commands.execute(op.command, op.args)).toMatchObject({ success: true });
    expect(fs.readFileSync(path.join(root, 'initiatives', 'INDEX.md'), 'utf8')).toContain('[New project](new-project/)');
    expect(fs.readFileSync(path.join(root, 'wiki', 'index.md'), 'utf8')).toContain('(initiatives/new-project.md)');
    expect(fs.readFileSync(path.join(root, 'wiki', 'overview.md'), 'utf8')).toContain('(initiatives/new-project.md)');
  });

  test('invalid second registration fails before any write', async () => {
    const core = targeted();
    const before = readViews();
    expect(await core.commands.execute('index.sync', { registrations: [registrations[1], { type: 'wiki', ref: 'missing' }] })).toMatchObject({ success: false, regenerated: [] });
    expect(readViews()).toEqual(before);
  });

  test('failure writing second view rolls back first view', async () => {
    const core = targeted();
    const before = readViews();
    const renameSync = fs.renameSync;
    let calls = 0;
    const spy = jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (++calls === 2) throw new Error('simulated second write failure');
      return renameSync(from, to);
    });
    try {
      expect(await core.commands.execute('index.sync', { registrations: registrations.slice(1) })).toMatchObject({ success: false, rolledBack: true, regenerated: [] });
      expect(readViews()).toEqual(before);
    } finally { spy.mockRestore(); }
  });

  test('file configuration enables targeted mode; invalid values fail closed', () => {
    fs.writeFileSync(path.join(root, '.mdocs.json'), JSON.stringify({ compatibility: { compiledViewMutationMode: 'targeted' } }));
    expect(createMdocsCore(project).contract.compiledViewMutationMode).toBe('targeted');
    fs.writeFileSync(path.join(root, '.mdocs.json'), JSON.stringify({ compatibility: { compiledViewMutationMode: 'anything' } }));
    expect(createMdocsCore(project).contract.compiledViewMutationMode).toBe('off');
  });

  test.each([null, [], {}, 'all'])('invalid registration batch %j fails explicitly', async registrations => {
    expect(await targeted().commands.execute('index.sync', { registrations })).toMatchObject({ success: false });
  });

  test.each([
    null,
    { type: 'wiki', ref: '../outside' },
    { type: 'wiki', ref: 'missing' },
    { type: 'wiki', ref: 'index' },
    { type: 'wiki', ref: 'systems/system-page', unknown: true },
    { type: 'unknown' },
    { type: 'initiative' },
    { type: 'initiative', id: 'missing' },
    { type: 'overview', initiativeId: 'example-done' }
  ])('invalid registration %j writes nothing', async registration => {
    const before = readViews();
    expect(await targeted().commands.execute('index.sync', { registrations: [registration] })).toMatchObject({ success: false });
    expect(readViews()).toEqual(before);
  });

  test('missing compiled page or curated view fails without mutation', async () => {
    const core = targeted();
    fs.unlinkSync(path.join(root, 'wiki', 'initiatives', 'example-active.md'));
    expect(await core.commands.execute('index.sync', { registrations: [registrations[2]] })).toMatchObject({ success: false });
    fs.unlinkSync(path.join(root, 'wiki', 'overview.md'));
    expect(await core.commands.execute('index.sync', { registrations: [registrations[2]] })).toMatchObject({ success: false });
    fs.unlinkSync(path.join(root, 'wiki', 'index.md'));
    expect(await core.commands.execute('index.sync', { registrations: [{ type: 'wiki', ref: 'systems/system-page' }] })).toMatchObject({ success: false });
  });

  test('targeted registration rejects flat mode and harness ownership', async () => {
    expect(await createMdocsCore(project, { compatibility: { initiativeMode: 'flat', compiledViewMutationMode: 'targeted' } }).commands.execute('index.sync', { registrations })).toMatchObject({ success: false });
    expect(await createMdocsCore(project, { compatibility: { wikiIndexOwner: 'harness', compiledViewMutationMode: 'targeted' } }).commands.execute('index.sync', { registrations })).toMatchObject({ success: false });
  });

  test('duplicate package markers fail before writing', async () => {
    const core = targeted();
    await core.commands.execute('index.sync', { registrations: [registrations[1]] });
    const file = path.join(root, 'wiki', 'index.md');
    const content = fs.readFileSync(file, 'utf8');
    fs.appendFileSync(file, content.split('\n').find(line => line.includes('mdocs:registration'))! + '\n');
    const before = fs.readFileSync(file, 'utf8');
    expect(await core.commands.execute('index.sync', { registrations: [registrations[1]] })).toMatchObject({ success: false, error: expect.stringContaining('Duplicate') });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  test('read-after-write catches a write that did not persist', async () => {
    const before = readViews();
    const core = targeted();
    const spy = jest.spyOn(fs, 'renameSync').mockImplementationOnce(() => undefined);
    try {
      expect(await core.commands.execute('index.sync', { registrations: [registrations[1]] })).toMatchObject({ success: false, rolledBack: true, error: expect.stringContaining('postcondition') });
      expect(readViews()).toEqual(before);
    } finally { spy.mockRestore(); }
  });

  test('rollback failure reports remaining uncertainty rather than success', async () => {
    const core = targeted();
    const rename = fs.renameSync;
    let calls = 0;
    const spy = jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (++calls >= 2) throw new Error('write or rollback unavailable');
      return rename(from, to);
    });
    try {
      expect(await core.commands.execute('index.sync', { registrations: registrations.slice(1) })).toMatchObject({ success: false, rolledBack: false, rollbackErrors: ['write or rollback unavailable'] });
    } finally { spy.mockRestore(); }
  });

  test('curated symlink cannot redirect writes', async () => {
    const index = path.join(root, 'wiki', 'index.md');
    const outside = path.join(project, 'outside-index.md');
    fs.renameSync(index, outside);
    fs.symlinkSync(outside, index);
    const before = fs.readFileSync(outside, 'utf8');
    expect(await targeted().commands.execute('index.sync', { registrations: [registrations[1]] })).toMatchObject({ success: false });
    expect(fs.readFileSync(outside, 'utf8')).toBe(before);
  });

  test('busy registration lock fails explicitly', async () => {
    fs.mkdirSync(path.join(root, '.compiled-views.lock'));
    expect(await targeted().commands.execute('index.sync', { registrations })).toMatchObject({ success: false, error: expect.stringContaining('lock timeout') });
  });

  test('commented/fenced examples do not count as registration or managed rows', async () => {
    const core = targeted();
    const file = path.join(root, 'wiki', 'index.md');
    const examples = '\n<!-- [Hidden](initiatives/example-active.md) -->\n\n```md\n- [Example](initiatives/example-active.md) <!-- mdocs:registration wiki:initiatives/example-active -->\n```\n';
    fs.appendFileSync(file, examples);
    expect(await core.commands.execute('index.sync', { registrations: [registrations[1]] })).toMatchObject({ success: true });
    const after = fs.readFileSync(file, 'utf8');
    expect(after).toContain(examples);
    expect(after.endsWith('- [Example Active](initiatives/example-active.md) — status: active <!-- mdocs:registration wiki:initiatives/example-active -->\n')).toBe(true);
  });

  test('unclosed fence fails its membership postcondition and rolls back', async () => {
    const core = targeted();
    const file = path.join(root, 'wiki', 'index.md');
    fs.appendFileSync(file, '\n```md\n');
    const before = fs.readFileSync(file, 'utf8');
    expect(await core.commands.execute('index.sync', { registrations: [registrations[1]] })).toMatchObject({ success: false, rolledBack: true });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  test('refreshing marked row does not normalize mixed line endings or rewrite neighboring prose', async () => {
    const core = targeted();
    const file = path.join(root, 'wiki', 'index.md');
    const prefix = '# Wiki\r\n\r\nCurated paragraph.\n\n';
    const suffix = '\nMore curated notes.\r\n';
    fs.writeFileSync(file, prefix + '- [Old](initiatives/example-active.md) <!-- mdocs:registration wiki:initiatives/example-active -->\n' + suffix);
    const result = await core.commands.execute('index.sync', { registrations: [registrations[1]] });
    expect(result.success).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(prefix + '- [Example Active](initiatives/example-active.md) — status: active <!-- mdocs:registration wiki:initiatives/example-active -->\n' + suffix);
  });
});
