export const codexSurface = {
  surface: 'codex',
  capabilities: {
    commandTools: true,
    aggregateCommandTool: true,
    skillPackaging: true,
    agentPackaging: false,
    configMutation: false,
    permissionHooks: false,
    toolExecutionHooks: false,
    eventHooks: false,
    subagentDispatch: 'prompted' as const
  }
};
