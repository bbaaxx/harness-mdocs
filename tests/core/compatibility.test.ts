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
