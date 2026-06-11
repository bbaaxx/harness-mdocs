export const claudeCodeSurface = {
  surface: 'claude-code',
  capabilities: {
    commandAccess: 'mcp' as const,
    commandTools: true,
    aggregateCommandTool: true,
    skillPackaging: true,
    agentPackaging: false,
    configMutation: false,
    permissionHooks: true,
    toolExecutionHooks: true,
    eventHooks: true,
    subagentDispatch: 'native' as const
  }
};

export { createClaudeCodeAdapter } from './adapter';
export { createClaudeCodeHooks } from './hooks';
export { startMcpServer, buildMcpServer } from './mcp-server';
export {
  translateToolName,
  translateArgs,
  parseHookStdin,
  toCore
} from './translate';
export type { ClaudeHookPayload } from './translate';
export { toMcpResult, toMcpError } from './result';
export type { McpToolResult } from './result';
export { withLock } from './lock';
export * as skills from './skills';
