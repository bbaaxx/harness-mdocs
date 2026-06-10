export const codexSurface = {
  surface: 'codex',
  capabilities: {
    commandAccess: 'cli' as const,
    commandTools: false,
    aggregateCommandTool: false,
    skillPackaging: true,
    agentPackaging: false,
    configMutation: false,
    permissionHooks: false,
    toolExecutionHooks: false,
    eventHooks: false,
    subagentDispatch: 'prompted' as const
  }
};
