import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createMdocsCore } from '../../src/core';

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-wiki-command-'));
}

test('wiki.update command refreshes the updated date', async () => {
  const projectDir = tempProject();
  const core = createMdocsCore(projectDir);
  core.managers.mdocs.init();

  core.managers.wiki.create({
    category: 'developer',
    id: 'command-update',
    title: 'Command Update',
    created: '2026-01-01',
    updated: '2026-01-01',
    relatedInitiatives: [],
    tags: [],
    content: 'Before'
  });

  const result = await core.commands.execute('wiki.update', {
    category: 'developer',
    id: 'command-update',
    content: 'After'
  });

  const today = new Date().toISOString().split('T')[0];
  const updated = core.managers.wiki.read('developer', 'command-update');
  expect(result).toMatchObject({ success: true, id: 'command-update' });
  expect(updated?.updated).toBe(today);
});

test('wiki.update command updates lifecycle and provenance metadata', async () => {
  const projectDir = tempProject();
  const core = createMdocsCore(projectDir);
  core.managers.mdocs.init();

  core.managers.wiki.create({
    category: 'developer',
    id: 'metadata-update',
    title: 'Metadata Update',
    created: '2026-01-01',
    updated: '2026-01-01',
    relatedInitiatives: ['old-initiative'],
    tags: ['old'],
    lifecycle: 'draft',
    knowledgeType: 'note',
    confidence: 'medium',
    sourceInitiatives: ['old-initiative'],
    supersedes: ['old-entry'],
    content: 'Before'
  });

  const result = await core.commands.execute('wiki.update', {
    category: 'developer',
    id: 'metadata-update',
    lifecycle: 'stable',
    knowledgeType: 'how-to',
    confidence: 'high',
    sourceInitiatives: ['codex-dogfood-end-to-end'],
    supersedes: ['previous-dogfood-note']
  });

  const updated = core.managers.wiki.read('developer', 'metadata-update');
  expect(result).toMatchObject({ success: true, id: 'metadata-update' });
  expect(updated?.lifecycle).toBe('stable');
  expect(updated?.knowledgeType).toBe('how-to');
  expect(updated?.confidence).toBe('high');
  expect(updated?.sourceInitiatives).toEqual(['codex-dogfood-end-to-end']);
  expect(updated?.supersedes).toEqual(['previous-dogfood-note']);
});
