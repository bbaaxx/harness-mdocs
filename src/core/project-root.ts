import * as fs from 'fs';
import * as path from 'path';

/**
 * Default name of the mdocs memory directory under a project root.
 * Kept in sync with createMdocsCore's default mdocsDirName.
 */
const MDOCS_DIR_NAME = 'mdocs';

/**
 * Resolve the project root for a given effective cwd + environment.
 *
 * Resolution precedence:
 *  (a) `MDOCS_PROJECT_DIR` env var if set and resolves to an existing
 *      directory — explicit authoritative pin. It does NOT need to already
 *      contain a `mdocs/` subdir: the env var designates the project root
 *      even before `mdocs init` bootstraps `mdocs/` (matches the MCP
 *      server's original `MDOCS_PROJECT_DIR || process.cwd()` semantics and
 *      the bootstrap flow `set env -> call mdocs_init`).
 *  (b) else walk UP from `cwd` to the nearest ancestor (including `cwd`)
 *      that contains a `mdocs/` dir — finds the owning project from a
 *      nested cwd (e.g. monorepo packages, subdirectories) when no env pin
 *      is present.
 *  (c) else fall back to `cwd` — preserves the legacy `process.cwd()`
 *      behavior so a fresh `mdocs init` still roots at the cwd.
 *
 * Pure / side-effect free: reads the filesystem but mutates nothing, so it
 * can be unit-tested with throwaway temp dirs. Surfaces (MCP server,
 * PreToolUse / PostToolUse hooks) MUST route their effective cwd through
 * this helper so they agree on the same mdocs root even when cwd and
 * MDOCS_PROJECT_DIR disagree.
 *
 * @param cwd effective working directory (hook payload cwd or process.cwd())
 * @returns absolute project directory to pass into createMdocsCore
 */
export function resolveProjectRoot(cwd: string): string {
  const start = path.isAbsolute(cwd) ? cwd : path.resolve(cwd);

  // (a) Explicit authoritative pin via env var — honored whenever it names an
  // existing directory, even before mdocs/ has been bootstrapped. A stale or
  // garbage value that points nowhere falls through to (b)/(c).
  const envDir = process.env.MDOCS_PROJECT_DIR;
  if (envDir && envDir.trim() !== '' && isExistingDir(envDir)) {
    return envDir;
  }

  // (b) Walk up from cwd to the nearest ancestor containing mdocs/.
  let dir = start;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (hasMdocsDir(dir)) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break; // filesystem root reached
    }
    dir = parent;
  }

  // (c) Fallback: preserve legacy cwd-rooted behavior.
  return start;
}

/**
 * True if `dir` is an existing directory. Used to validate the
 * `MDOCS_PROJECT_DIR` pin without requiring mdocs/ to pre-exist (so the
 * bootstrap `set env -> mdocs_init` flow still roots at the pinned dir).
 */
function isExistingDir(dir: string): boolean {
  try {
    return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * True if `dir` itself contains a `mdocs/` subdir. A `mdocs/` subdir is the
 * single signal that a directory is an mdocs project root (matches the
 * mdocsRoot = projectDir/mdocs convention in createMdocsCore). Used by the
 * walk-up fallback (b) only.
 */
function hasMdocsDir(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, MDOCS_DIR_NAME)) &&
      fs.statSync(path.join(dir, MDOCS_DIR_NAME)).isDirectory();
  } catch {
    return false;
  }
}
