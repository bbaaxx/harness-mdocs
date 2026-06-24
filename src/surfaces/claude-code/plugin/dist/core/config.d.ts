import type { MdocsCoreOptions } from './factory';
/**
 * Load the opt-in project-level `.mdocs.json` config file.
 *
 * Reads `<mdocsRoot>/.mdocs.json` and returns the parsed subset that maps to
 * {@link MdocsCoreOptions}: `mdocsDirName`, `standaloneCategories`,
 * `compatibility`, and the nested `wiki` options. Returns `{}` when the file
 * is missing or invalid — this loader NEVER throws, so a malformed config
 * degrades gracefully to defaults instead of breaking core construction.
 *
 * Precedence is applied by the caller (the factory): explicit `options` win
 * over file, file wins over built-in defaults. The "file" precedence tier is
 * established here; before this module the runtime path only honored explicit
 * options and built-in defaults.
 */
export declare function loadProjectConfig(mdocsRoot: string): MdocsCoreOptions;
