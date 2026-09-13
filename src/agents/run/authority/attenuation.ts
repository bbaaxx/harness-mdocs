import { WriteSelector, writeSelectorCovers } from '../compiler/schema';
import { TicketGrantInput } from './schema';
import { canonicalBudgets, canonicalSet, TicketAuthorityError } from './state';

export interface CanonicalTicketGrant {
  roots: string[];
  operationClasses: string[];
  toolClasses: string[];
  credentialClasses: string[];
  approvalRefs: string[];
  budgets: Record<string, number>;
  expiresAt: string;
  maxChildDepth: number;
  maxFanout: number;
}

export interface AuthorityEnvelopeForAttenuation extends CanonicalTicketGrant {
  writeSet?: readonly string[];
  criteria?: readonly string[];
}

function deny(message: string): never {
  throw new TicketAuthorityError('attenuation-denied', message);
}

export function canonicalizeTicketGrant(input: TicketGrantInput): CanonicalTicketGrant {
  return {
    roots: canonicalSet(input.roots),
    operationClasses: canonicalSet(input.operationClasses ?? []),
    toolClasses: canonicalSet(input.toolClasses ?? []),
    credentialClasses: canonicalSet(input.credentialClasses ?? []),
    approvalRefs: canonicalSet(input.approvalRefs ?? []),
    budgets: canonicalBudgets(input.budgets ?? {}),
    expiresAt: input.expiresAt,
    maxChildDepth: input.maxChildDepth,
    maxFanout: input.maxFanout
  };
}

function assertSetSubset(child: readonly string[], parent: readonly string[], name: string): void {
  const allowed = new Set(parent);
  for (const value of child) {
    if (!allowed.has(value)) deny(`${name} value "${value}" is not present in parent authority`);
  }
}

function assertSelectorSubset(child: readonly string[], parent: readonly string[], name: string): void {
  for (const selector of child) {
    if (!parent.some(candidate => writeSelectorCovers(candidate as WriteSelector, selector as WriteSelector))) {
      deny(`${name} selector "${selector}" expands beyond parent authority`);
    }
  }
}

/** Component-wise attenuation. Missing parent set/budget dimensions remain unavailable. */
export function assertTicketAttenuation(
  child: AuthorityEnvelopeForAttenuation,
  parent: AuthorityEnvelopeForAttenuation
): void {
  assertSelectorSubset(child.roots, parent.roots, 'root');
  if (child.writeSet !== undefined) {
    if (parent.writeSet === undefined) deny('Parent authority omits a write set');
    assertSelectorSubset(child.writeSet, parent.writeSet, 'write');
  }
  if (child.criteria !== undefined) {
    if (parent.criteria === undefined) deny('Parent authority omits criteria');
    assertSetSubset(child.criteria, parent.criteria, 'criterion');
  }
  assertSetSubset(child.operationClasses, parent.operationClasses, 'operation class');
  assertSetSubset(child.toolClasses, parent.toolClasses, 'tool class');
  assertSetSubset(child.credentialClasses, parent.credentialClasses, 'credential class');
  assertSetSubset(child.approvalRefs, parent.approvalRefs, 'approval reference');

  for (const [name, value] of Object.entries(child.budgets)) {
    const parentValue = parent.budgets[name];
    if (parentValue === undefined) deny(`Budget "${name}" is omitted from parent authority`);
    if (!Number.isFinite(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER) {
      deny(`Budget "${name}" must be positive, finite, and at most Number.MAX_SAFE_INTEGER`);
    }
    if (value > parentValue) deny(`Budget "${name}" exceeds parent authority`);
  }

  if (Date.parse(child.expiresAt) > Date.parse(parent.expiresAt)) {
    deny('Ticket expiry exceeds parent authority');
  }
  if (child.maxChildDepth > parent.maxChildDepth) deny('Child depth exceeds parent authority');
  if (child.maxFanout > parent.maxFanout) deny('Child fanout exceeds parent authority');
}

export function assertRootsCoverWriteSet(roots: readonly string[], writeSet: readonly string[]): void {
  for (const selector of writeSet) {
    if (!roots.some(root => writeSelectorCovers(root as WriteSelector, selector as WriteSelector))) {
      deny(`Graph write selector "${selector}" is not covered by ticket roots`);
    }
  }
}
