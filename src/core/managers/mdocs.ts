import * as fs from 'fs';
import * as path from 'path';

export class MdocsManager {
  private baseDir: string;

  constructor(baseDir: string) {
    if (!baseDir || typeof baseDir !== 'string') {
      throw new Error('baseDir must be a non-empty string');
    }
    this.baseDir = path.resolve(baseDir);
  }

  init(): void {
    const initiativesDir = path.join(this.baseDir, 'initiatives');
    const wikiDir = path.join(this.baseDir, 'wiki');

    fs.mkdirSync(initiativesDir, { recursive: true });
    fs.mkdirSync(wikiDir, { recursive: true });

    this.writeIndex(path.join(initiativesDir, 'INDEX.md'), '# Initiatives\n\nNo initiatives yet.');
    this.writeIndex(path.join(wikiDir, 'INDEX.md'), '# Wiki\n\nNo entries yet.');
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
    const wikiIndex = path.join(wikiPath, 'INDEX.md');

    return fs.existsSync(initiativesPath) &&
           fs.existsSync(wikiPath) &&
           fs.existsSync(initiativesIndex) &&
           fs.existsSync(wikiIndex) &&
           fs.statSync(initiativesPath).isDirectory() &&
           fs.statSync(wikiPath).isDirectory();
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
