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
exports.MdocsCommandRegistry = void 0;
const path = __importStar(require("path"));
const engine_1 = require("../workflow/engine");
const types_1 = require("../types");
const lock_1 = require("../lock");
const utils_1 = require("./utils");
class MdocsCommandRegistry {
    context;
    supportedCommands = [
        'initiative.create',
        'initiative.update',
        'initiative.done',
        'initiative.delete',
        'initiative.archive',
        'wiki.create',
        'wiki.update',
        'wiki.ingest',
        'wiki.stub',
        'wiki.delete',
        'wiki.list',
        'wiki.link',
        'wiki.xref',
        'workflow.advance',
        'lifecycle.graduate',
        'validate',
        'index.sync'
    ];
    constructor(context) {
        this.context = context;
    }
    async execute(command, args = {}) {
        try {
            switch (command) {
                case 'initiative.create':
                    return this.createInitiative(args);
                case 'initiative.update':
                    return this.updateInitiative(args);
                case 'initiative.done':
                    return this.doneInitiative(args);
                case 'initiative.delete':
                    return this.deleteInitiative(args);
                case 'initiative.archive':
                    return this.archiveInitiative(args);
                case 'wiki.create':
                    return this.createWiki(args);
                case 'wiki.update':
                    return this.updateWiki(args);
                case 'wiki.ingest':
                    return this.ingestWiki(args);
                case 'wiki.stub':
                    return this.stubWiki(args);
                case 'wiki.delete':
                    return this.deleteWiki(args);
                case 'wiki.list':
                    return this.listWiki(args);
                case 'wiki.link':
                    return this.linkWiki(args);
                case 'wiki.xref':
                    return this.crossReferenceWiki(args);
                case 'workflow.advance':
                    return this.advanceWorkflow(args);
                case 'lifecycle.graduate':
                    return this.graduateInitiative(args);
                case 'validate':
                    return this.validationResult();
                case 'index.sync':
                    return this.syncIndex();
                default:
                    return { error: `Unsupported mdocs command: ${command}`, supportedCommands: this.supportedCommands };
            }
        }
        catch (err) {
            return { error: err.message || String(err) };
        }
    }
    advanceWorkflow(args) {
        const step = args.step || args.nextStep;
        if (!step || typeof step !== 'string') {
            return { error: 'workflow.advance requires { step: StepName }', validSteps: engine_1.STEPS };
        }
        if (!engine_1.STEPS.includes(step)) {
            return { error: `Invalid workflow step: ${step}`, validSteps: engine_1.STEPS };
        }
        try {
            this.context.workflow.advance(step);
        }
        catch (err) {
            return { error: err.message || String(err), currentStep: this.context.workflow.getCurrentStep() };
        }
        return {
            success: true,
            currentStep: this.context.workflow.getCurrentStep(),
            activeInitiative: this.context.workflow.status().activeInitiative,
            stepHistory: this.context.workflow.status().stepHistory
        };
    }
    /**
     * lifecycle.graduate — record a completed initiative's learning into the
     * compiled views (overview.md sections + log.md entry) using the G2a helpers,
     * wrapped in withLock, and stamp the initiative `graduated` so the
     * graduation-due lint rule clears.
     *
     * INVARIANT: NEVER auto-generates prose. Only caller-supplied `sections`
     * bodies and `logEntry` content are written. Best-effort batch like ingest:
     * each section/log write is isolated in its own try/catch; a failing write
     * records an error but does NOT abort the rest. The `graduated` stamp is
     * applied last; if it throws, the write results are still returned with the
     * stamp error included.
     */
    graduateInitiative(args) {
        if (!args.id)
            return { error: 'lifecycle.graduate requires id' };
        this.context.initiatives.assertWriteSupported('lifecycle.graduate');
        const fileName = (0, utils_1.findInitiativeFilename)(this.context.mdocsRoot, this.context.initiatives, args.id);
        if (!fileName)
            return { error: `Initiative not found: ${args.id}` };
        const initiative = this.context.initiatives.read(fileName);
        if (!initiative)
            return { error: `Initiative not found: ${args.id}` };
        if (!(0, types_1.isCompleted)(initiative.status)) {
            return { error: `Only completed initiatives can be graduated (current status: ${initiative.status})` };
        }
        const sections = Array.isArray(args.sections) ? args.sections : [];
        const logEntry = args.logEntry;
        const lockResult = (0, lock_1.withLock)(this.context.mdocsRoot, 'lifecycle-graduate', () => {
            const sectionResults = [];
            let logResult = undefined;
            for (const s of sections) {
                try {
                    const p = this.context.wiki.updateOverviewSection(s.section, s.body);
                    sectionResults.push({
                        section: s.section,
                        ok: true,
                        skipped: p === null ? 'non-directory-v2' : undefined,
                        filePath: p ? path.relative(this.context.mdocsRoot, p) : undefined
                    });
                }
                catch (err) {
                    sectionResults.push({ section: s.section, ok: false, error: err.message || String(err) });
                }
            }
            if (logEntry !== undefined) {
                try {
                    const p = this.context.wiki.appendLog(logEntry);
                    logResult = {
                        ok: true,
                        skipped: p === null ? 'non-directory-v2' : undefined,
                        filePath: p ? path.relative(this.context.mdocsRoot, p) : undefined
                    };
                }
                catch (err) {
                    logResult = { ok: false, error: err.message || String(err) };
                }
            }
            let stampError;
            try {
                initiative.graduated = (0, utils_1.today)();
                this.context.initiatives.update(fileName, initiative);
            }
            catch (stampErr) {
                stampError = stampErr.message || String(stampErr);
            }
            return { sectionResults, logResult, stampError };
        });
        if (!lockResult.ran || lockResult.value === undefined) {
            return { success: false, error: 'lifecycle-graduate lock timeout' };
        }
        const { sectionResults, logResult, stampError } = lockResult.value;
        const wrote = { overviewSections: sectionResults };
        if (logResult !== undefined)
            wrote.logEntry = logResult;
        const result = {
            success: true,
            initiativeId: initiative.id,
            graduated: (0, utils_1.today)(),
            wrote
        };
        if (stampError)
            result.stampError = stampError;
        return result;
    }
    validationResult() {
        const initiativeValidation = this.context.initiatives.validate();
        const wikiValidation = this.context.wiki.validate();
        const allLintResults = this.context.linter.lintAll();
        const graphResults = allLintResults.filter(result => result.file === 'GRAPH');
        const graphErrors = graphResults.flatMap(result => result.issues.filter(issue => issue.severity === 'error').map(issue => `${result.file}: ${issue.message}`));
        const graphWarnings = graphResults.flatMap(result => result.issues.filter(issue => issue.severity !== 'error').map(issue => `${result.file}: ${issue.message}`));
        return {
            initiatives: initiativeValidation,
            wiki: wikiValidation,
            graph: { valid: graphErrors.length === 0, errors: graphErrors, warnings: graphWarnings, results: graphResults },
            valid: initiativeValidation.valid && wikiValidation.valid && graphErrors.length === 0
        };
    }
    createInitiative(args) {
        if (!args.title)
            return { error: 'initiative.create requires title' };
        this.context.initiatives.assertWriteSupported('initiative.create');
        const date = (0, utils_1.today)();
        const id = args.id || (0, utils_1.slugify)(args.title);
        const filePath = this.context.initiatives.create({
            id,
            title: args.title,
            status: 'active',
            created: date,
            updated: date,
            owner: args.owner || '',
            tags: Array.isArray(args.tags) ? args.tags : [],
            relatedWiki: Array.isArray(args.relatedWiki) ? args.relatedWiki : [],
            objective: args.objective || '',
            plan: Array.isArray(args.plan)
                ? args.plan
                    .map((item) => ({
                    description: typeof item === 'string' ? item : item?.description || '',
                    status: 'pending'
                }))
                    .filter((item) => item.description)
                : [],
            progressLog: [`[${new Date().toISOString()}] Created initiative via mdocs command`],
            artifacts: [],
            phase: args.phase || undefined,
            handoffSummary: args.handoffSummary || undefined,
            openQuestions: Array.isArray(args.openQuestions) ? args.openQuestions : undefined,
            blockers: Array.isArray(args.blockers) ? args.blockers : undefined,
            nextAction: args.nextAction || undefined,
            expectedDuration: args.expectedDuration || undefined,
            graduated: args.graduated || undefined
        });
        return { success: true, filename: path.basename(filePath), id };
    }
    updateInitiative(args) {
        if (!args.id)
            return { error: 'initiative.update requires id' };
        this.context.initiatives.assertWriteSupported('initiative.update');
        const fileName = (0, utils_1.findInitiativeFilename)(this.context.mdocsRoot, this.context.initiatives, args.id);
        if (!fileName)
            return { error: `Initiative not found: ${args.id}` };
        const initiative = this.context.initiatives.read(fileName);
        if (!initiative)
            return { error: `Initiative not found: ${args.id}` };
        const updates = args.updates || args;
        for (const field of ['status', 'tags', 'priority', 'dueDate', 'dependsOn', 'owner', 'phase', 'handoffSummary', 'nextAction', 'expectedDuration', 'graduated']) {
            if (updates[field] !== undefined)
                initiative[field] = updates[field];
        }
        if (updates.openQuestions !== undefined)
            initiative.openQuestions = Array.isArray(updates.openQuestions) ? updates.openQuestions : undefined;
        if (updates.blockers !== undefined)
            initiative.blockers = Array.isArray(updates.blockers) ? updates.blockers : undefined;
        initiative.updated = (0, utils_1.today)();
        if (args.progressNote)
            initiative.progressLog.push(args.progressNote);
        const filePath = this.context.initiatives.update(fileName, initiative);
        return { success: true, filename: path.basename(filePath), id: initiative.id };
    }
    doneInitiative(args) {
        if (!args.id)
            return { error: 'initiative.done requires id' };
        this.context.initiatives.assertWriteSupported('initiative.done');
        const fileName = (0, utils_1.findInitiativeFilename)(this.context.mdocsRoot, this.context.initiatives, args.id);
        if (!fileName)
            return { error: `Initiative not found: ${args.id}` };
        const initiative = this.context.initiatives.read(fileName);
        if (!initiative)
            return { error: `Initiative not found: ${args.id}` };
        const result = this.context.initiatives.markDone(fileName);
        if (this.context.workflow.status().activeInitiative === initiative.id) {
            this.context.workflow.setActiveInitiative(null);
        }
        return { success: true, filename: result.filename, id: initiative.id };
    }
    deleteInitiative(args) {
        if (!args.id)
            return { error: 'initiative.delete requires id' };
        this.context.initiatives.assertWriteSupported('initiative.delete');
        const fileName = (0, utils_1.findInitiativeFilename)(this.context.mdocsRoot, this.context.initiatives, args.id);
        if (!fileName)
            return { error: `Initiative not found: ${args.id}` };
        this.context.initiatives.delete(fileName);
        return { success: true, id: args.id, deletedFilename: fileName };
    }
    archiveInitiative(args) {
        if (!args.id)
            return { error: 'initiative.archive requires id' };
        this.context.initiatives.assertWriteSupported('initiative.archive');
        const fileName = (0, utils_1.findInitiativeFilename)(this.context.mdocsRoot, this.context.initiatives, args.id);
        if (!fileName)
            return { error: `Initiative not found: ${args.id}` };
        const initiative = this.context.initiatives.read(fileName);
        if (!initiative)
            return { error: `Initiative not found: ${args.id}` };
        if (!(0, types_1.isCompleted)(initiative.status))
            return { error: `Only completed initiatives can be archived: ${args.id}` };
        const result = this.context.initiatives.archive(fileName);
        return { success: true, id: args.id, archivedFilename: result.archivedFilename };
    }
    createWiki(args) {
        if (!args.id || !args.title)
            return { error: 'wiki.create requires id and title' };
        const date = (0, utils_1.today)();
        const category = args.category || '';
        const filePath = this.context.wiki.create({
            category,
            id: args.id,
            title: args.title,
            created: date,
            updated: date,
            content: args.content || '',
            relatedInitiatives: Array.isArray(args.relatedInitiatives) ? args.relatedInitiatives : [],
            tags: Array.isArray(args.tags) ? args.tags : [],
            lifecycle: args.lifecycle || undefined,
            knowledgeType: args.knowledgeType || undefined,
            confidence: args.confidence || undefined,
            sourceInitiatives: Array.isArray(args.sourceInitiatives) ? args.sourceInitiatives : undefined,
            supersedes: Array.isArray(args.supersedes) ? args.supersedes : undefined,
            relatedWiki: Array.isArray(args.relatedWiki) ? args.relatedWiki : undefined
        });
        return { success: true, filename: category ? path.join(path.basename(path.dirname(filePath)), path.basename(filePath)) : path.basename(filePath), id: args.id };
    }
    updateWiki(args) {
        if (!args.id)
            return { error: 'wiki.update requires id' };
        const category = args.category || '';
        const existing = category ? this.context.wiki.read(category, args.id) : this.context.wiki.readByRef(args.id);
        if (!existing)
            return { error: `Wiki entry not found: ${category ? `${category}/` : ''}${args.id}` };
        if (args.title !== undefined)
            existing.title = args.title;
        if (args.content !== undefined)
            existing.content = args.content;
        if (Array.isArray(args.tags))
            existing.tags = args.tags;
        if (Array.isArray(args.relatedInitiatives))
            existing.relatedInitiatives = args.relatedInitiatives;
        if (args.lifecycle !== undefined)
            existing.lifecycle = args.lifecycle;
        if (args.knowledgeType !== undefined)
            existing.knowledgeType = args.knowledgeType;
        if (args.confidence !== undefined)
            existing.confidence = args.confidence;
        if (Array.isArray(args.sourceInitiatives))
            existing.sourceInitiatives = args.sourceInitiatives;
        if (Array.isArray(args.supersedes))
            existing.supersedes = args.supersedes;
        const filePath = this.context.wiki.update(category, args.id, existing);
        return { success: true, filename: category ? path.join(path.basename(path.dirname(filePath)), path.basename(filePath)) : path.basename(filePath), id: args.id };
    }
    stubWiki(args) {
        if (!args.id)
            return { error: 'wiki.stub requires id' };
        const result = this.context.wiki.stub(args.category || '', args.id, args.title, args.template);
        if (result.existing)
            return { success: false, existing: true, filePath: path.relative(this.context.mdocsRoot, result.filePath) };
        return { success: true, category: args.category, id: args.id, filePath: path.relative(this.context.mdocsRoot, result.filePath) };
    }
    deleteWiki(args) {
        if (!args.id)
            return { error: 'wiki.delete requires id' };
        const category = args.category || '';
        const existing = category ? this.context.wiki.read(category, args.id) : this.context.wiki.readByRef(args.id);
        if (!existing)
            return { error: `Wiki entry not found: ${category ? `${category}/` : ''}${args.id}` };
        this.context.wiki.delete(category, args.id);
        return { success: true, category, id: args.id, deletedFilename: category ? `${category}/${args.id}.md` : `${args.id}.md` };
    }
    listWiki(args) {
        return {
            entries: this.context.wiki.list(args.category).map(entry => ({
                category: entry.category,
                id: entry.id,
                title: entry.title,
                tags: entry.tags
            }))
        };
    }
    linkWiki(args) {
        if (!args.initiativeId || !args.wikiSlug)
            return { error: 'wiki.link requires initiativeId and wikiSlug' };
        this.context.initiatives.assertWriteSupported('wiki.link');
        const rawParts = String(args.wikiSlug).split('/');
        if (rawParts.some(part => !part))
            return { error: `Invalid wikiSlug format: ${args.wikiSlug}. Expected id or category/id` };
        const parts = rawParts;
        if (parts.length !== 1 && parts.length !== 2)
            return { error: `Invalid wikiSlug format: ${args.wikiSlug}. Expected id or category/id` };
        const normalizedParts = parts.map((part, index) => index === parts.length - 1 ? part.replace(/\.md$/, '') : part);
        const wikiSlug = normalizedParts.join('/');
        if (normalizedParts.length === 1 && normalizedParts[0].toLowerCase() === 'index')
            return { error: 'Refusing to overwrite canonical root wiki index: index' };
        if (!this.context.wiki.readByRef(wikiSlug))
            return { error: `Wiki entry not found: ${wikiSlug}` };
        const fileName = (0, utils_1.findInitiativeFilename)(this.context.mdocsRoot, this.context.initiatives, args.initiativeId);
        if (!fileName)
            return { error: `Initiative not found: ${args.initiativeId}` };
        const initiative = this.context.initiatives.read(fileName);
        if (!initiative)
            return { error: `Initiative not found: ${args.initiativeId}` };
        if (!initiative.relatedWiki.includes(wikiSlug)) {
            initiative.relatedWiki.push(wikiSlug);
            initiative.updated = (0, utils_1.today)();
            this.context.initiatives.update(fileName, initiative);
        }
        this.context.wiki.addRelatedInitiativeByRef(wikiSlug, args.initiativeId);
        return { success: true, bidirectional: true, initiativeId: args.initiativeId, wikiSlug };
    }
    crossReferenceWiki(args) {
        if (!args.fromSlug || !args.toSlug)
            return { error: 'wiki.xref requires fromSlug and toSlug' };
        const [fromCategory, fromId] = args.fromSlug.split('/');
        const [toCategory, toId] = args.toSlug.split('/');
        if (!fromCategory || !fromId)
            return { error: `Invalid fromSlug format: ${args.fromSlug}. Expected category/id` };
        if (!toCategory || !toId)
            return { error: `Invalid toSlug format: ${args.toSlug}. Expected category/id` };
        this.context.wiki.addWikiCrossRef(fromCategory, fromId, toCategory, toId);
        return { success: true, bidirectional: true, fromSlug: args.fromSlug, toSlug: args.toSlug };
    }
    /**
     * wiki.ingest — record caller-supplied operations and apply them as one
     * isolated multi-file write composed from existing wiki.* primitives plus the
     * updateOverviewSection/appendLog helpers, wrapped in withLock.
     *
     * INVARIANT: ingest NEVER auto-generates prose. It only records + applies
     * exactly what the caller supplies (the agent authors all text). The manifest
     * contains only caller-supplied data + structural metadata (counts, refs,
     * ok/error).
     *
     * Best-effort batch: isolation is provided by the lock, NOT transactional
     * rollback — each op is wrapped in its own try/catch so one failing op records
     * an error but does NOT abort the rest of the batch.
     */
    ingestWiki(args) {
        const operations = args.operations;
        if (!Array.isArray(operations) || operations.length === 0) {
            return { error: 'wiki.ingest requires { operations: WikiIngestOp[] }' };
        }
        const lockResult = (0, lock_1.withLock)(this.context.mdocsRoot, 'wiki-ingest', () => {
            const appliedOps = [];
            const changedFiles = [];
            for (const op of operations) {
                // Each op application is isolated: a failing op records an error but
                // does NOT abort the rest of the batch.
                try {
                    if (op.type === 'createPage') {
                        const category = op.category || '';
                        const ref = category ? `${category}/${op.id}` : op.id;
                        const filePath = this.context.wiki.create({
                            category,
                            id: op.id,
                            title: op.title,
                            created: (0, utils_1.today)(),
                            updated: (0, utils_1.today)(),
                            content: op.content ?? '',
                            relatedInitiatives: Array.isArray(op.relatedInitiatives) ? op.relatedInitiatives : [],
                            tags: Array.isArray(op.tags) ? op.tags : [],
                            lifecycle: op.lifecycle,
                            knowledgeType: op.knowledgeType,
                            confidence: op.confidence
                        });
                        appliedOps.push({ type: op.type, ref, ok: true });
                        changedFiles.push(path.relative(this.context.mdocsRoot, filePath));
                    }
                    else if (op.type === 'updatePage') {
                        const category = op.category || '';
                        const ref = category ? `${category}/${op.id}` : op.id;
                        const existing = category ? this.context.wiki.read(category, op.id) : this.context.wiki.readByRef(op.id);
                        if (!existing) {
                            appliedOps.push({ type: op.type, ref, ok: false, error: 'not found' });
                        }
                        else {
                            if (op.content !== undefined)
                                existing.content = op.content;
                            if (op.lifecycle !== undefined)
                                existing.lifecycle = op.lifecycle;
                            if (Array.isArray(op.tags))
                                existing.tags = op.tags;
                            if (Array.isArray(op.relatedInitiatives))
                                existing.relatedInitiatives = op.relatedInitiatives;
                            const filePath = this.context.wiki.update(category, op.id, existing);
                            appliedOps.push({ type: op.type, ref, ok: true });
                            changedFiles.push(path.relative(this.context.mdocsRoot, filePath));
                        }
                    }
                    else if (op.type === 'updateOverviewSection') {
                        const filePath = this.context.wiki.updateOverviewSection(op.section, op.body);
                        if (filePath === null) {
                            // Legitimate no-op outside directory-v2 — NOT an error.
                            appliedOps.push({ type: op.type, ref: `overview#${op.section}`, ok: true, skipped: 'non-directory-v2' });
                        }
                        else {
                            appliedOps.push({ type: op.type, ref: `overview#${op.section}`, ok: true });
                            changedFiles.push(path.relative(this.context.mdocsRoot, filePath));
                        }
                    }
                    else if (op.type === 'appendLog') {
                        const filePath = this.context.wiki.appendLog(op.entry);
                        if (filePath === null) {
                            // Legitimate no-op outside directory-v2 — NOT an error.
                            appliedOps.push({ type: op.type, ref: 'log', ok: true, skipped: 'non-directory-v2' });
                        }
                        else {
                            appliedOps.push({ type: op.type, ref: 'log', ok: true });
                            changedFiles.push(path.relative(this.context.mdocsRoot, filePath));
                        }
                    }
                    else if (op.type === 'link') {
                        try {
                            this.context.wiki.addRelatedInitiativeByRef(op.wikiSlug, op.initiativeId);
                            appliedOps.push({ type: op.type, ref: `${op.initiativeId}->${op.wikiSlug}`, ok: true });
                        }
                        catch (linkErr) {
                            appliedOps.push({ type: op.type, ref: `${op.initiativeId}->${op.wikiSlug}`, ok: false, error: linkErr.message || String(linkErr) });
                        }
                    }
                    else {
                        appliedOps.push({ type: String(op.type), ref: '', ok: false, error: `unknown op type` });
                    }
                }
                catch (opErr) {
                    appliedOps.push({ type: String(op.type), ref: '', ok: false, error: opErr.message || String(opErr) });
                }
            }
            return { appliedOps, changedFiles };
        });
        if (!lockResult.ran || lockResult.value === undefined) {
            return { success: false, error: 'wiki-ingest lock timeout' };
        }
        const { appliedOps, changedFiles } = lockResult.value;
        return {
            success: true,
            applied: appliedOps.length,
            operations: appliedOps,
            changedFiles,
            note: args.note ?? null
        };
    }
    syncIndex() {
        const regenerated = [
            path.relative(this.context.mdocsRoot, this.context.initiatives.syncIndex()),
            ...this.context.wiki.syncIndices().map(filePath => path.relative(this.context.mdocsRoot, filePath))
        ];
        return { success: true, regenerated };
    }
}
exports.MdocsCommandRegistry = MdocsCommandRegistry;
//# sourceMappingURL=registry.js.map