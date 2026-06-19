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
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
