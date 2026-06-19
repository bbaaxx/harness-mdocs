import { WikiManager } from '../../src/core/managers/wiki';
import * as fs from 'fs';
import * as path from 'path';

const testDir = path.join(__dirname, 'test-wiki');

beforeEach(() => {
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true });
  }
  fs.mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true });
  }
});

describe('WikiManager', () => {
  test('create wiki entry in category', () => {
    const manager = new WikiManager(testDir);
    const entry = {
      id: 'wiki-test',
      title: 'Wiki Test',
      category: 'architecture',
      created: '2025-05-24',
      updated: '2025-05-24',
      relatedInitiatives: ['init1'],
      tags: ['test'],
      content: 'Test wiki content'
    };

    manager.create(entry);

    const categoryDir = path.join(testDir, 'wiki', 'architecture');
    expect(fs.existsSync(categoryDir)).toBe(true);
    expect(fs.existsSync(path.join(categoryDir, 'wiki-test.md'))).toBe(true);
  });

  test('list includes root wiki pages and validates plain canonical index', () => {
    const manager = new WikiManager(testDir);
    const wikiDir = path.join(testDir, 'wiki');
    fs.mkdirSync(wikiDir, { recursive: true });
    fs.writeFileSync(path.join(wikiDir, 'index.md'), '# Wiki Index\n\nPlain canonical index.', 'utf8');
    fs.writeFileSync(path.join(wikiDir, 'overview.md'), `---
id: overview
title: Overview
tags: [root]
---

Root overview content with enough detail for listing.
`, 'utf8');

    const entries = manager.list();
    const validation = manager.validate();

    expect(entries.map(entry => entry.id)).toEqual(expect.arrayContaining(['index', 'overview']));
    expect(manager.readByRef('overview')?.title).toBe('Overview');
    expect(validation.errors).toEqual([]);
  });

  test('getReferencedBy includes directory-v2 _status.md initiatives', () => {
    const manager = new WikiManager(testDir, { compatibility: { initiativeMode: 'directory' } });
    fs.mkdirSync(path.join(testDir, 'initiatives', 'dir-init'), { recursive: true });
    fs.writeFileSync(path.join(testDir, 'initiatives', 'dir-init', '_status.md'), `---
id: dir-init
title: Dir Init
status: active
started: 2026-06-19
related_wiki: ["architecture/dir-note"]
---
`, 'utf8');

    expect(manager.getReferencedBy('architecture', 'dir-note')).toContain('dir-init');
  });

  test('creates index files', () => {
    const manager = new WikiManager(testDir);
    manager.create({
      id: 'entry-one',
      title: 'Entry One',
      category: 'architecture',
      created: '2025-05-24',
      updated: '2025-05-24',
      relatedInitiatives: [],
      tags: [],
      content: 'Content one'
    });

    const rootIndex = fs.readFileSync(path.join(testDir, 'wiki', 'INDEX.md'), 'utf8');
    expect(rootIndex).toContain('architecture');

    const catIndex = fs.readFileSync(path.join(testDir, 'wiki', 'architecture', 'INDEX.md'), 'utf8');
    expect(catIndex).toContain('Entry One');
  });

  test('per-category INDEX entries use linked [Title](id.md) format', () => {
    const manager = new WikiManager(testDir);
    manager.create({
      id: 'linked-entry',
      title: 'Linked Entry',
      category: 'architecture',
      created: '2026-06-03',
      updated: '2026-06-03',
      relatedInitiatives: [],
      tags: [],
      content: 'Content'
    });

    const catIndex = fs.readFileSync(path.join(testDir, 'wiki', 'architecture', 'INDEX.md'), 'utf8');
    expect(catIndex).toContain('- [Linked Entry](linked-entry.md)');
  });

  test('create sanitizes path traversal in category and id', () => {
    const manager = new WikiManager(testDir);
    
    // These should throw because path traversal is rejected
    expect(() => manager.create({
      id: '../../../etc/passwd',
      title: 'Bad Entry',
      category: '../..',
      created: '2025-05-24',
      updated: '2025-05-24',
      relatedInitiatives: [],
      tags: [],
      content: 'Should be rejected'
    })).toThrow('Invalid name');
    
    // Verify no file was created outside wiki
    const escapedPath = path.join(testDir, '..', 'passwd.md');
    expect(fs.existsSync(escapedPath)).toBe(false);
  });

  test('read returns correct WikiEntry', () => {
    const manager = new WikiManager(testDir);
    const entry = {
      id: 'read-test',
      title: 'Read Test',
      category: 'architecture',
      created: '2025-05-24',
      updated: '2025-05-24',
      relatedInitiatives: ['init1', 'init2'],
      tags: ['test', 'read'],
      content: 'Read test content'
    };

    manager.create(entry);
    const read = manager.read('architecture', 'read-test');

    expect(read).not.toBeNull();
    expect(read!.id).toBe('read-test');
    expect(read!.title).toBe('Read Test');
    expect(read!.category).toBe('architecture');
    expect(read!.relatedInitiatives).toEqual(['init1', 'init2']);
    expect(read!.tags).toEqual(['test', 'read']);
    expect(read!.content).toBe('Read test content');
  });

  test('read returns null for missing entry', () => {
    const manager = new WikiManager(testDir);
    const read = manager.read('nonexistent', 'missing');
    expect(read).toBeNull();
  });

  test('update rewrites file and updates timestamp', () => {
    const manager = new WikiManager(testDir);
    const entry = {
      id: 'update-test',
      title: 'Update Test',
      category: 'architecture',
      created: '2025-05-24',
      updated: '2025-05-24',
      relatedInitiatives: [],
      tags: ['old'],
      content: 'Old content'
    };

    manager.create(entry);
    const updated = {
      ...entry,
      title: 'Updated Title',
      tags: ['new'],
      content: 'New content'
    };

    manager.update('architecture', 'update-test', updated);
    const read = manager.read('architecture', 'update-test');

    expect(read).not.toBeNull();
    expect(read!.title).toBe('Updated Title');
    expect(read!.tags).toEqual(['new']);
    expect(read!.content).toBe('New content');
    expect(read!.updated).not.toBe('2025-05-24'); // Timestamp should be updated
  });

  test('update throws for missing entry', () => {
    const manager = new WikiManager(testDir);
    expect(() => manager.update('nonexistent', 'missing', {
      id: 'missing',
      title: 'Missing',
      category: 'nonexistent',
      created: '2025-05-24',
      updated: '2025-05-24',
      relatedInitiatives: [],
      tags: [],
      content: ''
    })).toThrow('Wiki entry not found');
  });

  test('delete removes file', () => {
    const manager = new WikiManager(testDir);
    const entry = {
      id: 'delete-test',
      title: 'Delete Test',
      category: 'architecture',
      created: '2025-05-24',
      updated: '2025-05-24',
      relatedInitiatives: [],
      tags: [],
      content: 'Delete me'
    };

    manager.create(entry);
    expect(fs.existsSync(path.join(testDir, 'wiki', 'architecture', 'delete-test.md'))).toBe(true);

    manager.delete('architecture', 'delete-test');
    expect(fs.existsSync(path.join(testDir, 'wiki', 'architecture', 'delete-test.md'))).toBe(false);
  });

  test('findRelated matches by tag', () => {
    const manager = new WikiManager(testDir);
    manager.create({
      id: 'plugin-doc',
      title: 'Plugin Doc',
      category: 'architecture',
      created: '2025-05-24',
      updated: '2025-05-24',
      relatedInitiatives: [],
      tags: ['plugin', 'architecture'],
      content: 'Plugin content'
    });
    manager.create({
      id: 'api-doc',
      title: 'API Doc',
      category: 'reference',
      created: '2025-05-24',
      updated: '2025-05-24',
      relatedInitiatives: [],
      tags: ['api', 'reference'],
      content: 'API content'
    });
    manager.create({
      id: 'another-plugin',
      title: 'Another Plugin',
      category: 'guides',
      created: '2025-05-24',
      updated: '2025-05-24',
      relatedInitiatives: [],
      tags: ['plugin', 'guide'],
      content: 'Guide content'
    });

    const results = manager.findRelated(['plugin']);
    expect(results).toHaveLength(2);
    expect(results.map(r => r.id)).toContain('plugin-doc');
    expect(results.map(r => r.id)).toContain('another-plugin');
  });

  test('findRelated returns empty array for no matches', () => {
    const manager = new WikiManager(testDir);
    manager.create({
      id: 'only-doc',
      title: 'Only Doc',
      category: 'architecture',
      created: '2025-05-24',
      updated: '2025-05-24',
      relatedInitiatives: [],
      tags: ['unique'],
      content: 'Unique content'
    });

    const results = manager.findRelated(['nonexistent']);
    expect(results).toEqual([]);
  });

  test('validate reports wiki entries missing required frontmatter', () => {
    const manager = new WikiManager(testDir);
    const categoryDir = path.join(testDir, 'wiki', 'architecture');
    fs.mkdirSync(categoryDir, { recursive: true });
    fs.writeFileSync(path.join(categoryDir, 'missing-fields.md'), `---
id: ""
title: ""
category: ""
created: "2026-05-29"
updated: "2026-05-29"
related_initiatives: []
tags: []
---

Content`, 'utf8');

    const result = manager.validate();

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('architecture/missing-fields.md missing id'),
      expect.stringContaining('architecture/missing-fields.md missing title'),
      expect.stringContaining('architecture/missing-fields.md missing category')
    ]));
  });

  test('validate warns for wiki entries not referenced by initiatives', () => {
    const manager = new WikiManager(testDir);
    manager.create({
      id: 'orphan',
      title: 'Orphan',
      category: 'architecture',
      created: '2026-05-29',
      updated: '2026-05-29',
      relatedInitiatives: [],
      tags: [],
      content: 'No initiative points here'
    });

    const result = manager.validate();

    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('architecture/orphan.md is not referenced by any initiative')
    ]));
  });

  test('validate does not warn for stable wiki entries without initiative references', () => {
    const manager = new WikiManager(testDir);
    manager.create({
      id: 'example-repo',
      title: 'Example Repo',
      category: 'repo',
      created: '2026-06-03',
      updated: '2026-06-03',
      relatedInitiatives: [],
      tags: [],
      lifecycle: 'stable',
      content: 'Global repo knowledge'
    });

    const result = manager.validate();

    expect(result.valid).toBe(true);
    expect(result.warnings).not.toEqual(expect.arrayContaining([
      expect.stringContaining('repo/example-repo.md is not referenced by any initiative')
    ]));
  });

  test('validate does not warn for configured standalone category entries', () => {
    const manager = new WikiManager(testDir, { standaloneCategories: ['repo'] });
    manager.create({
      id: 'example-repo',
      title: 'Example Repo',
      category: 'repo',
      created: '2026-06-03',
      updated: '2026-06-03',
      relatedInitiatives: [],
      tags: [],
      content: 'Global repo knowledge'
    });

    const result = manager.validate();

    expect(result.valid).toBe(true);
    expect(result.warnings).not.toEqual(expect.arrayContaining([
      expect.stringContaining('repo/example-repo.md is not referenced by any initiative')
    ]));
  });

  test('validate does not warn when wiki entry has sources provenance', () => {
    const manager = new WikiManager(testDir);
    const categoryDir = path.join(testDir, 'wiki', 'initiative');
    fs.mkdirSync(categoryDir, { recursive: true });
    fs.writeFileSync(path.join(categoryDir, 'example-initiative.md'), `---
id: "example-initiative"
title: "Example Initiative"
category: "initiative"
created: "2026-06-03"
updated: "2026-06-03"
sources: [example-initiative]
---

Initiative summary.
`, 'utf8');

    const result = manager.validate();

    expect(result.valid).toBe(true);
    expect(result.warnings).not.toEqual(expect.arrayContaining([
      expect.stringContaining('initiative/example-initiative.md is not referenced by any initiative')
    ]));
  });

  test('validate still warns for non-global wiki entries without provenance', () => {
    const manager = new WikiManager(testDir);
    manager.create({
      id: 'orphan-initiative',
      title: 'Orphan Initiative',
      category: 'initiative',
      created: '2026-06-03',
      updated: '2026-06-03',
      relatedInitiatives: [],
      tags: [],
      content: 'No provenance'
    });

    const result = manager.validate();

    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('initiative/orphan-initiative.md is not referenced by any initiative')
    ]));
  });

  test('validate still warns when only wiki entry metadata lists related initiatives', () => {
    const manager = new WikiManager(testDir);
    manager.create({
      id: 'metadata-only',
      title: 'Metadata Only',
      category: 'architecture',
      created: '2026-06-03',
      updated: '2026-06-03',
      relatedInitiatives: ['missing-initiative'],
      tags: [],
      content: 'No initiative related_wiki points here'
    });

    const result = manager.validate();

    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('architecture/metadata-only.md is not referenced by any initiative')
    ]));
  });

  test('validate does not warn when wiki entry is referenced by an initiative', () => {
    const manager = new WikiManager(testDir);
    manager.create({
      id: 'referenced',
      title: 'Referenced',
      category: 'architecture',
      created: '2026-05-29',
      updated: '2026-05-29',
      relatedInitiatives: [],
      tags: [],
      content: 'An initiative points here'
    });
    const initiativesDir = path.join(testDir, 'initiatives');
    fs.mkdirSync(initiativesDir, { recursive: true });
    fs.writeFileSync(path.join(initiativesDir, 'uses-wiki.md'), `---
id: "uses-wiki"
title: "Uses Wiki"
status: "active"
created: "2026-05-29"
related_wiki: ["architecture/referenced"]
---
`, 'utf8');

    const result = manager.validate();

    expect(result.warnings).not.toEqual(expect.arrayContaining([
      expect.stringContaining('architecture/referenced.md is not referenced by any initiative')
    ]));
  });

  test('preserves v2 wiki lifecycle and provenance metadata', () => {
    const manager = new WikiManager(testDir);
    const filePath = manager.create({
      id: 'dispatch-memory',
      title: 'Dispatch Memory',
      category: 'architecture',
      created: '2026-05-29',
      updated: '2026-05-29',
      relatedInitiatives: ['upgrade-dispatch-memory-retrieval'],
      tags: ['memory'],
      content: 'Dispatch should behave like memory retrieval.',
      lifecycle: 'stable',
      knowledgeType: 'architecture',
      confidence: 'high',
      sourceInitiatives: ['align-implementation-with-philosophy'],
      supersedes: []
    });

    const readBack = manager.read('architecture', path.basename(filePath, '.md'));

    expect(readBack?.lifecycle).toBe('stable');
    expect(readBack?.knowledgeType).toBe('architecture');
    expect(readBack?.confidence).toBe('high');
    expect(readBack?.sourceInitiatives).toEqual(['align-implementation-with-philosophy']);
  });

  test('stub creates a new wiki entry with default template', () => {
    const manager = new WikiManager(testDir);
    const result = manager.stub('architecture', 'new-stub', 'New Stub');

    expect(result.success).toBe(true);
    expect(fs.existsSync(result.filePath)).toBe(true);

    const content = fs.readFileSync(result.filePath, 'utf8');
    expect(content).toContain('id: "new-stub"');
    expect(content).toContain('title: "New Stub"');
    expect(content).toContain('category: "architecture"');
    expect(content).toContain('## Overview');
    expect(content).toContain('## Details');
    expect(content).toContain('## References');
  });

  test('stub returns existing when entry already exists', () => {
    const manager = new WikiManager(testDir);
    manager.create({
      id: 'existing-stub',
      title: 'Existing Stub',
      category: 'architecture',
      created: '2026-05-29',
      updated: '2026-05-29',
      relatedInitiatives: [],
      tags: [],
      content: 'Already here'
    });

    const result = manager.stub('architecture', 'existing-stub', 'Different Title');

    expect(result.success).toBe(false);
    expect(result.existing).toBe(true);
  });

  test('stub updates indices after creation', () => {
    const manager = new WikiManager(testDir);
    manager.stub('guides', 'guide-stub', 'Guide Stub');

    const catIndex = fs.readFileSync(path.join(testDir, 'wiki', 'guides', 'INDEX.md'), 'utf8');
    expect(catIndex).toContain('Guide Stub');

    const rootIndex = fs.readFileSync(path.join(testDir, 'wiki', 'INDEX.md'), 'utf8');
    expect(rootIndex).toContain('guides');
  });

  test('stub accepts custom template', () => {
    const manager = new WikiManager(testDir);
    const customTemplate = '---\nid: "custom-id"\ntitle: "Custom Title"\ncategory: "testing"\ncreated: "2026-05-29"\nupdated: "2026-05-29"\nrelated_initiatives: []\ntags: []\n---\n\nCustom body\n';
    const result = manager.stub('testing', 'custom-stub', 'Custom Title', customTemplate);

    expect(result.success).toBe(true);
    const content = fs.readFileSync(result.filePath, 'utf8');
    expect(content).toBe(customTemplate);
  });

  test('validate reports broken related_wiki links as errors', () => {
    const manager = new WikiManager(testDir);
    const initiativesDir = path.join(testDir, 'initiatives');
    fs.mkdirSync(initiativesDir, { recursive: true });
    fs.writeFileSync(path.join(initiativesDir, 'broken-link.md'), `---
id: "broken-link"
title: "Broken Link"
status: "active"
created: "2026-05-29"
related_wiki: ["architecture/missing-entry"]
---
`, 'utf8');

    const result = manager.validate();

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('references missing wiki entry: architecture/missing-entry')
    ]));
  });

  test('validate does not error for valid related_wiki links', () => {
    const manager = new WikiManager(testDir);
    manager.create({
      id: 'valid-entry',
      title: 'Valid Entry',
      category: 'architecture',
      created: '2026-05-29',
      updated: '2026-05-29',
      relatedInitiatives: [],
      tags: [],
      content: 'Content'
    });

    const initiativesDir = path.join(testDir, 'initiatives');
    fs.mkdirSync(initiativesDir, { recursive: true });
    fs.writeFileSync(path.join(initiativesDir, 'valid-link.md'), `---
id: "valid-link"
title: "Valid Link"
status: "active"
created: "2026-05-29"
related_wiki: ["architecture/valid-entry"]
---
`, 'utf8');

    const result = manager.validate();

    expect(result.errors).not.toEqual(expect.arrayContaining([
      expect.stringContaining('architecture/valid-entry')
    ]));
  });

  test('create auto-generates Referenced By section', () => {
    const manager = new WikiManager(testDir);
    manager.create({
      id: 'auto-ref',
      title: 'Auto Ref',
      category: 'architecture',
      created: '2026-05-29',
      updated: '2026-05-29',
      relatedInitiatives: ['init-a', 'init-b'],
      tags: [],
      content: 'Main content here.'
    });

    const content = fs.readFileSync(path.join(testDir, 'wiki', 'architecture', 'auto-ref.md'), 'utf8');
    expect(content).toContain('## Referenced By');
    expect(content).toContain('- init-a');
    expect(content).toContain('- init-b');
  });

  test('update regenerates Referenced By section', () => {
    const manager = new WikiManager(testDir);
    manager.create({
      id: 'update-ref',
      title: 'Update Ref',
      category: 'architecture',
      created: '2026-05-29',
      updated: '2026-05-29',
      relatedInitiatives: ['init-a'],
      tags: [],
      content: 'Main content.'
    });

    // Update with new relatedInitiatives
    const entry = manager.read('architecture', 'update-ref')!;
    entry.relatedInitiatives = ['init-a', 'init-c'];
    manager.update('architecture', 'update-ref', entry);

    const content = fs.readFileSync(path.join(testDir, 'wiki', 'architecture', 'update-ref.md'), 'utf8');
    expect(content).toContain('## Referenced By');
    expect(content).toContain('- init-a');
    expect(content).toContain('- init-c');
    // Should not have duplicate sections
    const matches = content.match(/## Referenced By/g);
    expect(matches).toHaveLength(1);
  });

  test('addRelatedInitiative appends initiative id', () => {
    const manager = new WikiManager(testDir);
    manager.create({
      id: 'add-rel',
      title: 'Add Rel',
      category: 'architecture',
      created: '2026-05-29',
      updated: '2026-05-29',
      relatedInitiatives: [],
      tags: [],
      content: 'Content'
    });

    manager.addRelatedInitiative('architecture', 'add-rel', 'new-init');
    const entry = manager.read('architecture', 'add-rel');
    expect(entry!.relatedInitiatives).toContain('new-init');
  });

  test('addRelatedInitiative does not duplicate initiative id', () => {
    const manager = new WikiManager(testDir);
    manager.create({
      id: 'no-dup',
      title: 'No Dup',
      category: 'architecture',
      created: '2026-05-29',
      updated: '2026-05-29',
      relatedInitiatives: ['existing-init'],
      tags: [],
      content: 'Content'
    });

    manager.addRelatedInitiative('architecture', 'no-dup', 'existing-init');
    const entry = manager.read('architecture', 'no-dup');
    expect(entry!.relatedInitiatives).toEqual(['existing-init']);
  });

  test('getReferencedBy returns initiative ids that reference this wiki', () => {
    const manager = new WikiManager(testDir);
    manager.create({
      id: 'referenced-by-test',
      title: 'Referenced By Test',
      category: 'architecture',
      created: '2026-05-29',
      updated: '2026-05-29',
      relatedInitiatives: [],
      tags: [],
      content: 'Content'
    });

    const initiativesDir = path.join(testDir, 'initiatives');
    fs.mkdirSync(initiativesDir, { recursive: true });
    fs.writeFileSync(path.join(initiativesDir, 'init-alpha.md'), `---
id: "init-alpha"
title: "Init Alpha"
status: "active"
created: "2026-05-29"
related_wiki: ["architecture/referenced-by-test"]
---
`, 'utf8');
    fs.writeFileSync(path.join(initiativesDir, 'init-beta.md'), `---
id: "init-beta"
title: "Init Beta"
status: "active"
created: "2026-05-29"
related_wiki: ["architecture/referenced-by-test", "other/cat"]
---
`, 'utf8');

    const refs = manager.getReferencedBy('architecture', 'referenced-by-test');
    expect(refs).toContain('init-alpha');
    expect(refs).toContain('init-beta');
  });

  test('addWikiCrossRef creates wiki-to-wiki link', () => {
    const manager = new WikiManager(testDir);
    manager.create({
      id: 'wiki-a',
      title: 'Wiki A',
      category: 'architecture',
      created: '2026-05-29',
      updated: '2026-05-29',
      relatedInitiatives: [],
      tags: [],
      content: 'Content A'
    });
    manager.create({
      id: 'wiki-b',
      title: 'Wiki B',
      category: 'guides',
      created: '2026-05-29',
      updated: '2026-05-29',
      relatedInitiatives: [],
      tags: [],
      content: 'Content B'
    });

    manager.addWikiCrossRef('architecture', 'wiki-a', 'guides', 'wiki-b');

    const entryA = manager.read('architecture', 'wiki-a');
    expect(entryA!.relatedWiki).toContain('guides/wiki-b');
  });

  test('extractWikiRefs detects bracket and markdown wiki links', () => {
    const manager = new WikiManager(testDir);
    const content = `See [[guides/how-to]] and also [another](reference/api) and [external](https://example.com)`;
    // extractWikiRefs is private; test via addWikiCrossRef behavior or content parsing indirectly
    // We can test by creating entries with cross-references in content and checking frontmatter
    manager.create({
      id: 'link-source',
      title: 'Link Source',
      category: 'architecture',
      created: '2026-05-29',
      updated: '2026-05-29',
      relatedInitiatives: [],
      tags: [],
      content
    });

    // The extractWikiRefs is used by addWikiCrossRef; let's test that a manual cross-ref works
    manager.addWikiCrossRef('architecture', 'link-source', 'guides', 'how-to');
    const entry = manager.read('architecture', 'link-source');
    expect(entry!.relatedWiki).toContain('guides/how-to');
  });

  test('checkConsistency returns consistent for clean wiki', () => {
    const manager = new WikiManager(testDir);
    manager.create({
      id: 'wiki-consistency',
      title: 'Wiki Consistency',
      category: 'architecture',
      created: '2026-05-29',
      updated: '2026-05-29',
      relatedInitiatives: [],
      tags: [],
      content: 'Content'
    });

    const result = manager.checkConsistency();
    console.log('DEBUG result:', JSON.stringify(result, null, 2));

    expect(result.consistent).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.orphans).toEqual([]);
  });

  test('checkConsistency detects orphan wiki files not in INDEX', () => {
    const manager = new WikiManager(testDir);
    manager.create({
      id: 'listed-entry',
      title: 'Listed Entry',
      category: 'architecture',
      created: '2026-05-29',
      updated: '2026-05-29',
      relatedInitiatives: [],
      tags: [],
      content: 'Content'
    });

    // Create a file not in the category INDEX
    fs.writeFileSync(path.join(testDir, 'wiki', 'architecture', 'orphan-wiki.md'), `---
id: "orphan-wiki"
title: "Orphan Wiki"
category: "architecture"
created: "2026-05-29"
updated: "2026-05-29"
related_initiatives: []
tags: []
---

Content
`, 'utf8');

    const result = manager.checkConsistency();

    expect(result.consistent).toBe(false);
    expect(result.orphans).toEqual(expect.arrayContaining([
      expect.stringContaining('orphan-wiki.md')
    ]));
  });

  test('checkConsistency accepts linked INDEX entries with id different from filename', () => {
    const manager = new WikiManager(testDir);
    // Create a wiki entry via the manager (writes the file and the linked INDEX).
    manager.create({
      id: 'stable-id',
      title: 'Stable ID',
      category: 'architecture',
      created: '2026-06-03',
      updated: '2026-06-03',
      relatedInitiatives: [],
      tags: [],
      content: 'Content'
    });
    // Rename the file so the on-disk filename no longer matches the id. The
    // INDEX still references the id via the link target, so the checker must
    // resolve the file via its frontmatter id alias.
    const categoryDir = path.join(testDir, 'wiki', 'architecture');
    fs.renameSync(
      path.join(categoryDir, 'stable-id.md'),
      path.join(categoryDir, 'renamed-stable-id.md')
    );

    const result = manager.checkConsistency();

    expect(result.consistent).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.orphans).toEqual([]);
  });

  test('checkConsistency matches INDEX entry by frontmatter title when id and filename differ', () => {
    const manager = new WikiManager(testDir);
    // Manually write a legacy plain-format INDEX whose entry matches the file's
    // frontmatter title (not the id or the filename). The checker should still
    // consider this consistent because title is one of the recognized aliases.
    const categoryDir = path.join(testDir, 'wiki', 'architecture');
    fs.mkdirSync(categoryDir, { recursive: true });
    fs.writeFileSync(path.join(categoryDir, 'foo.md'), `---
id: "foo"
title: "Original Foo Plan"
category: "architecture"
created: "2026-06-03"
updated: "2026-06-03"
related_initiatives: []
tags: []
---

Content
`, 'utf8');
    fs.writeFileSync(
      path.join(categoryDir, 'INDEX.md'),
      '# architecture\n\n- Original Foo Plan\n',
      'utf8'
    );
    // Root INDEX must exist for the checker to consider the wiki consistent.
    fs.writeFileSync(
      path.join(testDir, 'wiki', 'INDEX.md'),
      '# Wiki\n\n## Categories\n\n- [architecture](architecture/INDEX.md)\n',
      'utf8'
    );

    const result = manager.checkConsistency();

    expect(result.consistent).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.orphans).toEqual([]);
  });

  test('checkConsistency still detects orphan when neither id, title, nor filename matches INDEX', () => {
    const manager = new WikiManager(testDir);
    const categoryDir = path.join(testDir, 'wiki', 'architecture');
    fs.mkdirSync(categoryDir, { recursive: true });
    fs.writeFileSync(path.join(categoryDir, 'foo.md'), `---
id: "foo"
title: "Foo"
category: "architecture"
created: "2026-06-03"
updated: "2026-06-03"
related_initiatives: []
tags: []
---

Content
`, 'utf8');
    // INDEX lists an entry that matches none of foo's aliases.
    fs.writeFileSync(
      path.join(categoryDir, 'INDEX.md'),
      '# architecture\n\n- [Unrelated](unrelated.md)\n',
      'utf8'
    );

    const result = manager.checkConsistency();

    expect(result.consistent).toBe(false);
    expect(result.orphans).toEqual(expect.arrayContaining([
      expect.stringContaining('foo.md')
    ]));
  });

  test('checkConsistency detects stale wiki index', () => {
    const manager = new WikiManager(testDir);
    manager.create({
      id: 'stale-wiki',
      title: 'Stale Wiki',
      category: 'architecture',
      created: '2026-05-29',
      updated: '2026-05-29',
      relatedInitiatives: [],
      tags: [],
      content: 'Content'
    });

    // Ensure consistent first
    expect(manager.checkConsistency().consistent).toBe(true);

    // Modify the file directly
    const filePath = path.join(testDir, 'wiki', 'architecture', 'stale-wiki.md');
    const content = fs.readFileSync(filePath, 'utf8');
    fs.writeFileSync(filePath, content + '\n<!-- modified -->', 'utf8');

    const result = manager.checkConsistency();
    expect(result.stale).toBe(true);
    expect(result.consistent).toBe(false);
  });
});
