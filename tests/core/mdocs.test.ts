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
