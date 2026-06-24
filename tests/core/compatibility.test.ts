import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createMdocsCore } from '../../src/core';
import { detectMdocsContract } from '../../src/core/contract';
import { lookup } from '../../src/core/operations';

function copyDir(source: string, target: string) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) copyDir(sourcePath, targetPath);
    else fs.copyFileSync(sourcePath, targetPath);
  }
}

function exactChildExists(parent: string, child: string): boolean {
  return fs.existsSync(parent) && fs.readdirSync(parent).includes(child);
}

test('existing mdocs fixture is readable without destructive initialization', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-compat-'));
  const fixtureRoot = path.resolve(__dirname, '../fixtures/legacy-mdocs');
  copyDir(fixtureRoot, projectDir);

  const before = fs.readFileSync(path.join(projectDir, 'mdocs', 'initiatives', 'INDEX.md'), 'utf8');
  const core = createMdocsCore(projectDir);
  const initResult = core.lifecycle.ensureInitialized();
  const status = core.managers.workflow.status();
  const validation = core.commands.validationResult();
  const after = fs.readFileSync(path.join(projectDir, 'mdocs', 'initiatives', 'INDEX.md'), 'utf8');

  expect(initResult).toEqual({ initialized: false, bootstrapInitiativeCreated: false });
  expect(status.currentStep).toBeDefined();
  expect(validation).toHaveProperty('valid');
  expect(after).toBe(before);
});

test('directory-v2 fixture is readable without uppercase wiki index', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-dirv2-'));
  const fixtureRoot = path.resolve(__dirname, '../fixtures/directory-v2-mdocs');
  copyDir(fixtureRoot, projectDir);

  const wikiIndexPath = path.join(projectDir, 'mdocs', 'wiki', 'index.md');
  const before = fs.readFileSync(wikiIndexPath, 'utf8');
  expect(detectMdocsContract(path.join(projectDir, 'mdocs')).wikiIndexMode).toBe('canonical-lowercase');
  const core = createMdocsCore(projectDir);
  const initResult = core.lifecycle.ensureInitialized();
  const after = fs.readFileSync(wikiIndexPath, 'utf8');

  expect(initResult).toEqual({ initialized: false, bootstrapInitiativeCreated: false });
  expect(core.managers.mdocs.exists()).toBe(true);
  expect(after).toBe(before);
  expect(exactChildExists(path.join(projectDir, 'mdocs', 'wiki'), 'INDEX.md')).toBe(false);
});

test('index sync is safe for directory-v2 external wiki index', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-dirv2-sync-'));
  const fixtureRoot = path.resolve(__dirname, '../fixtures/directory-v2-mdocs');
  copyDir(fixtureRoot, projectDir);

  const wikiIndexPath = path.join(projectDir, 'mdocs', 'wiki', 'index.md');
  const before = fs.readFileSync(wikiIndexPath, 'utf8');
  expect(detectMdocsContract(path.join(projectDir, 'mdocs')).wikiIndexOwner).toBe('external');
  const core = createMdocsCore(projectDir);
  const result = core.managers.wiki.syncIndices();
  const after = fs.readFileSync(wikiIndexPath, 'utf8');

  expect(result).toEqual([]);
  expect(after).toBe(before);
  expect(exactChildExists(path.join(projectDir, 'mdocs', 'wiki'), 'INDEX.md')).toBe(false);
  expect(exactChildExists(path.join(projectDir, 'mdocs', 'wiki', 'systems'), 'INDEX.md')).toBe(false);
});

test('directory-v2 index consistency does not require generated uppercase indices', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-dirv2-check-'));
  const fixtureRoot = path.resolve(__dirname, '../fixtures/directory-v2-mdocs');
  copyDir(fixtureRoot, projectDir);

  const core = createMdocsCore(projectDir);
  const result = core.managers.wiki.checkConsistency();

  expect(result).toEqual({ consistent: true, missing: [], orphans: [], stale: false });
});

test('directory-v2 initiative index sync does not rewrite directory index', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-dirv2-init-sync-'));
  const fixtureRoot = path.resolve(__dirname, '../fixtures/directory-v2-mdocs');
  copyDir(fixtureRoot, projectDir);

  const initiativeIndexPath = path.join(projectDir, 'mdocs', 'initiatives', 'INDEX.md');
  const before = fs.readFileSync(initiativeIndexPath, 'utf8');
  const core = createMdocsCore(projectDir);
  const result = core.managers.initiatives.syncIndex();
  const after = fs.readFileSync(initiativeIndexPath, 'utf8');

  expect(result).toBe(initiativeIndexPath);
  expect(after).toBe(before);
});

test('directory-v2 detection avoids generated indices when lowercase index is absent', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-dirv2-no-index-'));
  fs.mkdirSync(path.join(projectDir, 'mdocs', 'initiatives', 'example-active'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'mdocs', 'wiki'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'mdocs', 'initiatives', 'example-active', '_status.md'), '---\nid: example-active\nstatus: active\n---\n');

  const contract = detectMdocsContract(path.join(projectDir, 'mdocs'));

  expect(contract.initiativeMode).toBe('directory');
  expect(contract.wikiIndexMode).toBe('none');
  expect(contract.wikiIndexOwner).toBe('none');
});

test('directory-v2 initiatives are readable by lookup, search, and aliases', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-dirv2-read-'));
  const fixtureRoot = path.resolve(__dirname, '../fixtures/directory-v2-mdocs');
  copyDir(fixtureRoot, projectDir);
  const core = createMdocsCore(projectDir);

  expect(core.managers.initiatives.findById('example-active')?.title).toBe('Example Active');
  // Directory-v2 surfaces `complete` distinctly (G4 Slice A); the on-disk
  // _status.md value `complete` is no longer collapsed to `done`.
  expect(core.managers.initiatives.findById('example-complete')?.status).toBe('complete');
  expect(core.managers.initiatives.findById('legacy-flat')?.title).toBe('Legacy Flat');
  expect(core.managers.initiatives.findById('example-archived')).toBeNull();
  expect(core.managers.initiatives.list(true).some(initiative => initiative.id === 'example-archived')).toBe(true);
  expect(core.managers.initiatives.findByQuery('example-active')?.key).toBe('example-active');
});

test('directory-v2 lookup and search include directory initiatives', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-dirv2-ops-'));
  const fixtureRoot = path.resolve(__dirname, '../fixtures/directory-v2-mdocs');
  copyDir(fixtureRoot, projectDir);
  const core = createMdocsCore(projectDir);

  expect(lookup(core, 'example-active')).toMatchObject({
    id: 'example-active',
    filename: 'example-active'
  });
  expect(core.managers.search.query('directory-v2 initiative').some(result => result.id === 'example-active')).toBe(true);
});

test('directory-v2 malformed wiki.link is blocked without flat-file side effects', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-dirv2-guards-'));
  const fixtureRoot = path.resolve(__dirname, '../fixtures/directory-v2-mdocs');
  copyDir(fixtureRoot, projectDir);
  const core = createMdocsCore(projectDir);
  const initiativesDir = path.join(projectDir, 'mdocs', 'initiatives');
  const statusPath = path.join(initiativesDir, 'example-active', '_status.md');
  const beforeFiles = fs.readdirSync(initiativesDir).filter(file => file.endsWith('.md')).sort();
  const beforeStatus = fs.readFileSync(statusPath, 'utf8');

  await expect(core.commands.execute('wiki.link', { initiativeId: 'example-active', wikiSlug: 'bad/ref/too-deep' })).resolves.toMatchObject({ error: expect.stringContaining('Invalid wikiSlug') });

  expect(fs.readdirSync(initiativesDir).filter(file => file.endsWith('.md')).sort()).toEqual(beforeFiles);
  expect(fs.readFileSync(statusPath, 'utf8')).toBe(beforeStatus);
  expect(fs.existsSync(path.join(initiativesDir, 'archive', 'example-complete.md'))).toBe(false);
});

test('directory-v2 wiki.link updates status and wiki backlinks without flat-file side effects', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-dirv2-link-'));
  const fixtureRoot = path.resolve(__dirname, '../fixtures/directory-v2-mdocs');
  copyDir(fixtureRoot, projectDir);
  const core = createMdocsCore(projectDir);
  const initiativesDir = path.join(projectDir, 'mdocs', 'initiatives');
  const statusPath = path.join(initiativesDir, 'example-active', '_status.md');
  const wikiPath = path.join(projectDir, 'mdocs', 'wiki', 'systems', 'system-page.md');
  const wikiIndexPath = path.join(projectDir, 'mdocs', 'wiki', 'index.md');
  const beforeWikiIndex = fs.readFileSync(wikiIndexPath, 'utf8');

  const result = await core.commands.execute('wiki.link', { initiativeId: 'example-active', wikiSlug: 'systems/system-page' });
  await core.commands.execute('wiki.link', { initiativeId: 'example-active', wikiSlug: 'systems/system-page' });
  const status = fs.readFileSync(statusPath, 'utf8');
  const wiki = fs.readFileSync(wikiPath, 'utf8');

  expect(result).toMatchObject({ success: true, bidirectional: true, initiativeId: 'example-active', wikiSlug: 'systems/system-page' });
  expect(core.managers.initiatives.findById('example-active')?.relatedWiki).toContain('systems/system-page');
  expect((status.match(/systems\/system-page/g) || []).length).toBe(1);
  expect(core.managers.wiki.read('systems', 'system-page')?.relatedInitiatives).toContain('example-active');
  expect(wiki).toContain('## Referenced By');
  expect(wiki).toContain('- example-active');
  expect(fs.existsSync(path.join(initiativesDir, 'example-active.md'))).toBe(false);
  expect(fs.readFileSync(wikiIndexPath, 'utf8')).toBe(beforeWikiIndex);
  expect(exactChildExists(path.join(projectDir, 'mdocs', 'wiki'), 'INDEX.md')).toBe(false);
});

test('directory-v2 initiative.create writes a folder status file without generated indices', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-dirv2-create-'));
  const fixtureRoot = path.resolve(__dirname, '../fixtures/directory-v2-mdocs');
  copyDir(fixtureRoot, projectDir);
  const core = createMdocsCore(projectDir);
  const initiativesDir = path.join(projectDir, 'mdocs', 'initiatives');

  const result = await core.commands.execute('initiative.create', {
    title: 'Native Directory Write',
    objective: 'Create directory initiative safely.',
    tags: ['compatibility'],
    plan: ['Write _status.md']
  });

  const statusPath = path.join(initiativesDir, 'native-directory-write', '_status.md');
  expect(result).toMatchObject({ success: true, id: 'native-directory-write', filename: 'native-directory-write' });
  expect(fs.existsSync(statusPath)).toBe(true);
  expect(fs.readFileSync(statusPath, 'utf8')).toContain('Create directory initiative safely.');
  expect(core.managers.initiatives.findById('native-directory-write')?.title).toBe('Native Directory Write');
  expect(exactChildExists(initiativesDir, 'native-directory-write.md')).toBe(false);
});

test('directory-v2 initiative.update edits status metadata and appends progress', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-dirv2-update-'));
  const fixtureRoot = path.resolve(__dirname, '../fixtures/directory-v2-mdocs');
  copyDir(fixtureRoot, projectDir);
  const core = createMdocsCore(projectDir);
  const initiativesDir = path.join(projectDir, 'mdocs', 'initiatives');
  const statusPath = path.join(initiativesDir, 'example-active', '_status.md');
  const beforeFiles = fs.readdirSync(initiativesDir).filter(file => file.endsWith('.md')).sort();

  const result = await core.commands.execute('initiative.update', {
    id: 'example-active',
    updates: { owner: 'dir-owner', phase: 'implementation', nextAction: 'Keep writing safely' },
    progressNote: 'Directory update note'
  });
  const status = fs.readFileSync(statusPath, 'utf8');

  expect(result).toMatchObject({ success: true, id: 'example-active', filename: 'example-active' });
  expect(status).toContain('owner: dir-owner');
  expect(status).toContain('phase: implementation');
  expect(status).toContain('next_action: Keep writing safely');
  expect(status).toContain('Directory update note');
  expect(core.managers.initiatives.findById('example-active')?.owner).toBe('dir-owner');
  expect(fs.readdirSync(initiativesDir).filter(file => file.endsWith('.md')).sort()).toEqual(beforeFiles);
});

test('directory-v2 initiative.delete removes initiative folder only', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-dirv2-delete-'));
  const fixtureRoot = path.resolve(__dirname, '../fixtures/directory-v2-mdocs');
  copyDir(fixtureRoot, projectDir);
  const core = createMdocsCore(projectDir);
  const initiativesDir = path.join(projectDir, 'mdocs', 'initiatives');
  const wikiIndexPath = path.join(projectDir, 'mdocs', 'wiki', 'index.md');
  const beforeWikiIndex = fs.readFileSync(wikiIndexPath, 'utf8');

  const result = await core.commands.execute('initiative.delete', { id: 'example-active' });

  expect(result).toMatchObject({ success: true, id: 'example-active', deletedFilename: 'example-active' });
  expect(fs.existsSync(path.join(initiativesDir, 'example-active'))).toBe(false);
  expect(core.managers.initiatives.findById('example-active')).toBeNull();
  expect(fs.readFileSync(wikiIndexPath, 'utf8')).toBe(beforeWikiIndex);
  expect(exactChildExists(initiativesDir, 'INDEX.md')).toBe(true);
});

test('directory-v2 initiative.done updates status file without flat-file side effects', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-dirv2-done-'));
  const fixtureRoot = path.resolve(__dirname, '../fixtures/directory-v2-mdocs');
  copyDir(fixtureRoot, projectDir);
  const core = createMdocsCore(projectDir);
  const initiativesDir = path.join(projectDir, 'mdocs', 'initiatives');
  const statusPath = path.join(initiativesDir, 'example-active', '_status.md');
  const beforeFiles = fs.readdirSync(initiativesDir).filter(file => file.endsWith('.md')).sort();

  const result = await core.commands.execute('initiative.done', { id: 'example-active' });
  const status = fs.readFileSync(statusPath, 'utf8');

  expect(result).toMatchObject({ success: true, id: 'example-active', filename: 'example-active' });
  expect(status).toContain('status: complete');
  expect(status).toContain('completed:');
  expect(status).toContain('Marked done via mdocs command');
  expect(status).toContain('Example directory-v2 initiative.');
  // markDone writes status: complete to disk for directory-v2 (G4 Slice A),
  // and the store now surfaces that value distinctly instead of collapsing to done.
  expect(core.managers.initiatives.findById('example-active')?.status).toBe('complete');
  expect(fs.readdirSync(initiativesDir).filter(file => file.endsWith('.md')).sort()).toEqual(beforeFiles);
});

test('directory-v2 initiative.done clears active workflow state', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-dirv2-done-active-'));
  const fixtureRoot = path.resolve(__dirname, '../fixtures/directory-v2-mdocs');
  copyDir(fixtureRoot, projectDir);
  const core = createMdocsCore(projectDir);
  core.managers.workflow.setActiveInitiative('example-active');

  await core.commands.execute('initiative.done', { id: 'example-active' });

  expect(core.managers.workflow.status().activeInitiative).toBeNull();
});

test('directory-v2 initiative.archive moves whole folder to _archive', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-dirv2-archive-'));
  const fixtureRoot = path.resolve(__dirname, '../fixtures/directory-v2-mdocs');
  copyDir(fixtureRoot, projectDir);
  const core = createMdocsCore(projectDir);
  const initiativesDir = path.join(projectDir, 'mdocs', 'initiatives');
  const sourceDir = path.join(initiativesDir, 'example-complete');
  const targetDir = path.join(initiativesDir, '_archive', 'example-complete');
  fs.writeFileSync(path.join(sourceDir, 'artifact.txt'), 'preserved artifact', 'utf8');

  const result = await core.commands.execute('initiative.archive', { id: 'example-complete' });

  expect(result).toMatchObject({ success: true, id: 'example-complete', archivedFilename: 'example-complete' });
  expect(fs.existsSync(sourceDir)).toBe(false);
  expect(fs.existsSync(path.join(targetDir, '_status.md'))).toBe(true);
  expect(fs.readFileSync(path.join(targetDir, '_status.md'), 'utf8')).toContain('status: archived');
  expect(fs.readFileSync(path.join(targetDir, 'artifact.txt'), 'utf8')).toBe('preserved artifact');
  expect(core.managers.initiatives.findById('example-complete')).toBeNull();
  expect(core.managers.initiatives.list(true).some(initiative => initiative.id === 'example-complete')).toBe(true);
});

test('directory-v2 initiative.archive rejects active initiatives without moving folder', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-dirv2-archive-active-'));
  const fixtureRoot = path.resolve(__dirname, '../fixtures/directory-v2-mdocs');
  copyDir(fixtureRoot, projectDir);
  const core = createMdocsCore(projectDir);
  const initiativesDir = path.join(projectDir, 'mdocs', 'initiatives');

  const result = await core.commands.execute('initiative.archive', { id: 'example-active' });

  expect(result).toMatchObject({ error: 'Only completed initiatives can be archived: example-active' });
  expect(fs.existsSync(path.join(initiativesDir, 'example-active', '_status.md'))).toBe(true);
  expect(fs.existsSync(path.join(initiativesDir, '_archive', 'example-active'))).toBe(false);
});

test('directory-v2 root wiki index is searchable without generated index writes', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-dirv2-root-search-'));
  const fixtureRoot = path.resolve(__dirname, '../fixtures/directory-v2-mdocs');
  copyDir(fixtureRoot, projectDir);
  const wikiIndexPath = path.join(projectDir, 'mdocs', 'wiki', 'index.md');
  const before = fs.readFileSync(wikiIndexPath, 'utf8');
  const core = createMdocsCore(projectDir);

  const results = core.managers.search.query('Canonical lowercase index');

  expect(results.some(result => result.type === 'wiki' && result.id === 'index')).toBe(true);
  expect(fs.readFileSync(wikiIndexPath, 'utf8')).toBe(before);
  expect(exactChildExists(path.join(projectDir, 'mdocs', 'wiki'), 'INDEX.md')).toBe(false);
});

test('directory-v2 stable wiki sources satisfy complete initiative learning', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-dirv2-sources-'));
  const fixtureRoot = path.resolve(__dirname, '../fixtures/directory-v2-mdocs');
  copyDir(fixtureRoot, projectDir);
  fs.writeFileSync(path.join(projectDir, 'mdocs', 'wiki', 'complete-learning.md'), `---
id: complete-learning
title: Complete Learning
lifecycle: stable
sources: [example-complete]
tags: [compatibility]
---

Stable learning sourced from a complete directory initiative.
`, 'utf8');
  const core = createMdocsCore(projectDir);

  const validation = core.commands.validationResult();
  const graphWarnings = validation.graph.warnings.join('\n');

  expect(graphWarnings).not.toContain('Done initiative example-complete has no stable wiki learning');
});

test('directory-v2 detects optional obsidian visibility layer without indexing it', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-dirv2-obsidian-'));
  const fixtureRoot = path.resolve(__dirname, '../fixtures/directory-v2-mdocs');
  copyDir(fixtureRoot, projectDir);
  const mdocsRoot = path.join(projectDir, 'mdocs');

  const contract = detectMdocsContract(mdocsRoot, { obsidianRefreshCommand: 'ruby mdocs/scripts/obsidian_refresh.rb' });
  const core = createMdocsCore(projectDir, { compatibility: { obsidianRefreshCommand: 'ruby mdocs/scripts/obsidian_refresh.rb' } });
  const results = core.managers.search.query('visibility layer');

  expect(contract.obsidianVisibilityLayer).toBe(true);
  expect(contract.obsidianDir).toBe(path.join(mdocsRoot, '_obsidian'));
  expect(contract.obsidianRefreshCommand).toBe('ruby mdocs/scripts/obsidian_refresh.rb');
  expect(results.some(result => result.type === 'wiki' && result.id.includes('_obsidian'))).toBe(false);
});

test('contract defaults initiativeRecordMode to full', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-record-default-'));
  fs.mkdirSync(path.join(projectDir, 'mdocs', 'initiatives'), { recursive: true });

  const contract = detectMdocsContract(path.join(projectDir, 'mdocs'));

  expect(contract.initiativeRecordMode).toBe('full');
});

test('contract honors an explicit initiativeRecordMode override', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-record-override-'));
  fs.mkdirSync(path.join(projectDir, 'mdocs', 'initiatives'), { recursive: true });

  const contract = detectMdocsContract(path.join(projectDir, 'mdocs'), { initiativeRecordMode: 'metadata-only' });

  expect(contract.initiativeRecordMode).toBe('metadata-only');
});

test('createMdocsCore exposes the resolved contract', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-record-expose-'));
  fs.mkdirSync(path.join(projectDir, 'mdocs', 'initiatives'), { recursive: true });

  const core = createMdocsCore(projectDir);

  expect(core.contract).toBeDefined();
  expect(core.contract.initiativeRecordMode).toBe('full');
});
