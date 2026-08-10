import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createMdocsCore } from '../../src/core';

function copyDir(source: string, target: string) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

function setup() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-validation-'));
  copyDir(path.resolve(__dirname, '../fixtures/directory-v2-mdocs'), project);
  return { project, root: path.join(project, 'mdocs') };
}

function compiled(root: string, status = 'active', extra = '') {
  fs.mkdirSync(path.join(root, 'wiki', 'initiatives'), { recursive: true });
  fs.writeFileSync(path.join(root, 'wiki', 'initiatives', 'example-active.md'), `---
id: initiatives/example-active
title: Example Active
category: initiative
status: ${status}
related_initiatives: []
tags: []
---
${extra}`, 'utf8');
  fs.writeFileSync(path.join(root, 'wiki', 'index.md'), '# Wiki\n- [System](systems/system-page.md)\n- [Active](initiatives/example-active.md)\n', 'utf8');
  fs.writeFileSync(path.join(root, 'initiatives', 'INDEX.md'), '# Initiatives\n- [Active](example-active/_status.md)\n', 'utf8');
  fs.writeFileSync(path.join(root, 'wiki', 'overview.md'), '# Overview\n- [Active](initiatives/example-active.md)\n', 'utf8');
}

test('directory-v2 validation reports missing compiled page and external memberships', () => {
  const { project, root } = setup();
  fs.writeFileSync(path.join(root, 'wiki', 'orphan.md'), '---\nid: orphan\ntitle: Orphan\ncategory: ""\n---\n', 'utf8');
  const result = createMdocsCore(project).commands.validationResult();
  expect(result.initiatives.errors.join('\n')).toContain('missing compiled wiki page');
  expect(result.initiatives.errors.join('\n')).toContain('missing link to directory initiative');
  expect(result.wiki.errors.join('\n')).toContain('missing link to wiki page');
});

test('directory-v2 validation reports compiled status missing and mismatch', () => {
  const { project, root } = setup();
  compiled(root, 'paused');
  let errors = createMdocsCore(project).commands.validationResult().initiatives.errors.join('\n');
  expect(errors).toContain('does not match source status');
  compiled(root, '');
  errors = createMdocsCore(project).commands.validationResult().initiatives.errors.join('\n');
  expect(errors).toContain('missing status');
});

test('directory-v2 validation accepts canonical code-path index entries and status aliases', () => {
  const { project, root } = setup();
  compiled(root, 'on-hold');
  const statusPath = path.join(root, 'initiatives', 'example-active', '_status.md');
  fs.writeFileSync(statusPath, fs.readFileSync(statusPath, 'utf8').replace('status: active', 'status: blocked'), 'utf8');
  fs.writeFileSync(path.join(root, 'initiatives', 'INDEX.md'), '# Initiatives\n- `example-active/`\n', 'utf8');

  const errors = createMdocsCore(project).managers.initiatives.validate().errors.join('\n');
  expect(errors).not.toContain('missing link to directory initiative: example-active');
  expect(errors).not.toContain('does not match source status');
});

test('directory-v2 initiative index ignores unterminated code spans', () => {
  const { project, root } = setup();
  fs.writeFileSync(path.join(root, 'initiatives', 'INDEX.md'), '# Initiatives\n- `example-active/\n', 'utf8');

  expect(createMdocsCore(project).managers.initiatives.validate().errors.join('\n')).toContain('missing link to directory initiative: example-active');
});

test('directory-v2 validation accepts canonical backticked wiki paths but not prose', () => {
  const { project, root } = setup();
  compiled(root);
  fs.writeFileSync(path.join(root, 'wiki', 'index.md'), '# Wiki\n- [Overview](overview.md)\n- `systems/system-page.md`\n- `initiatives/example-active/`\n', 'utf8');
  expect(createMdocsCore(project).managers.wiki.validate().errors.join('\n')).not.toContain('missing link to wiki page');

  fs.writeFileSync(path.join(root, 'wiki', 'index.md'), '# Wiki\n- `system-page is documented here`\n- `initiatives/example-active`\n', 'utf8');
  expect(createMdocsCore(project).managers.wiki.validate().errors.join('\n')).toContain('missing link to wiki page: systems/system-page');

  fs.writeFileSync(path.join(root, 'wiki', 'index.md'), '# Wiki\n- `systems/system-page\n- `initiatives/example-active\n', 'utf8');
  expect(createMdocsCore(project).managers.wiki.validate().errors.join('\n')).toContain('missing link to wiki page: systems/system-page');
});

test('directory-v2 overview requires a category-qualified compiled-page link', () => {
  const { project, root } = setup();
  compiled(root);
  fs.writeFileSync(path.join(root, 'wiki', 'overview.md'), '# Overview\n- [Active](example-active.md)\n', 'utf8');

  expect(createMdocsCore(project).managers.initiatives.validate().errors.join('\n')).toContain('wiki/overview.md missing link to active initiative: example-active');
});

test('directory status records are validated by InitiativeManager', () => {
  const { project } = setup();
  const statusPath = path.join(project, 'mdocs', 'initiatives', 'example-active', '_status.md');
  fs.writeFileSync(statusPath, fs.readFileSync(statusPath, 'utf8').replace('id: example-active\n', ''), 'utf8');
  const errors = createMdocsCore(project).managers.initiatives.validate().errors.join('\n');
  expect(errors).toContain('example-active/_status.md missing id');
});

test('graph skips reciprocal provenance check but reports self-link integrity failures', () => {
  const { project, root } = setup();
  compiled(root, 'active', '');
  const compiledPath = path.join(root, 'wiki', 'initiatives', 'example-active.md');
  fs.writeFileSync(compiledPath, fs.readFileSync(compiledPath, 'utf8').replace('related_initiatives: []', 'related_initiatives: [example-active]'), 'utf8');
  const systemPath = path.join(root, 'wiki', 'systems', 'system-page.md');
  fs.writeFileSync(systemPath, fs.readFileSync(systemPath, 'utf8').replace('sources: [example-active]', 'related_wiki: [systems/system-page]'), 'utf8');
  const messages = createMdocsCore(project).commands.validationResult().graph.errors.join('\n');
  expect(messages).not.toContain('Initiative example-active missing reciprocal related_wiki link to initiative/example-active');
  expect(messages).toContain('Compiled initiative page initiatives/example-active has self related_initiatives reference');
  expect(messages).toContain('self related_wiki');
});

test('graph requires category-qualified reciprocal links and treats bare IDs as root pages', () => {
  const { project, root } = setup();
  compiled(root);
  const statusPath = path.join(root, 'initiatives', 'example-active', '_status.md');
  fs.writeFileSync(statusPath, fs.readFileSync(statusPath, 'utf8').replace('tags: [compatibility]', 'tags: [compatibility]\nrelated_wiki: [system-page]'), 'utf8');
  const systemPath = path.join(root, 'wiki', 'systems', 'system-page.md');
  fs.writeFileSync(systemPath, fs.readFileSync(systemPath, 'utf8').replace('sources: [example-active]', 'related_initiatives: [example-active]\nrelated_wiki: [system-page]'), 'utf8');

  const graph = createMdocsCore(project).commands.validationResult().graph;
  const messages = graph.errors.join('\n');
  expect(graph.warnings.join('\n')).toContain('Initiative example-active references missing wiki system-page');
  expect(messages).toContain('Initiative example-active missing reciprocal related_wiki link to systems/system-page');
  expect(messages).not.toContain('Wiki systems/system-page has self related_wiki reference');
});

test('graph uses physical category identity while accepting singular path-style refs', () => {
  const { project, root } = setup();
  compiled(root);
  const statusPath = path.join(root, 'initiatives', 'example-active', '_status.md');
  const systemPath = path.join(root, 'wiki', 'systems', 'system-page.md');
  fs.writeFileSync(statusPath, fs.readFileSync(statusPath, 'utf8').replace('tags: [compatibility]', 'tags: [compatibility]\nrelated_wiki: [system/system-page]'), 'utf8');
  fs.writeFileSync(systemPath, fs.readFileSync(systemPath, 'utf8')
    .replace('id: system-page', 'id: systems/system-page')
    .replace('category: systems', 'category: system')
    .replace('sources: [example-active]', 'related_initiatives: [example-active]'), 'utf8');

  const messages = createMdocsCore(project).commands.validationResult().graph.errors.join('\n');
  expect(messages).not.toContain('references missing wiki system/system-page');
  expect(messages).not.toContain('missing reciprocal related_wiki link to systems/system-page');
});

test('graph detects compiled-page self links through singular category aliases', () => {
  const { project, root } = setup();
  compiled(root);
  const compiledPath = path.join(root, 'wiki', 'initiatives', 'example-active.md');
  fs.writeFileSync(compiledPath, fs.readFileSync(compiledPath, 'utf8').replace('related_initiatives: []', 'related_wiki: [initiative/example-active]'), 'utf8');

  expect(createMdocsCore(project).commands.validationResult().graph.errors.join('\n')).toContain('Wiki initiatives/example-active has self related_wiki reference');
});

test('graph verifies reciprocal links for slugified initiative aliases', () => {
  const { project, root } = setup();
  const statusPath = path.join(root, 'initiatives', 'example-active', '_status.md');
  const systemPath = path.join(root, 'wiki', 'systems', 'system-page.md');
  fs.writeFileSync(statusPath, fs.readFileSync(statusPath, 'utf8').replace('tags: [compatibility]', 'tags: [compatibility]\naliases: [Example Legacy]'), 'utf8');
  fs.writeFileSync(systemPath, fs.readFileSync(systemPath, 'utf8').replace('sources: [example-active]', 'related_initiatives: [example-legacy]'), 'utf8');

  const messages = createMdocsCore(project).commands.validationResult().graph.errors.join('\n');
  expect(messages).toContain('Initiative example-active missing reciprocal related_wiki link to systems/system-page');
});

test('categorized wiki index entries require category-qualified destinations', () => {
  const { project, root } = setup();
  compiled(root);
  fs.writeFileSync(path.join(root, 'wiki', 'index.md'), '# Wiki\n- [Wrong category](other/system-page.md)\n- [Active](initiatives/example-active.md)\n', 'utf8');

  const errors = createMdocsCore(project).managers.wiki.validate().errors.join('\n');
  expect(errors).toContain('missing link to wiki page: systems/system-page');
});

test('wiki identity diagnostics allow consumer aliases and reject unsafe values', () => {
  const { project, root } = setup();
  compiled(root);
  let errors = createMdocsCore(project).managers.wiki.validate().errors.join('\n');
  expect(errors).not.toContain('initiatives/example-active.md raw id');
  fs.writeFileSync(path.join(root, 'wiki', 'systems', 'system-page.md'), fs.readFileSync(path.join(root, 'wiki', 'systems', 'system-page.md'), 'utf8').replace('id: system-page', 'id: wrong-id').replace('category: systems', 'category: wrong-category'), 'utf8');
  errors = createMdocsCore(project).managers.wiki.validate().errors.join('\n');
  expect(errors).toContain('raw id wrong-id');
  expect(errors).toContain('raw category wrong-category');
});

test('ingest aggregate failure and xref directionality are truthful', async () => {
  const { project } = setup();
  const core = createMdocsCore(project);
  const ingest = await core.commands.execute('wiki.ingest', { operations: [{ type: 'updatePage', category: 'systems', id: 'missing', content: 'x' }] });
  expect(ingest).toMatchObject({ success: false });
  core.managers.wiki.create({ category: 'systems', id: 'other', title: 'Other', created: '2026-01-01', updated: '2026-01-01', relatedInitiatives: [], tags: [], content: '' });
  const xref = await core.commands.execute('wiki.xref', { fromSlug: 'systems/system-page', toSlug: 'systems/other' });
  expect(xref).toMatchObject({ success: true, bidirectional: false });
});

test('xref rejects malformed and missing targets without writing a reference', async () => {
  const { project } = setup();
  const core = createMdocsCore(project);
  const malformed = await core.commands.execute('wiki.xref', { fromSlug: 'systems/system-page', toSlug: 'systems/missing/extra' });
  const missing = await core.commands.execute('wiki.xref', { fromSlug: 'systems/system-page', toSlug: 'systems/missing' });

  expect(malformed).toMatchObject({ success: false, error: expect.stringContaining('Invalid toSlug format') });
  expect(missing).toMatchObject({ success: false, error: 'Wiki target not found: systems/missing' });
  expect(core.managers.wiki.read('systems', 'system-page')?.relatedWiki || []).not.toContain('systems/missing');
});

test('wiki updates preserve raw identity and category values', async () => {
  const { project, root } = setup();
  const core = createMdocsCore(project);
  const page = path.join(root, 'wiki', 'systems', 'system-page.md');
  fs.writeFileSync(page, fs.readFileSync(page, 'utf8').replace('id: system-page', 'id: systems/system-page').replace('category: systems', 'category: system'), 'utf8');
  await expect(core.commands.execute('wiki.update', { category: 'systems', id: 'system-page', content: 'Updated.' })).resolves.toMatchObject({ success: true });
  await expect(core.commands.execute('wiki.ingest', { operations: [{ type: 'updatePage', category: 'systems', id: 'system-page', content: 'Updated again.' }] })).resolves.toMatchObject({ success: true });
  const content = fs.readFileSync(page, 'utf8');
  expect(content).toContain('id: systems/system-page');
  expect(content).toContain('category: system');
});
