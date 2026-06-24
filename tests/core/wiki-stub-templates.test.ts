import { WikiManager } from '../../src/core/managers/wiki';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function makeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-stub-templates-'));
}

function rmDir(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
}

describe('WikiManager.stub entity templates (repos / systems)', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeDir();
  });

  afterEach(() => {
    rmDir(projectDir);
  });

  test('stub("repos", id) writes the repo template with repo headings, no generic ## Details', () => {
    const manager = new WikiManager(projectDir);
    const result = manager.stub('repos', 'foo');

    expect(result.success).toBe(true);
    const expectedPath = path.join(projectDir, 'wiki', 'repos', 'foo.md');
    expect(result.filePath).toBe(expectedPath);
    expect(fs.existsSync(expectedPath)).toBe(true);

    const content = fs.readFileSync(expectedPath, 'utf8');
    expect(content).toContain('category: "repos"');
    expect(content).toContain('# foo');
    expect(content).toContain('## Summary');
    expect(content).toContain('## Responsibilities');
    expect(content).toContain('## Dependencies');
    expect(content).toContain('## Owners / Links');
    // Regression guard: generic template headings must NOT appear.
    expect(content).not.toContain('## Details');
  });

  test('stub("systems", id) writes the system template with system headings (## Boundaries)', () => {
    const manager = new WikiManager(projectDir);
    const result = manager.stub('systems', 'bar');

    expect(result.success).toBe(true);
    const expectedPath = path.join(projectDir, 'wiki', 'systems', 'bar.md');
    expect(result.filePath).toBe(expectedPath);
    expect(fs.existsSync(expectedPath)).toBe(true);

    const content = fs.readFileSync(expectedPath, 'utf8');
    expect(content).toContain('category: "systems"');
    expect(content).toContain('# bar');
    expect(content).toContain('## Summary');
    expect(content).toContain('## Boundaries');
    expect(content).toContain('## Dependencies');
    expect(content).toContain('## Owners / Links');
    expect(content).not.toContain('## Details');
  });

  test('stub("architecture", id) still produces the GENERIC template (regression guard)', () => {
    const manager = new WikiManager(projectDir);
    const result = manager.stub('architecture', 'x');

    expect(result.success).toBe(true);
    const content = fs.readFileSync(result.filePath, 'utf8');
    expect(content).toContain('category: "architecture"');
    expect(content).toContain('## Overview');
    expect(content).toContain('## Details');
    expect(content).toContain('## References');
    // Entity-only headings must NOT appear in the generic template.
    expect(content).not.toContain('## Responsibilities');
    expect(content).not.toContain('## Boundaries');
  });

  test('stub("repos", id, title) puts the supplied title in frontmatter title: and the H1', () => {
    const manager = new WikiManager(projectDir);
    const result = manager.stub('repos', 'foo', 'My Repo');

    expect(result.success).toBe(true);
    const content = fs.readFileSync(result.filePath, 'utf8');
    expect(content).toContain('title: "My Repo"');
    expect(content).toContain('# My Repo');
  });

  test('explicit template argument overrides entity template selection', () => {
    const manager = new WikiManager(projectDir);
    const result = manager.stub('repos', 'foo', undefined, 'CUSTOM');

    expect(result.success).toBe(true);
    const content = fs.readFileSync(result.filePath, 'utf8');
    expect(content).toBe('CUSTOM');
    expect(content).not.toContain('## Responsibilities');
    expect(content).not.toContain('## Owners / Links');
  });

  test('create({ category: "repos" }) is pass-through: body equals caller content, no entity template injected', () => {
    const manager = new WikiManager(projectDir);
    const filePath = manager.create({
      id: 'r1',
      title: 'R1',
      category: 'repos',
      created: '2026-06-23',
      updated: '2026-06-23',
      relatedInitiatives: [],
      tags: [],
      content: 'caller text'
    });

    expect(fs.existsSync(filePath)).toBe(true);
    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toContain('caller text');
    // Entity template skeleton must NOT be injected by create().
    expect(content).not.toContain('## Responsibilities');
    expect(content).not.toContain('## Owners / Links');
    expect(content).not.toContain('## Boundaries');
  });
});
