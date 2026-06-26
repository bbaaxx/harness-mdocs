"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.InitiativeStore = void 0;
exports.normalizeInitiativeStatus = normalizeInitiativeStatus;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const types_1 = require("./types");
// Lifecycle keys honored under metadata-only mode. Core bookkeeping keys
// (status/updated/completed/graduated) are added-or-updated so lifecycle
// events (markDone, graduate) still record their metadata on a thin consumer
// file. Optional descriptive keys (next_action) are rewritten only when
// already present, never injected. Structural identity keys
// (id/title/owner/related_wiki/tags) are never added and preserved verbatim.
const METADATA_ONLY_CORE_LIFECYCLE_KEYS = new Set([
    'status',
    'updated',
    'completed',
    'graduated'
]);
const METADATA_ONLY_OPTIONAL_LIFECYCLE_KEYS = new Set([
    'next_action'
]);
function parseSection(content, sectionName) {
    const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = content.match(new RegExp(`## ${escaped}\\n([\\s\\S]*?)(?=\\n## |$)`));
    return match ? match[1].trim() : '';
}
function parseListSection(content, sectionName) {
    const section = parseSection(content, sectionName);
    return section.split('\n').filter(line => line.trim().startsWith('- ')).map(line => line.replace(/^- /, '').trim());
}
function parsePlanItem(line) {
    const checkableMatch = line.match(/^- \[([ x/])\]\s*(.+)$/);
    if (checkableMatch) {
        const mark = checkableMatch[1];
        return { description: checkableMatch[2].trim(), status: mark === 'x' ? 'done' : mark === '/' ? 'in-progress' : 'pending' };
    }
    const plainMatch = line.match(/^- \s*(.+)$/);
    return { description: (plainMatch?.[1] || line).trim(), status: 'pending' };
}
function parsePlanSection(content) {
    const section = parseSection(content, 'Plan');
    return section.split('\n').filter(line => line.trim().startsWith('- ')).map(line => parsePlanItem(line));
}
function titleize(slug) {
    return slug.split(/[-_]+/).filter(Boolean).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}
function normalizeInitiativeStatus(status) {
    const value = (status || 'active').toLowerCase();
    // `complete` is the directory-v2 canonical completed value; `done` is the
    // flat-v1 alias. Both mean "completed" — see isCompleted() in ./types.
    if (['complete', 'completed'].includes(value))
        return 'complete';
    if (value === 'done')
        return 'done';
    if (['archived', 'archive'].includes(value))
        return 'archived';
    if (['paused', 'blocked', 'hold', 'on-hold', 'on_hold'].includes(value))
        return 'paused';
    return 'active';
}
const ALLOWED_EXPECTED_DURATIONS = new Set(['normal', 'long', 'suppress']);
function coerceExpectedDuration(raw) {
    if (typeof raw !== 'string')
        return undefined;
    const value = raw.toLowerCase();
    return ALLOWED_EXPECTED_DURATIONS.has(value) ? value : undefined;
}
class InitiativeStore {
    baseDir;
    contract;
    initiativesDir;
    constructor(baseDir, contract) {
        this.baseDir = baseDir;
        this.contract = contract;
        this.initiativesDir = path.join(baseDir, 'initiatives');
    }
    list(options = {}) {
        const records = [];
        if (!fs.existsSync(this.initiativesDir))
            return records;
        if (this.contract.initiativeMode === 'directory') {
            records.push(...this.listDirectoryRecords(false));
            if (options.includeArchived)
                records.push(...this.listDirectoryRecords(true));
            if (this.contract.legacyFlatFiles)
                records.push(...this.listFlatRecords());
            return records;
        }
        return this.listFlatRecords();
    }
    read(key) {
        return this.list({ includeArchived: true }).find(record => record.key === key || record.initiative.id === key) || null;
    }
    create(initiative) {
        const key = this.safeDirectoryKey(slugify(initiative.id || initiative.title));
        if (this.findById(initiative.id, { includeArchived: true }) || this.read(key)) {
            throw new Error(`Initiative already exists: ${initiative.id || key}`);
        }
        const dirPath = path.join(this.initiativesDir, key);
        const filePath = path.join(dirPath, '_status.md');
        if (fs.existsSync(dirPath))
            throw new Error(`Initiative directory already exists: ${key}`);
        fs.mkdirSync(dirPath, { recursive: true });
        fs.writeFileSync(filePath, this.formatStatusFile(initiative), 'utf8');
        const record = this.read(key);
        if (!record)
            throw new Error(`Directory initiative not found after create: ${key}`);
        return { key, dirPath, filePath, initiative: record.initiative };
    }
    update(key, initiative, progressNote) {
        const record = this.read(key);
        if (!record || record.sourceKind !== 'directory-status' || record.archived) {
            throw new Error(`Directory initiative not found: ${key}`);
        }
        const duplicate = this.findById(initiative.id, { includeArchived: true });
        if (duplicate && duplicate.key !== record.key)
            throw new Error(`Duplicate initiative id "${initiative.id}" found in ${duplicate.key}`);
        this.updateStatusFile(record.filePath, this.frontmatterUpdates(initiative), progressNote);
        const updated = this.read(record.key);
        if (!updated)
            throw new Error(`Directory initiative not found after update: ${key}`);
        return { key: record.key, dirPath: path.dirname(record.filePath), filePath: record.filePath, initiative: updated.initiative };
    }
    delete(key) {
        const record = this.read(key);
        if (!record || record.sourceKind !== 'directory-status' || record.archived) {
            throw new Error(`Directory initiative not found: ${key}`);
        }
        const slug = this.safeDirectoryKey(record.key);
        const dirPath = path.join(this.initiativesDir, slug);
        if (!fs.existsSync(dirPath))
            throw new Error(`Directory initiative not found: ${key}`);
        fs.rmSync(dirPath, { recursive: true, force: false });
    }
    markDone(key, timestamp = new Date()) {
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
        if (!updated)
            throw new Error(`Directory initiative not found after update: ${key}`);
        return { key: record.key, filePath: record.filePath, initiative: updated.initiative };
    }
    archive(key) {
        const record = this.read(key);
        if (!record || record.sourceKind !== 'directory-status' || record.archived) {
            throw new Error(`Directory initiative not found: ${key}`);
        }
        if (!(0, types_1.isCompleted)(record.initiative.status))
            throw new Error(`Only completed initiatives can be archived: ${record.initiative.id}`);
        const slug = this.safeDirectoryKey(record.key);
        const sourcePath = path.join(this.initiativesDir, slug);
        const archiveDir = path.join(this.initiativesDir, '_archive');
        const targetPath = path.join(archiveDir, slug);
        if (!fs.existsSync(sourcePath))
            throw new Error(`Directory initiative not found: ${key}`);
        if (fs.existsSync(targetPath))
            throw new Error(`Archived initiative already exists: ${slug}`);
        fs.mkdirSync(archiveDir, { recursive: true });
        this.updateStatusFile(record.filePath, {
            status: 'archived',
            updated: new Date().toISOString().split('T')[0]
        });
        fs.renameSync(sourcePath, targetPath);
        return { archivedFilename: slug, sourcePath, targetPath };
    }
    findById(id, options = {}) {
        return this.list(options).find(record => record.initiative.id === id) || null;
    }
    findByQuery(query) {
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
    listFlatRecords() {
        if (!fs.existsSync(this.initiativesDir))
            return [];
        return fs.readdirSync(this.initiativesDir)
            .filter(file => file.endsWith('.md') && file !== 'INDEX.md')
            .flatMap(file => {
            const filePath = path.join(this.initiativesDir, file);
            try {
                return [this.parseRecord(file, filePath, 'flat-file', false, file.replace(/\.md$/, ''))];
            }
            catch {
                return [];
            }
        });
    }
    listDirectoryRecords(archived) {
        const parent = archived ? path.join(this.initiativesDir, '_archive') : this.initiativesDir;
        if (!fs.existsSync(parent))
            return [];
        return fs.readdirSync(parent, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && entry.name !== 'archive' && entry.name !== '_archive')
            .flatMap(entry => {
            const statusPath = path.join(parent, entry.name, '_status.md');
            if (!fs.existsSync(statusPath))
                return [];
            try {
                const key = archived ? `_archive/${entry.name}` : entry.name;
                return [this.parseRecord(key, statusPath, 'directory-status', archived, entry.name)];
            }
            catch {
                return [];
            }
        });
    }
    parseRecord(key, filePath, sourceKind, archived, slug) {
        const content = fs.readFileSync(filePath, 'utf8');
        const front = (0, types_1.parseFrontmatter)(content);
        if (!Object.keys(front).length)
            throw new Error(`Invalid initiative format: ${key}`);
        const body = content.replace(/---\r?\n[\s\S]*?\r?\n---/, '').trim();
        const objective = parseSection(body, 'Objective') || body;
        const created = front.created || front.started || '';
        const initiative = {
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
            nextAction: front.next_action || undefined,
            expectedDuration: coerceExpectedDuration((0, types_1.readExpectedDurationRaw)(front)),
            graduated: front.graduated || undefined
        };
        return { key, filePath, sourceKind, archived, rawFrontmatter: front, initiative };
    }
    formatStatusFile(initiative) {
        const front = this.frontmatterUpdates(initiative);
        const lines = Object.entries(front).map(([key, value]) => `${key}: ${value}`);
        const sections = [
            initiative.objective ? `## Objective\n${initiative.objective}` : '',
            initiative.plan.length ? `## Plan\n${initiative.plan.map(item => `- [${item.status === 'done' ? 'x' : item.status === 'in-progress' ? '/' : ' '}] ${item.description}`).join('\n')}` : '',
            initiative.progressLog.length ? `## Progress Log\n${initiative.progressLog.map(item => `- ${item}`).join('\n')}` : '',
            initiative.artifacts.length ? `## Artifacts\n${initiative.artifacts.map(item => `- ${item}`).join('\n')}` : ''
        ].filter(Boolean).join('\n\n');
        return `---\n${lines.join('\n')}\n---\n\n${sections}\n`;
    }
    frontmatterUpdates(initiative) {
        // The store is directory-mode only; `complete` is the canonical on-disk
        // completed value. `done` (flat-v1 alias) and `complete` both map to it.
        const status = (0, types_1.isCompleted)(initiative.status) ? 'complete' : initiative.status;
        const front = {
            id: initiative.id,
            title: initiative.title,
            status,
            started: initiative.created,
            updated: initiative.updated || new Date().toISOString().split('T')[0],
            owner: initiative.owner || '',
            tags: JSON.stringify(initiative.tags || []),
            related_wiki: JSON.stringify(initiative.relatedWiki || [])
        };
        if (initiative.priority)
            front.priority = initiative.priority;
        if (initiative.dueDate)
            front.due_date = initiative.dueDate;
        if (initiative.dependsOn)
            front.depends_on = JSON.stringify(initiative.dependsOn);
        if (initiative.phase)
            front.phase = initiative.phase;
        if (initiative.handoffSummary)
            front.handoff_summary = initiative.handoffSummary;
        if (initiative.openQuestions)
            front.open_questions = JSON.stringify(initiative.openQuestions);
        if (initiative.blockers)
            front.blockers = JSON.stringify(initiative.blockers);
        if (initiative.nextAction)
            front.next_action = initiative.nextAction;
        if (initiative.expectedDuration)
            front.expected_duration = initiative.expectedDuration;
        if (initiative.graduated)
            front.graduated = initiative.graduated;
        return front;
    }
    safeDirectoryKey(key) {
        const base = path.basename(key);
        if (!base || base === '.' || base === '..' || base !== key || key.includes('/') || key.includes('\\')) {
            throw new Error(`Invalid directory initiative key: ${key}`);
        }
        return base;
    }
    updateStatusFile(filePath, updates, progressNote) {
        const content = fs.readFileSync(filePath, 'utf8');
        const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n?)([\s\S]*)$/);
        if (!match)
            throw new Error(`Invalid initiative status format: ${filePath}`);
        const newline = content.includes('\r\n') ? '\r\n' : '\n';
        const lines = match[1].split(/\r?\n/);
        if (this.contract.initiativeRecordMode === 'metadata-only') {
            // Metadata-only: rewrite only existing lifecycle keys in place. Never add
            // new frontmatter keys, never mutate the body, never inject sections, and
            // ignore progress notes. Preserves consumer prose and inline array
            // formatting verbatim.
            for (const [key, value] of Object.entries(updates)) {
                const isCore = METADATA_ONLY_CORE_LIFECYCLE_KEYS.has(key);
                if (!isCore && !METADATA_ONLY_OPTIONAL_LIFECYCLE_KEYS.has(key))
                    continue;
                const index = lines.findIndex(line => line.match(new RegExp(`^${key}:`)));
                if (index >= 0) {
                    lines[index] = `${key}: ${value}`;
                }
                else if (isCore) {
                    // Lifecycle events (markDone/graduate) may introduce core
                    // bookkeeping keys; optional keys are never injected.
                    lines.push(`${key}: ${value}`);
                }
            }
            const body = match[3] || '';
            fs.writeFileSync(filePath, `---${newline}${lines.join(newline)}${newline}---${newline}${body.replace(/^\r?\n/, '')}`, 'utf8');
            return;
        }
        for (const [key, value] of Object.entries(updates)) {
            const index = lines.findIndex(line => line.match(new RegExp(`^${key}:`)));
            const nextLine = `${key}: ${value}`;
            if (index >= 0)
                lines[index] = nextLine;
            else
                lines.push(nextLine);
        }
        let body = match[3] || '';
        if (progressNote)
            body = this.appendProgressNote(body, progressNote, newline);
        fs.writeFileSync(filePath, `---${newline}${lines.join(newline)}${newline}---${newline}${body.replace(/^\r?\n/, '')}`, 'utf8');
    }
    appendProgressNote(body, progressNote, newline) {
        const noteLine = `- ${progressNote}`;
        if (/## Progress Log\r?\n/.test(body)) {
            return body.replace(/(## Progress Log\r?\n)/, `$1${noteLine}${newline}`);
        }
        const separator = body.trim().length > 0 ? `${newline}${newline}` : '';
        return `${body.replace(/\s*$/, '')}${separator}## Progress Log${newline}${noteLine}${newline}`;
    }
}
exports.InitiativeStore = InitiativeStore;
function slugify(value) {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
//# sourceMappingURL=initiative-store.js.map