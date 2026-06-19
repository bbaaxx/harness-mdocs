import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createMdocsCore } from '../../src/core';
import { detectMdocsContract } from '../../src/core/contract';

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
