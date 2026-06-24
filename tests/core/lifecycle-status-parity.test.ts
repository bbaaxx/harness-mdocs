import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { createMdocsCore } from '../../src/core';
import { InitiativeManager } from '../../src/core/managers/initiative';
import { normalizeInitiativeStatus } from '../../src/core/initiative-store';
import { Initiative, isCompleted, Status } from '../../src/core/types';

// ---------- shared helpers ----------

function copyDir(source: string, target: string) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) copyDir(sourcePath, targetPath);
    else fs.copyFileSync(sourcePath, targetPath);
  }
}

function makeFlatProjectDir(prefix: string): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  // An empty mdocs/initiatives dir triggers flat-v1 detection.
  fs.mkdirSync(path.join(projectDir, 'mdocs', 'initiatives'), { recursive: true });
  return projectDir;
}

function makeDirV2ProjectDir(prefix: string): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const fixtureRoot = path.resolve(__dirname, '../fixtures/directory-v2-mdocs');
  copyDir(fixtureRoot, projectDir);
  return projectDir;
}

function baseInitiative(overrides: Partial<Initiative> = {}): Initiative {
  return {
    id: 'lifecycle-test',
    title: 'Lifecycle Test',
    status: 'active',
    created: '2026-06-23',
    updated: '2026-06-23',
    owner: 'tests',
    tags: [],
    relatedWiki: [],
    objective: 'verify lifecycle parity',
    plan: [],
    progressLog: [],
    artifacts: [],
    ...overrides,
  };
}

// ---------- 1 & 2. normalizeInitiativeStatus + isCompleted unit parity ----------

describe('normalizeInitiativeStatus surfaces complete distinctly from done', () => {
  test('complete / completed -> complete; done -> done; active -> active', () => {
    expect(normalizeInitiativeStatus('complete')).toBe<Status>('complete');
    expect(normalizeInitiativeStatus('completed')).toBe<Status>('complete');
    expect(normalizeInitiativeStatus('done')).toBe<Status>('done');
    expect(normalizeInitiativeStatus('active')).toBe<Status>('active');
    // Case-insensitive + archived/paused stay correct.
    expect(normalizeInitiativeStatus('COMPLETE')).toBe<Status>('complete');
    expect(normalizeInitiativeStatus('Done')).toBe<Status>('done');
    expect(normalizeInitiativeStatus('archived')).toBe<Status>('archived');
    expect(normalizeInitiativeStatus('paused')).toBe<Status>('paused');
  });
});

describe('isCompleted', () => {
  test('true for done and complete; false for active/paused/archived', () => {
    expect(isCompleted('done')).toBe(true);
    expect(isCompleted('complete')).toBe(true);
    expect(isCompleted('active')).toBe(false);
    expect(isCompleted('paused')).toBe(false);
    expect(isCompleted('archived')).toBe(false);
  });
});

// ---------- 3. directory-v2 markDone surfaces status 'complete' ----------

describe('directory-v2 markDone surfaces status complete', () => {
  test('marking an active initiative done yields initiative.status === "complete"', () => {
    const projectDir = makeDirV2ProjectDir('harness-mdocs-lifecycle-dv2-done-');
    const core = createMdocsCore(projectDir);

    const created = core.managers.initiatives.create(baseInitiative({ id: 'dv2-done', title: 'Dv2 Done' }));
    const key = path.basename(created);
    const result = core.managers.initiatives.markDone(key);

    expect(result.initiative.status).toBe<Status>('complete');
    // And read-back through the store agrees.
    const readBack = core.managers.initiatives.findById('dv2-done');
    expect(readBack?.status).toBe<Status>('complete');
  });
});

// ---------- 4. complete (dir-v2 done) AND done (flat) both archive ----------

describe('archive accepts both complete (dir-v2) and done (flat)', () => {
  test('a complete directory-v2 initiative can be archived', async () => {
    const projectDir = makeDirV2ProjectDir('harness-mdocs-lifecycle-dv2-archive-');
    const core = createMdocsCore(projectDir);

    const created = core.managers.initiatives.create(baseInitiative({ id: 'dv2-archive', title: 'Dv2 Archive' }));
    const key = path.basename(created);
    core.managers.initiatives.markDone(key);
    expect(core.managers.initiatives.findById('dv2-archive')?.status).toBe<Status>('complete');

    // No throw — complete is accepted.
    expect(() => core.managers.initiatives.archive(key)).not.toThrow();
    expect(core.managers.initiatives.findById('dv2-archive')).toBeNull();
  });

  test('a done flat-v1 initiative still archives via registry', async () => {
    const projectDir = makeFlatProjectDir('harness-mdocs-lifecycle-flat-archive-');
    const core = createMdocsCore(projectDir);

    const created = core.managers.initiatives.create(baseInitiative({ id: 'flat-archive', title: 'Flat Archive' }));
    const key = path.basename(created);
    core.managers.initiatives.markDone(key);
    expect(core.managers.initiatives.findById('flat-archive')?.status).toBe<Status>('done');

    const result = await core.commands.execute('initiative.archive', { id: 'flat-archive' });
    expect(result).toMatchObject({ success: true, id: 'flat-archive' });
  });

  test('registry.archive rejects an active initiative with the new wording', async () => {
    const projectDir = makeFlatProjectDir('harness-mdocs-lifecycle-flat-active-');
    const core = createMdocsCore(projectDir);

    core.managers.initiatives.create(baseInitiative({ id: 'flat-active', title: 'Flat Active' }));
    const result = await core.commands.execute('initiative.archive', { id: 'flat-active' });
    expect(result).toMatchObject({ error: expect.stringContaining('Only completed initiatives can be archived') });
  });
});

// ---------- 5. findBlocked: complete dependency does not block ----------

describe('findBlocked', () => {
  test('an initiative depending on a complete initiative is NOT blocked', () => {
    const projectDir = makeFlatProjectDir('harness-mdocs-lifecycle-blocked-');
    const manager = new InitiativeManager(path.join(projectDir, 'mdocs'));

    manager.create(baseInitiative({
      id: 'dep-target',
      title: 'Dependency',
      status: 'done', // flat-v1 completed value
    }));
    manager.create(baseInitiative({
      id: 'dependent',
      title: 'Dependent',
      dependsOn: ['dep-target'],
    }));

    const blocked = manager.findBlocked();
    expect(blocked.find(i => i.id === 'dependent')).toBeUndefined();
  });

  test('an initiative depending on an active initiative IS blocked', () => {
    const projectDir = makeFlatProjectDir('harness-mdocs-lifecycle-blocked-active-');
    const manager = new InitiativeManager(path.join(projectDir, 'mdocs'));

    manager.create(baseInitiative({ id: 'dep-active', title: 'Active Dep', status: 'active' }));
    manager.create(baseInitiative({
      id: 'dependent-2',
      title: 'Dependent 2',
      dependsOn: ['dep-active'],
    }));

    const blocked = manager.findBlocked();
    expect(blocked.find(i => i.id === 'dependent-2')).toBeDefined();
  });
});

// ---------- 6. expectedDuration round-trips through create -> read ----------

describe('expectedDuration round-trip', () => {
  test('directory-v2 create with expectedDuration:long survives read', () => {
    const projectDir = makeDirV2ProjectDir('harness-mdocs-lifecycle-dv2-dur-');
    const core = createMdocsCore(projectDir);

    core.managers.initiatives.create(baseInitiative({
      id: 'dv2-dur',
      title: 'Dv2 Duration',
      expectedDuration: 'long',
    }));
    const read = core.managers.initiatives.findById('dv2-dur');
    expect(read?.expectedDuration).toBe('long');
  });

  test('flat create with expectedDuration:suppress survives read', () => {
    const projectDir = makeFlatProjectDir('harness-mdocs-lifecycle-flat-dur-');
    const manager = new InitiativeManager(path.join(projectDir, 'mdocs'));

    manager.create(baseInitiative({
      id: 'flat-dur',
      title: 'Flat Duration',
      expectedDuration: 'suppress',
    }));
    const fileName = manager['formatFileName'](baseInitiative({ id: 'flat-dur', created: '2026-06-23' }));
    const read = manager.read(fileName);
    expect(read?.expectedDuration).toBe('suppress');
  });

  test('unknown expectedDuration value coerces to undefined on parse', () => {
    const projectDir = makeFlatProjectDir('harness-mdocs-lifecycle-flat-bad-dur-');
    const manager = new InitiativeManager(path.join(projectDir, 'mdocs'));

    manager.create(baseInitiative({
      id: 'flat-bad-dur',
      title: 'Flat Bad Dur',
      // bypass typed create by writing directly through update path below
    }));
    const fileName = manager['formatFileName'](baseInitiative({ id: 'flat-bad-dur', created: '2026-06-23' }));
    const filePath = path.join(projectDir, 'mdocs', 'initiatives', fileName);
    // Mutate on-disk value to an invalid string and re-read.
    const raw = fs.readFileSync(filePath, 'utf8');
    const mutated = raw.replace(/updated: ".*?"/, `updated: "2026-06-23"\nexpected_duration: "bogus"`);
    fs.writeFileSync(filePath, mutated, 'utf8');
    const read = manager.read(fileName);
    expect(read?.expectedDuration).toBeUndefined();
  });
});

// ---------- 7. graduated round-trips through update -> read ----------

describe('graduated round-trip via update', () => {
  test('registry.update sets graduated and it survives read', async () => {
    const projectDir = makeDirV2ProjectDir('harness-mdocs-lifecycle-dv2-graduated-');
    const core = createMdocsCore(projectDir);

    core.managers.initiatives.create(baseInitiative({ id: 'dv2-grad', title: 'Dv2 Graduated' }));
    const result = await core.commands.execute('initiative.update', {
      id: 'dv2-grad',
      updates: { graduated: '2026-06-23' },
    });
    expect(result).toMatchObject({ success: true });

    const read = core.managers.initiatives.findById('dv2-grad');
    expect(read?.graduated).toBe('2026-06-23');
  });

  test('flat update sets graduated and it survives read', () => {
    const projectDir = makeFlatProjectDir('harness-mdocs-lifecycle-flat-graduated-');
    const manager = new InitiativeManager(path.join(projectDir, 'mdocs'));

    manager.create(baseInitiative({ id: 'flat-grad', title: 'Flat Graduated' }));
    const fileName = manager['formatFileName'](baseInitiative({ id: 'flat-grad', created: '2026-06-23' }));
    const init = manager.read(fileName)!;
    init.graduated = '2026-07-01';
    manager.update(fileName, init);

    const read = manager.read(fileName);
    expect(read?.graduated).toBe('2026-07-01');
  });
});
