import { WikiManager } from '../../src/core/managers/wiki';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function makeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-overview-log-'));
}

function rmDir(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
}

describe('WikiManager.updateOverviewSection / appendLog (compiled views)', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeDir();
  });

  afterEach(() => {
    rmDir(projectDir);
  });

  test('updateOverviewSection creates overview.md with frontmatter + # Overview + section when absent', () => {
    const manager = new WikiManager(projectDir, { compatibility: { wikiIndexMode: 'canonical-lowercase' } });
    const filePath = manager.updateOverviewSection('Status', 'All green');

    expect(filePath).toBe(path.join(projectDir, 'wiki', 'overview.md'));
    expect(fs.existsSync(filePath as string)).toBe(true);

    const content = fs.readFileSync(filePath as string, 'utf8');
    expect(content).toMatch(/^---\nid: "overview"\ntitle: "Overview"/m);
    expect(content).toContain('category: ""');
    expect(content).toContain('# Overview');
    expect(content).toContain('## Status');
    expect(content).toContain('All green');
  });

  test('updateOverviewSection replaces an existing section body in place, preserving other sections byte-for-byte', () => {
    const manager = new WikiManager(projectDir, { compatibility: { wikiIndexMode: 'canonical-lowercase' } });
    manager.updateOverviewSection('Alpha', 'alpha body');
    manager.updateOverviewSection('Beta', 'beta body');

    const filePath = manager.updateOverviewSection('Alpha', 'alpha body UPDATED') as string;
    const content = fs.readFileSync(filePath, 'utf8');

    expect(content).toContain('## Alpha');
    expect(content).toContain('alpha body UPDATED');
    expect(content).not.toContain('alpha body\n');
    // Beta section preserved verbatim.
    expect(content).toContain('## Beta');
    expect(content).toContain('beta body');
    // Alpha appears exactly once.
    expect((content.match(/## Alpha/g) || []).length).toBe(1);
    expect((content.match(/## Beta/g) || []).length).toBe(1);
  });

  test('updateOverviewSection appends a new section at the end when it does not yet exist', () => {
    const manager = new WikiManager(projectDir, { compatibility: { wikiIndexMode: 'canonical-lowercase' } });
    manager.updateOverviewSection('First', 'one');

    const filePath = manager.updateOverviewSection('Second', 'two') as string;
    const content = fs.readFileSync(filePath, 'utf8');

    const firstIdx = content.indexOf('## First');
    const secondIdx = content.indexOf('## Second');
    expect(firstIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(firstIdx);
    expect(content).toContain('two');
  });

  test('updateOverviewSection is idempotent: same (section, body) twice yields identical file contents', () => {
    const manager = new WikiManager(projectDir, { compatibility: { wikiIndexMode: 'canonical-lowercase' } });
    const first = manager.updateOverviewSection('Metrics', 'lines: 42');
    const second = manager.updateOverviewSection('Metrics', 'lines: 42');

    expect(second).toBe(first);
    const a = fs.readFileSync(first as string, 'utf8');
    const b = fs.readFileSync(second as string, 'utf8');
    expect(a).toBe(b);
  });

  test('appendLog creates log.md with # Log + the entry; second call adds a second block at the end, first preserved verbatim', () => {
    const manager = new WikiManager(projectDir, { compatibility: { wikiIndexMode: 'canonical-lowercase' } });
    const firstPath = manager.appendLog({ timestamp: '2026-06-23T10:00:00.000Z', content: 'first entry' });
    expect(firstPath).toBe(path.join(projectDir, 'wiki', 'log.md'));

    const afterFirst = fs.readFileSync(firstPath as string, 'utf8');
    expect(afterFirst).toMatch(/^---\nid: "log"\ntitle: "Log"/m);
    expect(afterFirst).toContain('# Log');
    expect(afterFirst).toContain('## 2026-06-23T10:00:00.000Z');
    expect(afterFirst).toContain('first entry');

    const secondPath = manager.appendLog({ timestamp: '2026-06-23T11:00:00.000Z', content: 'second entry' });
    expect(secondPath).toBe(firstPath);

    const afterSecond = fs.readFileSync(secondPath as string, 'utf8');
    // First entry preserved verbatim and appears before the second.
    const firstIdx = afterSecond.indexOf('## 2026-06-23T10:00:00.000Z');
    const secondIdx = afterSecond.indexOf('## 2026-06-23T11:00:00.000Z');
    expect(firstIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(firstIdx);
    expect(afterSecond).toContain('first entry');
    expect(afterSecond).toContain('second entry');
  });

  test('appendLog accepts a plain string as the content with a generated ISO timestamp', () => {
    const manager = new WikiManager(projectDir, { compatibility: { wikiIndexMode: 'canonical-lowercase' } });
    const filePath = manager.appendLog('string-body') as string;
    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toContain('string-body');
    // An ISO-looking H2 timestamp is present.
    expect(content).toMatch(/^## \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/m);
  });

  test('appendLog emits the consumer heading when operation+subject are supplied', () => {
    const manager = new WikiManager(projectDir, { compatibility: { wikiIndexMode: 'canonical-lowercase' } });
    const filePath = manager.appendLog({
      date: '2026-06-24',
      operation: 'ship',
      subject: 'd1',
      content: 'shipped decision d1'
    }) as string;
    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toContain('## [2026-06-24] ship | d1');
    expect(content).toContain('shipped decision d1');
  });

  test('appendLog consumer heading falls back to today when date is absent', () => {
    const manager = new WikiManager(projectDir, { compatibility: { wikiIndexMode: 'canonical-lowercase' } });
    const filePath = manager.appendLog({
      operation: 'note',
      subject: 'x',
      content: 'body'
    }) as string;
    const content = fs.readFileSync(filePath, 'utf8');
    const today = new Date().toISOString().split('T')[0];
    expect(content).toContain(`## [${today}] note | x`);
  });

  test('appendLog preserves legacy timestamp form when only operation is supplied', () => {
    const manager = new WikiManager(projectDir, { compatibility: { wikiIndexMode: 'canonical-lowercase' } });
    const filePath = manager.appendLog({
      timestamp: '2026-06-23T10:00:00.000Z',
      operation: 'ship',
      content: 'partial'
    }) as string;
    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toContain('## 2026-06-23T10:00:00.000Z');
    expect(content).not.toMatch(/^## \[/m);
  });

  test('both helpers return null and write NO file under a non-directory-v2 mode', () => {
    const flatDir = makeDir();
    try {
      const flatManager = new WikiManager(flatDir); // default -> generated-uppercase / flat
      expect(flatManager['contract'].wikiIndexMode).not.toBe('canonical-lowercase');

      const overviewResult = flatManager.updateOverviewSection('X', 'Y');
      const logResult = flatManager.appendLog('Z');
      expect(overviewResult).toBeNull();
      expect(logResult).toBeNull();

      expect(fs.existsSync(path.join(flatDir, 'wiki', 'overview.md'))).toBe(false);
      expect(fs.existsSync(path.join(flatDir, 'wiki', 'log.md'))).toBe(false);
    } finally {
      rmDir(flatDir);
    }
  });

  test('neither helper creates wiki/index.md and, under external owner, index.md is not modified', () => {
    // Default dir-v2 owner is 'external' — pre-create an externally-owned index.md
    // and assert it stays byte-stable through the helper calls.
    const wikiDir = path.join(projectDir, 'wiki');
    fs.mkdirSync(wikiDir, { recursive: true });
    const indexPath = path.join(wikiDir, 'index.md');
    const externalIndex = '# Wiki\n\nExternally maintained index.\n';
    fs.writeFileSync(indexPath, externalIndex, 'utf8');

    const manager = new WikiManager(projectDir, { compatibility: { wikiIndexMode: 'canonical-lowercase' } });
    expect(manager['contract'].wikiIndexOwner).toBe('external');

    manager.updateOverviewSection('Status', 'green');
    manager.appendLog('event');

    // index.md is byte-stable.
    expect(fs.readFileSync(indexPath, 'utf8')).toBe(externalIndex);
    // overview.md / log.md exist; index.md was not created by the helpers (it pre-existed).
    expect(fs.existsSync(path.join(wikiDir, 'overview.md'))).toBe(true);
    expect(fs.existsSync(path.join(wikiDir, 'log.md'))).toBe(true);
  });

  test('produced overview.md and log.md parse cleanly via readByRef and pass validate()', () => {
    const manager = new WikiManager(projectDir, { compatibility: { wikiIndexMode: 'canonical-lowercase' } });
    manager.updateOverviewSection('Status', 'All green');
    manager.appendLog({ timestamp: '2026-06-23T10:00:00.000Z', content: 'boot' });

    const overview = manager.readByRef('overview');
    expect(overview).not.toBeNull();
    expect(overview?.id).toBe('overview');
    expect(overview?.title).toBe('Overview');

    const log = manager.readByRef('log');
    expect(log).not.toBeNull();
    expect(log?.id).toBe('log');
    expect(log?.title).toBe('Log');

    const result = manager.validate();
    expect(result.errors).toEqual([]);
  });
});
