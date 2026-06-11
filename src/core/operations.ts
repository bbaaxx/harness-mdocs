import * as fs from 'fs';
import * as path from 'path';
import { MdocsCore } from './factory';
import { findInitiativeFilename, slugify } from './commands/utils';

export function lookup(core: MdocsCore, query: string) {
  const normalizedQuery = query.toLowerCase();
  const querySlug = slugify(query);
  const initiativesDir = path.join(core.mdocsRoot, 'initiatives');
  const files = fs.existsSync(initiativesDir) ? fs.readdirSync(initiativesDir).filter(file => file.endsWith('.md') && file !== 'INDEX.md') : [];

  for (const fileName of files) {
    const initiative = core.managers.initiatives.read(fileName);
    if (!initiative) continue;

    const fileStem = fileName.replace(/\.md$/, '');
    const fileSlug = slugify(fileStem.replace(/--\d{4}-\d{2}-\d{2}$/, ''));
    const idSlug = slugify(initiative.id || '');
    const titleSlug = slugify(initiative.title || '');
    const title = initiative.title || '';
    const matched =
      initiative.id === query ||
      idSlug === querySlug ||
      title.toLowerCase().includes(normalizedQuery) ||
      titleSlug === querySlug ||
      fileName === query ||
      fileStem === query ||
      fileSlug === querySlug;

    if (matched) {
      return {
        type: 'initiative',
        id: initiative.id,
        title: initiative.title,
        status: initiative.status,
        tags: initiative.tags,
        filename: fileName
      };
    }
  }

  return { error: `No initiatives found for query: ${query}` };
}

export function resume(core: MdocsCore, id?: string) {
  const resolvedId = id || status(core).activeInitiative;
  if (!resolvedId) {
    return { resumable: core.managers.search.query('', { status: 'active' }).filter(result => result.type === 'initiative') };
  }

  const fileName = findInitiativeFilename(core.mdocsRoot, core.managers.initiatives, resolvedId);
  if (!fileName) return { error: `Initiative not found: ${resolvedId}` };
  const initiative = core.managers.initiatives.read(fileName);
  if (!initiative) return { error: `Initiative not found: ${resolvedId}` };
  core.managers.workflow.setActiveInitiative(initiative.id);
  return {
    initiative: { id: initiative.id, title: initiative.title, status: initiative.status },
    currentStep: core.managers.workflow.status().currentStep,
    nextAction: initiative.nextAction || initiative.plan.find(item => item.status !== 'done')?.description || '',
    blockers: initiative.blockers || [],
    latestProgress: initiative.progressLog.at(-1) || '',
    validation: core.commands.validationResult()
  };
}

export function dispatch(core: MdocsCore, id?: string) {
  const resolvedId = id || status(core).activeInitiative;
  if (!resolvedId) return { error: 'No initiativeId provided and no active initiative' };

  const initiative = core.managers.initiatives.findById(resolvedId);
  if (!initiative) return { error: 'Initiative not found' };

  const wikiEntries = [];
  for (const wikiRef of initiative.relatedWiki) {
    const [category, entryId] = wikiRef.split('/');
    if (category && entryId) {
      const entry = core.managers.wiki.read(category, entryId);
      if (entry) wikiEntries.push(entry);
    }
  }

  const retrievedMemory = core.managers.search.query(`${initiative.title} ${initiative.objective} ${initiative.tags.join(' ')}`).slice(0, 5);
  const recentEvents = core.managers.audit.query({ initiativeId: initiative.id, limit: 5 });
  const currentStep = core.managers.workflow.getCurrentStep();
  const context = core.managers.dispatch.assemble(initiative, wikiEntries, currentStep, { retrievedMemory, recentEvents });

  return {
    context,
    initiativeId: initiative.id,
    step: currentStep,
    relatedWikiCount: wikiEntries.length
  };
}

export function status(core: MdocsCore) {
  const state = core.managers.workflow.status();
  if (!state.activeInitiative) return state;

  const fileName = findInitiativeFilename(core.mdocsRoot, core.managers.initiatives, state.activeInitiative);
  const initiative = fileName ? core.managers.initiatives.read(fileName) : null;
  if (initiative?.status === 'active') return state;

  core.managers.workflow.setActiveInitiative(null);
  return core.managers.workflow.status();
}

export function indexCheck(core: MdocsCore, repair: boolean) {
  const initiativeResult = core.managers.initiatives.checkConsistency();
  const wikiResult = core.managers.wiki.checkConsistency();
  const consistent = initiativeResult.consistent && wikiResult.consistent;

  if (repair) {
    if (!consistent) {
      core.managers.initiatives.syncIndex();
      core.managers.wiki.syncIndices();
    }
    return {
      consistent: true,
      initiatives: consistent ? initiativeResult : core.managers.initiatives.checkConsistency(),
      wiki: consistent ? wikiResult : core.managers.wiki.checkConsistency(),
      repaired: !consistent
    };
  }

  return { consistent, initiatives: initiativeResult, wiki: wikiResult, repaired: false };
}

export function audit(core: MdocsCore, opts: {
  initiativeId?: string;
  type?: string;
  limit?: number;
  startDate?: string;
  endDate?: string;
}) {
  return core.managers.audit.query(opts);
}
