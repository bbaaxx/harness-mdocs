/** One allowlist for runtime dispatch, provider schemas and generated descriptions. */
export const SUPPORTED_COMMANDS = Object.freeze([
  'initiative.create', 'initiative.update', 'initiative.done', 'initiative.delete', 'initiative.archive',
  'wiki.create', 'wiki.update', 'wiki.ingest', 'wiki.stub', 'wiki.delete', 'wiki.list', 'wiki.link', 'wiki.xref',
  'workflow.advance', 'workflow.reset', 'lifecycle.graduate', 'validate', 'index.sync'
] as const);

export type MdocsCommand = typeof SUPPORTED_COMMANDS[number];
export const COMMAND_DESCRIPTION = `Run any mdocs core command (${SUPPORTED_COMMANDS.join(', ')}).`;

export function isMdocsCommand(command: unknown): command is MdocsCommand {
  return typeof command === 'string' && (SUPPORTED_COMMANDS as readonly string[]).includes(command);
}

export function invalidCommandResult(command: unknown) {
  return {
    success: false, code: 'INVALID_COMMAND', retryable: true, command,
    error: `Unsupported mdocs command: ${String(command)}`, supportedCommands: SUPPORTED_COMMANDS
  };
}
