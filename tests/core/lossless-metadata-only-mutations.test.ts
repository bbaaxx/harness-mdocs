import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createMdocsCore, MdocsCore } from '../../src/core';

function copyDir(source: string, target: string) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) copyDir(sourcePath, targetPath);
    else fs.copyFileSync(sourcePath, targetPath);
  }
}

function seedProject(prefix: string): { projectDir: string; core: MdocsCore } {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  copyDir(path.resolve(__dirname, '../fixtures/directory-v2-mdocs'), projectDir);
  const core = createMdocsCore(projectDir, { compatibility: { initiativeRecordMode: 'metadata-only' } });
  expect(core.contract.initiativeRecordMode).toBe('metadata-only');
  return { projectDir, core };
}

function statusPath(projectDir: string): string {
  return path.join(projectDir, 'mdocs', 'initiatives', 'example-active', '_status.md');
}

function writeConsumerPage(projectDir: string) {
  const filePath = path.join(projectDir, 'mdocs', 'wiki', 'systems', 'consumer-page.md');
  fs.writeFileSync(filePath, `---
id: systems/consumer-page
title: Consumer Page
category: system
created: 2026-01-01
updated: 2026-01-01
sources: [example-active]
status: complete
lifecycle: stable
custom_field: keep-me
tags: [compatibility]
---

Consumer body paragraph.
`, 'utf8');
  return filePath;
}

describe('issue #8 P0: lossless metadata-only wiki mutations', () => {
  // Acceptance test 1: updating a consumer page preserves unknown frontmatter
  // and body content.
  test('wiki.update preserves unknown frontmatter, consumer aliases, and body', async () => {
    const { projectDir, core } = seedProject('harness-mdocs-p0-lossless-');
    const filePath = writeConsumerPage(projectDir);

    const result = await core.commands.execute('wiki.update', {
      category: 'systems',
      id: 'consumer-page',
      content: 'New body.',
      related_initiatives: ['example-active']
    });

    expect(result).toMatchObject({ success: true, id: 'consumer-page' });
    expect(result.appliedFields).toEqual(expect.arrayContaining(['content', 'relatedInitiatives']));

    const raw = fs.readFileSync(filePath, 'utf8');
    expect(raw).toContain('custom_field: keep-me');
    expect(raw).toContain('sources: [example-active]');
    expect(raw).toContain('status: complete');
    expect(raw).toContain('id: systems/consumer-page');
    expect(raw).toContain('category: system');
    expect(raw).toContain('New body.');
    expect(raw).toContain('related_initiatives: ["example-active"]');

    const read = core.managers.wiki.read('systems', 'consumer-page');
    expect(read?.content).toBe('New body.');
    expect(read?.status).toBe('complete');
    expect(read?.sourceInitiatives).toEqual(['example-active']);
  });

  // Acceptance test 2: wiki.link persists both sides under metadata-only mode.
  test('wiki.link persists both sides under metadata-only mode', async () => {
    const { projectDir, core } = seedProject('harness-mdocs-p0-link-');
    const before = fs.readFileSync(statusPath(projectDir), 'utf8');
    expect(before).not.toContain('related_wiki');

    const result = await core.commands.execute('wiki.link', {
      initiativeId: 'example-active',
      wikiSlug: 'systems/system-page'
    });

    expect(result).toMatchObject({ success: true, bidirectional: true, initiativeId: 'example-active', wikiSlug: 'systems/system-page' });

    // Initiative side: related_wiki created surgically; body and other keys untouched.
    const after = fs.readFileSync(statusPath(projectDir), 'utf8');
    expect(after).toContain('related_wiki: ["systems/system-page"]');
    expect(after).toContain('Example directory-v2 initiative.');
    expect(after).toContain('tags: [compatibility]');

    // Wiki side: related_initiatives appended; consumer sources alias preserved.
    const wikiRaw = fs.readFileSync(path.join(projectDir, 'mdocs', 'wiki', 'systems', 'system-page.md'), 'utf8');
    expect(wikiRaw).toContain('related_initiatives: ["example-active"]');
    expect(wikiRaw).toContain('sources: [example-active]');
    expect(core.managers.wiki.read('systems', 'system-page')?.relatedInitiatives).toContain('example-active');

    // Idempotent re-link leaves the initiative file untouched.
    const beforeRelink = fs.readFileSync(statusPath(projectDir), 'utf8');
    const relink = await core.commands.execute('wiki.link', { initiativeId: 'example-active', wikiSlug: 'systems/system-page' });
    expect(relink).toMatchObject({ success: true, bidirectional: true });
    expect(fs.readFileSync(statusPath(projectDir), 'utf8')).toBe(beforeRelink);
  });

  // Acceptance test 3: page update preserves status, sources, path-style id,
  // consumer (singular) category — via wiki.ingest updatePage.
  test('wiki.ingest updatePage preserves status, sources, path-style id, and singular category', async () => {
    const { projectDir, core } = seedProject('harness-mdocs-p0-ingest-');
    const dir = path.join(projectDir, 'mdocs', 'wiki', 'initiative');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, 'example.md');
    fs.writeFileSync(filePath, `---
id: initiatives/example
title: Example Compiled
category: initiative
updated: 2026-01-01
sources: [example]
status: complete
lifecycle: stable
---

Compiled body.
`, 'utf8');

    const result: any = await core.commands.execute('wiki.ingest', {
      operations: [{ type: 'updatePage', category: 'initiative', id: 'example', content: 'Updated compiled body.' }]
    });

    expect(result.success).toBe(true);
    const op = result.operations[0];
    expect(op).toMatchObject({ type: 'updatePage', ok: true });
    expect(op.appliedFields).toContain('content');

    const raw = fs.readFileSync(filePath, 'utf8');
    expect(raw).toContain('id: initiatives/example');
    expect(raw).toContain('category: initiative');
    expect(raw).toContain('sources: [example]');
    expect(raw).toContain('status: complete');
    expect(raw).toContain('Updated compiled body.');
  });

  // Acceptance test 4: linking an initiative to its own compiled page creates
  // no self backlink.
  test('wiki.link to own compiled page is a provenance no-op', async () => {
    const { projectDir, core } = seedProject('harness-mdocs-p0-selflink-');
    const dir = path.join(projectDir, 'mdocs', 'wiki', 'initiatives');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, 'example-active.md');
    fs.writeFileSync(filePath, `---
id: initiatives/example-active
title: Example Active
category: initiatives
updated: 2026-01-01
status: active
---

Own compiled page.
`, 'utf8');

    const result = await core.commands.execute('wiki.link', {
      initiativeId: 'example-active',
      wikiSlug: 'initiatives/example-active'
    });

    expect(result).toMatchObject({ success: true, selfLink: true, skipped: 'own-compiled-page' });
    expect(result.bidirectional).not.toBe(true);

    // No self related_initiatives entry on the compiled page.
    expect(core.managers.wiki.read('initiatives', 'example-active')?.relatedInitiatives).not.toContain('example-active');
    // No related_wiki self-entry on the initiative status file.
    const raw = fs.readFileSync(statusPath(projectDir), 'utf8');
    expect(raw).not.toContain('related_wiki');
  });

  // Acceptance test 7: failure on the second half of a link leaves no partial
  // mutation (initiative side rolled back).
  test('wiki.link rolls back the initiative side when the wiki side fails', async () => {
    const { projectDir, core } = seedProject('harness-mdocs-p0-rollback-');
    const before = fs.readFileSync(statusPath(projectDir), 'utf8');
    const wikiPath = path.join(projectDir, 'mdocs', 'wiki', 'systems', 'system-page.md');
    const beforeWiki = fs.readFileSync(wikiPath, 'utf8');

    const spy = jest.spyOn(core.managers.wiki, 'addRelatedInitiativeByRef').mockImplementation(() => {
      throw new Error('simulated wiki-side failure');
    });

    const result = await core.commands.execute('wiki.link', {
      initiativeId: 'example-active',
      wikiSlug: 'systems/system-page'
    });

    expect(result.success).toBe(false);
    expect(result.bidirectional).not.toBe(true);
    expect(result.rolledBack).toBe(true);
    expect(fs.readFileSync(statusPath(projectDir), 'utf8')).toBe(before);
    expect(fs.readFileSync(wikiPath, 'utf8')).toBe(beforeWiki);
    expect(core.managers.initiatives.findById('example-active')?.relatedWiki).not.toContain('systems/system-page');

    spy.mockRestore();
  });

  // Acceptance test 8: unsupported update fields return explicit non-success.
  test('initiative.update rejects unsupported fields without writing', async () => {
    const { projectDir, core } = seedProject('harness-mdocs-p0-unsupported-');
    const before = fs.readFileSync(statusPath(projectDir), 'utf8');

    const result = await core.commands.execute('initiative.update', {
      id: 'example-active',
      updates: { objective: 'New objective', plan: ['Step 1'] }
    });

    expect(result.success).toBe(false);
    expect(result.unsupportedFields).toEqual(expect.arrayContaining(['objective', 'plan']));
    expect(fs.readFileSync(statusPath(projectDir), 'utf8')).toBe(before);
  });

  test('initiative.update reports skipped fields in metadata-only mode and persists lifecycle fields', async () => {
    const { projectDir, core } = seedProject('harness-mdocs-p0-skipped-');

    const result = await core.commands.execute('initiative.update', {
      id: 'example-active',
      updates: { status: 'paused', tags: ['new-tag'], related_wiki: ['systems/system-page'] },
      progressNote: 'progress note that will not persist'
    });

    expect(result).toMatchObject({ success: true, id: 'example-active' });
    expect(result.appliedFields).toContain('status');
    expect(result.skippedFields).toEqual(expect.arrayContaining(['tags', 'relatedWiki', 'progressNote']));

    const raw = fs.readFileSync(statusPath(projectDir), 'utf8');
    expect(raw).toContain('status: paused');
    expect(raw).not.toContain('new-tag');
    expect(raw).not.toContain('related_wiki');
    expect(raw).not.toContain('progress note');
    expect(raw).toContain('Example directory-v2 initiative.');
  });

  test('wiki.update rejects unknown fields without writing', async () => {
    const { projectDir, core } = seedProject('harness-mdocs-p0-wiki-unsupported-');
    const wikiPath = path.join(projectDir, 'mdocs', 'wiki', 'systems', 'system-page.md');
    const before = fs.readFileSync(wikiPath, 'utf8');

    const result = await core.commands.execute('wiki.update', {
      category: 'systems',
      id: 'system-page',
      bogus_field: 'nope'
    });

    expect(result.success).toBe(false);
    expect(result.unsupportedFields).toContain('bogus_field');
    expect(fs.readFileSync(wikiPath, 'utf8')).toBe(before);
  });

  // Acceptance test 9: every successful mutation passes a read-after-write
  // postcondition check (covered implicitly above; explicit here for the
  // initiative side).
  test('initiative.update lifecycle write reads back from disk (postcondition)', async () => {
    const { projectDir, core } = seedProject('harness-mdocs-p0-postcond-');

    const result = await core.commands.execute('initiative.update', {
      id: 'example-active',
      updates: { status: 'paused' }
    });

    expect(result).toMatchObject({ success: true });
    expect(result.appliedFields).toEqual(['status']);
    expect(core.managers.initiatives.findById('example-active')?.status).toBe('paused');
  });
});
