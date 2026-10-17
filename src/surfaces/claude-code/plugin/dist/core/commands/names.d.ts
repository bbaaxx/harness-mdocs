/** One allowlist for runtime dispatch, provider schemas and generated descriptions. */
export declare const SUPPORTED_COMMANDS: readonly ["initiative.create", "initiative.update", "initiative.done", "initiative.delete", "initiative.archive", "wiki.create", "wiki.update", "wiki.ingest", "wiki.stub", "wiki.delete", "wiki.list", "wiki.link", "wiki.xref", "workflow.advance", "workflow.reset", "lifecycle.graduate", "validate", "index.sync"];
export type MdocsCommand = typeof SUPPORTED_COMMANDS[number];
export declare const COMMAND_DESCRIPTION: string;
export declare function isMdocsCommand(command: unknown): command is MdocsCommand;
export declare function invalidCommandResult(command: unknown): {
    success: boolean;
    code: string;
    retryable: boolean;
    command: unknown;
    error: string;
    supportedCommands: readonly ["initiative.create", "initiative.update", "initiative.done", "initiative.delete", "initiative.archive", "wiki.create", "wiki.update", "wiki.ingest", "wiki.stub", "wiki.delete", "wiki.list", "wiki.link", "wiki.xref", "workflow.advance", "workflow.reset", "lifecycle.graduate", "validate", "index.sync"];
};
