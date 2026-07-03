import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { createMdocsCore, loadProjectConfig } from '../../src/core';

function tmpMdocsRoot(prefix = 'harness-mdocs-config-'): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const mdocsRoot = path.join(projectDir, 'mdocs');
  fs.mkdirSync(mdocsRoot, { recursive: true });
  return mdocsRoot;
}

function writeConfig(mdocsRoot: string, contents: string): void {
  fs.writeFileSync(path.join(mdocsRoot, '.mdocs.json'), contents, 'utf8');
}

test('loadProjectConfig returns parsed options for a valid .mdocs.json', () => {
  const root = tmpMdocsRoot();
  writeConfig(root, JSON.stringify({
    mdocsDirName: 'knowledge',
    standaloneCategories: ['repos', 'systems', 'glossary'],
    compatibility: { initiativeRecordMode: 'metadata-only', enforcementMode: 'advisory' },
    wiki: { standaloneCategories: ['wiki-local'] },
    audit: { level: 'metadata', maxBytes: 1024, maxBackups: 2 }
  }));

  const config = loadProjectConfig(root);

  expect(config.mdocsDirName).toBe('knowledge');
  expect(config.standaloneCategories).toEqual(['repos', 'systems', 'glossary']);
  expect(config.compatibility).toMatchObject({ initiativeRecordMode: 'metadata-only', enforcementMode: 'advisory' });
  expect(config.wiki).toEqual({ standaloneCategories: ['wiki-local'] });
  expect(config.audit).toEqual({ level: 'metadata', maxBytes: 1024, maxBackups: 2 });
});

test('loadProjectConfig returns {} when .mdocs.json is missing', () => {
  const root = tmpMdocsRoot();
  expect(loadProjectConfig(root)).toEqual({});
});

test('loadProjectConfig returns {} for malformed JSON', () => {
  const root = tmpMdocsRoot();
  writeConfig(root, '{ not valid json');
  expect(loadProjectConfig(root)).toEqual({});
});

test('loadProjectConfig returns {} for non-object JSON payloads', () => {
  const root = tmpMdocsRoot();

  writeConfig(root, JSON.stringify(['not', 'an', 'object']));
  expect(loadProjectConfig(root)).toEqual({});

  writeConfig(root, JSON.stringify(42));
  expect(loadProjectConfig(root)).toEqual({});
});

test('loadProjectConfig ignores ill-typed and unrecognized keys', () => {
  const root = tmpMdocsRoot();
  writeConfig(root, JSON.stringify({
    mdocsDirName: 123,
    standaloneCategories: 'not-an-array',
    compatibility: 'bad',
    wiki: 'also-bad',
    audit: 'also-bad',
    unknownKey: true
  }));

  const config = loadProjectConfig(root);

  expect(config.mdocsDirName).toBeUndefined();
  expect(config.standaloneCategories).toBeUndefined();
  expect(config.compatibility).toBeUndefined();
  expect(config.wiki).toBeUndefined();
  expect(config.audit).toBeUndefined();
});

test('createMdocsCore picks up .mdocs.json with no explicit options', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-config-core-'));
  const mdocsRoot = path.join(projectDir, 'mdocs');
  fs.mkdirSync(path.join(mdocsRoot, 'initiatives'), { recursive: true });
  writeConfig(mdocsRoot, JSON.stringify({
    compatibility: { initiativeRecordMode: 'metadata-only', enforcementMode: 'advisory' },
    standaloneCategories: ['repos', 'systems']
  }));

  const core = createMdocsCore(projectDir);

  expect(core.contract.initiativeRecordMode).toBe('metadata-only');
  expect(core.contract.enforcementMode).toBe('advisory');
});

test('explicit options win over .mdocs.json (merge precedence)', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-config-prec-'));
  const mdocsRoot = path.join(projectDir, 'mdocs');
  fs.mkdirSync(path.join(mdocsRoot, 'initiatives'), { recursive: true });
  writeConfig(mdocsRoot, JSON.stringify({
    compatibility: { initiativeRecordMode: 'metadata-only' }
  }));

  const coreOverride = createMdocsCore(projectDir, { compatibility: { initiativeRecordMode: 'full' } });
  expect(coreOverride.contract.initiativeRecordMode).toBe('full');

  const coreFile = createMdocsCore(projectDir);
  expect(coreFile.contract.initiativeRecordMode).toBe('metadata-only');
});

test('explicit audit options merge over .mdocs.json', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-config-audit-'));
  const mdocsRoot = path.join(projectDir, 'mdocs');
  fs.mkdirSync(path.join(mdocsRoot, 'initiatives'), { recursive: true });
  writeConfig(mdocsRoot, JSON.stringify({ audit: { level: 'metadata', maxBytes: 5, maxBackups: 1 } }));

  const core = createMdocsCore(projectDir, { audit: { level: 'off' } });
  core.managers.audit.append({ timestamp: '2025-05-24T10:00:00Z', type: 'tool', details: { toolName: 'write' } });

  expect(fs.existsSync(path.join(mdocsRoot, 'audit.log'))).toBe(false);
});
