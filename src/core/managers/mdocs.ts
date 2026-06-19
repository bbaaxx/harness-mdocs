import * as fs from 'fs';
import * as path from 'path';
import { detectMdocsContract, MdocsCompatibilityConfig, MdocsContract } from '../contract';

export class MdocsManager {
  private baseDir: string;
  private contract: MdocsContract;

  constructor(baseDir: string, compatibility: MdocsCompatibilityConfig = {}) {
    if (!baseDir || typeof baseDir !== 'string') {
      throw new Error('baseDir must be a non-empty string');
    }
    this.baseDir = path.resolve(baseDir);
    this.contract = detectMdocsContract(this.baseDir, compatibility);
  }

  init(): void {
    const initiativesDir = path.join(this.baseDir, 'initiatives');
    const wikiDir = path.join(this.baseDir, 'wiki');

    fs.mkdirSync(initiativesDir, { recursive: true });
    fs.mkdirSync(wikiDir, { recursive: true });

    this.writeIndex(path.join(initiativesDir, 'INDEX.md'), '# Initiatives\n\nNo initiatives yet.');
    if (this.contract.wikiIndexMode === 'generated-uppercase') {
      this.writeIndex(path.join(wikiDir, 'INDEX.md'), '# Wiki\n\nNo entries yet.');
    } else if (this.contract.wikiIndexMode === 'canonical-lowercase') {
      this.writeIndex(path.join(wikiDir, 'index.md'), '# Wiki\n\nNo entries yet.');
    }
  }

  private writeIndex(filePath: string, content: string): void {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, content, 'utf8');
    }
  }

  exists(): boolean {
    const initiativesPath = path.join(this.baseDir, 'initiatives');
    const wikiPath = path.join(this.baseDir, 'wiki');
    const initiativesIndex = path.join(initiativesPath, 'INDEX.md');
    const wikiIndex = this.contract.wikiIndexMode === 'canonical-lowercase'
      ? path.join(wikiPath, 'index.md')
      : path.join(wikiPath, 'INDEX.md');
    const hasDirectoryInitiative = this.hasDirectoryInitiative(initiativesPath);

    return fs.existsSync(initiativesPath) &&
           fs.existsSync(wikiPath) &&
           fs.statSync(initiativesPath).isDirectory() &&
           fs.statSync(wikiPath).isDirectory() &&
           (fs.existsSync(initiativesIndex) || this.contract.initiativeMode === 'directory' || hasDirectoryInitiative) &&
           (this.contract.wikiIndexMode === 'none' || fs.existsSync(wikiIndex));
  }

  private hasDirectoryInitiative(initiativesPath: string): boolean {
    if (!fs.existsSync(initiativesPath) || !fs.statSync(initiativesPath).isDirectory()) return false;
    return fs.readdirSync(initiativesPath, { withFileTypes: true }).some(entry => {
      if (!entry.isDirectory() || entry.name === 'archive' || entry.name === '_archive') return false;
      return fs.existsSync(path.join(initiativesPath, entry.name, '_status.md'));
    });
  }

  private getMetaPath(): string {
    return path.join(this.baseDir, '.index-meta.json');
  }

  writeIndexMeta(): void {
    const metaPath = this.getMetaPath();
    const meta = { lastSync: new Date().toISOString() };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
  }

  readIndexMeta(): { lastSync: string | null } {
    const metaPath = this.getMetaPath();
    if (!fs.existsSync(metaPath)) {
      return { lastSync: null };
    }
    try {
      const content = fs.readFileSync(metaPath, 'utf8');
      const meta = JSON.parse(content);
      return { lastSync: meta.lastSync || null };
    } catch {
      return { lastSync: null };
    }
  }
}
