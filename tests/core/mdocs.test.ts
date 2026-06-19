import { MdocsManager } from '../../src/core/managers/mdocs';
import * as fs from 'fs';
import * as path from 'path';

const testDir = path.join(__dirname, 'test-mdocs');

beforeEach(() => {
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true });
  }
});

afterEach(() => {
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true });
  }
});

test('exists returns false before init', () => {
  const manager = new MdocsManager(testDir);
  expect(manager.exists()).toBe(false);
});

test('exists returns true after init', () => {
  const manager = new MdocsManager(testDir);
  manager.init();
  expect(manager.exists()).toBe(true);
});

test('init is idempotent', () => {
  const manager = new MdocsManager(testDir);
  manager.init();

  const initiativesIndexPath = path.join(testDir, 'initiatives', 'INDEX.md');
  const originalContent = fs.readFileSync(initiativesIndexPath, 'utf8');

  manager.init();

  const afterInitContent = fs.readFileSync(initiativesIndexPath, 'utf8');
  expect(afterInitContent).toBe(originalContent);
});

test('init creates directory structure', () => {
  const manager = new MdocsManager(testDir);
  manager.init();

  expect(fs.existsSync(path.join(testDir, 'initiatives'))).toBe(true);
  expect(fs.existsSync(path.join(testDir, 'wiki'))).toBe(true);
  expect(fs.existsSync(path.join(testDir, 'initiatives', 'INDEX.md'))).toBe(true);
  expect(fs.existsSync(path.join(testDir, 'wiki', 'INDEX.md'))).toBe(true);
});

test('constructor throws for empty string', () => {
  expect(() => new MdocsManager('')).toThrow('baseDir must be a non-empty string');
});

test('constructor throws for non-string', () => {
  expect(() => new MdocsManager(123 as any)).toThrow('baseDir must be a non-empty string');
});

test('exists returns false when initiatives is a file not directory', () => {
  fs.mkdirSync(testDir, { recursive: true });
  fs.writeFileSync(path.join(testDir, 'initiatives'), 'not a dir');
  fs.mkdirSync(path.join(testDir, 'wiki'), { recursive: true });
  const manager = new MdocsManager(testDir);
  expect(manager.exists()).toBe(false);
});

test('init supports lowercase and disabled wiki index modes', () => {
  const lowercaseDir = path.join(testDir, 'lowercase');
  const noneDir = path.join(testDir, 'none');
  const lowercase = new MdocsManager(lowercaseDir, { wikiIndexMode: 'canonical-lowercase' });
  const none = new MdocsManager(noneDir, { wikiIndexMode: 'none' });

  lowercase.init();
  none.init();

  expect(fs.readdirSync(path.join(lowercaseDir, 'wiki'))).toContain('index.md');
  expect(fs.readdirSync(path.join(lowercaseDir, 'wiki'))).not.toContain('INDEX.md');
  expect(lowercase.exists()).toBe(true);
  expect(fs.existsSync(path.join(noneDir, 'wiki', 'INDEX.md'))).toBe(false);
  expect(none.exists()).toBe(true);
});

test('exists accepts directory initiatives and rejects file wiki path', () => {
  fs.mkdirSync(path.join(testDir, 'initiatives', 'work'), { recursive: true });
  fs.writeFileSync(path.join(testDir, 'initiatives', 'work', '_status.md'), '---\nid: work\ntitle: Work\n---\n', 'utf8');
  fs.mkdirSync(path.join(testDir, 'wiki'), { recursive: true });
  fs.writeFileSync(path.join(testDir, 'wiki', 'INDEX.md'), '# Wiki', 'utf8');
  expect(new MdocsManager(testDir).exists()).toBe(true);

  const wikiFileDir = path.join(testDir, 'wiki-file');
  fs.mkdirSync(path.join(wikiFileDir, 'initiatives'), { recursive: true });
  fs.writeFileSync(path.join(wikiFileDir, 'initiatives', 'INDEX.md'), '# Initiatives', 'utf8');
  fs.writeFileSync(path.join(wikiFileDir, 'wiki'), 'not a dir', 'utf8');
  expect(new MdocsManager(wikiFileDir).exists()).toBe(false);
});

test('index metadata handles missing, valid, missing field, and invalid JSON', () => {
  fs.mkdirSync(testDir, { recursive: true });
  const manager = new MdocsManager(testDir);

  expect(manager.readIndexMeta()).toEqual({ lastSync: null });
  manager.writeIndexMeta();
  expect(manager.readIndexMeta().lastSync).toEqual(expect.any(String));
  fs.writeFileSync(path.join(testDir, '.index-meta.json'), '{}', 'utf8');
  expect(manager.readIndexMeta()).toEqual({ lastSync: null });
  fs.writeFileSync(path.join(testDir, '.index-meta.json'), '{bad', 'utf8');
  expect(manager.readIndexMeta()).toEqual({ lastSync: null });
});
