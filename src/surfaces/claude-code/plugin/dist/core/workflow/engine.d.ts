import { WorkflowState, StepName } from '../types';
export declare const STEPS: StepName[];
/**
 * Enforcement mode.
 * - `gate`     — current behaviour: Write/Edit blocked before PLAN (default).
 * - `advisory` — writes/edits allowed (no block) but every tool call is still
 *                recorded in the audit log. For teams that want the trail
 *                without the friction.
 * - `off`      — no enforcement at all. CI escape hatch (MDOCS_ENFORCEMENT=off).
 */
export type EnforcementMode = 'gate' | 'advisory' | 'off';
/**
 * IDLE strictness.
 * - `open`    — IDLE allows every tool (0.4.2 behaviour, default).
 * - `readonly` — at IDLE only read tools (read/glob/grep/list) plus any
 *               ./mdocs/ path are allowed; Write/Edit/Bash are blocked with
 *               the standard reason. Makes enforcement real before the first
 *               advance.
 */
export type IdleStrictness = 'readonly' | 'open';
export interface WorkflowEngineOptions {
    enforcementMode?: EnforcementMode;
    idle?: IdleStrictness;
}
/**
 * Enforcement scope.
 *
 * The gate covers **Write/Edit only**. Bash is audited (every call lands in
 * mdocs/audit.log via the PostToolUse hook) but is NOT gated by command
 * content: an earlier destructive-bash blacklist matched destructive verbs
 * anywhere in the command string, including as quoted echo payloads, grep
 * patterns, argument values, and test scripts — the false-positive cost
 * (blocking builds, tests, and qa) exceeded the nudge value of catching
 * accidental early commits. The Write/Edit gate is the real "plan before
 * mutation" guardrail; "don't commit before COMPLETE" is agent-prompt
 * guidance, not a regex. See workflow-enforcement-dogfood-friction-log F2.
 *
 * Steps are treated as one "edits allowed" band — PLAN, EXECUTE, VERIFY,
 * REPORT, COMPLETE — so the engine does not enforce plan-vs-execute
 * discipline; that lives in the agent prompt, not the gate.
 */
export declare class WorkflowEngine {
    private statePath;
    private state;
    private readonly enforcementMode;
    private readonly idle;
    constructor(baseDir: string, options?: WorkflowEngineOptions);
    private load;
    private save;
    getCurrentStep(): StepName;
    /**
     * Advance to the next step (no-skip, no-back).
     *
     * Single-writer by design: no lock is taken here. Advances are inherently
     * sequential — one agent, one currentStep — so the race requires concurrent
     * `mdocs_advance` calls on the same state file, which is not a real access
     * pattern. PostToolUse wraps its initiative read-modify-write in `withLock`
     * because Claude Code fans out tool calls in parallel; advance does not have
     * that shape. Revisit only if a multi-writer surface is introduced.
     * See workflow-enforcement-dogfood-friction-log F5.
     */
    advance(nextStep: StepName): void;
    private isMdocsOperation;
    canExecuteTool(toolName: string, toolArgs?: Record<string, any>): boolean;
    status(): WorkflowState;
    setActiveInitiative(initiativeId: string | null): void;
    resumeAt(step: StepName): void;
    /**
     * Reset to a clean slate: IDLE + no active initiative. Pushes a history
     * entry so the transition is visible in the trail. Used by `mdocs_reset`
     * to abandon an initiative mid-flight, force-reset for testing, or begin a
     * fresh initiative cycle after COMPLETE.
     */
    reset(): void;
}
