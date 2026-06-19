import * as fs from 'fs';
import * as path from 'path';
import { MdocsContract } from './contract';
import { Initiative, parseFrontmatter, PlanItemStatus, Status } from './types';

function parseSection(content: string, sectionName: string): string {
  const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = content.match(new RegExp(`## ${escaped}\\n([\\s\\S]*?)(?=\\n## |$)`));
  return match ? match[1].trim() : '';
}

function parseListSection(content: string, sectionName: string): string[] {
  const section = parseSection(content, sectionName);
  return section.split('\n').filter(line => line.trim().startsWith('- ')).map(line => line.replace(/^- /, '').trim());
}

function parsePlanItem(line: string): { description: string; status: PlanItemStatus } {
  const checkableMatch = line.match(/^- \[([ x/])\]\s*(.+)$/);
  if (checkableMatch) {
    const mark = checkableMatch[1];
    return { description: checkableMatch[2].trim(), status: mark === 'x' ? 'done' : mark === '/' ? 'in-progress' : 'pending' };
  }
  const plainMatch = line.match(/^- \s*(.+)$/);
  return { description: (plainMatch?.[1] || line).trim(), status: 'pending' };
}

function parsePlanSection(content: string): { description: string; status: PlanItemStatus }[] {
  const section = parseSection(content, 'Plan');
  return section.split('\n').filter(line => line.trim().startsWith('- ')).map(line => parsePlanItem(line));
}

function titleize(slug: string): string {
  return slug.split(/[-_]+/).filter(Boolean).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

export function normalizeInitiativeStatus(status: string | undefined): Status {
  const value = (status || 'active').toLowerCase();
  if (['done', 'complete', 'completed'].includes(value)) return 'done';
  if (['archived', 'archive'].includes(value)) return 'archived';
  if (['paused', 'blocked', 'hold', 'on-hold', 'on_hold'].includes(value)) return 'paused';
  return 'active';
}

export interface InitiativeRecord {
  key: string;
  filePath: string;
  sourceKind: 'flat-file' | 'directory-status';
  archived: boolean;
  rawFrontmatter: Record<string, any>;
  initiative: Initiative;
}

export class InitiativeStore {
  private initiativesDir: string;

  constructor(private readonly baseDir: string, private readonly contract: MdocsContract) {
    this.initiativesDir = path.join(baseDir, 'initiatives');
  }

  list(options: { includeArchived?: boolean } = {}): InitiativeRecord[] {
    const records: InitiativeRecord[] = [];
    if (!fs.existsSync(this.initiativesDir)) return records;

    if (this.contract.initiativeMode === 'directory') {
      records.push(...this.listDirectoryRecords(false));
      if (options.includeArchived) records.push(...this.listDirectoryRecords(true));
      if (this.contract.legacyFlatFiles) records.push(...this.listFlatRecords());
      return records;
    }

    return this.listFlatRecords();
  }

  read(key: string): InitiativeRecord | null {
    return this.list({ includeArchived: true }).find(record => record.key === key || record.initiative.id === key) || null;
  }

  markDone(key: string, timestamp = new Date()): { key: string; filePath: string; initiative: Initiative } {
    const record = this.read(key);
    if (!record || record.sourceKind !== 'directory-status' || record.archived) {
      throw new Error(`Directory initiative not found: ${key}`);
    }
    const date = timestamp.toISOString().split('T')[0];
    this.updateStatusFile(record.filePath, {
      status: 'complete',
      updated: date,
      completed: record.rawFrontmatter.completed || date
    }, `[${timestamp.toISOString()}] Marked done via mdocs command`);
    const updated = this.read(record.key);
    if (!updated) throw new Error(`Directory initiative not found after update: ${key}`);
    return { key: record.key, filePath: record.filePath, initiative: updated.initiative };
  }

  archive(key: string): { archivedFilename: string; sourcePath: string; targetPath: string } {
    const record = this.read(key);
    if (!record || record.sourceKind !== 'directory-status' || record.archived) {
      throw new Error(`Directory initiative not found: ${key}`);
    }
    if (record.initiative.status !== 'done') throw new Error(`Only done initiatives can be archived: ${record.initiative.id}`);
    const slug = this.safeDirectoryKey(record.key);
    const sourcePath = path.join(this.initiativesDir, slug);
    const archiveDir = path.join(this.initiativesDir, '_archive');
    const targetPath = path.join(archiveDir, slug);
    if (!fs.existsSync(sourcePath)) throw new Error(`Directory initiative not found: ${key}`);
    if (fs.existsSync(targetPath)) throw new Error(`Archived initiative already exists: ${slug}`);
    fs.mkdirSync(archiveDir, { recursive: true });
    this.updateStatusFile(record.filePath, {
      status: 'archived',
      updated: new Date().toISOString().split('T')[0]
    });
    fs.renameSync(sourcePath, targetPath);
    return { archivedFilename: slug, sourcePath, targetPath };
  }

  findById(id: string, options: { includeArchived?: boolean } = {}): InitiativeRecord | null {
    return this.list(options).find(record => record.initiative.id === id) || null;
  }

  findByQuery(query: string): InitiativeRecord | null {
    const normalizedQuery = query.toLowerCase();
    const querySlug = slugify(query);
    return this.list({ includeArchived: true }).find(record => {
      const initiative = record.initiative;
      const keySlug = slugify(record.key.replace(/\.md$/, '').replace(/--\d{4}-\d{2}-\d{2}$/, ''));
      const idSlug = slugify(initiative.id || '');
      const titleSlug = slugify(initiative.title || '');
      return initiative.id === query ||
        idSlug === querySlug ||
        initiative.title.toLowerCase().includes(normalizedQuery) ||
        titleSlug === querySlug ||
        record.key === query ||
        keySlug === querySlug;
    }) || null;
  }

  private listFlatRecords(): InitiativeRecord[] {
    if (!fs.existsSync(this.initiativesDir)) return [];
    return fs.readdirSync(this.initiativesDir)
      .filter(file => file.endsWith('.md') && file !== 'INDEX.md')
      .flatMap(file => {
        const filePath = path.join(this.initiativesDir, file);
        try {
          return [this.parseRecord(file, filePath, 'flat-file', false, file.replace(/\.md$/, ''))];
        } catch {
          return [];
        }
      });
  }

  private listDirectoryRecords(archived: boolean): InitiativeRecord[] {
    const parent = archived ? path.join(this.initiativesDir, '_archive') : this.initiativesDir;
    if (!fs.existsSync(parent)) return [];
    return fs.readdirSync(parent, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name !== 'archive' && entry.name !== '_archive')
      .flatMap(entry => {
        const statusPath = path.join(parent, entry.name, '_status.md');
        if (!fs.existsSync(statusPath)) return [];
        try {
          const key = archived ? `_archive/${entry.name}` : entry.name;
          return [this.parseRecord(key, statusPath, 'directory-status', archived, entry.name)];
        } catch {
          return [];
        }
      });
  }

  private parseRecord(key: string, filePath: string, sourceKind: 'flat-file' | 'directory-status', archived: boolean, slug: string): InitiativeRecord {
    const content = fs.readFileSync(filePath, 'utf8');
    const front = parseFrontmatter(content);
    if (!Object.keys(front).length) throw new Error(`Invalid initiative format: ${key}`);
    const body = content.replace(/---\r?\n[\s\S]*?\r?\n---/, '').trim();
    const objective = parseSection(body, 'Objective') || body;
    const created = front.created || front.started || '';
    const initiative: Initiative = {
      id: front.id || slug,
      title: front.title || titleize(slug),
      status: normalizeInitiativeStatus(front.status),
      priority: front.priority || 'medium',
      created,
      updated: front.updated || front.modified || created,
      owner: front.owner || '',
      tags: Array.isArray(front.tags) ? front.tags : [],
      relatedWiki: Array.isArray(front.related_wiki) ? front.related_wiki : [],
      objective,
      plan: parsePlanSection(body),
      progressLog: parseListSection(body, 'Progress Log'),
      artifacts: parseListSection(body, 'Artifacts'),
      dueDate: front.due_date || undefined,
      dependsOn: Array.isArray(front.depends_on) ? front.depends_on : undefined,
      phase: front.phase || undefined,
      handoffSummary: front.handoff_summary || undefined,
      openQuestions: Array.isArray(front.open_questions) ? front.open_questions : undefined,
      blockers: Array.isArray(front.blockers) ? front.blockers : undefined,
      nextAction: front.next_action || undefined
    };
    return { key, filePath, sourceKind, archived, rawFrontmatter: front, initiative };
  }

  private safeDirectoryKey(key: string): string {
    const base = path.basename(key);
    if (!base || base === '.' || base === '..' || base !== key || key.includes('/') || key.includes('\\')) {
      throw new Error(`Invalid directory initiative key: ${key}`);
    }
    return base;
  }

  private updateStatusFile(filePath: string, updates: Record<string, string>, progressNote?: string): void {
    const content = fs.readFileSync(filePath, 'utf8');
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n?)([\s\S]*)$/);
    if (!match) throw new Error(`Invalid initiative status format: ${filePath}`);
    const newline = content.includes('\r\n') ? '\r\n' : '\n';
    const lines = match[1].split(/\r?\n/);
    for (const [key, value] of Object.entries(updates)) {
      const index = lines.findIndex(line => line.match(new RegExp(`^${key}:`)));
      const nextLine = `${key}: ${value}`;
      if (index >= 0) lines[index] = nextLine;
      else lines.push(nextLine);
    }
    let body = match[3] || '';
    if (progressNote) body = this.appendProgressNote(body, progressNote, newline);
    fs.writeFileSync(filePath, `---${newline}${lines.join(newline)}${newline}---${newline}${body.replace(/^\r?\n/, '')}`, 'utf8');
  }

  private appendProgressNote(body: string, progressNote: string, newline: string): string {
    const noteLine = `- ${progressNote}`;
    if (/## Progress Log\r?\n/.test(body)) {
      return body.replace(/(## Progress Log\r?\n)/, `$1${noteLine}${newline}`);
    }
    const separator = body.trim().length > 0 ? `${newline}${newline}` : '';
    return `${body.replace(/\s*$/, '')}${separator}## Progress Log${newline}${noteLine}${newline}`;
  }
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
