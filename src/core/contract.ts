import * as fs from 'fs';
import * as path from 'path';

export type InitiativeMode = 'flat' | 'directory' | 'auto';
export type WikiIndexMode = 'generated-uppercase' | 'canonical-lowercase' | 'none' | 'auto';
export type ArchiveDirMode = 'archive' | '_archive' | 'auto';
export type IndexOwner = 'harness' | 'external' | 'none';

export interface MdocsCompatibilityConfig {
  initiativeMode?: InitiativeMode;
  wikiIndexMode?: WikiIndexMode;
  archiveDir?: ArchiveDirMode;
  legacyFlatFiles?: boolean | 'auto';
}

export interface MdocsContract {
  initiativeMode: Exclude<InitiativeMode, 'auto'>;
  wikiIndexMode: Exclude<WikiIndexMode, 'auto'>;
  archiveDir: Exclude<ArchiveDirMode, 'auto'>;
  legacyFlatFiles: boolean;
  wikiIndexOwner: IndexOwner;
}

function safeExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
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

  const wikiIndexOwner: IndexOwner = wikiIndexMode === 'generated-uppercase'
    ? 'harness'
    : wikiIndexMode === 'canonical-lowercase'
      ? 'external'
      : 'none';

  return {
    initiativeMode,
    wikiIndexMode,
    archiveDir,
    legacyFlatFiles,
    wikiIndexOwner
  };
}
