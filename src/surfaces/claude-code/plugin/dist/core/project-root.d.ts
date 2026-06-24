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
export declare function resolveProjectRoot(cwd: string): string;
