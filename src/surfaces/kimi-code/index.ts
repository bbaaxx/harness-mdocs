export const kimiCodeSurface = {
  surface: 'kimi-code',
  capabilities: {
    commandAccess: 'mcp' as const,
    commandTools: true,
    aggregateCommandTool: true,
    skillPackaging: true,
    agentPackaging: true,
    configMutation: false,
    permissionHooks: true,
    toolExecutionHooks: true,
    eventHooks: true,
    subagentDispatch: 'native' as const
  }
};

export { createKimiCodeAdapter } from './adapter';
export type { MdocsKimiCodeOptions } from './adapter';
export { createKimiCodeHooks } from './hooks';
export {
  translateToolName,
  translateArgs,
  parseHookStdin,
  toCore
} from './translate';
export type { KimiHookPayload } from './translate';
export { toMcpResult, toMcpError } from './result';
export type { McpToolResult } from './result';
export { formatOrientationBanner } from './orientation';
export type { OrientationSnapshot } from './orientation';
export { buildMcpServer, buildKimiMcpServer, startMcpServer } from './mcp-server';
export { withLock } from './lock';
export * as skills from './skills';
