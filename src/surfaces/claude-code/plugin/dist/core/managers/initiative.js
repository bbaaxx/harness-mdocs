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
exports.InitiativeManager = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const contract_1 = require("../contract");
const initiative_store_1 = require("../initiative-store");
const types_1 = require("../types");
function parseSection(content, sectionName) {
    const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = content.match(new RegExp(`## ${escaped}\\n([\\s\\S]*?)(?=\\n## |$)`));
    return match ? match[1].trim() : '';
}
function parseListSection(content, sectionName) {
    const section = parseSection(content, sectionName);
    return section.split('\n').filter(line => line.trim().startsWith('- ')).map(line => line.replace(/^- /, '').trim());
}
function formatPlanItem(item) {
    const statusMap = {
        'pending': '- [ ]',
        'in-progress': '- [/]',
        'done': '- [x]'
    };
    const prefix = statusMap[item.status] || '- [ ]';
    return `${prefix} ${item.description}`;
}
function parsePlanItem(line) {
    // Match checkable items: - [ ] desc, - [/] desc, - [x] desc
    const checkableMatch = line.match(/^- \[([ x/])\]\s*(.+)$/);
    if (checkableMatch) {
        const mark = checkableMatch[1];
        const description = checkableMatch[2].trim();
        const status = mark === 'x' ? 'done' : mark === '/' ? 'in-progress' : 'pending';
        return { description, status };
    }
    // Backward compatibility: plain list item - Description
    const plainMatch = line.match(/^- \s*(.+)$/);
    if (plainMatch) {
        return { description: plainMatch[1].trim(), status: 'pending' };
    }
    return { description: line.trim(), status: 'pending' };
}
function parsePlanSection(content) {
    const section = parseSection(content, 'Plan');
    return section.split('\n')
        .filter(line => line.trim().startsWith('- '))
        .map(line => parsePlanItem(line));
}
const ALLOWED_EXPECTED_DURATIONS = new Set(['normal', 'long', 'suppress']);
function coerceExpectedDuration(raw) {
    if (typeof raw !== 'string')
        return undefined;
    const value = raw.toLowerCase();
    return ALLOWED_EXPECTED_DURATIONS.has(value) ? value : undefined;
}
function isSafePathSegment(segment) {
    return !!segment && segment !== '.' && segment !== '..' && path.basename(segment) === segment;
}
class InitiativeManager {
    dir;
    contract;
    store;
    constructor(baseDir, options = {}) {
        this.dir = path.join(baseDir, 'initiatives');
        this.contract = (0, contract_1.detectMdocsContract)(baseDir, options.compatibility);
        this.store = new initiative_store_1.InitiativeStore(baseDir, this.contract);
        fs.mkdirSync(this.dir, { recursive: true });
    }
    slugify(title) {
        return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    }
    formatFileName(initiative) {
        const idSlug = this.slugify(initiative.id || '');
        const slug = idSlug || this.slugify(initiative.title);
        return `${slug}--${initiative.created}.md`;
    }
    sanitizeFileName(fileName) {
        const base = path.basename(fileName);
        if (!base || base === '.' || base === '..') {
            return 'invalid.md'; // Return a safe fallback that won't match real files
        }
        return base;
    }
    toFrontmatter(initiative) {
        // Note: YAML frontmatter uses snake_case
        const front = {
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
        if (initiative.phase)
            front.phase = initiative.phase;
        if (initiative.handoffSummary)
            front.handoff_summary = initiative.handoffSummary;
        if (initiative.openQuestions && initiative.openQuestions.length > 0)
            front.open_questions = initiative.openQuestions;
        if (initiative.blockers && initiative.blockers.length > 0)
            front.blockers = initiative.blockers;
        if (initiative.nextAction)
            front.next_action = initiative.nextAction;
        if (initiative.expectedDuration)
            front.expected_duration = initiative.expectedDuration;
        if (initiative.graduated)
            front.graduated = initiative.graduated;
        return `---\n${Object.entries(front).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n---\n\n`;
    }
    initiativeFiles() {
        return fs.readdirSync(this.dir).filter(f => f.endsWith('.md') && f !== 'INDEX.md');
    }
    assertUniqueId(id, ignoreFileName) {
        if (!id)
            return;
        const ignored = ignoreFileName ? path.resolve(this.dir, this.sanitizeFileName(ignoreFileName)) : '';
        for (const fileName of this.initiativeFiles()) {
            if (ignored && path.resolve(this.dir, fileName) === ignored)
                continue;
            try {
                const existing = this.read(fileName);
                if (existing?.id === id) {
                    throw new Error(`Duplicate initiative id "${id}" found in ${fileName}`);
                }
            }
            catch (err) {
                if (err.message?.startsWith('Duplicate initiative id'))
                    throw err;
            }
        }
    }
    assertWriteSupported(operation) {
        const directoryNativeWrites = new Set(['initiative.create', 'initiative.update', 'initiative.done', 'initiative.delete', 'initiative.archive', 'lifecycle.graduate', 'wiki.link']);
        if (this.contract.initiativeMode === 'directory' && !directoryNativeWrites.has(operation)) {
            throw new Error(`${operation} is not supported for directory-v2 initiatives; write support is read-only to prevent accidental flat-file writes.`);
        }
    }
    create(initiative) {
        this.assertWriteSupported('initiative.create');
        if (this.contract.initiativeMode === 'directory') {
            return this.store.create(initiative).dirPath;
        }
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
    read(fileName) {
        const sanitized = this.sanitizeFileName(fileName);
        const filePath = path.join(this.dir, sanitized);
        if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
            return this.contract.initiativeMode === 'directory' ? this.store.read(fileName)?.initiative || null : null;
        }
        const content = fs.readFileSync(filePath, 'utf8');
        return this.parseInitiative(content, fileName);
    }
    parseInitiative(content, fileName) {
        const front = (0, types_1.parseFrontmatter)(content);
        if (!Object.keys(front).length)
            throw new Error(`Invalid initiative format: ${fileName}`);
        // Extract markdown body after frontmatter
        const body = content.replace(/---\n[\s\S]*?\n---/, '').trim();
        return {
            id: front.id || '',
            title: front.title || '',
            status: (0, initiative_store_1.normalizeInitiativeStatus)(front.status),
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
            nextAction: front.next_action || undefined,
            expectedDuration: coerceExpectedDuration((0, types_1.readExpectedDurationRaw)(front)),
            graduated: front.graduated || undefined
        };
    }
    update(fileName, initiative) {
        this.assertWriteSupported('initiative.update');
        if (this.contract.initiativeMode === 'directory') {
            const previous = this.store.read(fileName)?.initiative.progressLog || [];
            const newProgress = initiative.progressLog.slice(previous.length).join('\n- ');
            return this.store.update(fileName, initiative, newProgress || undefined).dirPath;
        }
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
    markDone(fileName) {
        if (this.contract.initiativeMode === 'directory') {
            const result = this.store.markDone(fileName);
            return { filePath: result.filePath, filename: result.key, initiative: result.initiative };
        }
        const sanitized = this.sanitizeFileName(fileName);
        const initiative = this.read(sanitized);
        if (!initiative)
            throw new Error(`Initiative file not found: ${sanitized}`);
        initiative.status = 'done';
        initiative.updated = new Date().toISOString().split('T')[0];
        initiative.progressLog.push(`[${new Date().toISOString()}] Marked done via mdocs command`);
        const filePath = this.update(sanitized, initiative);
        return { filePath, filename: path.basename(filePath), initiative };
    }
    delete(fileName) {
        this.assertWriteSupported('initiative.delete');
        if (this.contract.initiativeMode === 'directory') {
            this.store.delete(fileName);
            return;
        }
        const sanitized = this.sanitizeFileName(fileName);
        const filePath = path.join(this.dir, sanitized);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            this.updateIndex();
        }
    }
    syncIndex() {
        if (this.contract.initiativeMode === 'directory') {
            return path.join(this.dir, 'INDEX.md');
        }
        this.updateIndex();
        return path.join(this.dir, 'INDEX.md');
    }
    archive(fileName) {
        this.assertWriteSupported('initiative.archive');
        if (this.contract.initiativeMode === 'directory') {
            const result = this.store.archive(fileName);
            return { archivedFilename: result.archivedFilename, archiveIndex: path.join(this.dir, '_archive') };
        }
        const sanitized = this.sanitizeFileName(fileName);
        const sourcePath = path.join(this.dir, sanitized);
        if (!fs.existsSync(sourcePath))
            throw new Error(`Initiative file not found: ${sanitized}`);
        const initiative = this.read(sanitized);
        if (!initiative)
            throw new Error(`Initiative file not found: ${sanitized}`);
        if (!(0, types_1.isCompleted)(initiative.status))
            throw new Error(`Only completed initiatives can be archived: ${initiative.id}`);
        const archiveDir = path.join(this.dir, 'archive');
        fs.mkdirSync(archiveDir, { recursive: true });
        const targetPath = path.join(archiveDir, sanitized);
        if (fs.existsSync(targetPath))
            throw new Error(`Archived initiative already exists: ${sanitized}`);
        fs.renameSync(sourcePath, targetPath);
        this.updateIndex();
        this.updateArchiveIndex();
        return { archivedFilename: sanitized, archiveIndex: path.join(archiveDir, 'INDEX.md') };
    }
    findById(id) {
        return this.store.findById(id)?.initiative || null;
    }
    findKeyById(id) {
        return this.store.findById(id, { includeArchived: true })?.key || null;
    }
    findByQuery(query) {
        const record = this.store.findByQuery(query);
        return record ? { initiative: record.initiative, key: record.key } : null;
    }
    list(includeArchived = false) {
        return this.store.list({ includeArchived }).map(record => record.initiative);
    }
    findRelated(queryTags) {
        const files = fs.readdirSync(this.dir).filter(f => f.endsWith('.md') && f !== 'INDEX.md');
        const initiatives = [];
        for (const f of files) {
            try {
                const init = this.read(f);
                if (init)
                    initiatives.push(init);
            }
            catch {
                // Skip malformed files
            }
        }
        return initiatives.filter(i => i.tags.some(t => queryTags.includes(t)));
    }
    findBlocked() {
        const all = this.listAll();
        return all.filter(i => {
            if (!i.dependsOn || i.dependsOn.length === 0)
                return false;
            return i.dependsOn.some(depId => {
                const dep = all.find(d => d.id === depId);
                return dep && !(0, types_1.isCompleted)(dep.status);
            });
        });
    }
    findOverdue() {
        const today = new Date().toISOString().split('T')[0];
        return this.listAll().filter(i => {
            if (!i.dueDate || (0, types_1.isCompleted)(i.status))
                return false;
            return i.dueDate < today;
        });
    }
    listByPriority() {
        const priorityOrder = {
            'critical': 0,
            'high': 1,
            'medium': 2,
            'low': 3
        };
        return this.listAll().sort((a, b) => {
            const priA = priorityOrder[a.priority || 'medium'] ?? 2;
            const priB = priorityOrder[b.priority || 'medium'] ?? 2;
            if (priA !== priB)
                return priA - priB;
            // If same priority, sort by due date (earliest first)
            if (a.dueDate && b.dueDate)
                return a.dueDate.localeCompare(b.dueDate);
            if (a.dueDate)
                return -1;
            if (b.dueDate)
                return 1;
            return 0;
        });
    }
    validate() {
        const errors = [];
        const warnings = [];
        const ids = new Map();
        const files = this.initiativeFiles();
        const wikiRoot = path.join(path.dirname(this.dir), 'wiki');
        for (const fileName of files) {
            let initiative;
            let front = {};
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
                            }
                            catch {
                                front[key.trim()] = value;
                            }
                        }
                    }
                }
                const parsed = this.read(fileName);
                if (!parsed)
                    continue;
                initiative = parsed;
            }
            catch (err) {
                errors.push(`${fileName} invalid initiative format: ${err.message || String(err)}`);
                continue;
            }
            if (!front.id)
                errors.push(`${fileName} missing id`);
            if (!front.title)
                errors.push(`${fileName} missing title`);
            if (!front.status)
                errors.push(`${fileName} missing status`);
            if (!front.created)
                errors.push(`${fileName} missing created`);
            if (initiative.id) {
                const firstFile = ids.get(initiative.id);
                if (firstFile) {
                    errors.push(`Duplicate initiative id "${initiative.id}" in ${firstFile} and ${fileName}`);
                }
                else {
                    ids.set(initiative.id, fileName);
                }
            }
            for (const ref of initiative.relatedWiki || []) {
                if (typeof ref !== 'string') {
                    warnings.push(`${fileName} has non-string wiki reference: ${String(ref)}`);
                    continue;
                }
                const parts = ref.split('/').filter(Boolean);
                if (parts.length === 1) {
                    const [id] = parts;
                    if (!isSafePathSegment(id))
                        warnings.push(`${fileName} has unsafe wiki reference: ${ref}`);
                    else if (!fs.existsSync(path.join(wikiRoot, `${id}.md`)))
                        warnings.push(`${fileName} references missing wiki entry: ${ref}`);
                    continue;
                }
                const [category, id, ...rest] = parts;
                if (!isSafePathSegment(category) || !isSafePathSegment(id) || rest.length > 0) {
                    warnings.push(`${fileName} has unsafe wiki reference: ${ref}`);
                }
                else if (!fs.existsSync(path.join(wikiRoot, category, `${id}.md`))) {
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
                if (!actual.has(listedFile))
                    warnings.push(`INDEX.md lists missing initiative file: ${listedFile}`);
            }
            for (const actualFile of actual) {
                if (!listed.has(actualFile))
                    warnings.push(`INDEX.md missing initiative file: ${actualFile}`);
            }
        }
        return { valid: errors.length === 0, errors, warnings };
    }
    checkConsistency() {
        const missing = [];
        const orphans = [];
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
    listAll() {
        return this.list();
    }
    updateArchiveIndex() {
        const archiveDir = path.join(this.dir, 'archive');
        fs.mkdirSync(archiveDir, { recursive: true });
        const files = fs.readdirSync(archiveDir).filter(f => f.endsWith('.md') && f !== 'INDEX.md');
        const entries = [];
        for (const f of files) {
            try {
                const content = fs.readFileSync(path.join(archiveDir, f), 'utf8');
                const init = this.parseInitiative(content, f);
                entries.push({ initiative: init, fileName: f });
            }
            catch {
            }
        }
        const lines = entries.map(({ initiative: i, fileName }) => `- **${i.title}** (${i.status}) — ${fileName} — ${i.created} — [${i.tags.join(', ')}]`);
        fs.writeFileSync(path.join(archiveDir, 'INDEX.md'), `# Archived Initiatives\n\n${lines.join('\n') || 'No archived initiatives yet.'}`, 'utf8');
    }
    writeIndexMeta() {
        const metaPath = path.join(path.dirname(this.dir), '.index-meta.json');
        const meta = { lastSync: new Date().toISOString() };
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
    }
    updateIndex() {
        if (this.contract.initiativeMode === 'directory') {
            return;
        }
        const files = this.initiativeFiles();
        const entries = [];
        for (const f of files) {
            try {
                const init = this.read(f);
                if (init)
                    entries.push({ initiative: init, fileName: f });
            }
            catch {
                // Skip malformed files
            }
        }
        const lines = entries.map(({ initiative: i, fileName }) => `- **${i.title}** (${i.status}) — ${fileName} — ${i.created} — [${i.tags.join(', ')}]`);
        const index = `# Initiatives\n\n${lines.join('\n') || 'No initiatives yet.'}`;
        fs.writeFileSync(path.join(this.dir, 'INDEX.md'), index, 'utf8');
        this.writeIndexMeta();
    }
}
exports.InitiativeManager = InitiativeManager;
//# sourceMappingURL=initiative.js.map