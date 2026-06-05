import { MdocsCore } from '../../core';
import { findInitiativeFilename } from '../../core/commands/utils';

export function createOpencodeHooks(core: MdocsCore) {
  return {
    'tool.execute.before': async (input: any) => {
      const toolName = input.name || input.tool;
      const toolArgs = input.args || input.parameters || {};
      if (!core.managers.workflow.canExecuteTool(toolName, toolArgs)) {
        throw new Error(`Workflow gate: ${toolName} blocked at step ${core.managers.workflow.getCurrentStep()}`);
      }
    },

    'tool.execute.after': async (input: any) => {
      const step = core.managers.workflow.getCurrentStep();
      const activeInitiativeId = core.managers.workflow.status().activeInitiative;
      const toolName = input.name || input.tool;

      core.managers.audit.append({
        timestamp: new Date().toISOString(),
        type: 'tool',
        initiativeId: activeInitiativeId || undefined,
        step,
        details: { toolName, args: input.args || input.parameters || {} }
      });

      if (step !== 'IDLE' && activeInitiativeId) {
        const fileName = findInitiativeFilename(core.mdocsRoot, core.managers.initiatives, activeInitiativeId);
        if (fileName) {
          const initiative = core.managers.initiatives.read(fileName);
          if (initiative) {
            initiative.progressLog.push(`[${new Date().toISOString()}] ${toolName} executed at step ${step}`);
            initiative.updated = new Date().toISOString().split('T')[0];
            core.managers.initiatives.update(fileName, initiative);
          }
        }
      }
    },

    event: (input: any) => {
      const significantEvents = ['workflow.advance', 'initiative.create', 'wiki.create'];
      const eventType = input.type;
      const activeInitiativeId = core.managers.workflow.status().activeInitiative;

      core.managers.audit.append({
        timestamp: new Date().toISOString(),
        type: eventType.startsWith('workflow') ? 'workflow' : eventType.startsWith('initiative') ? 'initiative' : eventType.startsWith('wiki') ? 'wiki' : 'workflow',
        initiativeId: activeInitiativeId || undefined,
        step: core.managers.workflow.getCurrentStep(),
        details: { eventType }
      });

      if (significantEvents.includes(eventType) && activeInitiativeId) {
        const fileName = findInitiativeFilename(core.mdocsRoot, core.managers.initiatives, activeInitiativeId);
        if (fileName) {
          const initiative = core.managers.initiatives.read(fileName);
          if (initiative) {
            initiative.progressLog.push(`[${new Date().toISOString()}] Event: ${eventType}`);
            initiative.updated = new Date().toISOString().split('T')[0];
            core.managers.initiatives.update(fileName, initiative);
          }
        }
      }
    },

    'permission.ask': async (input: any) => {
      const toolName = input.tool || input.name;
      const toolArgs = input.args || input.parameters || {};
      if (core.managers.workflow.canExecuteTool(toolName, toolArgs)) {
        return { action: 'allow' };
      }
      return { action: 'ask' };
    }
  };
}
