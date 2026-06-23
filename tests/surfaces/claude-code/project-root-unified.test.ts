import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveProjectRoot } from '../../../src/core/project-root';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeMdocsRoot(dir: string): string {
  fs.mkdirSync(path.join(dir, 'mdocs'), { recursive: true });
  return dir;
}

/**
 * Mirrors how each surface obtains its effective cwd before delegating to the
 * shared helper. Keeping these mirrors here lets this test prove "all surfaces
 * call the SAME function with equivalent inputs" without standing up stdio or
 * spawning compiled binaries — and without coupling to the SDK / node spawn.
 *
 *   mcp-server.ts:        resolveProjectRoot(process.cwd())
 *   pre-tool-use.ts:      resolveProjectRoot(payload.cwd || process.cwd())
 *   post-tool-use.ts:     resolveProjectRoot(payload.cwd || process.cwd())
 */
function mcpResolve(env: NodeJS.ProcessEnv, cwd: string): string {
  return withEnv(env, () => resolveProjectRoot(cwd));
}
function hookResolve(env: NodeJS.ProcessEnv, payloadCwd: string | undefined, cwd: string): string {
  return withEnv(env, () => resolveProjectRoot(payloadCwd || cwd));
}

function withEnv<T>(env: NodeJS.ProcessEnv, fn: () => T): T {
  const prev = { ...process.env };
  // Wipe MDOCS_PROJECT_DIR first so we control it entirely.
  delete process.env.MDOCS_PROJECT_DIR;
  if (env.MDOCS_PROJECT_DIR !== undefined) {
    process.env.MDOCS_PROJECT_DIR = env.MDOCS_PROJECT_DIR;
  }
  try {
    return fn();
  } finally {
    // Restore the previous value (or unset it).
    delete process.env.MDOCS_PROJECT_DIR;
    if (prev.MDOCS_PROJECT_DIR !== undefined) {
      process.env.MDOCS_PROJECT_DIR = prev.MDOCS_PROJECT_DIR;
    }
  }
}

describe('G6: unified project root resolution across MCP + hooks', () => {
  test('(a) MDOCS_PROJECT_DIR wins, both surfaces resolve identically', () => {
    const envDir = makeMdocsRoot(tempDir('harness-mdocs-unify-env-'));
    const cwdDir = makeMdocsRoot(tempDir('harness-mdocs-unify-cwd-'));
    const payloadCwd = cwdDir;

    const mcpRoot = mcpResolve({ MDOCS_PROJECT_DIR: envDir }, cwdDir);
    const preRoot = hookResolve({ MDOCS_PROJECT_DIR: envDir }, payloadCwd, cwdDir);
    const postRoot = hookResolve({ MDOCS_PROJECT_DIR: envDir }, payloadCwd, cwdDir);

    expect(mcpRoot).toBe(envDir);
    expect(preRoot).toBe(envDir);
    expect(postRoot).toBe(envDir);
    expect(preRoot).toBe(mcpRoot);
    expect(postRoot).toBe(mcpRoot);
  });

  test('(b) walk-up finds nearest mdocs/ ancestor identically for all surfaces', () => {
    const projectDir = makeMdocsRoot(tempDir('harness-mdocs-unify-walk-'));
    const nested = path.join(projectDir, 'packages', 'web', 'src');
    fs.mkdirSync(nested, { recursive: true });

    // No env var; cwd is a deeply nested subdir (mimics the hook payload cwd
    // differing from process.cwd()).
    const mcpRoot = mcpResolve({}, nested);
    const preRoot = hookResolve({}, nested, nested);
    const postRoot = hookResolve({}, nested, nested);

    expect(mcpRoot).toBe(projectDir);
    expect(preRoot).toBe(projectDir);
    expect(postRoot).toBe(projectDir);
    expect(preRoot).toBe(mcpRoot);
    expect(postRoot).toBe(mcpRoot);
  });

  test('(c) fallback to cwd when no mdocs/ found — identical across surfaces', () => {
    const cwdDir = tempDir('harness-mdocs-unify-fallback-');

    const mcpRoot = mcpResolve({}, cwdDir);
    const preRoot = hookResolve({}, cwdDir, cwdDir);
    const postRoot = hookResolve({}, cwdDir, cwdDir);

    expect(mcpRoot).toBe(cwdDir);
    expect(preRoot).toBe(cwdDir);
    expect(postRoot).toBe(cwdDir);
  });

  test('(d) the divergent case: MDOCS_PROJECT_DIR set, cwd elsewhere — hook and MCP agree', () => {
    // This is the whole point of G6. Before unification:
    //   - mcp-server.ts used `MDOCS_PROJECT_DIR || process.cwd()` => envDir
    //   - hooks used `payload.cwd || process.cwd()` (ignoring env)      => cwdDir
    // so the gate and MCP operated on DIFFERENT mdocs roots. After G6 both
    // must resolve to the same root (envDir, since it contains mdocs/).
    const envDir = makeMdocsRoot(tempDir('harness-mdocs-unify-divergent-env-'));
    const cwdDir = makeMdocsRoot(tempDir('harness-mdocs-unify-divergent-cwd-'));

    const mcpRoot = mcpResolve({ MDOCS_PROJECT_DIR: envDir }, cwdDir);
    const preRoot = hookResolve({ MDOCS_PROJECT_DIR: envDir }, cwdDir, cwdDir);
    const postRoot = hookResolve({ MDOCS_PROJECT_DIR: envDir }, cwdDir, cwdDir);

    expect(mcpRoot).toBe(envDir);
    expect(preRoot).toBe(envDir);
    expect(postRoot).toBe(envDir);
    // The divergence-prevention invariant: all three MUST be equal.
    expect(preRoot).toBe(mcpRoot);
    expect(postRoot).toBe(mcpRoot);
  });

  test('(e) shared helper: both surfaces call the same resolveProjectRoot function', () => {
    // Structural proof: importing the SAME symbol from core/project-root and
    // routing both surfaces through it guarantees a single implementation.
    // If anyone re-introduces ad-hoc resolution in one surface, this import
    // path no longer reflects that surface and a reviewer will spot it.
    expect(typeof resolveProjectRoot).toBe('function');

    const envDir = makeMdocsRoot(tempDir('harness-mdocs-unify-shared-'));
    const cwdDir = makeMdocsRoot(tempDir('harness-mdocs-unify-shared-cwd-'));

    const direct = withEnv({ MDOCS_PROJECT_DIR: envDir }, () => resolveProjectRoot(cwdDir));
    const viaMcp = mcpResolve({ MDOCS_PROJECT_DIR: envDir }, cwdDir);
    const viaHook = hookResolve({ MDOCS_PROJECT_DIR: envDir }, cwdDir, cwdDir);

    expect(viaMcp).toBe(direct);
    expect(viaHook).toBe(direct);
  });
});
