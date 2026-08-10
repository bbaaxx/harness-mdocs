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
function unique(values) {
    return Array.from(new Set(values));
}
/**
 * Semantic equality for postcondition read-back checks. Empty arrays and
 * `undefined` are equivalent (empty optional arrays are omitted on write and
 * parse back as undefined).
 */
function fieldsPersistedEqual(actual, expected) {
    const normalize = (v) => (v === undefined || (Array.isArray(v) && v.length === 0) ? null : v);
    return JSON.stringify(normalize(actual)) === JSON.stringify(normalize(expected));
}
function countIssues(errors, warnings, infos = []) {
    return {
        errorCount: errors.length,
        warningCount: warnings.length,
        infoCount: infos.length,
        clean: errors.length === 0 && warnings.length === 0
    };
}
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
        const graphWarnings = graphResults.flatMap(result => result.issues.filter(issue => issue.severity === 'warning').map(issue => `${result.file}: ${issue.message}`));
        const graphInfos = graphResults.flatMap(result => result.issues.filter(issue => issue.severity === 'info').map(issue => `${result.file}: ${issue.message}`));
        const initiativeErrors = unique(initiativeValidation.errors);
        const initiativeWarnings = unique(initiativeValidation.warnings);
        const wikiErrors = unique(wikiValidation.errors);
        const wikiWarnings = unique(wikiValidation.warnings);
        const uniqueGraphErrors = unique(graphErrors);
        const uniqueGraphWarnings = unique(graphWarnings);
        const uniqueGraphInfos = unique(graphInfos);
        const errorCount = initiativeErrors.length + wikiErrors.length + uniqueGraphErrors.length;
        const warningCount = initiativeWarnings.length + wikiWarnings.length + uniqueGraphWarnings.length;
        const infoCount = uniqueGraphInfos.length;
        return {
            initiatives: { ...initiativeValidation, errors: initiativeErrors, warnings: initiativeWarnings, ...countIssues(initiativeErrors, initiativeWarnings) },
            wiki: { ...wikiValidation, errors: wikiErrors, warnings: wikiWarnings, ...countIssues(wikiErrors, wikiWarnings) },
            graph: { valid: uniqueGraphErrors.length === 0, errors: uniqueGraphErrors, warnings: uniqueGraphWarnings, infos: uniqueGraphInfos, results: graphResults, ...countIssues(uniqueGraphErrors, uniqueGraphWarnings, uniqueGraphInfos) },
            valid: initiativeValidation.valid && wikiValidation.valid && uniqueGraphErrors.length === 0,
            errorCount,
            warningCount,
            infoCount,
            clean: errorCount === 0 && warningCount === 0
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
            aliases: Array.isArray(args.aliases) ? args.aliases : [],
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
    /**
     * initiative.update — explicit mutation result. snake_case inputs are
     * normalized to camelCase. Fields the store will not persist are reported
     * in `skippedFields` (metadata-only mode: anything outside the lifecycle
     * set, plus an unpersisted progressNote); fields the command does not
     * support at all (objective, plan, unknown keys) are rejected explicitly in
     * `unsupportedFields` with no write. Persisted fields are verified by
     * re-reading the initiative from disk before they are reported as applied.
     */
    updateInitiative(rawArgs) {
        const args = (0, utils_1.normalizeCommandKeys)(rawArgs);
        if (!args.id)
            return { error: 'initiative.update requires id' };
        this.context.initiatives.assertWriteSupported('initiative.update');
        const fileName = (0, utils_1.findInitiativeFilename)(this.context.mdocsRoot, this.context.initiatives, args.id);
        if (!fileName)
            return { error: `Initiative not found: ${args.id}` };
        const initiative = this.context.initiatives.read(fileName);
        if (!initiative)
            return { error: `Initiative not found: ${args.id}` };
        const updates = (0, utils_1.normalizeCommandKeys)(args.updates || args);
        const SUPPORTED = new Set(['status', 'tags', 'aliases', 'relatedWiki', 'priority', 'dueDate', 'dependsOn', 'owner', 'phase', 'handoffSummary', 'nextAction', 'expectedDuration', 'graduated', 'openQuestions', 'blockers']);
        const CONTROL_KEYS = new Set(['id', 'updates', 'progressNote']);
        const metadataOnly = this.context.contract.initiativeMode === 'directory' && this.context.contract.initiativeRecordMode === 'metadata-only';
        const appliedFields = [];
        const appliedValues = {};
        const skippedFields = [];
        const unsupportedFields = [];
        for (const field of Object.keys(updates)) {
            if (CONTROL_KEYS.has(field) || updates[field] === undefined)
                continue;
            if (!SUPPORTED.has(field)) {
                unsupportedFields.push(field);
                continue;
            }
            if (metadataOnly && !this.metadataOnlyPersistable(field, initiative)) {
                skippedFields.push(field);
                continue;
            }
            const appliedValue = (field === 'openQuestions' || field === 'blockers')
                ? (Array.isArray(updates[field]) ? updates[field] : undefined)
                : updates[field];
            initiative[field] = appliedValue;
            appliedFields.push(field);
            appliedValues[field] = appliedValue;
        }
        if (unsupportedFields.length > 0) {
            return {
                success: false,
                error: `initiative.update does not support fields: ${unsupportedFields.join(', ')}`,
                unsupportedFields,
                skippedFields,
                appliedFields: [],
                id: args.id
            };
        }
        if (args.progressNote !== undefined) {
            if (metadataOnly) {
                skippedFields.push('progressNote');
            }
            else {
                initiative.progressLog.push(args.progressNote);
                appliedFields.push('progressNote');
            }
        }
        initiative.updated = (0, utils_1.today)();
        const filePath = this.context.initiatives.update(fileName, initiative);
        // Postcondition: every field reported as applied must read back from disk.
        // Re-read via the returned path: flat-mode updates may rename the file.
        const after = this.context.initiatives.read(path.basename(filePath));
        const failedFields = appliedFields
            .filter(field => field !== 'progressNote')
            .filter(field => {
            const actual = after?.[field];
            const expected = appliedValues[field];
            // `done` (flat-v1 alias) and `complete` (directory-v2 canonical) are
            // the same persisted state; accept either spelling on read-back.
            if (field === 'status' && (0, types_1.isCompleted)(actual) && (0, types_1.isCompleted)(expected))
                return false;
            return !fieldsPersistedEqual(actual, expected);
        });
        if (failedFields.length > 0) {
            return {
                success: false,
                error: `initiative.update postcondition failed: fields not persisted: ${failedFields.join(', ')}`,
                failedFields,
                appliedFields: appliedFields.filter(field => !failedFields.includes(field)),
                skippedFields,
                unsupportedFields,
                id: initiative.id
            };
        }
        return { success: true, filename: path.basename(filePath), id: initiative.id, appliedFields, skippedFields, unsupportedFields };
    }
    /**
     * Whether initiative.update can persist `field` under metadata-only mode.
     * Only lifecycle keys are rewritten; next_action only when the consumer
     * file already carries the key.
     */
    metadataOnlyPersistable(field, initiative) {
        if (field === 'status' || field === 'graduated')
            return true;
        if (field === 'nextAction')
            return initiative.nextAction !== undefined;
        return false;
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
    createWiki(rawArgs) {
        const args = (0, utils_1.normalizeCommandKeys)(rawArgs);
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
            status: args.status || undefined,
            lifecycle: args.lifecycle || undefined,
            knowledgeType: args.knowledgeType || undefined,
            confidence: args.confidence || undefined,
            sourceInitiatives: Array.isArray(args.sourceInitiatives) ? args.sourceInitiatives : undefined,
            supersedes: Array.isArray(args.supersedes) ? args.supersedes : undefined,
            relatedWiki: Array.isArray(args.relatedWiki) ? args.relatedWiki : undefined
        });
        return { success: true, filename: category ? path.join(path.basename(path.dirname(filePath)), path.basename(filePath)) : path.basename(filePath), id: args.id };
    }
    /**
     * wiki.update — lossless, explicit mutation result. snake_case inputs are
     * normalized to camelCase. Unknown fields are rejected in
     * `unsupportedFields` with no write. Requested changes are verified by
     * re-reading the page from disk; if a requested change did not persist the
     * result is non-success with the failed fields listed.
     */
    updateWiki(rawArgs) {
        const args = (0, utils_1.normalizeCommandKeys)(rawArgs);
        if (!args.id)
            return { error: 'wiki.update requires id' };
        const KNOWN = new Set(['id', 'category', 'title', 'content', 'tags', 'relatedInitiatives', 'status', 'lifecycle', 'knowledgeType', 'confidence', 'sourceInitiatives', 'supersedes', 'relatedWiki']);
        const unsupportedFields = Object.keys(args).filter(key => args[key] !== undefined && !KNOWN.has(key));
        if (unsupportedFields.length > 0) {
            return {
                success: false,
                error: `wiki.update does not support fields: ${unsupportedFields.join(', ')}`,
                unsupportedFields,
                id: args.id
            };
        }
        const category = args.category || '';
        const existing = category ? this.context.wiki.read(category, args.id) : this.context.wiki.readByRef(args.id);
        if (!existing)
            return { error: `Wiki entry not found: ${category ? `${category}/` : ''}${args.id}` };
        const rawIdentity = {
            id: existing.rawFrontmatter?.values.id,
            category: existing.rawFrontmatter?.values.category
        };
        const appliedFields = [];
        const appliedValues = {};
        const apply = (field, value) => {
            existing[field] = value;
            appliedFields.push(field);
            appliedValues[field] = value;
        };
        if (args.title !== undefined)
            apply('title', args.title);
        if (args.content !== undefined)
            apply('content', args.content);
        if (Array.isArray(args.tags))
            apply('tags', args.tags);
        if (Array.isArray(args.relatedInitiatives))
            apply('relatedInitiatives', args.relatedInitiatives);
        if (args.status !== undefined)
            apply('status', args.status);
        if (args.lifecycle !== undefined)
            apply('lifecycle', args.lifecycle);
        if (args.knowledgeType !== undefined)
            apply('knowledgeType', args.knowledgeType);
        if (args.confidence !== undefined)
            apply('confidence', args.confidence);
        if (Array.isArray(args.sourceInitiatives))
            apply('sourceInitiatives', args.sourceInitiatives);
        if (Array.isArray(args.supersedes))
            apply('supersedes', args.supersedes);
        if (Array.isArray(args.relatedWiki))
            apply('relatedWiki', args.relatedWiki);
        const filePath = this.context.wiki.update(category, args.id, existing);
        // Postcondition: every requested change must read back from disk.
        const after = category ? this.context.wiki.read(category, args.id) : this.context.wiki.readByRef(args.id);
        const failedFields = appliedFields.filter(field => {
            const actual = after?.[field];
            const expected = appliedValues[field];
            // Body content is trimmed on parse; compare trimmed forms.
            if (field === 'content')
                return String(actual ?? '').trim() !== String(expected ?? '').trim();
            return !fieldsPersistedEqual(actual, expected);
        });
        if (!fieldsPersistedEqual(after?.rawFrontmatter?.values.id, rawIdentity.id) || !fieldsPersistedEqual(after?.rawFrontmatter?.values.category, rawIdentity.category)) {
            failedFields.push('raw identity/category');
        }
        if (failedFields.length > 0) {
            return {
                success: false,
                error: `wiki.update postcondition failed: fields not persisted: ${failedFields.join(', ')}`,
                failedFields,
                appliedFields: appliedFields.filter(field => !failedFields.includes(field)),
                id: args.id
            };
        }
        return { success: true, filename: category ? path.join(path.basename(path.dirname(filePath)), path.basename(filePath)) : path.basename(filePath), id: args.id, appliedFields, unsupportedFields: [] };
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
    /**
     * wiki.link — bidirectional, postcondition-verified link.
     *
     * - Under directory metadata-only mode the initiative-side `related_wiki`
     *   is persisted via a surgical frontmatter-array mutation (the whitelisted
     *   update would silently drop it).
     * - Self-backlink guard: linking an initiative to its own compiled page
     *   (category `initiatives`/`initiative`, id equal to the initiative id) is
     *   provenance, not a link — no self `related_initiatives` entry and no
     *   `related_wiki` self-entry are written; the result is success with
     *   `selfLink: true`, never `bidirectional: true`.
     * - After both writes, both sides are read back from disk; only a verified
     *   pair returns `bidirectional: true`. If the wiki side fails after the
     *   initiative side was written, the initiative side is rolled back
     *   surgically so no partial mutation remains.
     */
    linkWiki(rawArgs) {
        const args = (0, utils_1.normalizeCommandKeys)(rawArgs);
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
        const wikiEntry = this.context.wiki.readByRef(wikiSlug);
        if (!wikiEntry)
            return { error: `Wiki entry not found: ${wikiSlug}` };
        const fileName = (0, utils_1.findInitiativeFilename)(this.context.mdocsRoot, this.context.initiatives, args.initiativeId);
        if (!fileName)
            return { error: `Initiative not found: ${args.initiativeId}` };
        const initiative = this.context.initiatives.read(fileName);
        if (!initiative)
            return { error: `Initiative not found: ${args.initiativeId}` };
        // Self-backlink guard: an initiative's own compiled page is provenance.
        const wikiCategory = (wikiEntry.category || '').toLowerCase();
        if ((wikiCategory === 'initiatives' || wikiCategory === 'initiative') && wikiEntry.id === initiative.id) {
            return {
                success: true,
                selfLink: true,
                skipped: 'own-compiled-page',
                bidirectional: false,
                initiativeId: args.initiativeId,
                wikiSlug
            };
        }
        let initiativeChanged = false;
        try {
            initiativeChanged = this.context.initiatives.addRelatedWikiLink(fileName, wikiSlug);
        }
        catch (err) {
            return { success: false, bidirectional: false, error: `wiki.link failed on initiative side: ${err.message || String(err)}` };
        }
        try {
            this.context.wiki.addRelatedInitiativeByRef(wikiSlug, args.initiativeId);
        }
        catch (err) {
            // Second half failed: roll back the initiative side surgically so no
            // partial mutation remains.
            let rolledBack = false;
            if (initiativeChanged) {
                try {
                    this.context.initiatives.removeRelatedWikiLink(fileName, wikiSlug);
                    rolledBack = true;
                }
                catch {
                    // Rollback best-effort; the error below reports the failure.
                }
            }
            return {
                success: false,
                bidirectional: false,
                error: `wiki.link failed on wiki side: ${err.message || String(err)}`,
                rolledBack
            };
        }
        // Postcondition: both sides must read back from disk.
        const initiativeAfter = this.context.initiatives.read(fileName);
        const wikiAfter = this.context.wiki.readByRef(wikiSlug);
        const initiativeLinked = !!initiativeAfter?.relatedWiki.includes(wikiSlug);
        const wikiLinked = !!wikiAfter?.relatedInitiatives.includes(args.initiativeId);
        if (initiativeLinked && wikiLinked) {
            return { success: true, bidirectional: true, initiativeId: args.initiativeId, wikiSlug };
        }
        if (initiativeLinked && !wikiLinked) {
            // Wiki side did not persist: roll the initiative side back.
            try {
                this.context.initiatives.removeRelatedWikiLink(fileName, wikiSlug);
            }
            catch {
                // Rollback best-effort.
            }
        }
        return {
            success: false,
            bidirectional: false,
            error: 'wiki.link postcondition failed: link not persisted on both sides',
            initiativeLinked,
            wikiLinked
        };
    }
    crossReferenceWiki(args) {
        if (!args.fromSlug || !args.toSlug)
            return { error: 'wiki.xref requires fromSlug and toSlug' };
        const parseCategoryRef = (ref) => {
            if (typeof ref !== 'string')
                return null;
            const parts = ref.split('/');
            return parts.length === 2 && parts[0] && parts[1] ? [parts[0], parts[1]] : null;
        };
        const fromRef = parseCategoryRef(args.fromSlug);
        const toRef = parseCategoryRef(args.toSlug);
        if (!fromRef)
            return { success: false, error: `Invalid fromSlug format: ${args.fromSlug}. Expected category/id` };
        if (!toRef)
            return { success: false, error: `Invalid toSlug format: ${args.toSlug}. Expected category/id` };
        const [fromCategory, fromId] = fromRef;
        const [toCategory, toId] = toRef;
        if (!this.context.wiki.read(toCategory, toId)) {
            return { success: false, error: `Wiki target not found: ${args.toSlug}` };
        }
        this.context.wiki.addWikiCrossRef(fromCategory, fromId, toCategory, toId);
        const from = this.context.wiki.read(fromCategory, fromId);
        const persisted = !!from?.relatedWiki?.includes(`${toCategory}/${toId}`);
        return persisted
            ? { success: true, bidirectional: false, fromSlug: args.fromSlug, toSlug: args.toSlug }
            : { success: false, bidirectional: false, error: 'wiki.xref postcondition failed: reference not persisted', fromSlug: args.fromSlug, toSlug: args.toSlug };
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
            for (const rawOp of operations) {
                // Each op application is isolated: a failing op records an error but
                // does NOT abort the rest of the batch. snake_case op keys are
                // normalized to camelCase at the boundary.
                const op = (0, utils_1.normalizeCommandKeys)(rawOp);
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
                            status: op.status,
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
                            const rawIdentity = {
                                id: existing.rawFrontmatter?.values.id,
                                category: existing.rawFrontmatter?.values.category
                            };
                            const KNOWN_OP_KEYS = new Set(['type', 'category', 'id', 'content', 'status', 'lifecycle', 'tags', 'relatedInitiatives']);
                            const unsupportedFields = Object.keys(op).filter(key => op[key] !== undefined && !KNOWN_OP_KEYS.has(key));
                            if (unsupportedFields.length > 0) {
                                appliedOps.push({
                                    type: op.type,
                                    ref,
                                    ok: false,
                                    error: `unsupported fields: ${unsupportedFields.join(', ')}`,
                                    unsupportedFields
                                });
                                continue;
                            }
                            const appliedFields = [];
                            const appliedValues = {};
                            const applyOp = (field, value) => {
                                existing[field] = value;
                                appliedFields.push(field);
                                appliedValues[field] = value;
                            };
                            if (op.content !== undefined)
                                applyOp('content', op.content);
                            if (op.status !== undefined)
                                applyOp('status', op.status);
                            if (op.lifecycle !== undefined)
                                applyOp('lifecycle', op.lifecycle);
                            if (Array.isArray(op.tags))
                                applyOp('tags', op.tags);
                            if (Array.isArray(op.relatedInitiatives))
                                applyOp('relatedInitiatives', op.relatedInitiatives);
                            const filePath = this.context.wiki.update(category, op.id, existing);
                            // Postcondition: requested changes must read back from disk.
                            const after = category ? this.context.wiki.read(category, op.id) : this.context.wiki.readByRef(op.id);
                            const failedFields = appliedFields.filter(field => {
                                const actual = after?.[field];
                                const expected = appliedValues[field];
                                if (field === 'content')
                                    return String(actual ?? '').trim() !== String(expected ?? '').trim();
                                return !fieldsPersistedEqual(actual, expected);
                            });
                            if (!fieldsPersistedEqual(after?.rawFrontmatter?.values.id, rawIdentity.id) || !fieldsPersistedEqual(after?.rawFrontmatter?.values.category, rawIdentity.category)) {
                                failedFields.push('raw identity/category');
                            }
                            if (failedFields.length > 0) {
                                appliedOps.push({
                                    type: op.type,
                                    ref,
                                    ok: false,
                                    error: `postcondition failed: fields not persisted: ${failedFields.join(', ')}`,
                                    failedFields,
                                    appliedFields: appliedFields.filter(field => !failedFields.includes(field)),
                                    unsupportedFields
                                });
                            }
                            else {
                                appliedOps.push({ type: op.type, ref, ok: true, appliedFields });
                                changedFiles.push(path.relative(this.context.mdocsRoot, filePath));
                            }
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
                            // Self-backlink guard: an initiative's own compiled page is
                            // provenance, not a link target.
                            const target = this.context.wiki.readByRef(op.wikiSlug);
                            const targetCategory = (target?.category || '').toLowerCase();
                            if (target && (targetCategory === 'initiatives' || targetCategory === 'initiative') && target.id === op.initiativeId) {
                                appliedOps.push({ type: op.type, ref: `${op.initiativeId}->${op.wikiSlug}`, ok: true, selfLink: true, skipped: 'own-compiled-page' });
                            }
                            else {
                                this.context.wiki.addRelatedInitiativeByRef(op.wikiSlug, op.initiativeId);
                                appliedOps.push({ type: op.type, ref: `${op.initiativeId}->${op.wikiSlug}`, ok: true });
                            }
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
            success: appliedOps.every(operation => operation.ok),
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