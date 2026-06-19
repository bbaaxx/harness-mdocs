import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createMdocsCore } from '../../src/core';

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

test('directory-v2 wiki.link accepts root wiki references', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-dirv2-root-link-'));
  const fixtureRoot = path.resolve(__dirname, '../fixtures/directory-v2-mdocs');
  copyDir(fixtureRoot, projectDir);
  const core = createMdocsCore(projectDir);
  const statusPath = path.join(projectDir, 'mdocs', 'initiatives', 'example-active', '_status.md');
  fs.writeFileSync(path.join(projectDir, 'mdocs', 'wiki', 'overview.md'), `---
id: overview
title: Overview
category: ""
created: 2026-01-01
updated: 2026-01-01
related_initiatives: []
tags: []
---

Root overview.
`, 'utf8');

  const result = await core.commands.execute('wiki.link', { initiativeId: 'example-active', wikiSlug: 'overview' });

  expect(result).toMatchObject({ success: true, wikiSlug: 'overview' });
  expect(core.managers.initiatives.findById('example-active')?.relatedWiki).toContain('overview');
  expect(core.managers.wiki.readByRef('overview')?.relatedInitiatives).toContain('example-active');
  expect(fs.readFileSync(statusPath, 'utf8')).toContain('overview');
  expect(core.commands.validationResult().valid).toBe(true);
});

test('directory-v2 root wiki commands create update delete without clobbering lowercase index', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-dirv2-root-write-'));
  const fixtureRoot = path.resolve(__dirname, '../fixtures/directory-v2-mdocs');
  copyDir(fixtureRoot, projectDir);
  const core = createMdocsCore(projectDir);
  const wikiIndexPath = path.join(projectDir, 'mdocs', 'wiki', 'index.md');
  const rootPath = path.join(projectDir, 'mdocs', 'wiki', 'overview.md');
  const beforeWikiIndex = fs.readFileSync(wikiIndexPath, 'utf8');

  const create = await core.commands.execute('wiki.create', { id: 'overview', title: 'Root Overview', content: 'Root overview body.', tags: ['compatibility'] });
  expect(fs.existsSync(rootPath)).toBe(true);
  const update = await core.commands.execute('wiki.update', { id: 'overview', content: 'Updated root overview body.', tags: ['compatibility', 'root'] });
  expect(fs.readFileSync(rootPath, 'utf8')).toContain('Updated root overview body.');
  const deleted = await core.commands.execute('wiki.delete', { id: 'overview' });

  expect(create).toMatchObject({ success: true, filename: 'overview.md', id: 'overview' });
  expect(update).toMatchObject({ success: true, filename: 'overview.md', id: 'overview' });
  expect(deleted).toMatchObject({ success: true, deletedFilename: 'overview.md' });
  expect(fs.existsSync(rootPath)).toBe(false);
  expect(fs.readFileSync(wikiIndexPath, 'utf8')).toBe(beforeWikiIndex);
  expect(exactChildExists(path.join(projectDir, 'mdocs', 'wiki'), 'INDEX.md')).toBe(false);
  expect(fs.existsSync(path.join(projectDir, 'mdocs', 'wiki', 'overview'))).toBe(false);
});

test('directory-v2 root wiki stub creates root file without replacing canonical index', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-dirv2-root-stub-'));
  const fixtureRoot = path.resolve(__dirname, '../fixtures/directory-v2-mdocs');
  copyDir(fixtureRoot, projectDir);
  const core = createMdocsCore(projectDir);
  const wikiIndexPath = path.join(projectDir, 'mdocs', 'wiki', 'index.md');
  const beforeWikiIndex = fs.readFileSync(wikiIndexPath, 'utf8');

  const result = await core.commands.execute('wiki.stub', { id: 'glossary', title: 'Glossary' });
  const again = await core.commands.execute('wiki.stub', { id: 'glossary', title: 'Glossary' });

  expect(result).toMatchObject({ success: true, id: 'glossary', filePath: 'wiki/glossary.md' });
  expect(again).toMatchObject({ success: false, existing: true });
  expect(core.managers.wiki.readByRef('glossary')?.title).toBe('Glossary');
  expect(fs.readFileSync(wikiIndexPath, 'utf8')).toBe(beforeWikiIndex);
  expect(exactChildExists(path.join(projectDir, 'mdocs', 'wiki'), 'INDEX.md')).toBe(false);
});

test('directory-v2 root wiki writes reject canonical index aliases', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-dirv2-root-index-'));
  const fixtureRoot = path.resolve(__dirname, '../fixtures/directory-v2-mdocs');
  copyDir(fixtureRoot, projectDir);
  const core = createMdocsCore(projectDir);
  const wikiIndexPath = path.join(projectDir, 'mdocs', 'wiki', 'index.md');
  const beforeWikiIndex = fs.readFileSync(wikiIndexPath, 'utf8');

  await expect(core.commands.execute('wiki.create', { id: 'INDEX', title: 'Bad Index' })).resolves.toMatchObject({ error: expect.stringContaining('canonical root wiki index') });
  await expect(core.commands.execute('wiki.link', { initiativeId: 'example-active', wikiSlug: 'index' })).resolves.toMatchObject({ error: expect.stringContaining('canonical root wiki index') });

  expect(fs.readFileSync(wikiIndexPath, 'utf8')).toBe(beforeWikiIndex);
  expect(exactChildExists(path.join(projectDir, 'mdocs', 'wiki'), 'INDEX.md')).toBe(false);
  expect(core.managers.initiatives.findById('example-active')?.relatedWiki).not.toContain('index');
});

test('directory-v2 wiki.link normalizes md suffixes before writing', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-dirv2-md-ref-'));
  const fixtureRoot = path.resolve(__dirname, '../fixtures/directory-v2-mdocs');
  copyDir(fixtureRoot, projectDir);
  const core = createMdocsCore(projectDir);
  fs.writeFileSync(path.join(projectDir, 'mdocs', 'wiki', 'overview.md'), `---
id: overview
title: Overview
category: ""
created: 2026-01-01
updated: 2026-01-01
related_initiatives: []
tags: []
---

Root overview.
`, 'utf8');

  const result = await core.commands.execute('wiki.link', { initiativeId: 'example-active', wikiSlug: 'overview.md' });

  expect(result).toMatchObject({ success: true, wikiSlug: 'overview' });
  expect(core.managers.initiatives.findById('example-active')?.relatedWiki).toContain('overview');
  expect(core.managers.initiatives.findById('example-active')?.relatedWiki).not.toContain('overview.md');
  expect(core.managers.wiki.readByRef('overview')?.relatedInitiatives).toContain('example-active');
});

test('directory-v2 wiki.link rejects empty path segments without side effects', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-dirv2-empty-ref-'));
  const fixtureRoot = path.resolve(__dirname, '../fixtures/directory-v2-mdocs');
  copyDir(fixtureRoot, projectDir);
  const core = createMdocsCore(projectDir);
  const statusPath = path.join(projectDir, 'mdocs', 'initiatives', 'example-active', '_status.md');
  const beforeStatus = fs.readFileSync(statusPath, 'utf8');

  await expect(core.commands.execute('wiki.link', { initiativeId: 'example-active', wikiSlug: 'overview/' })).resolves.toMatchObject({ error: expect.stringContaining('Invalid wikiSlug') });

  expect(fs.readFileSync(statusPath, 'utf8')).toBe(beforeStatus);
});
