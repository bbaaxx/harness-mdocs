import { sessionContext } from '../../core';

export type OrientationSnapshot = ReturnType<typeof sessionContext>;

/**
 * Format the sessionContext snapshot as a compact markdown orientation
 * banner for Kimi Code SessionStart hooks. Kimi Code appends exit-0 stdout
 * from a SessionStart hook to the session context (there is no additionalContext
 * JSON envelope — plain markdown stdout is the orientation channel), so the
 * banner is emitted verbatim. Kept short: it runs on every session start and
 * should be a pointer, not a full dump.
 */
export function formatOrientationBanner(ctx: OrientationSnapshot): string {
  const lines: string[] = ['## mdocs orientation'];

  const countParts: string[] = [];
  const totalInitiatives = Object.values(ctx.counts).reduce((a, b) => a + b, 0);
  if (totalInitiatives === 0) {
    countParts.push('0 initiatives');
  } else {
    for (const status of ['active', 'complete', 'done', 'archived']) {
      if (ctx.counts[status]) countParts.push(`${ctx.counts[status]} ${status}`);
    }
    // Surface any unexpected statuses too (e.g. paused, blocked).
    for (const [status, n] of Object.entries(ctx.counts)) {
      if (!['active', 'complete', 'done', 'archived'].includes(status)) {
        countParts.push(`${n} ${status}`);
      }
    }
  }
  lines.push(`Initiatives: ${countParts.join(', ')} (workflow step: ${ctx.currentStep})`);

  if (ctx.activeInitiative) {
    lines.push(`Active: ${ctx.activeInitiative.title} (\`${ctx.activeInitiative.id}\`)`);
  }

  lines.push(`Wiki pages: ${ctx.wikiPageCount}`);
  lines.push('Use the `mdocs_status` MCP tool / see `mdocs/wiki/index.md` to resume work.');

  return lines.join('\n');
}
