"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SubagentAssembler = void 0;
class SubagentAssembler {
    assemble(initiative, wikiEntries, currentStep, options = {}) {
        const lines = [
            `# Initiative: ${initiative.title}`,
            `## Objective`,
            initiative.objective,
            ``,
            `## Plan`,
            ...initiative.plan.map(p => {
                const statusMap = {
                    'pending': '- [ ]',
                    'in-progress': '- [/]',
                    'done': '- [x]'
                };
                const prefix = statusMap[p.status] || '- [ ]';
                return `${prefix} ${p.description}`;
            }),
            ``,
        ];
        if (initiative.handoffSummary) {
            lines.push(`## Handoff Summary`, initiative.handoffSummary, ``);
        }
        if (initiative.nextAction) {
            lines.push(`## Next Action`, initiative.nextAction, ``);
        }
        if (initiative.blockers && initiative.blockers.length > 0) {
            lines.push(`## Blockers`, ...initiative.blockers.map(b => `- ${b}`), ``);
        }
        if (initiative.progressLog && initiative.progressLog.length > 0) {
            lines.push(`## Progress Log`, ...initiative.progressLog.map(l => `- ${l}`), ``);
        }
        if (initiative.artifacts && initiative.artifacts.length > 0) {
            lines.push(`## Artifacts`, ...initiative.artifacts.map(a => `- ${a}`), ``);
        }
        if (options.retrievedMemory && options.retrievedMemory.length > 0) {
            lines.push(`## Retrieved Memory`);
            for (const mem of options.retrievedMemory) {
                lines.push(`- **${mem.title}** (${mem.type}/${mem.id}) [score: ${mem.score}]`);
                if (mem.snippet)
                    lines.push(`  ${mem.snippet}`);
            }
            lines.push(``);
        }
        if (wikiEntries.length > 0) {
            lines.push(`## Related Wiki`);
            for (const e of wikiEntries) {
                lines.push(`### ${e.title}`, e.content);
            }
            lines.push(``);
        }
        if (options.recentEvents && options.recentEvents.length > 0) {
            lines.push(`## Recent Activity`);
            for (const event of options.recentEvents) {
                const toolName = event.details?.toolName || event.type;
                lines.push(`- [${event.timestamp}] ${toolName} at ${event.step || 'unknown'}`);
            }
            lines.push(``);
        }
        lines.push(`## Current Step`);
        lines.push(`You are executing the **${currentStep}** step.`);
        lines.push(`Focus on the plan items and verify against the objective.`);
        return lines.join('\n');
    }
}
exports.SubagentAssembler = SubagentAssembler;
//# sourceMappingURL=subagent.js.map