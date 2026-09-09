import { z } from 'zod';

/**
 * Semantic orchestration roles. The ONLY topology is
 * PLAN_ROOT -> EXECUTION -> LEAF: orchestration depth <= 1, delegation
 * depth <= 2. Plan/root performs integration itself through ActionMediator;
 * there is no root-to-leaf exception and no recursive EO edge.
 */
export const semanticRoleSchema = z.enum(['PLAN_ROOT', 'EXECUTION', 'LEAF']);
export type SemanticRole = z.infer<typeof semanticRoleSchema>;

const LEGAL_EDGES: ReadonlySet<string> = new Set([
  'PLAN_ROOT->EXECUTION',
  'EXECUTION->LEAF'
]);

/**
 * A delegation edge between semantic roles. FAIL-CLOSED: only
 * PLAN_ROOT->EXECUTION and EXECUTION->LEAF exist. Root-to-leaf, EO-to-EO,
 * any LEAF outgoing edge, and self-loops are rejected and named.
 */
export const delegationEdgeSchema = z.object({
  from: semanticRoleSchema,
  to: semanticRoleSchema
}).strict().superRefine((edge, context) => {
  const name = `${edge.from}->${edge.to}`;
  if (edge.from === edge.to) {
    context.addIssue({
      code: 'custom',
      message: `Illegal delegation edge ${name}: self-loops are forbidden`
    });
    return;
  }
  if (!LEGAL_EDGES.has(name)) {
    context.addIssue({
      code: 'custom',
      message: `Illegal delegation edge ${name}: only PLAN_ROOT->EXECUTION and EXECUTION->LEAF exist`
    });
  }
});

export type DelegationEdge = z.infer<typeof delegationEdgeSchema>;

/** True when from->to is one of the two legal delegation edges. */
export function isLegalDelegationEdge(from: SemanticRole, to: SemanticRole): boolean {
  return LEGAL_EDGES.has(`${from}->${to}`);
}
