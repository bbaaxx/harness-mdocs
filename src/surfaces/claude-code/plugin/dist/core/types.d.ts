export type Status = 'active' | 'paused' | 'done' | 'complete' | 'archived';
/**
 * True for any status that means "completed".
 * `done` is the flat-v1 alias; `complete` is the directory-v2 canonical value.
 * Both surface the same semantic completion state.
 *
 * Accepts a raw `string` in addition to `Status` because some callers (e.g. the
 * linter) hold initiative status as an untyped string; the comparison only
 * ever matches the two completed values, so unknown strings simply return false.
 */
export declare function isCompleted(status: Status | string): boolean;
export type StepName = 'IDLE' | 'UNDERSTAND' | 'DISCOVER' | 'CONTEXT' | 'PLAN' | 'EXECUTE' | 'VERIFY' | 'REPORT' | 'COMPLETE';
export type PlanItemStatus = 'pending' | 'in-progress' | 'done';
export interface PlanItem {
    description: string;
    status: PlanItemStatus;
    startedAt?: string;
    completedAt?: string;
}
export type Priority = 'critical' | 'high' | 'medium' | 'low';
export interface Initiative {
    id: string;
    title: string;
    status: Status;
    priority?: Priority;
    created: string;
    updated: string;
    owner: string;
    tags: string[];
    relatedWiki: string[];
    objective: string;
    plan: PlanItem[];
    progressLog: string[];
    artifacts: string[];
    dueDate?: string;
    dependsOn?: string[];
    phase?: 'discovery' | 'planning' | 'implementation' | 'verification' | 'done';
    handoffSummary?: string;
    openQuestions?: string[];
    blockers?: string[];
    nextAction?: string;
    /**
     * Optional expected-duration bucket. `suppress` opts an initiative out of
     * overdue enforcement; `long` widens the normal cadence expectations.
     * Set via initiative.create / initiative.update.
     */
    expectedDuration?: 'normal' | 'long' | 'suppress';
    /**
     * ISO date the initiative was graduated via `lifecycle.graduate` (Slice C).
     * Empty/absent for un-graduated initiatives.
     */
    graduated?: string;
}
export interface WikiEntry {
    id: string;
    title: string;
    category: string;
    created: string;
    updated: string;
    relatedInitiatives: string[];
    tags: string[];
    content: string;
    lifecycle?: 'draft' | 'stable' | 'superseded' | 'needs-review';
    knowledgeType?: 'architecture' | 'decision' | 'how-to' | 'reference' | 'roadmap' | 'note';
    confidence?: 'low' | 'medium' | 'high';
    sourceInitiatives?: string[];
    supersedes?: string[];
    relatedWiki?: string[];
}
export interface WorkflowState {
    currentStep: StepName;
    activeInitiative: string | null;
    stepHistory: {
        step: StepName;
        timestamp: string;
    }[];
}
export interface LintIssue {
    severity: 'error' | 'warning' | 'info';
    message: string;
    line?: number;
}
export interface LintResult {
    file: string;
    type: 'initiative' | 'wiki';
    score: number;
    issues: LintIssue[];
    passed: boolean;
}
export interface SearchResult {
    type: 'initiative' | 'wiki';
    id: string;
    title: string;
    score: number;
    snippet?: string;
    matchedFields?: string[];
}
export interface SearchOptions {
    tags?: string[];
    status?: string;
    category?: string;
    dateFrom?: string;
    dateTo?: string;
}
export type WikiIngestOp = {
    type: 'createPage';
    category: string;
    id: string;
    title: string;
    content?: string;
    tags?: string[];
    relatedInitiatives?: string[];
    lifecycle?: WikiEntry['lifecycle'];
    knowledgeType?: WikiEntry['knowledgeType'];
    confidence?: WikiEntry['confidence'];
} | {
    type: 'updatePage';
    category: string;
    id: string;
    content?: string;
    lifecycle?: WikiEntry['lifecycle'];
    tags?: string[];
    relatedInitiatives?: string[];
} | {
    type: 'updateOverviewSection';
    section: string;
    body: string;
} | {
    type: 'appendLog';
    entry: {
        timestamp?: string;
        date?: string;
        operation?: string;
        subject?: string;
        content: string;
    } | string;
} | {
    type: 'link';
    initiativeId: string;
    wikiSlug: string;
};
export interface AuditEvent {
    timestamp: string;
    type: 'tool' | 'workflow' | 'initiative' | 'wiki';
    initiativeId?: string;
    step?: StepName;
    details: Record<string, any>;
}
/**
 * Parse a YAML frontmatter value that may be JSON (`["a","b"]`) or
 * YAML inline array (`[a, b, c]`) or a plain scalar.
 */
export declare function parseYamlValue(raw: string): any;
/**
 * Parse YAML frontmatter lines into a key-value map.
 * Handles both JSON-style values and YAML inline arrays.
 */
export declare function parseFrontmatter(content: string): Record<string, any>;
/**
 * Read an initiative's expected-duration frontmatter value across the
 * supported key spellings: snake_case `expected_duration`, camelCase
 * `expectedDuration`, and the hyphenated consumer form `expected-duration`.
 * Returns `undefined` when none are present. Centralized so lifecycle and lint
 * logic honors the consumer schema without each caller re-implementing the
 * lookup.
 */
export declare function readExpectedDurationRaw(front: Record<string, any>): any;
