import * as fs from 'fs';
import * as path from 'path';

import { EnforcementMode, IdleStrictness } from './workflow/engine';

export type InitiativeMode = 'flat' | 'directory' | 'auto';
export type WikiIndexMode = 'generated-uppercase' | 'canonical-lowercase' | 'none' | 'auto';
export type ArchiveDirMode = 'archive' | '_archive' | 'auto';
export type IndexOwner = 'harness' | 'external' | 'none';

export interface MdocsCompatibilityConfig {
  initiativeMode?: InitiativeMode;
  wikiIndexMode?: WikiIndexMode;
  /**
   * Optional override for who owns the wiki index. For directory-v2
   * (canonical-lowercase), the safe default is `'external'` (no-op on
   * sync). Set `wikiIndexOwner: 'harness'` to opt into harness maintaining
   * the lowercase `wiki/index.md`. Ignored where inapplicable.
   */
  wikiIndexOwner?: IndexOwner;
  archiveDir?: ArchiveDirMode;
  legacyFlatFiles?: boolean | 'auto';
  obsidianRefreshCommand?: string | string[] | null;
  /**
   * Workflow enforcement mode. `gate` (default) blocks Write/Edit before
   * PLAN; `advisory` allows writes but still audits; `off` disables
   * enforcement entirely (CI escape hatch). Precedence: env > file > default.
   */
  enforcementMode?: EnforcementMode;
  /**
   * IDLE strictness. `open` (default) allows every tool at IDLE (0.4.2
   * behaviour); `readonly` blocks Write/Edit/Bash at IDLE until the workflow
   * advances. Precedence: env > file > default.
   */
  idle?: IdleStrictness;
  /**
   * How initiative `_status.md` files are written. `full` (default) keeps the
   * harness-authored Objective/Plan/Progress Log body and full frontmatter.
   * `metadata-only` treats the file as thin lifecycle metadata: surgical
   * lifecycle-key updates only, no body-section injection, and no new
   * frontmatter keys — for consumer trees that keep artifacts in sibling
   * files. Opt-in via `.mdocs.json`; defaults to current (`full`) behavior.
   */
  initiativeRecordMode?: 'full' | 'metadata-only';
}

export interface MdocsContract {
  initiativeMode: Exclude<InitiativeMode, 'auto'>;
  wikiIndexMode: Exclude<WikiIndexMode, 'auto'>;
  archiveDir: Exclude<ArchiveDirMode, 'auto'>;
  legacyFlatFiles: boolean;
  wikiIndexOwner: IndexOwner;
  obsidianVisibilityLayer: boolean;
  obsidianDir?: string;
  obsidianRefreshCommand?: string | string[] | null;
  enforcementMode: EnforcementMode;
  idle: IdleStrictness;
  initiativeRecordMode: 'full' | 'metadata-only';
}

function safeExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

/**
 * Validate an explicit `wikiIndexOwner` override against the resolved mode.
 * `'harness'` is permitted for both generated-uppercase (default) and
 * canonical-lowercase (opt-in). `'external'` is only meaningful for
 * canonical-lowercase. `'none'` applies when there is no index.
 */
function isValidOwnerForMode(owner: IndexOwner, mode: Exclude<WikiIndexMode, 'auto'>): boolean {
  if (owner === 'harness') return mode === 'generated-uppercase' || mode === 'canonical-lowercase';
  if (owner === 'external') return mode === 'canonical-lowercase';
  if (owner === 'none') return mode === 'none';
  return false;
}

function hasExactChild(parentDir: string, childName: string): boolean {
  if (!safeExists(parentDir)) return false;
  try {
    return fs.readdirSync(parentDir).includes(childName);
  } catch {
    return false;
  }
}

function hasDirectoryInitiatives(initiativesDir: string): boolean {
  if (!safeExists(initiativesDir)) return false;
  try {
    return fs.readdirSync(initiativesDir, { withFileTypes: true }).some(entry => {
      if (!entry.isDirectory() || entry.name === 'archive' || entry.name === '_archive') return false;
      return safeExists(path.join(initiativesDir, entry.name, '_status.md'));
    });
  } catch {
    return false;
  }
}

function hasFlatInitiatives(initiativesDir: string): boolean {
  if (!safeExists(initiativesDir)) return false;
  try {
    return fs.readdirSync(initiativesDir).some(file => file.endsWith('.md') && file !== 'INDEX.md');
  } catch {
    return false;
  }
}

function schemaMentionsDirectoryStatus(mdocsRoot: string): boolean {
  const schemaPath = path.join(mdocsRoot, 'SCHEMA.md');
  if (!safeExists(schemaPath)) return false;
  try {
    return fs.readFileSync(schemaPath, 'utf8').includes('_status.md');
  } catch {
    return false;
  }
}

export function detectMdocsContract(mdocsRoot: string, config: MdocsCompatibilityConfig = {}): MdocsContract {
  const initiativesDir = path.join(mdocsRoot, 'initiatives');
  const wikiDir = path.join(mdocsRoot, 'wiki');
  const directorySignals = hasDirectoryInitiatives(initiativesDir) || schemaMentionsDirectoryStatus(mdocsRoot);
  const lowercaseWikiIndex = hasExactChild(wikiDir, 'index.md');
  const uppercaseWikiIndex = hasExactChild(wikiDir, 'INDEX.md');
  const underscoreArchive = safeExists(path.join(initiativesDir, '_archive'));
  const flatInitiatives = hasFlatInitiatives(initiativesDir);
  const obsidianDir = path.join(mdocsRoot, '_obsidian');
  const obsidianVisibilityLayer = safeExists(obsidianDir) && isDirectory(obsidianDir);

  const initiativeMode = config.initiativeMode && config.initiativeMode !== 'auto'
    ? config.initiativeMode
    : directorySignals
      ? 'directory'
      : 'flat';

  const wikiIndexMode = config.wikiIndexMode && config.wikiIndexMode !== 'auto'
    ? config.wikiIndexMode
    : directorySignals
      ? lowercaseWikiIndex
        ? 'canonical-lowercase'
        : 'none'
      : lowercaseWikiIndex && !uppercaseWikiIndex
        ? 'canonical-lowercase'
        : 'generated-uppercase';

  const archiveDir = config.archiveDir && config.archiveDir !== 'auto'
    ? config.archiveDir
    : underscoreArchive
      ? '_archive'
      : 'archive';

  const legacyFlatFiles = config.legacyFlatFiles === 'auto' || config.legacyFlatFiles === undefined
    ? flatInitiatives
    : config.legacyFlatFiles;

  // Wiki index owner. Defaults are safe: harness owns generated-uppercase,
  // external owns canonical-lowercase (directory-v2), none when there is no
  // index. The `wikiIndexOwner` config is an explicit opt-in/override and is
  // validated against the resolved mode so nonsense combinations fall back to
  // the safe default rather than silently clobbering an external index.
  const defaultWikiIndexOwner: IndexOwner = wikiIndexMode === 'generated-uppercase'
    ? 'harness'
    : wikiIndexMode === 'canonical-lowercase'
      ? 'external'
      : 'none';
  const configuredOwner = config.wikiIndexOwner;
  const wikiIndexOwner: IndexOwner = configuredOwner && isValidOwnerForMode(configuredOwner, wikiIndexMode)
    ? configuredOwner
    : defaultWikiIndexOwner;

  return {
    initiativeMode,
    wikiIndexMode,
    archiveDir,
    legacyFlatFiles,
    wikiIndexOwner,
    obsidianVisibilityLayer,
    obsidianDir: obsidianVisibilityLayer ? obsidianDir : undefined,
    obsidianRefreshCommand: config.obsidianRefreshCommand ?? null,
    enforcementMode: resolveEnforcementMode(config.enforcementMode),
    idle: resolveIdleStrictness(config.idle),
    initiativeRecordMode: config.initiativeRecordMode ?? 'full'
  };
}

/**
 * Resolve the enforcement mode with precedence: env > file/config > default.
 * `MDOCS_ENFORCEMENT` is the CI escape hatch (`off` disables the gate
 * entirely); `gate` is the default.
 */
function resolveEnforcementMode(configValue?: EnforcementMode): EnforcementMode {
  const envValue = typeof process !== 'undefined' && process.env?.MDOCS_ENFORCEMENT;
  if (envValue === 'gate' || envValue === 'advisory' || envValue === 'off') return envValue;
  return configValue ?? 'gate';
}

/**
 * Resolve IDLE strictness with precedence: env > file/config > default.
 * `MDOCS_ENFORCEMENT_IDLE=readonly` tightens IDLE to read-only; `open` is
 * the 0.4.2 default.
 */
function resolveIdleStrictness(configValue?: IdleStrictness): IdleStrictness {
  const envValue = typeof process !== 'undefined' && process.env?.MDOCS_ENFORCEMENT_IDLE;
  if (envValue === 'readonly' || envValue === 'open') return envValue;
  return configValue ?? 'open';
}

function isDirectory(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}
