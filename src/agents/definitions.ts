import { AgentCapabilityDefinition, AgentProfileDefinition } from './schema';

export const ORCHESTRATE_PROFILE = Object.freeze({
  schemaVersion: 1,
  id: 'orchestrate',
  productIdentity: 'mdocs-orchestrator',
  mode: 'normal'
} as const) satisfies AgentProfileDefinition;

export const ROUTE_PROFILE = Object.freeze({
  schemaVersion: 1,
  id: 'route',
  productIdentity: 'mdocs-orchestrator',
  mode: 'read-only'
} as const) satisfies AgentProfileDefinition;

export const RUN_PROFILE = Object.freeze({
  schemaVersion: 1,
  id: 'run',
  productIdentity: 'mdocs-orchestrator',
  mode: 'policy-backed-resumable'
} as const) satisfies AgentProfileDefinition;

export const ORCHESTRATE_CAPABILITY = Object.freeze({
  schemaVersion: 1,
  id: 'orchestrate',
  displayName: 'Orchestrate',
  description: 'Coordinate initiative lifecycle, context, delegation, verification, and reporting.',
  profileId: ORCHESTRATE_PROFILE.id,
  invocation: Object.freeze({ intent: 'orchestrate', activation: 'default' } as const)
} as const) satisfies AgentCapabilityDefinition;

export const ROUTE_CAPABILITY = Object.freeze({
  schemaVersion: 1,
  id: 'route',
  displayName: 'Route',
  description: 'Analyze project-scoped capabilities and produce a read-only execution blueprint.',
  profileId: ROUTE_PROFILE.id,
  invocation: Object.freeze({ intent: 'route', activation: 'explicit' } as const)
} as const) satisfies AgentCapabilityDefinition;

export const RUN_CAPABILITY = Object.freeze({
  schemaVersion: 1,
  id: 'run',
  displayName: 'Run',
  description: 'Execute bounded initiative work under explicit policy with resumable state.',
  profileId: RUN_PROFILE.id,
  invocation: Object.freeze({ intent: 'run', activation: 'explicit' } as const)
} as const) satisfies AgentCapabilityDefinition;

export const CANONICAL_AGENT_PROFILES = Object.freeze([
  ORCHESTRATE_PROFILE,
  ROUTE_PROFILE,
  RUN_PROFILE
] as const);

export const CANONICAL_AGENT_CAPABILITIES = Object.freeze([
  ORCHESTRATE_CAPABILITY,
  ROUTE_CAPABILITY,
  RUN_CAPABILITY
] as const);
