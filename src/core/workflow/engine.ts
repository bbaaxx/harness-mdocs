import * as fs from 'fs';
import * as path from 'path';
import { WorkflowState, StepName } from '../types';

export const STEPS: StepName[] = [
  'IDLE', 'UNDERSTAND', 'DISCOVER', 'CONTEXT', 'PLAN',
  'EXECUTE', 'VERIFY', 'REPORT', 'COMPLETE'
];

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
export class WorkflowEngine {
  private statePath: string;
  private state: WorkflowState;
  private readonly enforcementMode: EnforcementMode;
  private readonly idle: IdleStrictness;

  constructor(baseDir: string, options: WorkflowEngineOptions = {}) {
    this.statePath = path.join(baseDir, '.workflow-state.json');
    this.state = this.load();
    this.enforcementMode = options.enforcementMode ?? 'gate';
    this.idle = options.idle ?? 'open';
  }

  private load(): WorkflowState {
    if (fs.existsSync(this.statePath)) {
      return JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    }
    return {
      currentStep: 'IDLE',
      activeInitiative: null,
      stepHistory: []
    };
  }

  private save(): void {
    const dir = path.dirname(this.statePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), 'utf8');
  }

  getCurrentStep(): StepName {
    return this.state.currentStep;
  }

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
  advance(nextStep: StepName): void {
    const currentIndex = STEPS.indexOf(this.state.currentStep);
    const nextIndex = STEPS.indexOf(nextStep);

    if (nextIndex < currentIndex) {
      throw new Error(`Cannot go back from ${this.state.currentStep} to ${nextStep}`);
    }
    if (nextIndex > currentIndex + 1) {
      throw new Error(`Cannot skip from ${this.state.currentStep} to ${nextStep}`);
    }

    this.state.stepHistory.push({
      step: nextStep,
      timestamp: new Date().toISOString()
    });
    this.state.currentStep = nextStep;
    this.save();
  }

  private isMdocsOperation(toolName: string, toolArgs?: Record<string, any>): boolean {
    // Check if any path argument references the mdocs directory
    const args = toolArgs || {};

    const isMdocsPath = (p: string): boolean => {
      // Match both absolute (/mdocs/) and relative (mdocs/) paths
      // Also handle Windows paths (\mdocs\)
      return p.includes('/mdocs/') ||
             p.includes('\\mdocs\\') ||
             p.startsWith('mdocs/') ||
             p.startsWith('mdocs\\');
    };

    // Direct file paths (read, write, edit tools)
    if (args.filePath && typeof args.filePath === 'string' && isMdocsPath(args.filePath)) {
      return true;
    }

    // Path parameter (glob, grep, list tools)
    if (args.path && typeof args.path === 'string' && isMdocsPath(args.path)) {
      return true;
    }

    // Pattern parameter (glob, grep tools)
    if (args.pattern && typeof args.pattern === 'string' && isMdocsPath(args.pattern)) {
      return true;
    }

    // Bash commands operating on mdocs
    if (toolName === 'bash') {
      const command = args.command || args.args?.command || '';
      if (typeof command === 'string' && isMdocsPath(command)) {
        return true;
      }
    }

    return false;
  }

  canExecuteTool(toolName: string, toolArgs?: Record<string, any>): boolean {
    // `off` — no enforcement at all (CI escape hatch).
    if (this.enforcementMode === 'off') return true;

    const readTools = ['read', 'glob', 'grep', 'list'];
    const writeTools = ['edit', 'write'];

    // Allow unrestricted access to mdocs knowledge files regardless of workflow step
    if (this.isMdocsOperation(toolName, toolArgs)) {
      return true;
    }

    if (readTools.includes(toolName)) return true;

    // IDLE handling. Under `open` (default) every tool is allowed at IDLE
    // (0.4.2 behaviour). Under `readonly`, IDLE permits only read tools
    // (read/glob/grep/list) plus any ./mdocs/ path; Write/Edit/Bash are
    // blocked with the same reason used at UNDERSTAND. Read tools and mdocs
    // paths were already allowed above, so under readonly we block everything
    // else at IDLE.
    if (this.state.currentStep === 'IDLE') {
      return this.idle === 'open';
    }

    // `advisory` — writes/edits allowed (no block); audit still records them.
    if (this.enforcementMode === 'advisory') return true;

    if (writeTools.includes(toolName)) {
      return ['PLAN', 'EXECUTE', 'VERIFY', 'REPORT', 'COMPLETE'].includes(this.state.currentStep);
    }
    // Bash is audited but ungated by content (see class doc).
    return true;
  }

  status(): WorkflowState {
    return this.state;
  }

  setActiveInitiative(initiativeId: string | null): void {
    this.state.activeInitiative = initiativeId;
    this.save();
  }

  resumeAt(step: StepName): void {
    this.state.currentStep = step;
    this.state.stepHistory.push({ step, timestamp: new Date().toISOString() });
    this.save();
  }

  /**
   * Reset to a clean slate: IDLE + no active initiative. Pushes a history
   * entry so the transition is visible in the trail. Used by `mdocs_reset`
   * to abandon an initiative mid-flight, force-reset for testing, or begin a
   * fresh initiative cycle after COMPLETE.
   */
  reset(): void {
    this.state.activeInitiative = null;
    this.state.currentStep = 'IDLE';
    this.state.stepHistory.push({ step: 'IDLE', timestamp: new Date().toISOString() });
    this.save();
  }
}
