import * as crypto from 'crypto';

import {
  DelegationTicketPayload,
  isLegalDelegationEdge,
  OrchestrationArtifactPayload
} from '../../contracts';
import { CompiledPlanGraph, validateCompiledPlanGraph } from '../compiler';
import { HostIdentity, HostIdentityProvider, OpaqueHandle } from '../trust';
import {
  ControllerLeaseProof,
  LeaseAuthorityState,
  LeaseSources,
  parseLeaseAuthorityState,
  validateControllerLease,
  validateWorkstreamLease,
  WorkstreamLeaseProof
} from './leases';
import {
  assertRootsCoverWriteSet,
  assertTicketAttenuation,
  canonicalizeTicketGrant,
  CanonicalTicketGrant
} from './attenuation';
import {
  DelegateTicketInput,
  delegateTicketInputSchema,
  HostIdentitySnapshot,
  IssueRootTicketInput,
  issueRootTicketInputSchema,
  ResolveTicketInput,
  ResolveTicketForAuthorityInput,
  resolveTicketForAuthorityInputSchema,
  resolveTicketInputSchema,
  RootAuthority,
  RootAuthorityInput,
  rootAuthorityInputSchema,
  StoredTicketRecord,
  TicketAuthorityState,
  TicketLeasePlaceholder
} from './schema';
import {
  canonicalAuthoritySnapshot,
  canonicalSet,
  parseTicketAuthorityState,
  snapshotAuthorityData,
  TicketAuthorityError,
  TicketAuthorityErrorCode
} from './state';

export interface TicketAuthorityBrokerOptions {
  compiled: CompiledPlanGraph;
  runId: string;
  projectId: string;
  graphEpoch: number;
  cancellationGeneration: number;
  hostIdentityProvider: HostIdentityProvider;
  rootAuthority?: RootAuthorityInput;
  state?: unknown;
  now?: () => Date;
  leaseState?: () => unknown;
  leaseSources?: LeaseSources;
}

export interface TicketAuthorityBrokerTestSources {
  random?: () => string;
}

export interface IssuedTicketHandle {
  readonly handle: OpaqueHandle;
}

export interface ResolvedTicketAuthority {
  readonly runId: string;
  readonly projectId: string;
  readonly approvedPlanDigest: string;
  readonly approvedGraphDigest: string;
  readonly graphId: string;
  readonly graphRevision: number;
  readonly graphEpoch: number;
  readonly cancellationGeneration: number;
  readonly lease: TicketLeasePlaceholder;
  readonly roots: readonly string[];
  readonly ticket: Omit<DelegationTicketPayload, 'nonce'>;
}

export interface ResolvedTicketClaims {
  readonly runId: string;
  readonly projectId: string;
  readonly graphEpoch: number;
  readonly cancellationGeneration: number;
  readonly holder: HostIdentitySnapshot;
  readonly lease: TicketLeasePlaceholder;
  readonly ticketHandleId: string;
  readonly nodeId: string;
  readonly recipientRole: 'EXECUTION' | 'LEAF';
  readonly expiresAt: string;
}

export type TicketResolution =
  | Readonly<{ ok: true; authority: ResolvedTicketAuthority }>
  | Readonly<{ ok: false; code: TicketAuthorityErrorCode; reason: string }>;

export type TicketClaimsResolution =
  | Readonly<{ ok: true; claims: ResolvedTicketClaims }>
  | Readonly<{ ok: false; code: TicketAuthorityErrorCode; reason: string }>;

export interface TicketAuthorityBroker {
  issueRoot(input: IssueRootTicketInput): Promise<IssuedTicketHandle>;
  delegate(input: DelegateTicketInput): Promise<IssuedTicketHandle>;
  /** Pure validation. Never consumes the ticket nonce. */
  resolveClaimsOnly(input: ResolveTicketInput): Promise<TicketClaimsResolution>;
  /** Validate and consume the ticket nonce. Manager-transaction use only. */
  claim(input: ResolveTicketInput): Promise<TicketClaimsResolution>;
  /** Resolve authority; consumes the nonce when still issued. Manager-transaction use only. */
  resolveForAuthority(input: ResolveTicketForAuthorityInput): Promise<TicketResolution>;
  revoke(handle: OpaqueHandle): boolean;
  snapshot(): Readonly<TicketAuthorityState>;
}

type GraphNode = OrchestrationArtifactPayload['nodes'][number];

const EMPTY_LEASE: TicketLeasePlaceholder = Object.freeze({ ref: null, generation: 0, fence: 0 });

function parseInput<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: readonly { path: PropertyKey[]; message: string }[] } } }, value: unknown): T {
  const snapshot = snapshotAuthorityData(value);
  const result = schema.safeParse(snapshot);
  if (!result.success) {
    const reason = result.error.issues
      .map(issue => `${issue.path.join('.') || '$'}: ${issue.message}`)
      .sort()
      .join('; ');
    throw new TicketAuthorityError('invalid-input', `Invalid ticket input: ${reason}`);
  }
  return result.data;
}

function equalSets(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameIdentity(left: HostIdentitySnapshot, right: HostIdentitySnapshot): boolean {
  return left.providerId === right.providerId &&
    left.sessionRef === right.sessionRef &&
    left.principalRef === right.principalRef;
}

function fail(code: TicketAuthorityErrorCode, reason: string): never {
  throw new TicketAuthorityError(code, reason);
}

function denial(error: unknown): TicketResolution {
  if (error instanceof TicketAuthorityError) {
    return canonicalAuthoritySnapshot({ ok: false as const, code: error.code, reason: error.message });
  }
  return canonicalAuthoritySnapshot({
    ok: false as const,
    code: 'invalid-input' as const,
    reason: `Ticket authority denied: ${error instanceof Error ? error.message : String(error)}`
  });
}

function claimsDenial(error: unknown): TicketClaimsResolution {
  return denial(error) as TicketClaimsResolution;
}

function normalizeRootAuthority(value: unknown): Readonly<RootAuthority> {
  const snapshot = snapshotAuthorityData(value);
  const grantInput = rootAuthorityInputSchema.safeParse(snapshot);
  if (!grantInput.success) {
    fail('invalid-input', `Invalid root authority: ${grantInput.error.issues.map(issue => issue.message).sort().join('; ')}`);
  }
  return canonicalAuthoritySnapshot(canonicalizeTicketGrant(grantInput.data));
}

function identitySnapshot(value: HostIdentity | null): Readonly<HostIdentitySnapshot> {
  if (!value) fail('host-identity-mismatch', 'Trusted host identity is unavailable');
  const snapshot = snapshotAuthorityData(value);
  const keys = Object.keys(snapshot as unknown as Record<string, unknown>).sort();
  if (keys.join(',') !== 'principalRef,providerId,sessionRef') {
    fail('host-identity-mismatch', 'Trusted host identity fields are not exact');
  }
  const identity = snapshot as HostIdentitySnapshot;
  for (const field of [identity.providerId, identity.sessionRef, identity.principalRef]) {
    if (typeof field !== 'string' || field.length === 0) {
      fail('host-identity-mismatch', 'Trusted host identity is malformed');
    }
  }
  return canonicalAuthoritySnapshot(identity);
}

function graphCriteria(graph: OrchestrationArtifactPayload, node: GraphNode): string[] {
  const criteria = [...node.localCriteria];
  if (node.ownerRole === 'EXECUTION') {
    const childIds = new Set(graph.edges
      .filter(edge => edge.fromNodeId === node.nodeId)
      .map(edge => edge.toNodeId));
    for (const child of graph.nodes) {
      if (childIds.has(child.nodeId)) criteria.push(...child.localCriteria);
    }
  }
  return canonicalSet(criteria);
}

function topologyForNode(
  graph: OrchestrationArtifactPayload,
  nodeId: string
): { node: GraphNode; parent: GraphNode } {
  const node = graph.nodes.find(candidate => candidate.nodeId === nodeId);
  if (!node) fail('topology-denied', `Graph node "${nodeId}" does not exist`);
  const incoming = graph.edges.filter(edge => edge.toNodeId === nodeId);
  if (incoming.length !== 1) fail('topology-denied', `Graph node "${nodeId}" must have exactly one parent edge`);
  const parent = graph.nodes.find(candidate => candidate.nodeId === incoming[0].fromNodeId);
  if (!parent || !isLegalDelegationEdge(parent.ownerRole, node.ownerRole)) {
    fail('topology-denied', `Graph edge into "${nodeId}" is not a legal delegation edge`);
  }
  return { node, parent };
}

function assertStateBindings(
  state: Readonly<TicketAuthorityState>,
  compiled: CompiledPlanGraph,
  options: TicketAuthorityBrokerOptions
): void {
  const expected: Record<string, unknown> = {
    runId: options.runId,
    projectId: options.projectId,
    approvedPlanDigest: compiled.plan.digest,
    approvedGraphDigest: compiled.graph.digest,
    graphId: compiled.graph.id,
    graphRevision: compiled.planRevision,
    graphEpoch: options.graphEpoch,
    cancellationGeneration: options.cancellationGeneration
  };
  for (const [field, value] of Object.entries(expected)) {
    if (state[field as keyof TicketAuthorityState] !== value) {
      fail('binding-mismatch', `Stored authority ${field} does not match broker binding`);
    }
  }
}

function recordGrant(record: StoredTicketRecord): CanonicalTicketGrant & {
  writeSet: readonly string[];
  criteria: readonly string[];
} {
  return {
    roots: record.roots,
    operationClasses: record.ticket.operationClasses,
    toolClasses: record.ticket.toolClasses,
    credentialClasses: record.ticket.credentialClasses,
    approvalRefs: record.ticket.approvalRefs,
    budgets: record.ticket.budgets,
    expiresAt: record.ticket.expiresAt,
    maxChildDepth: record.ticket.maxChildDepth,
    maxFanout: record.ticket.maxFanout,
    writeSet: record.ticket.writeSet,
    criteria: record.ticket.criteria
  };
}

/** Root authority has no persisted write set/criteria; the graph supplies them. */
function rootEnvelope(
  graph: OrchestrationArtifactPayload,
  rootAuthority: Readonly<RootAuthority>
): CanonicalTicketGrant & { writeSet: readonly string[]; criteria: readonly string[] } {
  return {
    ...rootAuthority,
    writeSet: canonicalSet(graph.nodes.flatMap(node => node.writeSet)),
    criteria: canonicalSet(graph.nodes.flatMap(node => node.localCriteria))
  };
}

function validateStoredRecords(state: Readonly<TicketAuthorityState>, graph: OrchestrationArtifactPayload): void {
  const byHandle = new Map(state.tickets.map(record => [record.ticket.ticketHandleId, record]));
  if (byHandle.size !== state.tickets.length) fail('invalid-state', 'Stored ticket handles are not unique');
  if (new Set(state.tickets.map(record => record.ticket.nonce)).size !== state.tickets.length) {
    fail('invalid-state', 'Stored ticket nonces are not unique');
  }
  const maximumGeneration = state.tickets.reduce(
    (maximum, record) => Math.max(maximum, record.ticket.generation),
    0
  );
  if (state.lastTicketGeneration !== maximumGeneration) {
    fail('invalid-state', 'Stored lastTicketGeneration does not match ticket records');
  }
  if (new Set(state.tickets.map(record => record.ticket.generation)).size !== state.tickets.length) {
    fail('invalid-state', 'Stored ticket generations are not unique');
  }

  for (const record of state.tickets) {
    const globalBindings: [unknown, unknown, string][] = [
      [record.projectId, state.projectId, 'projectId'],
      [record.approvedPlanDigest, state.approvedPlanDigest, 'approvedPlanDigest'],
      [record.approvedGraphDigest, state.approvedGraphDigest, 'approvedGraphDigest'],
      [record.graphId, state.graphId, 'graphId'],
      [record.graphRevision, state.graphRevision, 'graphRevision'],
      [record.graphEpoch, state.graphEpoch, 'graphEpoch'],
      [record.cancellationGeneration, state.cancellationGeneration, 'cancellationGeneration'],
      [record.ticket.runId, state.runId, 'ticket.runId'],
      [record.ticket.graphId, state.graphId, 'ticket.graphId'],
      [record.ticket.cancellationGeneration, state.cancellationGeneration, 'ticket.cancellationGeneration']
    ];
    for (const [actual, expected, name] of globalBindings) {
      if (actual !== expected) fail('invalid-state', `Stored ${name} binding is inconsistent`);
    }

    const { node, parent } = topologyForNode(graph, record.ticket.nodeId);
    if (record.ticket.parentNodeId !== parent.nodeId ||
        record.ticket.issuerRole !== parent.ownerRole ||
        record.ticket.recipientRole !== node.ownerRole) {
      fail('invalid-state', `Stored ticket topology for "${node.nodeId}" does not match graph`);
    }
    if (!equalSets(record.ticket.writeSet, canonicalSet(node.writeSet)) ||
        !equalSets(record.ticket.criteria, graphCriteria(graph, node))) {
      fail('invalid-state', `Stored ticket authority for "${node.nodeId}" does not match graph`);
    }
    if (record.ticket.reportDestination !== `controller:${node.nodeId}` ||
        record.ticket.reportSchemaRef !== node.expectedReportKind) {
      fail('invalid-state', `Stored ticket report binding for "${node.nodeId}" does not match graph`);
    }

    const expectedChildRole = node.ownerRole === 'EXECUTION' && record.ticket.maxChildDepth > 0
      ? 'LEAF'
      : undefined;
    if (record.ticket.allowedChildRole !== expectedChildRole ||
        (node.ownerRole === 'LEAF' && record.ticket.maxChildDepth !== 0)) {
      fail('invalid-state', `Stored child topology for "${node.nodeId}" is invalid`);
    }
    assertRootsCoverWriteSet(record.roots, record.ticket.writeSet);

    if (record.parentTicketHandleId === null) {
      if (record.ticket.issuerRole !== 'PLAN_ROOT' || record.ticket.recipientRole !== 'EXECUTION') {
        fail('invalid-state', 'Root ticket must bind PLAN_ROOT->EXECUTION');
      }
      if (record.lease.ref === null || record.lease.generation < 1 || record.lease.fence < 1) {
        fail('invalid-state', 'Root ticket is not bound to a controller lease');
      }
      assertTicketAttenuation(recordGrant(record), rootEnvelope(graph, state.rootAuthority));
    } else {
      const parentRecord = byHandle.get(record.parentTicketHandleId);
      if (!parentRecord || parentRecord.ticket.nodeId !== record.ticket.parentNodeId) {
        fail('invalid-state', `Stored parent ticket for "${node.nodeId}" is invalid`);
      }
      if (parentRecord.ticket.generation >= record.ticket.generation) {
        fail('invalid-state', `Stored child generation for "${node.nodeId}" does not follow its parent`);
      }
      if (!sameIdentity(record.hostIdentity, parentRecord.hostIdentity)) {
        fail('invalid-state', `Stored child host identity for "${node.nodeId}" differs from parent`);
      }
      if (record.lease.ref === null || record.lease.generation < 1 || record.lease.fence < 1) {
        fail('invalid-state', `Child ticket for "${node.nodeId}" is not bound to a workstream lease`);
      }
      assertTicketAttenuation(recordGrant(record), recordGrant(parentRecord));
      if (record.ticket.maxChildDepth >= parentRecord.ticket.maxChildDepth) {
        fail('invalid-state', `Stored child depth for "${node.nodeId}" is not reduced`);
      }
    }
  }
}

function validateLoadedRecords(
  state: Readonly<TicketAuthorityState>,
  graph: OrchestrationArtifactPayload
): void {
  try {
    validateStoredRecords(state, graph);
  } catch (error) {
    if (error instanceof TicketAuthorityError && error.code === 'invalid-state') throw error;
    throw new TicketAuthorityError(
      'invalid-state',
      `Stored ticket authority is invalid: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function createBroker(
  options: TicketAuthorityBrokerOptions,
  testSources: TicketAuthorityBrokerTestSources = {}
): TicketAuthorityBroker {
  const compiled = snapshotAuthorityData(options.compiled) as CompiledPlanGraph;
  const validation = validateCompiledPlanGraph(compiled);
  if (!validation.ok) fail('invalid-graph', `Compiled plan/graph invalid: ${validation.reasons.join('; ')}`);
  const graph = compiled.graph.payload;
  const now = options.now ?? (() => new Date());
  const random = testSources.random ?? (() => crypto.randomBytes(32).toString('base64url'));
  const provider = options.hostIdentityProvider;
  const leaseStateSource = options.leaseState;
  const leaseSources = options.leaseSources ?? {};
  let state: Readonly<TicketAuthorityState>;

  if (options.state !== undefined) {
    state = parseTicketAuthorityState(options.state);
    assertStateBindings(state, compiled, options);
    if (options.rootAuthority !== undefined) {
      const root = normalizeRootAuthority(options.rootAuthority);
      if (JSON.stringify(root) !== JSON.stringify(state.rootAuthority)) {
        fail('binding-mismatch', 'Stored root authority does not match supplied root authority');
      }
    }
    validateLoadedRecords(state, graph);
  } else {
    if (options.rootAuthority === undefined) fail('invalid-input', 'Fresh broker requires rootAuthority');
    const rootAuthority = normalizeRootAuthority(options.rootAuthority);
    state = canonicalAuthoritySnapshot({
      format: 'harness-mdocs/ticket-authority' as const,
      schemaVersion: 1 as const,
      runId: options.runId,
      projectId: options.projectId,
      approvedPlanDigest: compiled.plan.digest,
      approvedGraphDigest: compiled.graph.digest,
      graphId: compiled.graph.id,
      graphRevision: compiled.planRevision,
      graphEpoch: options.graphEpoch,
      cancellationGeneration: options.cancellationGeneration,
      rootAuthority,
      lastTicketGeneration: 0,
      tickets: []
    });
    state = parseTicketAuthorityState(state);
  }

  const knownHandles = new Set(state.tickets.map(record => record.ticket.ticketHandleId));
  const knownNonces = new Set(state.tickets.map(record => record.ticket.nonce));

  function randomValue(kind: 'handle' | 'nonce'): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      let value: string;
      try {
        value = random();
      } catch {
        fail('random-source-invalid', `Random ${kind} source failed`);
      }
      if (typeof value !== 'string' || value.length < 16 || value.length > 1024) {
        fail('random-source-invalid', `Random ${kind} must contain 16..1024 characters`);
      }
      const candidate = `${kind === 'handle' ? 'opaque-ticket' : `ticket-${kind}`}:${value}`;
      const set = kind === 'handle' ? knownHandles : knownNonces;
      if (!set.has(candidate)) {
        set.add(candidate);
        return candidate;
      }
    }
    fail('random-source-invalid', `Random ${kind} source repeated values`);
  }

  function clockMillis(): number {
    try {
      const value = now();
      if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
        fail('invalid-input', 'Clock returned invalid Date');
      }
      return value.getTime();
    } catch {
      fail('invalid-input', 'Clock source failed');
    }
  }

  function activeRecord(handle: string): StoredTicketRecord {
    if (!knownHandles.has(handle)) fail('unknown-handle', 'Unknown opaque ticket handle');
    const first = state.tickets.find(candidate => candidate.ticket.ticketHandleId === handle);
    if (!first) fail('unknown-handle', 'Unknown opaque ticket handle');
    const seen = new Set<string>();
    let record: StoredTicketRecord | undefined = first;
    const currentTime = clockMillis();
    while (record) {
      const currentHandle = record.ticket.ticketHandleId;
      if (seen.has(currentHandle)) fail('invalid-state', 'Ticket ancestor cycle');
      seen.add(currentHandle);
      if (record.lifecycle !== 'active') fail('inactive-ticket', 'Ticket or ancestor lifecycle is not active');
      if (currentTime >= Date.parse(record.ticket.expiresAt)) fail('expired-ticket', 'Ticket or ancestor is expired');
      const parentHandle: string | null = record.parentTicketHandleId;
      record = parentHandle
        ? state.tickets.find(candidate => candidate.ticket.ticketHandleId === parentHandle)
        : undefined;
      if (parentHandle && !record) fail('invalid-state', 'Ticket ancestor is missing');
    }
    return first;
  }

  async function currentIdentity(): Promise<Readonly<HostIdentitySnapshot>> {
    try {
      return identitySnapshot(await provider.currentHostIdentity());
    } catch (error) {
      if (error instanceof TicketAuthorityError) throw error;
      fail('host-identity-mismatch', 'Trusted host identity provider failed');
    }
  }

  function currentLeaseState(): Readonly<LeaseAuthorityState> {
    if (!leaseStateSource) fail('lease-required', 'Lease authority state is unavailable');
    try {
      return parseLeaseAuthorityState(leaseStateSource());
    } catch (error) {
      if (error instanceof TicketAuthorityError) throw error;
      fail('lease-required', 'Lease authority state is unavailable');
    }
  }

  function proofFromPlaceholder(
    lease: TicketLeasePlaceholder,
    kind: 'controller',
    nodeId?: string
  ): ControllerLeaseProof;
  function proofFromPlaceholder(
    lease: TicketLeasePlaceholder,
    kind: 'workstream',
    nodeId: string
  ): WorkstreamLeaseProof;
  function proofFromPlaceholder(
    lease: TicketLeasePlaceholder,
    kind: 'controller' | 'workstream',
    nodeId?: string
  ): ControllerLeaseProof | WorkstreamLeaseProof {
    if (lease.ref === null || lease.generation < 1 || lease.fence < 1) {
      fail('lease-required', `${kind === 'controller' ? 'Controller' : 'Workstream'} lease binding is required`);
    }
    return kind === 'controller'
      ? { kind, leaseRef: lease.ref, generation: lease.generation, fence: lease.fence }
      : { kind, nodeId: nodeId!, leaseRef: lease.ref, generation: lease.generation, fence: lease.fence };
  }

  function leaseOperationBinding(identity: HostIdentitySnapshot) {
    return {
      runId: state.runId,
      projectId: state.projectId,
      graphEpoch: state.graphEpoch,
      cancellationGeneration: state.cancellationGeneration,
      holder: identity
    };
  }

  function validateControllerBinding(lease: TicketLeasePlaceholder, identity: HostIdentitySnapshot): void {
    validateControllerLease(currentLeaseState(), {
      ...leaseOperationBinding(identity),
      proof: proofFromPlaceholder(lease, 'controller')
    }, leaseSources);
  }

  function validateWorkstreamBinding(
    lease: TicketLeasePlaceholder,
    nodeId: string,
    identity: HostIdentitySnapshot
  ): void {
    validateWorkstreamLease(currentLeaseState(), {
      ...leaseOperationBinding(identity),
      nodeId,
      proof: proofFromPlaceholder(lease, 'workstream', nodeId)
    }, leaseSources);
  }

  function persist(record: StoredTicketRecord): void {
    state = parseTicketAuthorityState({
      ...state,
      lastTicketGeneration: record.ticket.generation,
      tickets: [...state.tickets, record]
    });
    validateStoredRecords(state, graph);
  }

  async function issue(
    rawInput: IssueRootTicketInput | DelegateTicketInput,
    parentRecord?: StoredTicketRecord
  ): Promise<IssuedTicketHandle> {
    const parsed = parentRecord
      ? parseInput(delegateTicketInputSchema, rawInput)
      : parseInput(issueRootTicketInputSchema, rawInput);
    const grant = canonicalizeTicketGrant(parsed);
    const identity = await currentIdentity();
    if (parentRecord) parentRecord = activeRecord(parentRecord.ticket.ticketHandleId);
    const { node, parent } = topologyForNode(graph, parsed.nodeId);

    if (!parentRecord) {
      if (parent.ownerRole !== 'PLAN_ROOT' || node.ownerRole !== 'EXECUTION') {
        fail('topology-denied', 'Root tickets may only follow PLAN_ROOT->EXECUTION graph edges');
      }
      if (grant.maxChildDepth > 1) fail('topology-denied', 'EXECUTION ticket child depth cannot exceed 1');
      if (!parsed.lease) fail('lease-required', 'Root ticket issuance requires controller lease binding');
      validateControllerBinding(parsed.lease, identity);
    } else {
      if (parentRecord.nonceStatus !== 'claimed') fail('inactive-ticket', 'Parent ticket must be claimed before delegation');
      if (parentRecord.ticket.nodeId !== parent.nodeId ||
          parentRecord.ticket.recipientRole !== 'EXECUTION' || node.ownerRole !== 'LEAF') {
        fail('topology-denied', 'Child tickets may only follow the exact parent EXECUTION->LEAF graph edge');
      }
      if (parentRecord.ticket.allowedChildRole !== 'LEAF' || parentRecord.ticket.maxChildDepth < 1) {
        fail('topology-denied', 'Parent ticket carries no LEAF delegation authority');
      }
      if (grant.maxChildDepth !== 0) fail('topology-denied', 'LEAF ticket child depth must be 0');
      if (!sameIdentity(identity, parentRecord.hostIdentity)) {
        fail('host-identity-mismatch', 'Current host identity differs from parent ticket identity');
      }
      if (!parsed.lease) fail('lease-required', 'EO delegation requires workstream lease binding');
      validateWorkstreamBinding(parsed.lease, parentRecord.ticket.nodeId, identity);
    }

    const writeSet = canonicalSet(node.writeSet);
    const criteria = graphCriteria(graph, node);
    assertRootsCoverWriteSet(grant.roots, writeSet);
    const authority = { ...grant, writeSet, criteria };
    assertTicketAttenuation(
      authority,
      parentRecord ? recordGrant(parentRecord) : rootEnvelope(graph, state.rootAuthority)
    );
    if (parentRecord && grant.maxChildDepth >= parentRecord.ticket.maxChildDepth) {
      fail('attenuation-denied', 'Child ticket must reduce remaining delegation depth');
    }
    if (clockMillis() >= Date.parse(grant.expiresAt)) fail('expired-ticket', 'Cannot issue an expired ticket');

    if (state.lastTicketGeneration >= Number.MAX_SAFE_INTEGER) {
      fail('invalid-state', 'Ticket generation exhausted');
    }
    const generation = state.lastTicketGeneration + 1;
    const handle = randomValue('handle');
    const nonce = randomValue('nonce');
    const hostIdentityRef = `host-binding:${nonce}`;
    const ticket: DelegationTicketPayload = {
      ticketHandleId: handle,
      runId: state.runId,
      graphId: state.graphId,
      nodeId: node.nodeId,
      parentNodeId: parent.nodeId,
      generation,
      issuerRole: parent.ownerRole,
      recipientRole: node.ownerRole,
      hostIdentityRef,
      scope: parsed.scope,
      writeSet,
      criteria,
      operationClasses: grant.operationClasses,
      toolClasses: grant.toolClasses,
      credentialClasses: grant.credentialClasses,
      approvalRefs: grant.approvalRefs,
      budgets: grant.budgets,
      ...(node.ownerRole === 'EXECUTION' && grant.maxChildDepth > 0
        ? { allowedChildRole: 'LEAF' as const }
        : {}),
      maxChildDepth: grant.maxChildDepth,
      maxFanout: grant.maxFanout,
      nonce,
      expiresAt: grant.expiresAt,
      cancellationGeneration: state.cancellationGeneration,
      reportDestination: `controller:${node.nodeId}`,
      reportSchemaRef: node.expectedReportKind
    };
    const record = canonicalAuthoritySnapshot({
      projectId: state.projectId,
      approvedPlanDigest: state.approvedPlanDigest,
      approvedGraphDigest: state.approvedGraphDigest,
      graphId: state.graphId,
      graphRevision: state.graphRevision,
      graphEpoch: state.graphEpoch,
      cancellationGeneration: state.cancellationGeneration,
      lease: parsed.lease ?? EMPTY_LEASE,
      roots: grant.roots,
      hostIdentity: identity,
      parentTicketHandleId: parentRecord?.ticket.ticketHandleId ?? null,
      nonceStatus: 'issued' as const,
      lifecycle: 'active' as const,
      ticket
    }) as Readonly<StoredTicketRecord>;
    persist(record as StoredTicketRecord);
    return canonicalAuthoritySnapshot({ handle: handle as OpaqueHandle });
  }

  const broker: TicketAuthorityBroker = {
    issueRoot: rawInput => issue(rawInput),
    delegate: async rawInput => {
      const detached = parseInput(delegateTicketInputSchema, rawInput);
      const parentRecord = activeRecord(detached.parentHandle);
      return issue(detached, parentRecord);
    },
    resolveClaimsOnly: async rawInput => {
      try {
        const input = parseInput(resolveTicketInputSchema, rawInput);
        const identity = await currentIdentity();
        const record = activeRecord(input.handle);
        const checks: [unknown, unknown, TicketAuthorityErrorCode, string][] = [
          [input.runId, record.ticket.runId, 'run-mismatch', 'Run binding mismatch'],
          [input.projectId, record.projectId, 'project-mismatch', 'Project binding mismatch'],
          [input.approvedPlanDigest, record.approvedPlanDigest, 'plan-mismatch', 'Approved plan digest mismatch'],
          [input.approvedGraphDigest, record.approvedGraphDigest, 'graph-mismatch', 'Approved graph digest mismatch'],
          [input.graphId, record.graphId, 'graph-mismatch', 'Graph ID mismatch'],
          [input.graphRevision, record.graphRevision, 'graph-revision-mismatch', 'Graph revision mismatch'],
          [input.graphEpoch, record.graphEpoch, 'graph-epoch-mismatch', 'Graph epoch mismatch'],
          [input.cancellationGeneration, record.cancellationGeneration,
            'cancellation-generation-mismatch', 'Cancellation generation mismatch']
        ];
        for (const [actual, expected, code, reason] of checks) {
          if (actual !== expected) fail(code, reason);
        }
        if (!sameIdentity(identity, record.hostIdentity)) {
          fail('host-identity-mismatch', 'Current host identity does not match ticket host identity');
        }
        return canonicalAuthoritySnapshot({
          ok: true,
          claims: {
            runId: record.ticket.runId,
            projectId: record.projectId,
            graphEpoch: record.graphEpoch,
            cancellationGeneration: record.cancellationGeneration,
            holder: record.hostIdentity,
            lease: record.lease,
            ticketHandleId: record.ticket.ticketHandleId,
            nodeId: record.ticket.nodeId,
            recipientRole: record.ticket.recipientRole as 'EXECUTION' | 'LEAF',
            expiresAt: record.ticket.expiresAt
          }
        });
      } catch (error) {
        return claimsDenial(error);
      }
    },
    claim: async rawInput => {
      try {
        const resolved = await broker.resolveClaimsOnly(rawInput);
        if (!resolved.ok) return resolved;
        const input = parseInput(resolveTicketInputSchema, rawInput);
        const record = activeRecord(input.handle);
        if (record.nonceStatus === 'claimed') fail('replayed-ticket', 'Ticket nonce was already claimed');
        state = parseTicketAuthorityState({
          ...state,
          tickets: state.tickets.map(candidate =>
            candidate.ticket.ticketHandleId === input.handle
              ? { ...candidate, nonceStatus: 'claimed' }
              : candidate)
        });
        validateStoredRecords(state, graph);
        return resolved;
      } catch (error) {
        return claimsDenial(error);
      }
    },
    resolveForAuthority: async rawInput => {
      try {
        const input = parseInput(resolveTicketForAuthorityInputSchema, rawInput);
        const identity = await currentIdentity();
        const record = activeRecord(input.handle);
        const checks: [unknown, unknown, TicketAuthorityErrorCode, string][] = [
          [input.runId, record.ticket.runId, 'run-mismatch', 'Run binding mismatch'],
          [input.projectId, record.projectId, 'project-mismatch', 'Project binding mismatch'],
          [input.approvedPlanDigest, record.approvedPlanDigest, 'plan-mismatch', 'Approved plan digest mismatch'],
          [input.approvedGraphDigest, record.approvedGraphDigest, 'graph-mismatch', 'Approved graph digest mismatch'],
          [input.graphId, record.graphId, 'graph-mismatch', 'Graph ID mismatch'],
          [input.graphRevision, record.graphRevision, 'graph-revision-mismatch', 'Graph revision mismatch'],
          [input.graphEpoch, record.graphEpoch, 'graph-epoch-mismatch', 'Graph epoch mismatch'],
          [input.cancellationGeneration, record.cancellationGeneration,
            'cancellation-generation-mismatch', 'Cancellation generation mismatch']
        ];
        for (const [actual, expected, code, reason] of checks) {
          if (actual !== expected) fail(code, reason);
        }
        if (!sameIdentity(identity, record.hostIdentity)) {
          fail('host-identity-mismatch', 'Current host identity does not match ticket host identity');
        }
        const workstreamNodeId = record.ticket.recipientRole === 'EXECUTION'
          ? record.ticket.nodeId
          : record.ticket.parentNodeId;
        if (!input.lease) fail('lease-required', 'Workstream lease binding is required for authority resolution');
        validateWorkstreamBinding(input.lease, workstreamNodeId, identity);
        if (record.ticket.recipientRole === 'LEAF' &&
            (record.lease.ref !== input.lease.ref ||
              record.lease.generation !== input.lease.generation ||
              record.lease.fence !== input.lease.fence)) {
          fail('stale-lease', 'Leaf ticket is not bound to current workstream lease');
        }
        if (record.nonceStatus === 'issued') {
          state = parseTicketAuthorityState({
            ...state,
            tickets: state.tickets.map(candidate =>
              candidate.ticket.ticketHandleId === input.handle
                ? { ...candidate, nonceStatus: 'claimed' }
                : candidate)
          });
          validateStoredRecords(state, graph);
        }
        const { nonce: _nonce, ...ticket } = record.ticket;
        return canonicalAuthoritySnapshot({
          ok: true,
          authority: {
            runId: record.ticket.runId,
            projectId: record.projectId,
            approvedPlanDigest: record.approvedPlanDigest,
            approvedGraphDigest: record.approvedGraphDigest,
            graphId: record.graphId,
            graphRevision: record.graphRevision,
            graphEpoch: record.graphEpoch,
            cancellationGeneration: record.cancellationGeneration,
            lease: input.lease,
            roots: record.roots,
            ticket
          }
        });
      } catch (error) {
        return denial(error);
      }
    },
    revoke: handle => {
      if (typeof handle !== 'string' || !knownHandles.has(handle)) return false;
      const index = state.tickets.findIndex(record => record.ticket.ticketHandleId === handle);
      if (index < 0 || state.tickets[index].lifecycle !== 'active') return false;
      const revoked = new Set<string>([handle]);
      for (let changed = true; changed;) {
        changed = false;
        for (const record of state.tickets) {
          if (record.parentTicketHandleId && revoked.has(record.parentTicketHandleId) &&
              !revoked.has(record.ticket.ticketHandleId)) {
            revoked.add(record.ticket.ticketHandleId);
            changed = true;
          }
        }
      }
      state = parseTicketAuthorityState({
        ...state,
        tickets: state.tickets.map(record => revoked.has(record.ticket.ticketHandleId)
          ? { ...record, lifecycle: 'revoked' }
          : record)
      });
      return true;
    },
    snapshot: () => state
  };
  return Object.freeze(broker);
}

export function createTicketAuthorityBroker(options: TicketAuthorityBrokerOptions): TicketAuthorityBroker {
  return createBroker(options);
}

export function createTicketAuthorityBrokerForTest(
  options: TicketAuthorityBrokerOptions,
  sources: TicketAuthorityBrokerTestSources
): TicketAuthorityBroker {
  return createBroker(options, sources);
}
