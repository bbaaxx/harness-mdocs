import * as path from 'path';
import { AuditLog } from '../audit';
import { InitiativeManager } from '../managers/initiative';
import { MdocsManager } from '../managers/mdocs';
import { WikiManager } from '../managers/wiki';
import { MdocsLinter } from '../validation/linter';
import { SearchEngine } from '../search';
import { SubagentAssembler } from '../subagent';
import { WorkflowEngine } from '../workflow/engine';
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
    'wiki.stub',
    'wiki.delete',
    'wiki.list',
    'wiki.link',
    'wiki.xref',
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
      nextAction: args.nextAction || undefined
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
    for (const field of ['status', 'tags', 'priority', 'dueDate', 'dependsOn', 'owner', 'phase', 'handoffSummary', 'nextAction']) {
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
    if (initiative.status !== 'done') return { error: `Only done initiatives can be archived: ${args.id}` };
    const result = this.context.initiatives.archive(fileName);
    return { success: true, id: args.id, archivedFilename: result.archivedFilename };
  }

  private createWiki(args: Record<string, any>) {
    if (!args.category || !args.id || !args.title) return { error: 'wiki.create requires category, id, and title' };
    const date = today();
    const filePath = this.context.wiki.create({
      category: args.category,
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
    return { success: true, filename: path.join(path.basename(path.dirname(filePath)), path.basename(filePath)), id: args.id };
  }

  private updateWiki(args: Record<string, any>) {
    if (!args.category || !args.id) return { error: 'wiki.update requires category and id' };
    const existing = this.context.wiki.read(args.category, args.id);
    if (!existing) return { error: `Wiki entry not found: ${args.category}/${args.id}` };
    if (args.title !== undefined) existing.title = args.title;
    if (args.content !== undefined) existing.content = args.content;
    if (Array.isArray(args.tags)) existing.tags = args.tags;
    if (Array.isArray(args.relatedInitiatives)) existing.relatedInitiatives = args.relatedInitiatives;
    if (args.lifecycle !== undefined) existing.lifecycle = args.lifecycle;
    if (args.knowledgeType !== undefined) existing.knowledgeType = args.knowledgeType;
    if (args.confidence !== undefined) existing.confidence = args.confidence;
    if (Array.isArray(args.sourceInitiatives)) existing.sourceInitiatives = args.sourceInitiatives;
    if (Array.isArray(args.supersedes)) existing.supersedes = args.supersedes;
    const filePath = this.context.wiki.update(args.category, args.id, existing);
    return { success: true, filename: path.join(path.basename(path.dirname(filePath)), path.basename(filePath)), id: args.id };
  }

  private stubWiki(args: Record<string, any>) {
    if (!args.category || !args.id) return { error: 'wiki.stub requires category and id' };
    const result = this.context.wiki.stub(args.category, args.id, args.title, args.template);
    if (result.existing) return { success: false, existing: true, filePath: path.relative(this.context.mdocsRoot, result.filePath) };
    return { success: true, category: args.category, id: args.id, filePath: path.relative(this.context.mdocsRoot, result.filePath) };
  }

  private deleteWiki(args: Record<string, any>) {
    if (!args.category || !args.id) return { error: 'wiki.delete requires category and id' };
    if (!this.context.wiki.read(args.category, args.id)) return { error: `Wiki entry not found: ${args.category}/${args.id}` };
    this.context.wiki.delete(args.category, args.id);
    return { success: true, category: args.category, id: args.id, deletedFilename: `${args.category}/${args.id}.md` };
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
    const [category, entryId] = args.wikiSlug.split('/');
    if (!category || !entryId) return { error: `Invalid wikiSlug format: ${args.wikiSlug}. Expected category/id` };
    const fileName = findInitiativeFilename(this.context.mdocsRoot, this.context.initiatives, args.initiativeId);
    if (!fileName) return { error: `Initiative not found: ${args.initiativeId}` };
    const initiative = this.context.initiatives.read(fileName);
    if (!initiative) return { error: `Initiative not found: ${args.initiativeId}` };
    if (!initiative.relatedWiki.includes(args.wikiSlug)) {
      initiative.relatedWiki.push(args.wikiSlug);
      initiative.updated = today();
      this.context.initiatives.update(fileName, initiative);
    }
    this.context.wiki.addRelatedInitiative(category, entryId, args.initiativeId);
    return { success: true, bidirectional: true, initiativeId: args.initiativeId, wikiSlug: args.wikiSlug };
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

  private syncIndex() {
    const regenerated = [
      path.relative(this.context.mdocsRoot, this.context.initiatives.syncIndex()),
      ...this.context.wiki.syncIndices().map(filePath => path.relative(this.context.mdocsRoot, filePath))
    ];
    return { success: true, regenerated };
  }
}
