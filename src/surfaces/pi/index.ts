export const piSurface = {
  surface: 'pi',
  capabilities: {
    commandAccess: 'extension-tools' as const,
    commandTools: true,
    aggregateCommandTool: true,
    skillPackaging: true,
    agentPackaging: false,
    configMutation: false,
    permissionHooks: false,
    toolExecutionHooks: true,
    eventHooks: true,
    subagentDispatch: 'prompted' as const
  }
};

export { createPiAdapter } from './adapter';
export type { MdocsPiOptions } from './adapter';
export { createPiTools, PI_TOOL_NAMES } from './tools';
export type { PiToolDefinition } from './tools';
export { toPiToolResult, toPiToolError } from './result';
export type { PiToolResult } from './result';
export { formatOrientationBanner, formatOrientationNotify } from './orientation';
export type { OrientationSnapshot } from './orientation';
export { translateToolName, translateArgs, toCore } from './translate';
export type { PiToolCallEvent } from './translate';
export * as skills from './skills';
export { default as createPiExtension } from './extension';
