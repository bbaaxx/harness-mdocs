import { MdocsCore } from './factory';
import { StepName } from './types';
import { findInitiativeFilename } from './commands/utils';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { BUILD_GIT_SHA, BUILD_VERSION } from './build-info';

/**
 * Build fingerprint so any surface can answer "which build are you running?".
 * Version from the build-time stamp when available, else package.json, else
 * '0.0.0'; git sha from the build-time stamp, else npm's gitHead field
 * stamped at publish, else the package's own repo, else null.
 */
export function buildInfo(): { version: string; gitSha: string | null } {
  let version = BUILD_VERSION ?? '0.0.0';
  let gitSha: string | null = BUILD_GIT_SHA;
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
    if (!BUILD_VERSION && typeof pkg.version === 'string') version = pkg.version;
    if (!gitSha && typeof pkg.gitHead === 'string') gitSha = pkg.gitHead.slice(0, 7);
  } catch { /* package.json unreadable — keep defaults */ }
  try {
    if (!gitSha) gitSha = execSync('git rev-parse --short HEAD', { cwd: join(__dirname, '..', '..'), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null;
  } catch { /* not a git checkout — keep null */ }
  return { version, gitSha };
}

export function advance(core: MdocsCore, step: string) {
  core.managers.workflow.advance(step as StepName);
  return core.managers.workflow.status();
}

export function lookup(core: MdocsCore, query: string) {
  const match = core.managers.initiatives.findByQuery(query);
  if (match) return {
    type: 'initiative',
    id: match.initiative.id,
    title: match.initiative.title,
    status: match.initiative.status,
    tags: match.initiative.tags,
    filename: match.key
  };

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

  // F1-D / F9-A: when currentStep is terminal (COMPLETE) or IDLE, move the
  // step back to IDLE then advance to UNDERSTAND so a resumed initiative lands
  // inside the gated region. Mid-flight steps (UNDERSTAND…REPORT) are
  // preserved unchanged. NOTE: this uses `resumeAt('IDLE')` (step-only reset),
  // NOT `reset()` — `reset()` is the F9-B full-clean-slate primitive that also
  // clears activeInitiative, which would wipe the id we just set above.
  const currentStep = core.managers.workflow.getCurrentStep();
  if (currentStep === 'COMPLETE' || currentStep === 'IDLE') {
    core.managers.workflow.resumeAt('IDLE');
    core.managers.workflow.advance('UNDERSTAND');
  }

  return {
    initiative: { id: initiative.id, title: initiative.title, status: initiative.status },
    currentStep: core.managers.workflow.status().currentStep,
    nextAction: initiative.nextAction || initiative.plan.find(item => item.status !== 'done')?.description || '',
    blockers: initiative.blockers || [],
    latestProgress: initiative.progressLog.at(-1) || '',
    validation: core.commands.validationResult()
  };
}

/**
 * F9-B: explicit reset. Returns the workflow to IDLE and clears the active
 * initiative (full clean slate). Use cases: abandon an initiative mid-flight,
 * force-reset for testing, or begin a fresh initiative cycle after COMPLETE.
 */
export function reset(core: MdocsCore) {
  core.managers.workflow.reset();
  return core.managers.workflow.status();
}

export function dispatch(core: MdocsCore, id?: string) {
  const resolvedId = id || status(core).activeInitiative;
  if (!resolvedId) return { error: 'No initiativeId provided and no active initiative' };

  const fileName = findInitiativeFilename(core.mdocsRoot, core.managers.initiatives, resolvedId);
  const initiative = fileName ? core.managers.initiatives.read(fileName) : null;
  if (!initiative) return { error: 'Initiative not found' };

  const wikiEntries = [];
  for (const wikiRef of initiative.relatedWiki) {
    const entry = core.managers.wiki.readByRef(wikiRef);
    if (entry) wikiEntries.push(entry);
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
  const build = buildInfo();
  if (!state.activeInitiative) return { ...state, build };

  const fileName = findInitiativeFilename(core.mdocsRoot, core.managers.initiatives, state.activeInitiative);
  const initiative = fileName ? core.managers.initiatives.read(fileName) : null;
  if (initiative?.status === 'active') return { ...state, build };

  core.managers.workflow.setActiveInitiative(null);
  return { ...core.managers.workflow.status(), build };
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

/**
 * G1: Compact orientation snapshot for the Claude Code SessionStart hook.
 * Returns only what the orientation banner needs — initiative counts by
 * status, the active initiative id/title + current workflow step, and the
 * wiki page count. Kept deliberately small so the additionalContext string
 * stays well under the 10,000-char hook output cap.
 *
 * Reuses existing managers (initiatives.list, wiki.list, workflow.status)
 * so it agrees with `mdocs_status` / `mdocs_resume` on what "active" means.
 * Any read error is swallowed by the caller (session-start.ts fail-open).
 */
export function sessionContext(core: MdocsCore): {
  counts: Record<string, number>;
  activeInitiative: { id: string; title: string } | null;
  currentStep: string;
  wikiPageCount: number;
} {
  const initiatives = core.managers.initiatives.list();
  const counts: Record<string, number> = {};
  for (const i of initiatives) {
    const status = i.status || 'unknown';
    counts[status] = (counts[status] || 0) + 1;
  }

  const workflowStatus = core.managers.workflow.status();
  let activeInitiative: { id: string; title: string } | null = null;
  if (workflowStatus.activeInitiative) {
    const active = initiatives.find(i => i.id === workflowStatus.activeInitiative);
    if (active && active.status === 'active') {
      activeInitiative = { id: active.id, title: active.title };
    }
  }

  let wikiPageCount = 0;
  try {
    wikiPageCount = core.managers.wiki.list().length;
  } catch {
    wikiPageCount = 0;
  }

  return {
    counts,
    activeInitiative,
    currentStep: workflowStatus.currentStep,
    wikiPageCount
  };
}
