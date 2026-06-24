import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveProjectRoot } from '../../src/core/project-root';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeMdocsRoot(dir: string): string {
  fs.mkdirSync(path.join(dir, 'mdocs'), { recursive: true });
  return dir;
}

describe('resolveProjectRoot', () => {
  const prevEnv = process.env.MDOCS_PROJECT_DIR;

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.MDOCS_PROJECT_DIR;
    else process.env.MDOCS_PROJECT_DIR = prevEnv;
  });

  test('(a) MDOCS_PROJECT_DIR wins when set and contains mdocs/', () => {
    const envDir = makeMdocsRoot(tempDir('harness-mdocs-root-env-'));
    const cwdDir = makeMdocsRoot(tempDir('harness-mdocs-root-cwd-'));
    process.env.MDOCS_PROJECT_DIR = envDir;

    expect(resolveProjectRoot(cwdDir)).toBe(envDir);
  });

  test('MDOCS_PROJECT_DIR is honored even before mdocs/ exists (bootstrap flow)', () => {
    // Matches the established `set env -> mdocs_init` pattern: the env pin
    // designates the project root even before mdocs/ has been bootstrapped,
    // so createMdocsCore/mdocs_init will create mdocs/ under the pinned dir.
    const envDir = tempDir('harness-mdocs-root-bootstrap-'); // no mdocs/ subdir
    const cwdDir = makeMdocsRoot(tempDir('harness-mdocs-root-cwd-'));
    process.env.MDOCS_PROJECT_DIR = envDir;

    expect(resolveProjectRoot(cwdDir)).toBe(envDir);
  });

  test('MDOCS_PROJECT_DIR is ignored when it points at a non-existent path', () => {
    const cwdDir = makeMdocsRoot(tempDir('harness-mdocs-root-real-'));
    process.env.MDOCS_PROJECT_DIR = path.join(tempDir('harness-mdocs-root-stale-'), 'does-not-exist');

    expect(resolveProjectRoot(cwdDir)).toBe(cwdDir);
  });

  test('(b) walk-up finds the nearest ancestor containing mdocs/', () => {
    const projectDir = makeMdocsRoot(tempDir('harness-mdocs-root-walk-'));
    const nested = path.join(projectDir, 'packages', 'web', 'src');
    fs.mkdirSync(nested, { recursive: true });

    expect(resolveProjectRoot(nested)).toBe(projectDir);
  });

  test('walk-up prefers the nearest ancestor, not a more distant one', () => {
    const outer = makeMdocsRoot(tempDir('harness-mdocs-root-outer-'));
    const inner = makeMdocsRoot(path.join(outer, 'inner-project'));
    const leaf = path.join(inner, 'subdir');
    fs.mkdirSync(leaf, { recursive: true });

    expect(resolveProjectRoot(leaf)).toBe(inner);
  });

  test('(c) falls back to cwd when no ancestor has mdocs/', () => {
    const cwdDir = tempDir('harness-mdocs-root-fallback-'); // no mdocs/ anywhere up the tree (os.tmpdir has none)

    expect(resolveProjectRoot(cwdDir)).toBe(cwdDir);
  });

  test('non-breaking: no env var + cwd contains mdocs/ => root == cwd (0.4.2 default)', () => {
    delete process.env.MDOCS_PROJECT_DIR;
    const cwdDir = makeMdocsRoot(tempDir('harness-mdocs-root-default-'));

    expect(resolveProjectRoot(cwdDir)).toBe(cwdDir);
  });

  test('empty MDOCS_PROJECT_DIR is treated as unset', () => {
    const cwdDir = makeMdocsRoot(tempDir('harness-mdocs-root-empty-'));
    process.env.MDOCS_PROJECT_DIR = '   ';

    expect(resolveProjectRoot(cwdDir)).toBe(cwdDir);
  });
});
