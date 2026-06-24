import { AuditLog } from '../audit';
import { InitiativeManager } from '../managers/initiative';
import { MdocsManager } from '../managers/mdocs';
import { WikiManager } from '../managers/wiki';
import { MdocsLinter } from '../validation/linter';
import { SearchEngine } from '../search';
import { SubagentAssembler } from '../subagent';
import { WorkflowEngine } from '../workflow/engine';
export interface MdocsCommandContext {
    mdocsRoot: string;
    mdocs: MdocsManager;
    initiatives: InitiativeManager;
    wiki: WikiManager;
    workflow: WorkflowEngine;
    search: SearchEngine;
    audit: AuditLog;
    linter: MdocsLinter;
    dispatch: SubagentAssembler;
}
export declare class MdocsCommandRegistry {
    private readonly context;
    readonly supportedCommands: string[];
    constructor(context: MdocsCommandContext);
    execute(command: string, args?: Record<string, any>): Promise<any>;
    private advanceWorkflow;
    /**
     * lifecycle.graduate — record a completed initiative's learning into the
     * compiled views (overview.md sections + log.md entry) using the G2a helpers,
     * wrapped in withLock, and stamp the initiative `graduated` so the
     * graduation-due lint rule clears.
     *
     * INVARIANT: NEVER auto-generates prose. Only caller-supplied `sections`
     * bodies and `logEntry` content are written. Best-effort batch like ingest:
     * each section/log write is isolated in its own try/catch; a failing write
     * records an error but does NOT abort the rest. The `graduated` stamp is
     * applied last; if it throws, the write results are still returned with the
     * stamp error included.
     */
    private graduateInitiative;
    validationResult(): {
        initiatives: {
            valid: boolean;
            errors: string[];
            warnings: string[];
        };
        wiki: {
            valid: boolean;
            errors: string[];
            warnings: string[];
        };
        graph: {
            valid: boolean;
            errors: string[];
            warnings: string[];
            results: import("../types").LintResult[];
        };
        valid: boolean;
    };
    private createInitiative;
    private updateInitiative;
    private doneInitiative;
    private deleteInitiative;
    private archiveInitiative;
    private createWiki;
    private updateWiki;
    private stubWiki;
    private deleteWiki;
    private listWiki;
    private linkWiki;
    private crossReferenceWiki;
    /**
     * wiki.ingest — record caller-supplied operations and apply them as one
     * isolated multi-file write composed from existing wiki.* primitives plus the
     * updateOverviewSection/appendLog helpers, wrapped in withLock.
     *
     * INVARIANT: ingest NEVER auto-generates prose. It only records + applies
     * exactly what the caller supplies (the agent authors all text). The manifest
     * contains only caller-supplied data + structural metadata (counts, refs,
     * ok/error).
     *
     * Best-effort batch: isolation is provided by the lock, NOT transactional
     * rollback — each op is wrapped in its own try/catch so one failing op records
     * an error but does NOT abort the rest of the batch.
     */
    private ingestWiki;
    private syncIndex;
}
