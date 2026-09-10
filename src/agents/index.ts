export * from './schema';
export * from './registry';
export * from './definitions';
export * from './evidence';
export * from './project-context';
export * from './run';
export * from './contracts';
export * from './route';

import { CANONICAL_AGENT_CAPABILITIES, CANONICAL_AGENT_PROFILES } from './definitions';
import { createAgentCapabilityRegistry } from './registry';

export const canonicalAgentCapabilityRegistry = createAgentCapabilityRegistry({
  capabilities: CANONICAL_AGENT_CAPABILITIES,
  profiles: CANONICAL_AGENT_PROFILES
});
