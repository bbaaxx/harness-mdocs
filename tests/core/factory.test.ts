import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createMdocsCore } from '../../src/core';

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-core-'));
}

describe('createMdocsCore', () => {
  test('creates managers rooted under the configured mdocs directory', () => {
    const projectDir = tempProject();
    const core = createMdocsCore(projectDir);

    expect(core.projectDir).toBe(projectDir);
    expect(core.mdocsRoot).toBe(path.join(projectDir, 'mdocs'));
    expect(core.managers.mdocs).toBeDefined();
    expect(core.managers.initiatives).toBeDefined();
    expect(core.managers.wiki).toBeDefined();
    expect(core.managers.workflow).toBeDefined();
    expect(core.managers.search).toBeDefined();
    expect(core.managers.audit).toBeDefined();
    expect(core.managers.linter).toBeDefined();
    expect(core.managers.dispatch).toBeDefined();
    expect(core.lifecycle).toBeDefined();
  });

  test('initializes mdocs and bootstrap initiative only when missing', () => {
    const projectDir = tempProject();
    const core = createMdocsCore(projectDir);

    const first = core.lifecycle.ensureInitialized();
    const second = core.lifecycle.ensureInitialized();

    expect(first.initialized).toBe(true);
    expect(first.bootstrapInitiativeCreated).toBe(true);
    expect(second.initialized).toBe(false);
    expect(second.bootstrapInitiativeCreated).toBe(false);
    expect(fs.existsSync(path.join(projectDir, 'mdocs', 'initiatives', 'INDEX.md'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'mdocs', 'wiki', 'INDEX.md'))).toBe(true);
  });
});
