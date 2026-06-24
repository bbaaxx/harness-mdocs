export declare const claudeCodeSurface: {
    surface: string;
    capabilities: {
        commandAccess: "mcp";
        commandTools: boolean;
        aggregateCommandTool: boolean;
        skillPackaging: boolean;
        agentPackaging: boolean;
        configMutation: boolean;
        permissionHooks: boolean;
        toolExecutionHooks: boolean;
        eventHooks: boolean;
        subagentDispatch: "native";
    };
};
export { createClaudeCodeAdapter } from './adapter';
export { createClaudeCodeHooks } from './hooks';
export { startMcpServer, buildMcpServer } from './mcp-server';
export { translateToolName, translateArgs, parseHookStdin, toCore } from './translate';
export type { ClaudeHookPayload } from './translate';
export { toMcpResult, toMcpError } from './result';
export type { McpToolResult } from './result';
export { withLock } from './lock';
export * as skills from './skills';
