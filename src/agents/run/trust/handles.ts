import * as crypto from 'crypto';

declare const opaqueHandleBrand: unique symbol;

/**
 * Opaque authority handle issued to workers. The string carries no parseable
 * authority content: workers cannot derive scope, digests, or lineage from it,
 * and workers MUST NOT attempt to inspect it. Only the control plane maps a
 * handle to authority records.
 */
export type OpaqueHandle = string & { readonly [opaqueHandleBrand]: true };

/** Control-plane-only view of the authority behind a handle. */
export interface HandleInspection {
  runId: string;
  graphId: string;
  nodeId: string;
  generation: number;
  /** RFC3339 UTC `Z` timestamp after which the handle is invalid. */
  expiresAt: string;
  cancellationGeneration: number;
  scopeSummary: string;
  writeSetSummary: readonly string[];
}

export interface HandleIssueParams {
  runId: string;
  graphId: string;
  nodeId: string;
  generation: number;
  expiresAt: string;
  cancellationGeneration: number;
  scopeSummary: string;
  writeSetSummary: readonly string[];
}

/**
 * Issues and inspects opaque handles. `inspect` is control-plane-only:
 * workers never call it and never receive the inspection payload.
 */
export interface HandleBroker {
  issue(params: HandleIssueParams): OpaqueHandle;
  inspect(handle: OpaqueHandle): HandleInspection;
}

/**
 * Control-plane-only helper used by broker implementations to mint a handle
 * value. Reachable through the package root so trusted control-plane and test
 * code can mint forgery attempts; workers must never call it — a handle a
 * worker constructs itself is unknown to the broker and inert.
 */
export function createOpaqueHandle(id: string = crypto.randomUUID()): OpaqueHandle {
  return `opaque:${id}` as OpaqueHandle;
}
