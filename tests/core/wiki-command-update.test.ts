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
