import * as fs from 'fs';
import * as path from 'path';

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
export function loadProjectConfig(mdocsRoot: string): MdocsCoreOptions {
  const configPath = path.join(mdocsRoot, '.mdocs.json');
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }

  const source = parsed as Record<string, any>;
  const config: MdocsCoreOptions = {};

  if (typeof source.mdocsDirName === 'string' && source.mdocsDirName.length > 0) {
    config.mdocsDirName = source.mdocsDirName;
  }
  if (Array.isArray(source.standaloneCategories)) {
    const categories = source.standaloneCategories.filter(
      (category: unknown): category is string => typeof category === 'string'
    );
    if (categories.length > 0) {
      config.standaloneCategories = categories;
    }
  }
  if (isPlainObject(source.compatibility)) {
    config.compatibility = source.compatibility;
  }
  if (isPlainObject(source.wiki)) {
    config.wiki = source.wiki;
  }

  return config;
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
