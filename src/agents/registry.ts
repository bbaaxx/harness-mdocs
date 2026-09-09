import {
  AgentCapabilityDefinition,
  agentCapabilityDefinitionSchema,
  AgentProfileDefinition,
  agentProfileDefinitionSchema,
  InvocationMetadata
} from './schema';

export type RegisteredAgentCapability = Readonly<
  Omit<AgentCapabilityDefinition, 'invocation'> & {
    invocation: Readonly<InvocationMetadata>;
  }
>;
export type RegisteredAgentProfile = Readonly<AgentProfileDefinition>;

export interface AgentCapabilityRegistry {
  listCapabilities(): readonly RegisteredAgentCapability[];
  getCapability(id: string): RegisteredAgentCapability | undefined;
  listProfiles(): readonly RegisteredAgentProfile[];
  getProfile(id: string): RegisteredAgentProfile | undefined;
}

export interface AgentCapabilityRegistryInput {
  capabilities: readonly unknown[];
  profiles: readonly unknown[];
}

function compareIds(left: { id: string }, right: { id: string }): number {
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

function assertUniqueIds(items: readonly { id: string }[], kind: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) throw new Error(`Duplicate ${kind} id "${item.id}"`);
    seen.add(item.id);
  }
}

export function createAgentCapabilityRegistry(
  input: AgentCapabilityRegistryInput
): AgentCapabilityRegistry {
  const capabilities = input.capabilities.map(value => {
    const capability = agentCapabilityDefinitionSchema.parse(value);
    return Object.freeze({
      ...capability,
      invocation: Object.freeze({ ...capability.invocation })
    });
  });
  const profiles = input.profiles.map(value => Object.freeze(
    agentProfileDefinitionSchema.parse(value)
  ));

  assertUniqueIds(capabilities, 'capability');
  assertUniqueIds(profiles, 'profile');

  const invocationIntents = new Set<string>();
  for (const capability of capabilities) {
    if (invocationIntents.has(capability.invocation.intent)) {
      throw new Error(`Duplicate invocation intent "${capability.invocation.intent}"`);
    }
    invocationIntents.add(capability.invocation.intent);
  }

  const capabilityById = new Map(capabilities.map(capability => [capability.id, capability]));
  const profileById = new Map(profiles.map(profile => [profile.id, profile]));

  for (const capability of capabilities) {
    const profile = profileById.get(capability.profileId);
    if (!profile) {
      throw new Error(
        `Capability "${capability.id}" references unknown profile "${capability.profileId}"`
      );
    }
    if (
      profile.mode === 'policy-backed-resumable' &&
      capability.invocation.activation !== 'explicit'
    ) {
      throw new Error(
        `Capability "${capability.id}" must use explicit activation for policy-backed-resumable profile "${profile.id}"`
      );
    }
  }

  const defaultCount = capabilities.filter(
    capability => capability.invocation.activation === 'default'
  ).length;
  if (defaultCount !== 1) {
    throw new Error(`Registry requires exactly one default activation; found ${defaultCount}`);
  }

  const sortedCapabilities = Object.freeze([...capabilities].sort(compareIds));
  const sortedProfiles = Object.freeze([...profiles].sort(compareIds));

  return Object.freeze({
    listCapabilities: () => sortedCapabilities,
    getCapability: (id: string) => capabilityById.get(id),
    listProfiles: () => sortedProfiles,
    getProfile: (id: string) => profileById.get(id)
  });
}
