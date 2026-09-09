import { OpaqueHandle } from './handles';
import { UsageSample } from './meter';

export type SideEffectClass = 'none' | 'workspace' | 'external' | 'credential';

interface StructuredActionBase {
  writeSet: string[];
  sideEffectClass: SideEffectClass;
}

export type StructuredAction =
  | (StructuredActionBase & { operation: 'fs.write'; path: string })
  | (StructuredActionBase & { operation: 'fs.delete'; path: string })
  | (StructuredActionBase & { operation: 'process.exec'; argv: string[] })
  | (StructuredActionBase & { operation: 'network.request'; url: string; method: string })
  | (StructuredActionBase & { operation: 'git.mutate'; args: string[] })
  | (StructuredActionBase & { operation: 'package.hook'; hook: string })
  | (StructuredActionBase & { operation: 'agent.spawn'; agentRef: string })
  | (StructuredActionBase & { operation: 'tool.invoke'; tool: string; argumentsDigest?: string });

export type MediationDecision =
  | { allowed: true; reservationId: string }
  | {
      allowed: false;
      reason: string;
      code:
        | 'no-handle'
        | 'stale-generation'
        | 'policy-denied'
        | 'write-set-violation'
        | 'budget-exceeded'
        | 'cancelled'
        | 'kill-switch';
    };

export interface ActionReceiptSummary {
  actionId: string;
  idempotencyId: string;
  resultClass: 'success' | 'failure' | 'uncertain';
  startedAt: string;
  endedAt: string;
  usageFinal?: UsageSample;
}

/**
 * Mandatory pre-effect broker. Every spawn and every effect path goes through
 * `authorize`; a surface without mediation is plan-only. Authorization is
 * fail-closed and persists intent BEFORE any effect. Post-execution receipts
 * are evidence, not prevention.
 */
export interface ActionMediator {
  authorize(handle: OpaqueHandle, action: StructuredAction): Promise<MediationDecision>;
  execute(reservationId: string): Promise<ActionReceiptSummary>;
  cancel(runId: string, generation: number): Promise<void>;
}
