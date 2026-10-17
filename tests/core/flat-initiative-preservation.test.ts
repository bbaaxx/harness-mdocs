import fs = require('fs');
import * as os from 'os';
import * as path from 'path';
import { createMdocsCore } from '../../src/core';

describe('issue #11: lossless flat initiative mutations', () => {
  let project: string;
  let file: string;
  let original: string;
  const filename = 'research--2026-10-15.md';
  const id = 'research--2026-10-15';
  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'mdocs-flat-preserve-'));
    fs.mkdirSync(path.join(project, 'mdocs', 'initiatives'), { recursive: true });
    file = path.join(project, 'mdocs', 'initiatives', filename);
    original = `---
id: "${id}"
title: Research
status: active
created: 2026-10-15
updated: 2026-10-15
owner: researcher
tags: [research]
related_wiki: []
custom: keep-me
custom_block: |
  durable metadata
---

## Direction
Durable context.

## Objective
Investigate.

## Plan
- [ ] First step
  wrapped plan detail
  - nested step

## Progress Log
- Prior finding
  wrapped progress detail

## Considered and set aside
Keep this too.

\`\`\`markdown
## Progress Log
Not a real section.
\`\`\`

## Artifacts
- report.md
  artifact detail
`;
    fs.writeFileSync(file, original);
  });
  afterEach(() => fs.rmSync(project, { recursive: true, force: true }));

  test.each(['\n', '\r\n'])('metadata update preserves body, unknown keys and filename (%j)', async newline => {
    original = original.replace(/\n/g, newline);
    fs.writeFileSync(file, original);
    const core = createMdocsCore(project);
    const result = await core.commands.execute('initiative.update', { id, updates: { owner: 'coordinator' } });
    expect(result).toMatchObject({ success: true, filename });
    expect(fs.readFileSync(file, 'utf8')).toBe(original.replace('owner: researcher', 'owner: "coordinator"')
      .replace('updated: 2026-10-15', `updated: "${new Date().toISOString().slice(0, 10)}"`));
    expect(core.managers.initiatives.findById(id)?.plan[0].description).toContain('wrapped plan detail\n  - nested step');
  });

  test('progress append preserves existing multiline entries and following sections', async () => {
    const core = createMdocsCore(project);
    expect(await core.commands.execute('initiative.update', { id, progressNote: 'New finding\n  more detail' })).toMatchObject({ success: true });
    const after = fs.readFileSync(file, 'utf8');
    expect(after).toContain('- Prior finding\n  wrapped progress detail\n- New finding\n  more detail\n\n## Considered');
    expect(after).toContain('custom_block: |\n  durable metadata');
    expect(core.managers.initiatives.read(filename)?.progressLog).toEqual(['Prior finding\n  wrapped progress detail', 'New finding\n  more detail']);
  });

  test('lazy continuations and fenced bullets remain part of their list item', () => {
    const source = original.replace('  wrapped progress detail', 'lazy continuation\n  ```markdown\n- code, not a second note\n  ```');
    fs.writeFileSync(file, source);
    const core = createMdocsCore(project);
    expect(core.managers.initiatives.read(filename)?.progressLog).toEqual(['Prior finding\nlazy continuation\n  ```markdown\n- code, not a second note\n  ```']);
    expect(core.managers.initiatives.findById(id)?.progressLog).toEqual(core.managers.initiatives.read(filename)?.progressLog);
  });

  test('frontmatter field change preserves blank separators after that field', async () => {
    const source = original.replace('owner: researcher\n', 'owner: researcher\n\n');
    fs.writeFileSync(file, source);
    await createMdocsCore(project).commands.execute('initiative.update', { id, updates: { owner: 'coordinator' } });
    expect(fs.readFileSync(file, 'utf8')).toContain('owner: "coordinator"\n\ntags: [research]');
  });

  test('manager API replaces only explicitly changed known sections', () => {
    const manager = createMdocsCore(project).managers.initiatives;
    const initiative = manager.read(filename)!;
    initiative.objective = 'New objective.';
    initiative.plan[0].status = 'done';
    manager.update(filename, initiative);
    expect(fs.readFileSync(file, 'utf8')).toBe(original.replace('Investigate.', 'New objective.').replace('- [ ] First step', '- [x] First step'));
  });

  test('completion, graduation and wiki linking preserve rich context', async () => {
    const core = createMdocsCore(project);
    await core.commands.execute('wiki.create', { category: 'testing', id: 'learning', title: 'Learning', content: 'Stable learning.', lifecycle: 'stable' });
    expect(await core.commands.execute('wiki.link', { initiativeId: id, wikiSlug: 'testing/learning' })).toMatchObject({ success: true, bidirectional: true });
    expect(await core.commands.execute('initiative.done', { id })).toMatchObject({ success: true, filename });
    expect(await core.commands.execute('lifecycle.graduate', { id })).toMatchObject({ success: true });
    const after = fs.readFileSync(file, 'utf8');
    for (const text of ['## Direction\nDurable context.', 'wrapped plan detail', 'wrapped progress detail', '## Considered and set aside', 'custom: keep-me']) expect(after).toContain(text);
  });

  test('failed atomic replacement leaves original file intact and cleans temporary file', () => {
    const manager = createMdocsCore(project).managers.initiatives;
    const initiative = manager.read(filename)!;
    initiative.owner = 'new owner';
    const rename = jest.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('write failed'); });
    try {
      expect(() => manager.update(filename, initiative)).toThrow('write failed');
      expect(fs.readFileSync(file, 'utf8')).toBe(original);
      expect(fs.readdirSync(path.dirname(file))).toEqual([filename]);
    } finally { rename.mockRestore(); }
  });
});
