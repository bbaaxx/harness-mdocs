import * as path from 'path';
import { AuditLog } from '../audit';
import { InitiativeManager } from '../managers/initiative';
import { MdocsManager } from '../managers/mdocs';
import { WikiManager } from '../managers/wiki';
import { MdocsLinter } from '../validation/linter';
import { SearchEngine } from '../search';
import { SubagentAssembler } from '../subagent';
import { WorkflowEngine, STEPS } from '../workflow/engine';
import { isCompleted, StepName } from '../types';
import { withLock } from '../lock';
import { findInitiativeFilename, slugify, today } from './utils';

export interface MdocsCommandContext {
  mdocsRoot: string;
  mdocs: MdocsManager;
  initiatives: InitiativeManager;
  wiki: WikiManager;
  workflow: WorkflowEngine;
  search: SearchEngine;
  audit: AuditLog;
  linter: MdocsLinter;
  dispatch: SubagentAssembler;
}

export class MdocsCommandRegistry {
  readonly supportedCommands = [
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

  constructor(private readonly context: MdocsCommandContext) {}

  async execute(command: string, args: Record<string, any> = {}): Promise<any> {
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
    } catch (err: any) {
      return { error: err.message || String(err) };
    }
  }

  private advanceWorkflow(args: Record<string, any>) {
    const step = args.step || args.nextStep;
    if (!step || typeof step !== 'string') {
      return { error: 'workflow.advance requires { step: StepName }', validSteps: STEPS };
    }
    if (!STEPS.includes(step as StepName)) {
      return { error: `Invalid workflow step: ${step}`, validSteps: STEPS };
    }
    try {
      this.context.workflow.advance(step as StepName);
    } catch (err: any) {
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
  private graduateInitiative(args: Record<string, any>) {
    if (!args.id) return { error: 'lifecycle.graduate requires id' };
    this.context.initiatives.assertWriteSupported('lifecycle.graduate');
    const fileName = findInitiativeFilename(this.context.mdocsRoot, this.context.initiatives, args.id);
    if (!fileName) return { error: `Initiative not found: ${args.id}` };
    const initiative = this.context.initiatives.read(fileName);
    if (!initiative) return { error: `Initiative not found: ${args.id}` };
    if (!isCompleted(initiative.status)) {
      return { error: `Only completed initiatives can be graduated (current status: ${initiative.status})` };
    }

    const sections: Array<{ section: string; body: string }> = Array.isArray(args.sections) ? args.sections : [];
    const logEntry = args.logEntry;

    const lockResult = withLock(this.context.mdocsRoot, 'lifecycle-graduate', () => {
      const sectionResults: any[] = [];
      let logResult: any = undefined;

      for (const s of sections) {
        try {
          const p = this.context.wiki.updateOverviewSection(s.section, s.body);
          sectionResults.push({
            section: s.section,
            ok: true,
            skipped: p === null ? 'non-directory-v2' : undefined,
            filePath: p ? path.relative(this.context.mdocsRoot, p) : undefined
          });
        } catch (err: any) {
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
        } catch (err: any) {
          logResult = { ok: false, error: err.message || String(err) };
        }
      }

      let stampError: string | undefined;
      try {
        initiative.graduated = today();
        this.context.initiatives.update(fileName, initiative);
      } catch (stampErr: any) {
        stampError = stampErr.message || String(stampErr);
      }

      return { sectionResults, logResult, stampError };
    });

    if (!lockResult.ran || lockResult.value === undefined) {
      return { success: false, error: 'lifecycle-graduate lock timeout' };
    }

    const { sectionResults, logResult, stampError } = lockResult.value;
    const wrote: any = { overviewSections: sectionResults };
    if (logResult !== undefined) wrote.logEntry = logResult;
    const result: any = {
      success: true,
      initiativeId: initiative.id,
      graduated: today(),
      wrote
    };
    if (stampError) result.stampError = stampError;
    return result;
  }

  validationResult() {
    const initiativeValidation = this.context.initiatives.validate();
    const wikiValidation = this.context.wiki.validate();
    const allLintResults = this.context.linter.lintAll();
    const graphResults = allLintResults.filter(result => result.file === 'GRAPH');
    const graphErrors = graphResults.flatMap(result =>
      result.issues.filter(issue => issue.severity === 'error').map(issue => `${result.file}: ${issue.message}`)
    );
    const graphWarnings = graphResults.flatMap(result =>
      result.issues.filter(issue => issue.severity !== 'error').map(issue => `${result.file}: ${issue.message}`)
    );
    return {
      initiatives: initiativeValidation,
      wiki: wikiValidation,
      graph: { valid: graphErrors.length === 0, errors: graphErrors, warnings: graphWarnings, results: graphResults },
      valid: initiativeValidation.valid && wikiValidation.valid && graphErrors.length === 0
    };
  }

  private createInitiative(args: Record<string, any>) {
    if (!args.title) return { error: 'initiative.create requires title' };
    this.context.initiatives.assertWriteSupported('initiative.create');
    const date = today();
    const id = args.id || slugify(args.title);
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
            .map((item: any) => ({
              description: typeof item === 'string' ? item : item?.description || '',
              status: 'pending' as const
            }))
            .filter((item: any) => item.description)
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

  private updateInitiative(args: Record<string, any>) {
    if (!args.id) return { error: 'initiative.update requires id' };
    this.context.initiatives.assertWriteSupported('initiative.update');
    const fileName = findInitiativeFilename(this.context.mdocsRoot, this.context.initiatives, args.id);
    if (!fileName) return { error: `Initiative not found: ${args.id}` };
    const initiative = this.context.initiatives.read(fileName);
    if (!initiative) return { error: `Initiative not found: ${args.id}` };
    const updates = args.updates || args;
    for (const field of ['status', 'tags', 'priority', 'dueDate', 'dependsOn', 'owner', 'phase', 'handoffSummary', 'nextAction', 'expectedDuration', 'graduated']) {
      if (updates[field] !== undefined) (initiative as any)[field] = updates[field];
    }
    if (updates.openQuestions !== undefined) initiative.openQuestions = Array.isArray(updates.openQuestions) ? updates.openQuestions : undefined;
    if (updates.blockers !== undefined) initiative.blockers = Array.isArray(updates.blockers) ? updates.blockers : undefined;
    initiative.updated = today();
    if (args.progressNote) initiative.progressLog.push(args.progressNote);
    const filePath = this.context.initiatives.update(fileName, initiative);
    return { success: true, filename: path.basename(filePath), id: initiative.id };
  }

  private doneInitiative(args: Record<string, any>) {
    if (!args.id) return { error: 'initiative.done requires id' };
    this.context.initiatives.assertWriteSupported('initiative.done');
    const fileName = findInitiativeFilename(this.context.mdocsRoot, this.context.initiatives, args.id);
    if (!fileName) return { error: `Initiative not found: ${args.id}` };
    const initiative = this.context.initiatives.read(fileName);
    if (!initiative) return { error: `Initiative not found: ${args.id}` };
    const result = this.context.initiatives.markDone(fileName);
    if (this.context.workflow.status().activeInitiative === initiative.id) {
      this.context.workflow.setActiveInitiative(null);
    }
    return { success: true, filename: result.filename, id: initiative.id };
  }

  private deleteInitiative(args: Record<string, any>) {
    if (!args.id) return { error: 'initiative.delete requires id' };
    this.context.initiatives.assertWriteSupported('initiative.delete');
    const fileName = findInitiativeFilename(this.context.mdocsRoot, this.context.initiatives, args.id);
    if (!fileName) return { error: `Initiative not found: ${args.id}` };
    this.context.initiatives.delete(fileName);
    return { success: true, id: args.id, deletedFilename: fileName };
  }

  private archiveInitiative(args: Record<string, any>) {
    if (!args.id) return { error: 'initiative.archive requires id' };
    this.context.initiatives.assertWriteSupported('initiative.archive');
    const fileName = findInitiativeFilename(this.context.mdocsRoot, this.context.initiatives, args.id);
    if (!fileName) return { error: `Initiative not found: ${args.id}` };
    const initiative = this.context.initiatives.read(fileName);
    if (!initiative) return { error: `Initiative not found: ${args.id}` };
    if (!isCompleted(initiative.status)) return { error: `Only completed initiatives can be archived: ${args.id}` };
    const result = this.context.initiatives.archive(fileName);
    return { success: true, id: args.id, archivedFilename: result.archivedFilename };
  }

  private createWiki(args: Record<string, any>) {
    if (!args.id || !args.title) return { error: 'wiki.create requires id and title' };
    const date = today();
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

  private updateWiki(args: Record<string, any>) {
    if (!args.id) return { error: 'wiki.update requires id' };
    const category = args.category || '';
    const existing = category ? this.context.wiki.read(category, args.id) : this.context.wiki.readByRef(args.id);
    if (!existing) return { error: `Wiki entry not found: ${category ? `${category}/` : ''}${args.id}` };
    if (args.title !== undefined) existing.title = args.title;
    if (args.content !== undefined) existing.content = args.content;
    if (Array.isArray(args.tags)) existing.tags = args.tags;
    if (Array.isArray(args.relatedInitiatives)) existing.relatedInitiatives = args.relatedInitiatives;
    if (args.lifecycle !== undefined) existing.lifecycle = args.lifecycle;
    if (args.knowledgeType !== undefined) existing.knowledgeType = args.knowledgeType;
    if (args.confidence !== undefined) existing.confidence = args.confidence;
    if (Array.isArray(args.sourceInitiatives)) existing.sourceInitiatives = args.sourceInitiatives;
    if (Array.isArray(args.supersedes)) existing.supersedes = args.supersedes;
    const filePath = this.context.wiki.update(category, args.id, existing);
    return { success: true, filename: category ? path.join(path.basename(path.dirname(filePath)), path.basename(filePath)) : path.basename(filePath), id: args.id };
  }

  private stubWiki(args: Record<string, any>) {
    if (!args.id) return { error: 'wiki.stub requires id' };
    const result = this.context.wiki.stub(args.category || '', args.id, args.title, args.template);
    if (result.existing) return { success: false, existing: true, filePath: path.relative(this.context.mdocsRoot, result.filePath) };
    return { success: true, category: args.category, id: args.id, filePath: path.relative(this.context.mdocsRoot, result.filePath) };
  }

  private deleteWiki(args: Record<string, any>) {
    if (!args.id) return { error: 'wiki.delete requires id' };
    const category = args.category || '';
    const existing = category ? this.context.wiki.read(category, args.id) : this.context.wiki.readByRef(args.id);
    if (!existing) return { error: `Wiki entry not found: ${category ? `${category}/` : ''}${args.id}` };
    this.context.wiki.delete(category, args.id);
    return { success: true, category, id: args.id, deletedFilename: category ? `${category}/${args.id}.md` : `${args.id}.md` };
  }

  private listWiki(args: Record<string, any>) {
    return {
      entries: this.context.wiki.list(args.category).map(entry => ({
        category: entry.category,
        id: entry.id,
        title: entry.title,
        tags: entry.tags
      }))
    };
  }

  private linkWiki(args: Record<string, any>) {
    if (!args.initiativeId || !args.wikiSlug) return { error: 'wiki.link requires initiativeId and wikiSlug' };
    this.context.initiatives.assertWriteSupported('wiki.link');
    const rawParts = String(args.wikiSlug).split('/');
    if (rawParts.some(part => !part)) return { error: `Invalid wikiSlug format: ${args.wikiSlug}. Expected id or category/id` };
    const parts: string[] = rawParts;
    if (parts.length !== 1 && parts.length !== 2) return { error: `Invalid wikiSlug format: ${args.wikiSlug}. Expected id or category/id` };
    const normalizedParts = parts.map((part, index) => index === parts.length - 1 ? part.replace(/\.md$/, '') : part);
    const wikiSlug = normalizedParts.join('/');
    if (normalizedParts.length === 1 && normalizedParts[0].toLowerCase() === 'index') return { error: 'Refusing to overwrite canonical root wiki index: index' };
    if (!this.context.wiki.readByRef(wikiSlug)) return { error: `Wiki entry not found: ${wikiSlug}` };
    const fileName = findInitiativeFilename(this.context.mdocsRoot, this.context.initiatives, args.initiativeId);
    if (!fileName) return { error: `Initiative not found: ${args.initiativeId}` };
    const initiative = this.context.initiatives.read(fileName);
    if (!initiative) return { error: `Initiative not found: ${args.initiativeId}` };
    if (!initiative.relatedWiki.includes(wikiSlug)) {
      initiative.relatedWiki.push(wikiSlug);
      initiative.updated = today();
      this.context.initiatives.update(fileName, initiative);
    }
    this.context.wiki.addRelatedInitiativeByRef(wikiSlug, args.initiativeId);
    return { success: true, bidirectional: true, initiativeId: args.initiativeId, wikiSlug };
  }

  private crossReferenceWiki(args: Record<string, any>) {
    if (!args.fromSlug || !args.toSlug) return { error: 'wiki.xref requires fromSlug and toSlug' };
    const [fromCategory, fromId] = args.fromSlug.split('/');
    const [toCategory, toId] = args.toSlug.split('/');
    if (!fromCategory || !fromId) return { error: `Invalid fromSlug format: ${args.fromSlug}. Expected category/id` };
    if (!toCategory || !toId) return { error: `Invalid toSlug format: ${args.toSlug}. Expected category/id` };
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
  private ingestWiki(args: Record<string, any>) {
    const operations = args.operations;
    if (!Array.isArray(operations) || operations.length === 0) {
      return { error: 'wiki.ingest requires { operations: WikiIngestOp[] }' };
    }

    const lockResult = withLock(this.context.mdocsRoot, 'wiki-ingest', () => {
      const appliedOps: any[] = [];
      const changedFiles: string[] = [];

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
              created: today(),
              updated: today(),
              content: op.content ?? '',
              relatedInitiatives: Array.isArray(op.relatedInitiatives) ? op.relatedInitiatives : [],
              tags: Array.isArray(op.tags) ? op.tags : [],
              lifecycle: op.lifecycle,
              knowledgeType: op.knowledgeType,
              confidence: op.confidence
            });
            appliedOps.push({ type: op.type, ref, ok: true });
            changedFiles.push(path.relative(this.context.mdocsRoot, filePath));
          } else if (op.type === 'updatePage') {
            const category = op.category || '';
            const ref = category ? `${category}/${op.id}` : op.id;
            const existing = category ? this.context.wiki.read(category, op.id) : this.context.wiki.readByRef(op.id);
            if (!existing) {
              appliedOps.push({ type: op.type, ref, ok: false, error: 'not found' });
            } else {
              if (op.content !== undefined) existing.content = op.content;
              if (op.lifecycle !== undefined) existing.lifecycle = op.lifecycle;
              if (Array.isArray(op.tags)) existing.tags = op.tags;
              if (Array.isArray(op.relatedInitiatives)) existing.relatedInitiatives = op.relatedInitiatives;
              const filePath = this.context.wiki.update(category, op.id, existing);
              appliedOps.push({ type: op.type, ref, ok: true });
              changedFiles.push(path.relative(this.context.mdocsRoot, filePath));
            }
          } else if (op.type === 'updateOverviewSection') {
            const filePath = this.context.wiki.updateOverviewSection(op.section, op.body);
            if (filePath === null) {
              // Legitimate no-op outside directory-v2 — NOT an error.
              appliedOps.push({ type: op.type, ref: `overview#${op.section}`, ok: true, skipped: 'non-directory-v2' });
            } else {
              appliedOps.push({ type: op.type, ref: `overview#${op.section}`, ok: true });
              changedFiles.push(path.relative(this.context.mdocsRoot, filePath));
            }
          } else if (op.type === 'appendLog') {
            const filePath = this.context.wiki.appendLog(op.entry);
            if (filePath === null) {
              // Legitimate no-op outside directory-v2 — NOT an error.
              appliedOps.push({ type: op.type, ref: 'log', ok: true, skipped: 'non-directory-v2' });
            } else {
              appliedOps.push({ type: op.type, ref: 'log', ok: true });
              changedFiles.push(path.relative(this.context.mdocsRoot, filePath));
            }
          } else if (op.type === 'link') {
            try {
              this.context.wiki.addRelatedInitiativeByRef(op.wikiSlug, op.initiativeId);
              appliedOps.push({ type: op.type, ref: `${op.initiativeId}->${op.wikiSlug}`, ok: true });
            } catch (linkErr: any) {
              appliedOps.push({ type: op.type, ref: `${op.initiativeId}->${op.wikiSlug}`, ok: false, error: linkErr.message || String(linkErr) });
            }
          } else {
            appliedOps.push({ type: String(op.type), ref: '', ok: false, error: `unknown op type` });
          }
        } catch (opErr: any) {
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

  private syncIndex() {
    const regenerated = [
      path.relative(this.context.mdocsRoot, this.context.initiatives.syncIndex()),
      ...this.context.wiki.syncIndices().map(filePath => path.relative(this.context.mdocsRoot, filePath))
    ];
    return { success: true, regenerated };
  }
}
