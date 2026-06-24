import { InitiativeManager } from '../../src/core/managers/initiative';
import * as fs from 'fs';
import * as path from 'path';
import { Initiative } from '../../src/core/types';

const testDir = path.join(__dirname, 'test-initiatives');

beforeEach(() => {
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true });
  }
  fs.mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

describe('InitiativeManager', () => {
  test('create initiative file with correct format', () => {
    const manager = new InitiativeManager(testDir);
    const initiative: Initiative = {
      id: 'test-init',
      title: 'Test Initiative',
      status: 'active',
      created: '2025-05-24',
      updated: '2025-05-24',
      owner: 'test-owner',
      tags: ['test'],
      relatedWiki: [],
      objective: 'Test objective',
      plan: [{ description: 'Step 1', status: 'pending' }],
      progressLog: [],
      artifacts: []
    };

    manager.create(initiative);

    const files = fs.readdirSync(testDir);
    expect(files).toContain('initiatives');
    const initiativeFiles = fs.readdirSync(path.join(testDir, 'initiatives'));
    expect(initiativeFiles).toContain('test-init--2025-05-24.md');

    const fileContent = fs.readFileSync(path.join(testDir, 'initiatives', 'test-init--2025-05-24.md'), 'utf8');
    expect(fileContent).toContain('---');
    expect(fileContent).toContain('title: "Test Initiative"');
    expect(fileContent).toContain('## Objective');
    expect(fileContent).toContain('## Plan');
    expect(fileContent).toContain('- [ ] Step 1');
  });

  test('read initiative parses frontmatter and sections', () => {
    const manager = new InitiativeManager(testDir);
    const initiative: Initiative = {
      id: 'test-init',
      title: 'Test Initiative',
      status: 'active',
      created: '2025-05-24',
      updated: '2025-05-24',
      owner: 'test-owner',
      tags: ['test'],
      relatedWiki: ['wiki/test'],
      objective: 'Test objective',
      plan: [{ description: 'Step 1', status: 'pending' }, { description: 'Step 2', status: 'pending' }],
      progressLog: ['Started'],
      artifacts: ['wiki/test']
    };

    manager.create(initiative);
    const read = manager.read('test-init--2025-05-24.md');
    
    expect(read).not.toBeNull();
    expect(read!.id).toBe('test-init');
    expect(read!.title).toBe('Test Initiative');
    expect(read!.relatedWiki).toEqual(['wiki/test']);
    expect(read!.objective).toBe('Test objective');
    expect(read!.plan).toEqual([
      { description: 'Step 1', status: 'pending' },
      { description: 'Step 2', status: 'pending' }
    ]);
    expect(read!.progressLog).toEqual(['Started']);
    expect(read!.status).toBe('active');
    expect(read!.created).toBe('2025-05-24');
    expect(read!.updated).toBe('2025-05-24');
    expect(read!.owner).toBe('test-owner');
    expect(read!.tags).toEqual(['test']);
    expect(read!.artifacts).toEqual(['wiki/test']);
  });

  test('read returns null for non-existent file', () => {
    const manager = new InitiativeManager(testDir);
    const result = manager.read('non-existent.md');
    expect(result).toBeNull();
  });

  test('find related initiatives by tag', () => {
    const manager = new InitiativeManager(testDir);
    const init1: Initiative = { id: 'init1', title: 'Auth System', status: 'active', created: '2025-05-24', updated: '2025-05-24', owner: 'a', tags: ['auth', 'security'], relatedWiki: [], objective: 'Auth', plan: [], progressLog: [], artifacts: [] };
    const init2: Initiative = { id: 'init2', title: 'Login Page', status: 'active', created: '2025-05-24', updated: '2025-05-24', owner: 'a', tags: ['auth', 'ui'], relatedWiki: [], objective: 'Login', plan: [], progressLog: [], artifacts: [] };
    const init3: Initiative = { id: 'init3', title: 'Dashboard', status: 'active', created: '2025-05-24', updated: '2025-05-24', owner: 'a', tags: ['ui'], relatedWiki: [], objective: 'Dash', plan: [], progressLog: [], artifacts: [] };
    
    manager.create(init1);
    manager.create(init2);
    manager.create(init3);

    const related = manager.findRelated(['auth', 'security']);
    expect(related.length).toBe(2);
    expect(related.map(i => i.id)).toContain('init1');
    expect(related.map(i => i.id)).toContain('init2');
  });

  test('update initiative rewrites file', () => {
    const manager = new InitiativeManager(testDir);
    const initiative: Initiative = {
      id: 'test-init',
      title: 'Test Initiative',
      status: 'active',
      created: '2025-05-24',
      updated: '2025-05-24',
      owner: 'test-owner',
      tags: ['test'],
      relatedWiki: [],
      objective: 'Original',
      plan: [{ description: 'Step 1', status: 'pending' }],
      progressLog: [],
      artifacts: []
    };

    manager.create(initiative);
    
    const updated = { ...initiative, objective: 'Updated' };
    manager.update('test-init--2025-05-24.md', updated);
    
    const read = manager.read('test-init--2025-05-24.md');
    expect(read!.objective).toBe('Updated');
  });

  test('update with title change keeps id-based file', () => {
    const manager = new InitiativeManager(testDir);
    const initiative: Initiative = {
      id: 'test-init',
      title: 'Old Title',
      status: 'active',
      created: '2025-05-24',
      updated: '2025-05-24',
      owner: 'test-owner',
      tags: ['test'],
      relatedWiki: [],
      objective: 'Test',
      plan: [],
      progressLog: [],
      artifacts: []
    };

    manager.create(initiative);
    const updated = { ...initiative, title: 'New Title' };
    manager.update('test-init--2025-05-24.md', updated);

    const idBasedExists = fs.existsSync(path.join(testDir, 'initiatives', 'test-init--2025-05-24.md'));
    const titleBasedExists = fs.existsSync(path.join(testDir, 'initiatives', 'new-title--2025-05-24.md'));
    expect(idBasedExists).toBe(true);
    expect(titleBasedExists).toBe(false);
  });

  test('delete initiative removes file and updates index', () => {
    const manager = new InitiativeManager(testDir);
    const initiative: Initiative = {
      id: 'test-init',
      title: 'Test Initiative',
      status: 'active',
      created: '2025-05-24',
      updated: '2025-05-24',
      owner: 'test-owner',
      tags: ['test'],
      relatedWiki: [],
      objective: 'Test',
      plan: [],
      progressLog: [],
      artifacts: []
    };

    manager.create(initiative);
    manager.delete('test-init--2025-05-24.md');
    
    const files = fs.readdirSync(path.join(testDir, 'initiatives'));
    expect(files).not.toContain('test-init--2025-05-24.md');
  });

  test('index is generated', () => {
    const manager = new InitiativeManager(testDir);
    const initiative: Initiative = {
      id: 'test-init',
      title: 'Test Initiative',
      status: 'active',
      created: '2025-05-24',
      updated: '2025-05-24',
      owner: 'test-owner',
      tags: ['test'],
      relatedWiki: [],
      objective: 'Test',
      plan: [],
      progressLog: [],
      artifacts: []
    };

    manager.create(initiative);
    
    const indexContent = fs.readFileSync(path.join(testDir, 'initiatives', 'INDEX.md'), 'utf8');
    expect(indexContent).toContain('Test Initiative');
    expect(indexContent).toContain('active');
  });

  test('findRelated returns empty array when no tags match', () => {
    const manager = new InitiativeManager(testDir);
    const init: Initiative = { id: 'init1', title: 'Auth', status: 'active', created: '2025-05-24', updated: '2025-05-24', owner: 'a', tags: ['auth'], relatedWiki: [], objective: 'Auth', plan: [], progressLog: [], artifacts: [] };
    manager.create(init);
    
    const related = manager.findRelated(['nonexistent']);
    expect(related).toEqual([]);
  });

  test('read throws for invalid file format', () => {
    const manager = new InitiativeManager(testDir);
    fs.writeFileSync(path.join(testDir, 'initiatives', 'invalid.md'), 'not valid markdown');
    expect(() => manager.read('invalid.md')).toThrow('Invalid initiative format');
  });

  test('read sanitizes path traversal attempts', () => {
    const manager = new InitiativeManager(testDir);
    const result = manager.read('../../../etc/passwd');
    expect(result).toBeNull(); // Should not read outside initiatives dir
  });

  test('delete sanitizes path traversal attempts', () => {
    const manager = new InitiativeManager(testDir);
    // Should not throw and should not delete anything outside initiatives dir
    expect(() => manager.delete('../../../etc/passwd')).not.toThrow();
  });

  test('create throws when file already exists', () => {
    const manager = new InitiativeManager(testDir);
    const initiative: Initiative = {
      id: 'test-init',
      title: 'Test Initiative',
      status: 'active',
      created: '2025-05-24',
      updated: '2025-05-24',
      owner: 'test-owner',
      tags: ['test'],
      relatedWiki: [],
      objective: 'Test',
      plan: [],
      progressLog: [],
      artifacts: []
    };

    manager.create(initiative);
    expect(() => manager.create(initiative)).toThrow('already exists');
  });

  test('create with priority, dueDate, and dependsOn', () => {
    const manager = new InitiativeManager(testDir);
    const initiative: Initiative = {
      id: 'priority-test',
      title: 'Priority Test',
      status: 'active',
      priority: 'high',
      created: '2025-05-24',
      updated: '2025-05-24',
      owner: 'test',
      tags: [],
      relatedWiki: [],
      objective: 'Test priority fields',
      plan: [],
      progressLog: [],
      artifacts: [],
      dueDate: '2025-06-01',
      dependsOn: ['dep1', 'dep2']
    };

    manager.create(initiative);
    const read = manager.read('priority-test--2025-05-24.md');
    expect(read).not.toBeNull();
    expect(read!.priority).toBe('high');
    expect(read!.dueDate).toBe('2025-06-01');
    expect(read!.dependsOn).toEqual(['dep1', 'dep2']);
  });

  test('read defaults priority to medium when not specified', () => {
    const manager = new InitiativeManager(testDir);
    const content = `---
id: no-priority
title: No Priority
status: active
created: 2025-05-24
updated: 2025-05-24
owner: test
tags: []
related_wiki: []
---

## Objective
No priority

## Plan

## Progress Log

## Artifacts
`;
    fs.writeFileSync(path.join(testDir, 'initiatives', 'no-priority--2025-05-24.md'), content, 'utf8');
    const read = manager.read('no-priority--2025-05-24.md');
    expect(read).not.toBeNull();
    expect(read!.priority).toBe('medium');
  });

  test('findBlocked returns initiatives with undone dependencies', () => {
    const manager = new InitiativeManager(testDir);
    const dep1: Initiative = { id: 'dep1', title: 'Dependency 1', status: 'active', priority: 'medium', created: '2025-05-24', updated: '2025-05-24', owner: 'a', tags: [], relatedWiki: [], objective: 'Dep1', plan: [], progressLog: [], artifacts: [] };
    const dep2: Initiative = { id: 'dep2', title: 'Dependency 2', status: 'done', priority: 'medium', created: '2025-05-24', updated: '2025-05-24', owner: 'a', tags: [], relatedWiki: [], objective: 'Dep2', plan: [], progressLog: [], artifacts: [] };
    const blocked: Initiative = { id: 'blocked', title: 'Blocked', status: 'active', priority: 'medium', created: '2025-05-24', updated: '2025-05-24', owner: 'a', tags: [], relatedWiki: [], objective: 'Blocked', plan: [], progressLog: [], artifacts: [], dependsOn: ['dep1', 'dep2'] };
    const unblocked: Initiative = { id: 'unblocked', title: 'Unblocked', status: 'active', priority: 'medium', created: '2025-05-24', updated: '2025-05-24', owner: 'a', tags: [], relatedWiki: [], objective: 'Unblocked', plan: [], progressLog: [], artifacts: [], dependsOn: ['dep2'] };

    manager.create(dep1);
    manager.create(dep2);
    manager.create(blocked);
    manager.create(unblocked);

    const blockedList = manager.findBlocked();
    expect(blockedList).toHaveLength(1);
    expect(blockedList[0].id).toBe('blocked');
  });

  test('findOverdue returns initiatives past due date', () => {
    const manager = new InitiativeManager(testDir);
    const pastDue: Initiative = { id: 'past', title: 'Past Due', status: 'active', priority: 'medium', created: '2025-05-24', updated: '2025-05-24', owner: 'a', tags: [], relatedWiki: [], objective: 'Past', plan: [], progressLog: [], artifacts: [], dueDate: '2020-01-01' };
    const futureDue: Initiative = { id: 'future', title: 'Future Due', status: 'active', priority: 'medium', created: '2025-05-24', updated: '2025-05-24', owner: 'a', tags: [], relatedWiki: [], objective: 'Future', plan: [], progressLog: [], artifacts: [], dueDate: '2099-12-31' };
    const done: Initiative = { id: 'done', title: 'Done', status: 'done', priority: 'medium', created: '2025-05-24', updated: '2025-05-24', owner: 'a', tags: [], relatedWiki: [], objective: 'Done', plan: [], progressLog: [], artifacts: [], dueDate: '2020-01-01' };

    manager.create(pastDue);
    manager.create(futureDue);
    manager.create(done);

    const overdue = manager.findOverdue();
    expect(overdue).toHaveLength(1);
    expect(overdue[0].id).toBe('past');
  });

  test('listByPriority sorts by priority then due date', () => {
    const manager = new InitiativeManager(testDir);
    const low: Initiative = { id: 'low', title: 'Low', status: 'active', priority: 'low', created: '2025-05-24', updated: '2025-05-24', owner: 'a', tags: [], relatedWiki: [], objective: 'Low', plan: [], progressLog: [], artifacts: [] };
    const critical: Initiative = { id: 'critical', title: 'Critical', status: 'active', priority: 'critical', created: '2025-05-24', updated: '2025-05-24', owner: 'a', tags: [], relatedWiki: [], objective: 'Critical', plan: [], progressLog: [], artifacts: [], dueDate: '2025-06-15' };
    const high: Initiative = { id: 'high', title: 'High', status: 'active', priority: 'high', created: '2025-05-24', updated: '2025-05-24', owner: 'a', tags: [], relatedWiki: [], objective: 'High', plan: [], progressLog: [], artifacts: [], dueDate: '2025-06-01' };
    const criticalLater: Initiative = { id: 'critical-later', title: 'Critical Later', status: 'active', priority: 'critical', created: '2025-05-24', updated: '2025-05-24', owner: 'a', tags: [], relatedWiki: [], objective: 'Critical Later', plan: [], progressLog: [], artifacts: [], dueDate: '2025-06-30' };

    manager.create(low);
    manager.create(critical);
    manager.create(high);
    manager.create(criticalLater);

    const sorted = manager.listByPriority();
    expect(sorted.map(i => i.id)).toEqual(['critical', 'critical-later', 'high', 'low']);
  });

  test('validate reports duplicate ids, missing required fields, broken wiki warnings, and index drift', () => {
    const manager = new InitiativeManager(testDir);
    const initiativesDir = path.join(testDir, 'initiatives');
    const wikiDir = path.join(testDir, 'wiki', 'architecture');
    fs.mkdirSync(wikiDir, { recursive: true });
    fs.writeFileSync(path.join(wikiDir, 'existing.md'), '---\nid: "existing"\ntitle: "Existing"\ncategory: "architecture"\n---\n', 'utf8');
    fs.writeFileSync(path.join(initiativesDir, 'one.md'), `---
id: "duplicate"
title: "One"
status: "active"
created: "2026-05-29"
related_wiki: ["architecture/existing"]
---

## Objective

## Plan

## Progress Log

## Artifacts
`, 'utf8');
    fs.writeFileSync(path.join(initiativesDir, 'two.md'), `---
id: "duplicate"
title: ""
status: ""
created: ""
related_wiki: ["architecture/missing"]
---

## Objective

## Plan

## Progress Log

## Artifacts
`, 'utf8');
    fs.writeFileSync(path.join(initiativesDir, 'INDEX.md'), '# Initiatives\n\n- **One** (active) — one.md — 2026-05-29 — []\n- ghost.md', 'utf8');

    const result = manager.validate();

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('Duplicate initiative id "duplicate"'),
      expect.stringContaining('two.md missing title'),
      expect.stringContaining('two.md missing status'),
      expect.stringContaining('two.md missing created')
    ]));
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('two.md references missing wiki entry: architecture/missing'),
      expect.stringContaining('INDEX.md lists missing initiative file: ghost.md'),
      expect.stringContaining('INDEX.md missing initiative file: two.md')
    ]));
  });

  test('create and update reject duplicate non-empty initiative ids without blocking same-file updates', () => {
    const manager = new InitiativeManager(testDir);
    const first: Initiative = { id: 'shared', title: 'First', status: 'active', created: '2026-05-29', updated: '2026-05-29', owner: 'a', tags: [], relatedWiki: [], objective: '', plan: [], progressLog: [], artifacts: [] };
    const second: Initiative = { ...first, title: 'Second', created: '2026-05-30', updated: '2026-05-30' };
    manager.create(first);

    expect(() => manager.create(second)).toThrow('Duplicate initiative id "shared"');
    expect(() => manager.update('shared--2026-05-29.md', { ...first, title: 'First Updated' })).not.toThrow();

    const other: Initiative = { ...first, id: 'other', title: 'Other', created: '2026-05-31', updated: '2026-05-31' };
    manager.create(other);
    expect(() => manager.update('other--2026-05-31.md', { ...other, id: 'shared' })).toThrow('Duplicate initiative id "shared"');
  });

  test('validate warns for unsafe related_wiki path segments without resolving outside wiki root', () => {
    const manager = new InitiativeManager(testDir);
    const initiativesDir = path.join(testDir, 'initiatives');
    const escapedSecretDir = path.join(testDir, 'secret');
    fs.mkdirSync(escapedSecretDir, { recursive: true });
    fs.writeFileSync(path.join(escapedSecretDir, 'foo.md'), 'outside wiki root', 'utf8');
    fs.writeFileSync(path.join(initiativesDir, 'unsafe-wiki--2026-05-29.md'), `---
id: "unsafe-wiki"
title: "Unsafe Wiki"
status: "active"
created: "2026-05-29"
related_wiki: ["../secret/foo"]
---

## Objective

## Plan

## Progress Log

## Artifacts
`, 'utf8');

    const result = manager.validate();

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('unsafe-wiki--2026-05-29.md has unsafe wiki reference: ../secret/foo')
    ]));
  });

  test('preserves v2 initiative memory metadata and sections', () => {
    const manager = new InitiativeManager(testDir);
    const filePath = manager.create({
      id: 'memory-metadata',
      title: 'Memory Metadata',
      status: 'active',
      priority: 'high',
      created: '2026-05-29',
      updated: '2026-05-29',
      owner: 'agent',
      tags: ['memory'],
      relatedWiki: [],
      objective: 'Capture durable state for agent resume.',
      plan: [{ description: 'Add metadata', status: 'pending' }],
      progressLog: ['Created'],
      artifacts: [],
      phase: 'implementation',
      handoffSummary: 'Metadata fields are ready for the next agent.',
      openQuestions: ['Should lifecycle states be enforced?'],
      blockers: ['Need graph validation'],
      nextAction: 'Implement dispatch retrieval.'
    });

    const readBack = manager.read(path.basename(filePath));

    expect(readBack?.phase).toBe('implementation');
    expect(readBack?.handoffSummary).toContain('ready for the next agent');
    expect(readBack?.openQuestions).toEqual(['Should lifecycle states be enforced?']);
    expect(readBack?.blockers).toEqual(['Need graph validation']);
    expect(readBack?.nextAction).toBe('Implement dispatch retrieval.');
  });

  test('validate warns for non-string related_wiki entries instead of throwing', () => {
    const manager = new InitiativeManager(testDir);
    const initiativesDir = path.join(testDir, 'initiatives');
    fs.writeFileSync(path.join(initiativesDir, 'numeric-wiki--2026-05-29.md'), `---
id: "numeric-wiki"
title: "Numeric Wiki"
status: "active"
created: "2026-05-29"
related_wiki: [123]
---

## Objective

## Plan

## Progress Log

## Artifacts
`, 'utf8');

    const result = manager.validate();

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('numeric-wiki--2026-05-29.md has non-string wiki reference: 123')
    ]));
  });

  test('checkConsistency returns consistent for clean repo', () => {
    const manager = new InitiativeManager(testDir);
    manager.create({
      id: 'consistency-test',
      title: 'Consistency Test',
      status: 'active',
      created: '2026-05-29',
      updated: '2026-05-29',
      owner: 'a',
      tags: [],
      relatedWiki: [],
      objective: 'Test',
      plan: [],
      progressLog: [],
      artifacts: []
    });

    const result = manager.checkConsistency();

    expect(result.consistent).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.orphans).toEqual([]);
    expect(result.stale).toBe(false);
  });

  test('checkConsistency detects orphan files not in INDEX', () => {
    const manager = new InitiativeManager(testDir);
    manager.create({
      id: 'orphan-detect',
      title: 'Orphan Detect',
      status: 'active',
      created: '2026-05-29',
      updated: '2026-05-29',
      owner: 'a',
      tags: [],
      relatedWiki: [],
      objective: 'Test',
      plan: [],
      progressLog: [],
      artifacts: []
    });

    // Manually create a file not in INDEX
    fs.writeFileSync(path.join(testDir, 'initiatives', 'hidden--2026-05-29.md'), `---
id: "hidden"
title: "Hidden"
status: "active"
created: "2026-05-29"
updated: "2026-05-29"
owner: "a"
tags: []
related_wiki: []
---

## Objective

## Plan

## Progress Log

## Artifacts
`, 'utf8');

    const result = manager.checkConsistency();

    expect(result.consistent).toBe(false);
    expect(result.orphans).toEqual(expect.arrayContaining([
      expect.stringContaining('hidden--2026-05-29.md')
    ]));
  });

  test('checkConsistency detects missing files listed in INDEX', () => {
    const manager = new InitiativeManager(testDir);
    // Write an INDEX with a ghost entry
    fs.writeFileSync(path.join(testDir, 'initiatives', 'INDEX.md'), '# Initiatives\n\n- **Ghost** (active) — ghost--2026-05-29.md — 2026-05-29 — []', 'utf8');

    const result = manager.checkConsistency();

    expect(result.consistent).toBe(false);
    expect(result.missing).toEqual(expect.arrayContaining([
      expect.stringContaining('ghost--2026-05-29.md')
    ]));
  });

  test('checkConsistency detects stale index when file is newer', () => {
    const manager = new InitiativeManager(testDir);
    manager.create({
      id: 'stale-test',
      title: 'Stale Test',
      status: 'active',
      created: '2026-05-29',
      updated: '2026-05-29',
      owner: 'a',
      tags: [],
      relatedWiki: [],
      objective: 'Test',
      plan: [],
      progressLog: [],
      artifacts: []
    });

    // Ensure consistent first
    expect(manager.checkConsistency().consistent).toBe(true);

    // Wait a bit and modify the file directly
    const filePath = path.join(testDir, 'initiatives', 'stale-test--2026-05-29.md');
    const content = fs.readFileSync(filePath, 'utf8');
    fs.writeFileSync(filePath, content + '\n<!-- modified -->', 'utf8');
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(filePath, future, future);

    const result = manager.checkConsistency();
    expect(result.stale).toBe(true);
    expect(result.consistent).toBe(false);
  });
});

// Metadata-only mode (cc1): a consumer `_status.md` is thin lifecycle metadata.
// Update/markDone/graduate-stamp must rewrite only existing lifecycle keys in
// place, never inject body sections, never add frontmatter keys, and preserve
// inline array formatting like `tags: [a, b]`.
describe('InitiativeManager metadata-only mode', () => {
  const metaDir = path.join(__dirname, 'test-initiatives-metadata-only');

  beforeEach(() => {
    if (fs.existsSync(metaDir)) fs.rmSync(metaDir, { recursive: true });
    fs.mkdirSync(metaDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(metaDir)) fs.rmSync(metaDir, { recursive: true, force: true });
  });

  // Seed a consumer-style thin _status.md: frontmatter with inline tags, a
  // couple of non-lifecycle keys, and one prose paragraph (no body sections).
  function seedThinStatus(): string {
    const dir = path.join(metaDir, 'initiatives', 'consumer-init');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, '_status.md');
    fs.writeFileSync(filePath, [
      '---',
      'id: consumer-init',
      'title: Consumer Init',
      'status: active',
      'started: 2026-06-24',
      'updated: 2026-06-24',
      'owner: consumer',
      'tags: [a, b]',
      'priority: high',
      '---',
      '',
      'This is a prose-only consumer body with no sections.',
      ''
    ].join('\n'), 'utf8');
    return filePath;
  }

  function readStatus(filePath: string): string {
    return fs.readFileSync(filePath, 'utf8');
  }

  test('update preserves shape, inline tags, and adds no sections or keys', () => {
    const filePath = seedThinStatus();
    const manager = new InitiativeManager(metaDir, {
      compatibility: { initiativeMode: 'directory', initiativeRecordMode: 'metadata-only' }
    });

    const before = readStatus(filePath);
    const initiative = manager.read('consumer-init');
    expect(initiative).not.toBeNull();
    if (!initiative) return;

    // Simulate a consumer-driven lifecycle refresh.
    initiative.updated = '2026-07-01';
    initiative.status = 'paused';
    initiative.nextAction = 'review';
    manager.update('consumer-init', initiative);

    const after = readStatus(filePath);

    // No injected body sections.
    expect(after).not.toContain('## Objective');
    expect(after).not.toContain('## Plan');
    expect(after).not.toContain('## Progress Log');
    expect(after).not.toContain('## Artifacts');

    // Prose body preserved verbatim.
    expect(after).toContain('This is a prose-only consumer body with no sections.');

    // Inline tags formatting preserved (not JSON-stringified).
    expect(after).toContain('tags: [a, b]');
    expect(after).not.toContain('tags: ["a","b"]');

    // Lifecycle keys rewritten in place.
    expect(after).toContain('updated: 2026-07-01');
    // normalizeInitiativeStatus maps 'paused' through unchanged.
    expect(after).toMatch(/status: paused/);

    // No new frontmatter keys introduced (id/title/owner/tags/priority
    // unchanged; next_action added only because it was a lifecycle key in the
    // update payload, but it was NOT present originally so it must NOT appear).
    expect(after).not.toContain('next_action:');

    // Frontmatter key set unchanged aside from lifecycle value edits.
    const beforeKeys = before.split('---')[1].split('\n').filter(l => l.trim() && l.includes(':')).map(l => l.split(':')[0].trim()).sort();
    const afterKeys = after.split('---')[1].split('\n').filter(l => l.trim() && l.includes(':')).map(l => l.split(':')[0].trim()).sort();
    expect(afterKeys).toEqual(beforeKeys);
  });

  test('markDone rewrites status/updated/completed without injecting sections', () => {
    const filePath = seedThinStatus();
    const manager = new InitiativeManager(metaDir, {
      compatibility: { initiativeMode: 'directory', initiativeRecordMode: 'metadata-only' }
    });

    manager.markDone('consumer-init');

    const after = readStatus(filePath);

    expect(after).not.toContain('## Progress Log');
    expect(after).not.toContain('Marked done via mdocs command');
    expect(after).toContain('This is a prose-only consumer body with no sections.');
    expect(after).toContain('tags: [a, b]');
    // completed is a lifecycle key added by markDone; status maps to complete.
    expect(after).toMatch(/status: complete/);
    expect(after).toContain('completed:');
  });

  test('graduate-stamp rewrites graduated (existing key) without body mutation', () => {
    const filePath = seedThinStatus();
    // Add a graduated key so the stamp can rewrite it in place.
    const seeded = readStatus(filePath).replace('priority: high', 'priority: high\ngraduated: ');
    fs.writeFileSync(filePath, seeded, 'utf8');

    const manager = new InitiativeManager(metaDir, {
      compatibility: { initiativeMode: 'directory', initiativeRecordMode: 'metadata-only' }
    });

    // Mark done first so graduate's isCompleted gate passes.
    manager.markDone('consumer-init');
    const initiative = manager.read('consumer-init');
    expect(initiative).not.toBeNull();
    if (!initiative) return;

    // The graduate command stamps `graduated` via initiative.update; emulate
    // that single-key lifecycle stamp directly through update.
    initiative.graduated = '2026-07-02';
    manager.update('consumer-init', initiative);

    const after = readStatus(filePath);

    expect(after).not.toContain('## Objective');
    expect(after).not.toContain('## Progress Log');
    expect(after).toContain('graduated: 2026-07-02');
    expect(after).toContain('tags: [a, b]');
    expect(after).toContain('This is a prose-only consumer body with no sections.');
  });

  test('default full mode still injects Progress Log on update (regression guard)', () => {
    const filePath = seedThinStatus();
    const manager = new InitiativeManager(metaDir, {
      compatibility: { initiativeMode: 'directory', initiativeRecordMode: 'full' }
    });

    const initiative = manager.read('consumer-init');
    expect(initiative).not.toBeNull();
    if (!initiative) return;
    initiative.progressLog.push('[2026-07-01] note');
    manager.update('consumer-init', initiative);

    const after = readStatus(filePath);
    expect(after).toContain('## Progress Log');
    expect(after).toContain('[2026-07-01] note');
  });
});
