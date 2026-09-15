import {
  RunControllerFidelity,
  RunControllerMode,
  RunControllerPublicState,
  RunControllerReasonCode,
  RunControllerState
} from './algebra';
import { parseRunControllerState } from './schema';

export type RunControllerViewMode = Exclude<RunControllerMode, 'unselected'> | null;
type ProjectedNodeState = RunControllerState['execution']['state'];

export interface RunControllerView {
  readonly authority: false;
  readonly runId: string;
  readonly projectId: string;
  readonly state: RunControllerPublicState;
  readonly mode: RunControllerViewMode;
  readonly fidelity: RunControllerFidelity;
  readonly reasonCode: RunControllerReasonCode | null;
  readonly graphRevision: number;
  readonly milestoneCounts: Readonly<Record<ProjectedNodeState, number>>;
  readonly nodeCounts: Readonly<Record<ProjectedNodeState, number>>;
  readonly blockerCount: number;
  readonly pendingCommandCount: number;
  readonly progressPercent: number;
  readonly budgetSummary?: Readonly<{
    reserved: number;
    committed: number;
    currency: string | null;
  }>;
  readonly updatedAt: string;
}

const NODE_STATES: readonly ProjectedNodeState[] = Object.freeze([
  'pending', 'running', 'accepted', 'failed', 'cancelled'
]);

function counts(states: readonly ProjectedNodeState[]): Record<ProjectedNodeState, number> {
  const result = Object.create(null) as Record<ProjectedNodeState, number>;
  for (const state of NODE_STATES) result[state] = states.filter(value => value === state).length;
  return result;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Detached informational projection. No field can be reused as controller authority. */
export function projectRunController(stateValue: unknown): Readonly<RunControllerView> {
  const state = parseRunControllerState(stateValue);
  const nodeStates = [state.execution.state, state.milestone.state, state.globalIntegration.state];
  const accepted = nodeStates.filter(value => value === 'accepted').length;
  const blockerCount =
    (state.recoverySummary.required ? 1 : 0) +
    state.pendingUsageRefs.length +
    state.pendingProjectionRefs.length +
    state.drainSummary.pendingDescendants +
    nodeStates.filter(value => value === 'failed').length;
  const view: RunControllerView = {
    authority: false,
    runId: state.runId,
    projectId: state.projectId,
    state: state.publicState,
    mode: state.mode === 'unselected' ? null : state.mode,
    fidelity: state.fidelity.result,
    reasonCode: state.reasonCode,
    graphRevision: state.model.planRevision,
    milestoneCounts: counts([state.milestone.state]),
    nodeCounts: counts(nodeStates),
    blockerCount,
    pendingCommandCount: state.outbox.length,
    progressPercent: Math.floor((accepted / nodeStates.length) * 100),
    ...(state.budgetSummary === null ? {} : {
      budgetSummary: {
        reserved: state.budgetSummary.reserved,
        committed: state.budgetSummary.committed,
        currency: state.budgetSummary.currency
      }
    }),
    updatedAt: state.updatedAt
  };
  return deepFreeze(view);
}
