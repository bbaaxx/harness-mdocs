import { AuditLog } from '../audit';
import { MdocsContract } from '../contract';
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
    contract: MdocsContract;
}
export declare class MdocsCommandRegistry {
    private readonly context;
    readonly supportedCommands: string[];
    constructor(context: MdocsCommandContext);
    execute(command: string, args?: Record<string, any>): Promise<any>;
    private resetWorkflow;
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
            errorCount: number;
            warningCount: number;
            infoCount: number;
            clean: boolean;
            errors: string[];
            warnings: string[];
            valid: boolean;
        };
        wiki: {
            errorCount: number;
            warningCount: number;
            infoCount: number;
            clean: boolean;
            errors: string[];
            warnings: string[];
            valid: boolean;
        };
        graph: {
            errorCount: number;
            warningCount: number;
            infoCount: number;
            clean: boolean;
            valid: boolean;
            errors: string[];
            warnings: string[];
            infos: string[];
            results: import("../types").LintResult[];
        };
        valid: boolean;
        errorCount: number;
        warningCount: number;
        infoCount: number;
        clean: boolean;
    };
    private createInitiative;
    /**
     * initiative.update — explicit mutation result. snake_case inputs are
     * normalized to camelCase. Fields the store will not persist are reported
     * in `skippedFields` (metadata-only mode: anything outside the lifecycle
     * set, plus an unpersisted progressNote); fields the command does not
     * support at all (objective, plan, unknown keys) are rejected explicitly in
     * `unsupportedFields` with no write. Persisted fields are verified by
     * re-reading the initiative from disk before they are reported as applied.
     */
    private updateInitiative;
    /**
     * Whether initiative.update can persist `field` under metadata-only mode.
     * Only lifecycle keys are rewritten; next_action only when the consumer
     * file already carries the key.
     */
    private metadataOnlyPersistable;
    private doneInitiative;
    private deleteInitiative;
    private archiveInitiative;
    private createWiki;
    /**
     * wiki.update — lossless, explicit mutation result. snake_case inputs are
     * normalized to camelCase. Unknown fields are rejected in
     * `unsupportedFields` with no write. Requested changes are verified by
     * re-reading the page from disk; if a requested change did not persist the
     * result is non-success with the failed fields listed.
     */
    private updateWiki;
    private stubWiki;
    private deleteWiki;
    private listWiki;
    /**
     * wiki.link — bidirectional, postcondition-verified link.
     *
     * - Under directory metadata-only mode the initiative-side `related_wiki`
     *   is persisted via a surgical frontmatter-array mutation (the whitelisted
     *   update would silently drop it).
     * - Self-backlink guard: linking an initiative to its own compiled page
     *   (category `initiatives`/`initiative`, id equal to the initiative id) is
     *   provenance, not a link — no self `related_initiatives` entry and no
     *   `related_wiki` self-entry are written; the result is success with
     *   `selfLink: true`, never `bidirectional: true`.
     * - After both writes, both sides are read back from disk; only a verified
     *   pair returns `bidirectional: true`. If the wiki side fails after the
     *   initiative side was written, the initiative side is rolled back
     *   surgically so no partial mutation remains.
     */
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
