import { sessionContext } from '../../core/operations';
import { MdocsCore } from '../../core';

/**
 * Compact orientation banner for the pi surface.
 *
 * Consumes `sessionContext(core)` (the same snapshot used by the Claude Code
 * SessionStart hook and `mdocs_status`) and renders a short markdown banner
 * suitable for appending to the system prompt in `before_agent_start`, plus a
 * one-line user-facing summary for `session_start` notifications.
 *
 * Kept deliberately small (well under ~1 KB) because `before_agent_start` runs
 * every turn. Any read error is swallowed by the caller (extension fail-open).
 */

export interface OrientationSnapshot {
  counts: Record<string, number>;
  activeInitiative: { id: string; title: string } | null;
  currentStep: string;
  wikiPageCount: number;
}

export function formatOrientationBanner(core: MdocsCore): string {
  const ctx = safeSnapshot(core);
  const lines: string[] = [
    '## mdocs — Initiative and Wiki Memory',
    '',
    `mdocs is active. Workflow step: **${ctx.currentStep}**${ctx.activeInitiative ? `, active initiative: **${ctx.activeInitiative.title}** (\`${ctx.activeInitiative.id}\`)` : ''}.`
  ];

  const activeCount = ctx.counts.active ?? 0;
  const doneCount = (ctx.counts.done ?? 0) + (ctx.counts.complete ?? 0);
  lines.push(
    `Initiatives: ${activeCount} active, ${doneCount} done. Wiki pages: ${ctx.wikiPageCount}.`
  );

  lines.push('');
  lines.push('Quick reference:');
  lines.push('- Status / orientation: `mdocs_status`');
  lines.push('- Resume work: `mdocs_resume`');
  lines.push('- Run any core command: `mdocs` (with `command` + `args`)');
  lines.push('- Advance the workflow: `mdocs_advance` (e.g. `{ "step": "PLAN" }`)');
  lines.push('- Search memory: `mdocs_search`');
  lines.push('- Validate before completion: `mdocs_validate`');
  lines.push('');
  lines.push(
    'Enforcement: `write`/`edit` are blocked before `PLAN` and allowed from `PLAN` through `COMPLETE` (edits under `./mdocs/` are always allowed). `bash` is audited but not gated by content. Advance the workflow rather than working around a blocked tool.'
  );

  return lines.join('\n');
}

/** One-line user-facing summary for the `session_start` notification. */
export function formatOrientationNotify(core: MdocsCore): string {
  const ctx = safeSnapshot(core);
  const active = ctx.activeInitiative ? ` — active: ${ctx.activeInitiative.title}` : '';
  return `mdocs active (step ${ctx.currentStep}${active})`;
}

function safeSnapshot(core: MdocsCore): OrientationSnapshot {
  try {
    return sessionContext(core);
  } catch {
    return { counts: {}, activeInitiative: null, currentStep: 'IDLE', wikiPageCount: 0 };
  }
}
