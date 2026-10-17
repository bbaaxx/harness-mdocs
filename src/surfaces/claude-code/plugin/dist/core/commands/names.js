"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.COMMAND_DESCRIPTION = exports.SUPPORTED_COMMANDS = void 0;
exports.isMdocsCommand = isMdocsCommand;
exports.invalidCommandResult = invalidCommandResult;
/** One allowlist for runtime dispatch, provider schemas and generated descriptions. */
exports.SUPPORTED_COMMANDS = Object.freeze([
    'initiative.create', 'initiative.update', 'initiative.done', 'initiative.delete', 'initiative.archive',
    'wiki.create', 'wiki.update', 'wiki.ingest', 'wiki.stub', 'wiki.delete', 'wiki.list', 'wiki.link', 'wiki.xref',
    'workflow.advance', 'workflow.reset', 'lifecycle.graduate', 'validate', 'index.sync'
]);
exports.COMMAND_DESCRIPTION = `Run any mdocs core command (${exports.SUPPORTED_COMMANDS.join(', ')}).`;
function isMdocsCommand(command) {
    return typeof command === 'string' && exports.SUPPORTED_COMMANDS.includes(command);
}
function invalidCommandResult(command) {
    return {
        success: false, code: 'INVALID_COMMAND', retryable: true, command,
        error: `Unsupported mdocs command: ${String(command)}`, supportedCommands: exports.SUPPORTED_COMMANDS
    };
}
//# sourceMappingURL=names.js.map