import { MdocsCore } from './factory';
import { StepName } from './types';
export declare function advance(core: MdocsCore, step: string): import("./types").WorkflowState;
export declare function lookup(core: MdocsCore, query: string): {
    type: string;
    id: string;
    title: string;
    status: import("./types").Status;
    tags: string[];
    filename: string;
    error?: undefined;
} | {
    error: string;
    type?: undefined;
    id?: undefined;
    title?: undefined;
    status?: undefined;
    tags?: undefined;
    filename?: undefined;
};
export declare function resume(core: MdocsCore, id?: string): {
    resumable: import("./types").SearchResult[];
    error?: undefined;
    initiative?: undefined;
    currentStep?: undefined;
    nextAction?: undefined;
    blockers?: undefined;
    latestProgress?: undefined;
    validation?: undefined;
} | {
    error: string;
    resumable?: undefined;
    initiative?: undefined;
    currentStep?: undefined;
    nextAction?: undefined;
    blockers?: undefined;
    latestProgress?: undefined;
    validation?: undefined;
} | {
    initiative: {
        id: string;
        title: string;
        status: import("./types").Status;
    };
    currentStep: StepName;
    nextAction: string;
    blockers: string[];
    latestProgress: string;
    validation: {
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
            results: import("./types").LintResult[];
        };
        valid: boolean;
    };
    resumable?: undefined;
    error?: undefined;
};
/**
 * F9-B: explicit reset. Returns the workflow to IDLE and clears the active
 * initiative (full clean slate). Use cases: abandon an initiative mid-flight,
 * force-reset for testing, or begin a fresh initiative cycle after COMPLETE.
 */
export declare function reset(core: MdocsCore): import("./types").WorkflowState;
export declare function dispatch(core: MdocsCore, id?: string): {
    error: string;
    context?: undefined;
    initiativeId?: undefined;
    step?: undefined;
    relatedWikiCount?: undefined;
} | {
    context: string;
    initiativeId: string;
    step: StepName;
    relatedWikiCount: number;
    error?: undefined;
};
export declare function status(core: MdocsCore): import("./types").WorkflowState;
export declare function indexCheck(core: MdocsCore, repair: boolean): {
    consistent: boolean;
    initiatives: {
        consistent: boolean;
        missing: string[];
        orphans: string[];
        stale: boolean;
    };
    wiki: {
        consistent: boolean;
        missing: string[];
        orphans: string[];
        stale: boolean;
    };
    repaired: boolean;
};
export declare function audit(core: MdocsCore, opts: {
    initiativeId?: string;
    type?: string;
    limit?: number;
    startDate?: string;
    endDate?: string;
}): import("./types").AuditEvent[];
/**
 * G1: Compact orientation snapshot for the Claude Code SessionStart hook.
 * Returns only what the orientation banner needs — initiative counts by
 * status, the active initiative id/title + current workflow step, and the
 * wiki page count. Kept deliberately small so the additionalContext string
 * stays well under the 10,000-char hook output cap.
 *
 * Reuses existing managers (initiatives.list, wiki.list, workflow.status)
 * so it agrees with `mdocs_status` / `mdocs_resume` on what "active" means.
 * Any read error is swallowed by the caller (session-start.ts fail-open).
 */
export declare function sessionContext(core: MdocsCore): {
    counts: Record<string, number>;
    activeInitiative: {
        id: string;
        title: string;
    } | null;
    currentStep: string;
    wikiPageCount: number;
};
