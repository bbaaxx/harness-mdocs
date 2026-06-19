import * as fs from 'fs';
import * as path from 'path';
import { detectMdocsContract, MdocsCompatibilityConfig, MdocsContract } from '../contract';
import { InitiativeStore, normalizeInitiativeStatus } from '../initiative-store';
import { Initiative, PlanItem, PlanItemStatus, parseFrontmatter } from '../types';

export interface InitiativeManagerOptions {
  compatibility?: MdocsCompatibilityConfig;
}

function parseSection(content: string, sectionName: string): string {
  const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = content.match(new RegExp(`## ${escaped}\\n([\\s\\S]*?)(?=\\n## |$)`));
  return match ? match[1].trim() : '';
}

function parseListSection(content: string, sectionName: string): string[] {
  const section = parseSection(content, sectionName);
  return section.split('\n').filter(line => line.trim().startsWith('- ')).map(line => line.replace(/^- /, '').trim());
}

function formatPlanItem(item: { description: string; status: string }): string {
  const statusMap: Record<string, string> = {
    'pending': '- [ ]',
    'in-progress': '- [/]',
    'done': '- [x]'
  };
  const prefix = statusMap[item.status] || '- [ ]';
  return `${prefix} ${item.description}`;
}

function parsePlanItem(line: string): { description: string; status: PlanItemStatus } {
  // Match checkable items: - [ ] desc, - [/] desc, - [x] desc
  const checkableMatch = line.match(/^- \[([ x/])\]\s*(.+)$/);
  if (checkableMatch) {
    const mark = checkableMatch[1];
    const description = checkableMatch[2].trim();
    const status: PlanItemStatus = mark === 'x' ? 'done' : mark === '/' ? 'in-progress' : 'pending';
    return { description, status };
  }
  // Backward compatibility: plain list item - Description
  const plainMatch = line.match(/^- \s*(.+)$/);
  if (plainMatch) {
    return { description: plainMatch[1].trim(), status: 'pending' };
  }
  return { description: line.trim(), status: 'pending' };
}

function parsePlanSection(content: string): { description: string; status: PlanItemStatus }[] {
  const section = parseSection(content, 'Plan');
  return section.split('\n')
    .filter(line => line.trim().startsWith('- '))
    .map(line => parsePlanItem(line));
}

function isSafePathSegment(segment: string): boolean {
  return !!segment && segment !== '.' && segment !== '..' && path.basename(segment) === segment;
}

export class InitiativeManager {
  private dir: string;
  private contract: MdocsContract;
  private store: InitiativeStore;

  constructor(baseDir: string, options: InitiativeManagerOptions = {}) {
    this.dir = path.join(baseDir, 'initiatives');
    this.contract = detectMdocsContract(baseDir, options.compatibility);
    this.store = new InitiativeStore(baseDir, this.contract);
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private slugify(title: string): string {
    return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  private formatFileName(initiative: Initiative): string {
    const idSlug = this.slugify(initiative.id || '');
    const slug = idSlug || this.slugify(initiative.title);
    return `${slug}--${initiative.created}.md`;
  }

  private sanitizeFileName(fileName: string): string {
    const base = path.basename(fileName);
    if (!base || base === '.' || base === '..') {
      return 'invalid.md'; // Return a safe fallback that won't match real files
    }
    return base;
  }

  private toFrontmatter(initiative: Initiative): string {
    // Note: YAML frontmatter uses snake_case
    const front: Record<string, any> = {
      id: initiative.id,
      title: initiative.title,
      status: initiative.status,
      created: initiative.created,
      updated: initiative.updated,
      owner: initiative.owner,
      tags: initiative.tags,
      related_wiki: initiative.relatedWiki,
    };
    if (initiative.priority) {
      front.priority = initiative.priority;
    }
    if (initiative.dueDate) {
      front.due_date = initiative.dueDate;
    }
    if (initiative.dependsOn && initiative.dependsOn.length > 0) {
      front.depends_on = initiative.dependsOn;
    }
    if (initiative.phase) front.phase = initiative.phase;
    if (initiative.handoffSummary) front.handoff_summary = initiative.handoffSummary;
    if (initiative.openQuestions && initiative.openQuestions.length > 0) front.open_questions = initiative.openQuestions;
    if (initiative.blockers && initiative.blockers.length > 0) front.blockers = initiative.blockers;
    if (initiative.nextAction) front.next_action = initiative.nextAction;
    return `---\n${Object.entries(front).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n---\n\n`;
  }

  private initiativeFiles(): string[] {
    return fs.readdirSync(this.dir).filter(f => f.endsWith('.md') && f !== 'INDEX.md');
  }

  private assertUniqueId(id: string, ignoreFileName?: string): void {
    if (!id) return;
    const ignored = ignoreFileName ? path.resolve(this.dir, this.sanitizeFileName(ignoreFileName)) : '';
    for (const fileName of this.initiativeFiles()) {
      if (ignored && path.resolve(this.dir, fileName) === ignored) continue;
      try {
        const existing = this.read(fileName);
        if (existing?.id === id) {
          throw new Error(`Duplicate initiative id "${id}" found in ${fileName}`);
        }
      } catch (err: any) {
        if (err.message?.startsWith('Duplicate initiative id')) throw err;
      }
    }
  }

  create(initiative: Initiative): string {
    const fileName = this.formatFileName(initiative);
    const filePath = path.join(this.dir, fileName);

    if (fs.existsSync(filePath)) {
      throw new Error(`Initiative file already exists: ${fileName}`);
    }

    this.assertUniqueId(initiative.id);

    const content = this.toFrontmatter(initiative) +
      `## Objective\n${initiative.objective}\n\n` +
      `## Plan\n${initiative.plan.map(p => formatPlanItem(p)).join('\n')}\n\n` +
      `## Progress Log\n${initiative.progressLog.map(l => `- ${l}`).join('\n')}\n\n` +
      `## Artifacts\n${initiative.artifacts.map(a => `- ${a}`).join('\n')}`;

    fs.writeFileSync(filePath, content, 'utf8');
    this.updateIndex();
    return filePath;
  }

  read(fileName: string): Initiative | null {
    const sanitized = this.sanitizeFileName(fileName);
    const filePath = path.join(this.dir, sanitized);
    if (!fs.existsSync(filePath)) {
      return this.contract.initiativeMode === 'directory' ? this.store.read(fileName)?.initiative || null : null;
    }
    const content = fs.readFileSync(filePath, 'utf8');
    return this.parseInitiative(content, fileName);
  }

  private parseInitiative(content: string, fileName: string): Initiative {
    const front = parseFrontmatter(content);
    if (!Object.keys(front).length) throw new Error(`Invalid initiative format: ${fileName}`);

    // Extract markdown body after frontmatter
    const body = content.replace(/---\n[\s\S]*?\n---/, '').trim();

    return {
      id: front.id || '',
      title: front.title || '',
      status: normalizeInitiativeStatus(front.status),
      priority: front.priority || 'medium',
      created: front.created || '',
      updated: front.updated || '',
      owner: front.owner || '',
      tags: Array.isArray(front.tags) ? front.tags : [],
      relatedWiki: Array.isArray(front.related_wiki) ? front.related_wiki : [],
      // Parse markdown sections
      objective: parseSection(body, 'Objective'),
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
  }

  update(fileName: string, initiative: Initiative): string {
    const sanitized = this.sanitizeFileName(fileName);
    this.assertUniqueId(initiative.id, sanitized);
    const oldPath = path.join(this.dir, sanitized);
    const newFileName = this.formatFileName(initiative);
    const newPath = path.join(this.dir, newFileName);

    // If the filename is changing, delete old first only if new doesn't exist
    if (oldPath !== newPath) {
      if (fs.existsSync(newPath)) {
        throw new Error(`Cannot update: target file already exists: ${newFileName}`);
      }
      if (fs.existsSync(oldPath)) {
        fs.unlinkSync(oldPath);
      }
    }

    // Write the file (will overwrite if same name, which is expected for updates)
    const content = this.toFrontmatter(initiative) +
      `## Objective\n${initiative.objective}\n\n` +
      `## Plan\n${initiative.plan.map(p => formatPlanItem(p)).join('\n')}\n\n` +
      `## Progress Log\n${initiative.progressLog.map(l => `- ${l}`).join('\n')}\n\n` +
      `## Artifacts\n${initiative.artifacts.map(a => `- ${a}`).join('\n')}`;

    fs.writeFileSync(newPath, content, 'utf8');
    this.updateIndex();
    return newPath;
  }

  delete(fileName: string): void {
    const sanitized = this.sanitizeFileName(fileName);
    const filePath = path.join(this.dir, sanitized);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      this.updateIndex();
    }
  }

  syncIndex(): string {
    if (this.contract.initiativeMode === 'directory') {
      return path.join(this.dir, 'INDEX.md');
    }
    this.updateIndex();
    return path.join(this.dir, 'INDEX.md');
  }

  archive(fileName: string): { archivedFilename: string; archiveIndex: string } {
    const sanitized = this.sanitizeFileName(fileName);
    const sourcePath = path.join(this.dir, sanitized);
    if (!fs.existsSync(sourcePath)) throw new Error(`Initiative file not found: ${sanitized}`);
    const initiative = this.read(sanitized);
    if (!initiative) throw new Error(`Initiative file not found: ${sanitized}`);
    if (initiative.status !== 'done') throw new Error(`Only done initiatives can be archived: ${initiative.id}`);

    const archiveDir = path.join(this.dir, 'archive');
    fs.mkdirSync(archiveDir, { recursive: true });
    const targetPath = path.join(archiveDir, sanitized);
    if (fs.existsSync(targetPath)) throw new Error(`Archived initiative already exists: ${sanitized}`);

    fs.renameSync(sourcePath, targetPath);
    this.updateIndex();
    this.updateArchiveIndex();
    return { archivedFilename: sanitized, archiveIndex: path.join(archiveDir, 'INDEX.md') };
  }

  findById(id: string): Initiative | null {
    return this.store.findById(id)?.initiative || null;
  }

  findKeyById(id: string): string | null {
    return this.store.findById(id, { includeArchived: true })?.key || null;
  }

  findByQuery(query: string): { initiative: Initiative; key: string } | null {
    const record = this.store.findByQuery(query);
    return record ? { initiative: record.initiative, key: record.key } : null;
  }

  list(includeArchived = false): Initiative[] {
    return this.store.list({ includeArchived }).map(record => record.initiative);
  }

  findRelated(queryTags: string[]): Initiative[] {
    const files = fs.readdirSync(this.dir).filter(f => f.endsWith('.md') && f !== 'INDEX.md');
    const initiatives: Initiative[] = [];
    for (const f of files) {
      try {
        const init = this.read(f);
        if (init) initiatives.push(init);
      } catch {
        // Skip malformed files
      }
    }
    return initiatives.filter(i => i.tags.some(t => queryTags.includes(t)));
  }

  findBlocked(): Initiative[] {
    const all = this.listAll();
    return all.filter(i => {
      if (!i.dependsOn || i.dependsOn.length === 0) return false;
      return i.dependsOn.some(depId => {
        const dep = all.find(d => d.id === depId);
        return dep && dep.status !== 'done';
      });
    });
  }

  findOverdue(): Initiative[] {
    const today = new Date().toISOString().split('T')[0];
    return this.listAll().filter(i => {
      if (!i.dueDate || i.status === 'done') return false;
      return i.dueDate < today;
    });
  }

  listByPriority(): Initiative[] {
    const priorityOrder: Record<string, number> = {
      'critical': 0,
      'high': 1,
      'medium': 2,
      'low': 3
    };
    return this.listAll().sort((a, b) => {
      const priA = priorityOrder[a.priority || 'medium'] ?? 2;
      const priB = priorityOrder[b.priority || 'medium'] ?? 2;
      if (priA !== priB) return priA - priB;
      // If same priority, sort by due date (earliest first)
      if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
      if (a.dueDate) return -1;
      if (b.dueDate) return 1;
      return 0;
    });
  }

  validate(): { valid: boolean; errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];
    const ids = new Map<string, string>();
    const files = this.initiativeFiles();
    const wikiRoot = path.join(path.dirname(this.dir), 'wiki');

    for (const fileName of files) {
      let initiative: Initiative;
      let front: Record<string, any> = {};
      try {
        const content = fs.readFileSync(path.join(this.dir, fileName), 'utf8');
        const match = content.match(/---\n([\s\S]*?)\n---/);
        if (match) {
          for (const line of match[1].split('\n')) {
            const [key, ...valueParts] = line.split(':');
            if (key && valueParts.length > 0) {
              const value = valueParts.join(':').trim();
              try {
                front[key.trim()] = JSON.parse(value);
              } catch {
                front[key.trim()] = value;
              }
            }
          }
        }
        const parsed = this.read(fileName);
        if (!parsed) continue;
        initiative = parsed;
      } catch (err: any) {
        errors.push(`${fileName} invalid initiative format: ${err.message || String(err)}`);
        continue;
      }

      if (!front.id) errors.push(`${fileName} missing id`);
      if (!front.title) errors.push(`${fileName} missing title`);
      if (!front.status) errors.push(`${fileName} missing status`);
      if (!front.created) errors.push(`${fileName} missing created`);

      if (initiative.id) {
        const firstFile = ids.get(initiative.id);
        if (firstFile) {
          errors.push(`Duplicate initiative id "${initiative.id}" in ${firstFile} and ${fileName}`);
        } else {
          ids.set(initiative.id, fileName);
        }
      }

      for (const ref of initiative.relatedWiki || []) {
        if (typeof ref !== 'string') {
          warnings.push(`${fileName} has non-string wiki reference: ${String(ref)}`);
          continue;
        }
        const [category, id, ...rest] = ref.split('/');
        if (!isSafePathSegment(category) || !isSafePathSegment(id) || rest.length > 0) {
          warnings.push(`${fileName} has unsafe wiki reference: ${ref}`);
        } else if (!fs.existsSync(path.join(wikiRoot, category, `${id}.md`))) {
          warnings.push(`${fileName} references missing wiki entry: ${ref}`);
        }
      }
    }

    const indexPath = path.join(this.dir, 'INDEX.md');
    if (fs.existsSync(indexPath)) {
      const indexContent = fs.readFileSync(indexPath, 'utf8');
      const listed = new Set(Array.from(indexContent.matchAll(/[\w.-]+\.md/g)).map(match => match[0]).filter(name => name !== 'INDEX.md'));
      const actual = new Set(files);
      for (const listedFile of listed) {
        if (!actual.has(listedFile)) warnings.push(`INDEX.md lists missing initiative file: ${listedFile}`);
      }
      for (const actualFile of actual) {
        if (!listed.has(actualFile)) warnings.push(`INDEX.md missing initiative file: ${actualFile}`);
      }
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  checkConsistency(): { consistent: boolean; missing: string[]; orphans: string[]; stale: boolean } {
    const missing: string[] = [];
    const orphans: string[] = [];
    let stale = false;

    if (this.contract.initiativeMode === 'directory') {
      return { consistent: true, missing, orphans, stale };
    }

    const indexPath = path.join(this.dir, 'INDEX.md');
    if (!fs.existsSync(indexPath)) {
      return { consistent: false, missing: ['INDEX.md missing'], orphans: [], stale: true };
    }

    const indexContent = fs.readFileSync(indexPath, 'utf8');
    const listed = new Set(Array.from(indexContent.matchAll(/[\w.-]+\.md/g)).map(match => match[0]).filter(name => name !== 'INDEX.md'));
    const actualFiles = this.initiativeFiles();
    const actual = new Set(actualFiles);

    for (const listedFile of listed) {
      if (!actual.has(listedFile)) {
        missing.push(listedFile);
      }
    }

    for (const actualFile of actualFiles) {
      if (!listed.has(actualFile)) {
        orphans.push(actualFile);
      }
    }

    // Check staleness: compare INDEX mtime with latest initiative mtime
    const indexMtime = fs.statSync(indexPath).mtimeMs;
    for (const fileName of actualFiles) {
      const filePath = path.join(this.dir, fileName);
      const fileMtime = fs.statSync(filePath).mtimeMs;
      if (fileMtime > indexMtime) {
        stale = true;
        break;
      }
    }

    return {
      consistent: missing.length === 0 && orphans.length === 0 && !stale,
      missing,
      orphans,
      stale
    };
  }

  private listAll(): Initiative[] {
    return this.list();
  }

  private updateArchiveIndex(): void {
    const archiveDir = path.join(this.dir, 'archive');
    fs.mkdirSync(archiveDir, { recursive: true });
    const files = fs.readdirSync(archiveDir).filter(f => f.endsWith('.md') && f !== 'INDEX.md');
    const entries: { initiative: Initiative; fileName: string }[] = [];
    for (const f of files) {
      try {
        const content = fs.readFileSync(path.join(archiveDir, f), 'utf8');
        const init = this.parseInitiative(content, f);
        entries.push({ initiative: init, fileName: f });
      } catch {
      }
    }
    const lines = entries.map(({ initiative: i, fileName }) => `- **${i.title}** (${i.status}) — ${fileName} — ${i.created} — [${i.tags.join(', ')}]`);
    fs.writeFileSync(path.join(archiveDir, 'INDEX.md'), `# Archived Initiatives\n\n${lines.join('\n') || 'No archived initiatives yet.'}`, 'utf8');
  }

  private writeIndexMeta(): void {
    const metaPath = path.join(path.dirname(this.dir), '.index-meta.json');
    const meta = { lastSync: new Date().toISOString() };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
  }

  private updateIndex(): void {
    if (this.contract.initiativeMode === 'directory') {
      return;
    }
    const files = this.initiativeFiles();
    const entries: { initiative: Initiative; fileName: string }[] = [];
    for (const f of files) {
      try {
        const init = this.read(f);
        if (init) entries.push({ initiative: init, fileName: f });
      } catch {
        // Skip malformed files
      }
    }
    const lines = entries.map(({ initiative: i, fileName }) => `- **${i.title}** (${i.status}) — ${fileName} — ${i.created} — [${i.tags.join(', ')}]`);
    const index = `# Initiatives\n\n${lines.join('\n') || 'No initiatives yet.'}`;
    fs.writeFileSync(path.join(this.dir, 'INDEX.md'), index, 'utf8');
    this.writeIndexMeta();
  }
}
