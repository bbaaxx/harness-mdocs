import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  agentCapabilityDefinitionSchema,
  agentProfileDefinitionSchema,
  CANONICAL_AGENT_CAPABILITIES,
  CANONICAL_AGENT_PROFILES,
  canonicalAgentCapabilityRegistry,
  createAgentCapabilityRegistry,
  projectCapabilityInventorySchema,
  projectRootSchema,
  resolveProjectFilesystemEvidence,
  restrictSurfaceFidelity,
  RUN_CAPABILITY,
  ROUTE_PROFILE,
  surfaceFidelitySchema,
  SURFACE_FIDELITIES
} from '../../src/agents';

const confirmedAvailability = {
  installed: 'confirmed',
  configured: 'confirmed',
  exposed: 'confirmed',
  permitted: 'confirmed',
  taskSuitability: 'suitable'
} as const;

test('canonical capability and profile definitions satisfy strict schemas', () => {
  expect(CANONICAL_AGENT_CAPABILITIES.map(value => agentCapabilityDefinitionSchema.parse(value)))
    .toEqual(CANONICAL_AGENT_CAPABILITIES);
  expect(CANONICAL_AGENT_PROFILES.map(value => agentProfileDefinitionSchema.parse(value)))
    .toEqual(CANONICAL_AGENT_PROFILES);

  expect(agentCapabilityDefinitionSchema.safeParse({
    ...RUN_CAPABILITY,
    executableClass: 'RunAgent'
  }).success).toBe(false);
});

test('canonical profiles preserve one product identity and intended activation boundaries', () => {
  expect(CANONICAL_AGENT_PROFILES.map(profile => profile.productIdentity))
    .toEqual(['mdocs-orchestrator', 'mdocs-orchestrator', 'mdocs-orchestrator']);
  expect(CANONICAL_AGENT_PROFILES.map(profile => profile.mode))
    .toEqual(['normal', 'read-only', 'policy-backed-resumable']);
  expect(CANONICAL_AGENT_CAPABILITIES.map(capability => capability.invocation.activation))
    .toEqual(['default', 'explicit', 'explicit']);
});

test('exported canonical definitions and arrays are deeply frozen', () => {
  expect(Object.isFrozen(CANONICAL_AGENT_PROFILES)).toBe(true);
  expect(Object.isFrozen(CANONICAL_AGENT_CAPABILITIES)).toBe(true);
  for (const profile of CANONICAL_AGENT_PROFILES) expect(Object.isFrozen(profile)).toBe(true);
  for (const capability of CANONICAL_AGENT_CAPABILITIES) {
    expect(Object.isFrozen(capability)).toBe(true);
    expect(Object.isFrozen(capability.invocation)).toBe(true);
  }

  expect(() => { (RUN_CAPABILITY.invocation as any).activation = 'default'; }).toThrow(TypeError);
  expect(() => { (CANONICAL_AGENT_CAPABILITIES as any).push(RUN_CAPABILITY); }).toThrow(TypeError);
  expect(RUN_CAPABILITY.invocation.activation).toBe('explicit');
});

test('project capability inventory accepts every project-scoped evidence source', () => {
  const result = projectCapabilityInventorySchema.parse({
    schemaVersion: 1,
    projectRoot: '/workspace/project',
    observations: [{
      capabilityId: 'route',
      evidence: [
        { source: 'active-project-runtime', reference: 'opencode tools' },
        { source: 'project-config', reference: '.mdocs.json' },
        { source: 'project-manifest', reference: 'package.json' },
        { source: 'package-project-asset', reference: 'harness-mdocs/agents' }
      ],
      availability: confirmedAvailability
    }]
  });

  expect(result.observations[0].evidence).toHaveLength(4);
});

test.each(['global-config', 'home-config', 'global-cache', 'user-config'])(
  'project capability inventory rejects non-project evidence source %s',
  source => {
    const result = projectCapabilityInventorySchema.safeParse({
      schemaVersion: 1,
      projectRoot: '/workspace/project',
      observations: [{
        capabilityId: 'route',
        evidence: [{ source, reference: '~/.config/tooling' }],
        availability: confirmedAvailability
      }]
    });

    expect(result.success).toBe(false);
  }
);

test('project capability inventory rejects duplicate observations', () => {
  const observation = {
    capabilityId: 'route',
    evidence: [{ source: 'project-config', reference: '.mdocs.json' }],
    availability: confirmedAvailability
  };

  expect(projectCapabilityInventorySchema.safeParse({
    schemaVersion: 1,
    projectRoot: '/workspace/project',
    observations: [observation, observation]
  }).success).toBe(false);
});

test.each([
  ['project-config', '~/.config/tooling'],
  ['project-manifest', '/etc/tooling/config.json'],
  ['package-project-asset', '../shared/config.json'],
  ['project-config', 'config/../../shared.json'],
  ['project-manifest', 'C:\\Users\\user\\tooling.json'],
  ['package-project-asset', '\\\\server\\share\\tooling.json']
])('project path evidence source %s rejects non-project reference %s', (source, reference) => {
  expect(projectCapabilityInventorySchema.safeParse({
    schemaVersion: 1,
    projectRoot: 'C:\\workspace\\project',
    observations: [{
      capabilityId: 'route',
      evidence: [{ source, reference }],
      availability: confirmedAvailability
    }]
  }).success).toBe(false);
});

test('inventory requires an absolute project root while runtime evidence stays opaque', () => {
  const inventory = {
    schemaVersion: 1,
    projectRoot: '/workspace/project',
    observations: [{
      capabilityId: 'route',
      evidence: [{ source: 'active-project-runtime', reference: 'runtime://session/tool-registry' }],
      availability: confirmedAvailability
    }]
  };

  expect(projectCapabilityInventorySchema.safeParse(inventory).success).toBe(true);
  expect(projectCapabilityInventorySchema.safeParse({
    ...inventory,
    projectRoot: '../project'
  }).success).toBe(false);
});

test('filesystem evidence resolver rejects schema-valid roots that are not native absolute paths', () => {
  const foreignRoot = ['/workspace/project', 'C:\\workspace\\project']
    .find(root => projectRootSchema.safeParse(root).success && !path.isAbsolute(root));

  if (!foreignRoot) return;
  expect(() => resolveProjectFilesystemEvidence(foreignRoot, {
    source: 'project-config',
    reference: '.mdocs.json'
  })).toThrow('not absolute for current platform');
});

test('filesystem evidence resolver accepts contained paths and rejects symlink escapes', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mdocs-agent-evidence-'));
  const projectRoot = path.join(tempRoot, 'project');
  const outsideRoot = path.join(tempRoot, 'outside');
  fs.mkdirSync(projectRoot);
  fs.mkdirSync(outsideRoot);
  fs.writeFileSync(path.join(projectRoot, 'package.json'), '{}', 'utf8');
  const outsideFile = path.join(outsideRoot, 'global.json');
  fs.writeFileSync(outsideFile, '{}', 'utf8');

  try {
    expect(resolveProjectFilesystemEvidence(projectRoot, {
      source: 'project-manifest',
      reference: 'package.json'
    })).toBe(fs.realpathSync(path.join(projectRoot, 'package.json')));
    expect(() => resolveProjectFilesystemEvidence(projectRoot, {
      source: 'active-project-runtime',
      reference: 'runtime://tool-registry'
    })).toThrow('has no filesystem path');

    const link = path.join(projectRoot, 'linked-global.json');
    try {
      fs.symlinkSync(outsideFile, link, 'file');
    } catch (error: any) {
      if (['EPERM', 'EACCES', 'ENOSYS', 'EINVAL'].includes(error?.code)) return;
      throw error;
    }

    expect(() => resolveProjectFilesystemEvidence(projectRoot, {
      source: 'project-config',
      reference: 'linked-global.json'
    })).toThrow('escapes project root');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('registry rejects duplicate and unresolved IDs', () => {
  expect(() => createAgentCapabilityRegistry({
    capabilities: [RUN_CAPABILITY, RUN_CAPABILITY],
    profiles: CANONICAL_AGENT_PROFILES
  })).toThrow('Duplicate capability id "run"');

  expect(() => createAgentCapabilityRegistry({
    capabilities: CANONICAL_AGENT_CAPABILITIES,
    profiles: [ROUTE_PROFILE, ROUTE_PROFILE]
  })).toThrow('Duplicate profile id "route"');

  expect(() => createAgentCapabilityRegistry({
    capabilities: [{ ...RUN_CAPABILITY, profileId: 'missing' }],
    profiles: CANONICAL_AGENT_PROFILES
  })).toThrow('references unknown profile "missing"');
});

test('registry requires explicit activation for policy-backed resumable profiles', () => {
  expect(() => createAgentCapabilityRegistry({
    capabilities: [{
      ...RUN_CAPABILITY,
      invocation: { ...RUN_CAPABILITY.invocation, activation: 'default' }
    }],
    profiles: CANONICAL_AGENT_PROFILES
  })).toThrow('must use explicit activation for policy-backed-resumable profile "run"');
});

test('registry rejects duplicate invocation intents', () => {
  expect(() => createAgentCapabilityRegistry({
    capabilities: [
      ...CANONICAL_AGENT_CAPABILITIES,
      {
        schemaVersion: 1,
        id: 'inspect',
        displayName: 'Inspect',
        description: 'Inspect project evidence without mutation.',
        profileId: 'route',
        invocation: { intent: 'route', activation: 'explicit' }
      }
    ],
    profiles: CANONICAL_AGENT_PROFILES
  })).toThrow('Duplicate invocation intent "route"');
});

test('registry requires exactly one default capability', () => {
  const noDefault = CANONICAL_AGENT_CAPABILITIES.map(capability => ({
    ...capability,
    invocation: { ...capability.invocation, activation: 'explicit' }
  }));
  expect(() => createAgentCapabilityRegistry({
    capabilities: noDefault,
    profiles: CANONICAL_AGENT_PROFILES
  })).toThrow('requires exactly one default activation; found 0');

  expect(() => createAgentCapabilityRegistry({
    capabilities: [
      ...CANONICAL_AGENT_CAPABILITIES,
      {
        schemaVersion: 1,
        id: 'inspect',
        displayName: 'Inspect',
        description: 'Inspect project evidence without mutation.',
        profileId: 'route',
        invocation: { intent: 'inspect', activation: 'default' }
      }
    ],
    profiles: CANONICAL_AGENT_PROFILES
  })).toThrow('requires exactly one default activation; found 2');
});

test('registry listing and lookup are deterministic', () => {
  const registry = createAgentCapabilityRegistry({
    capabilities: [...CANONICAL_AGENT_CAPABILITIES].reverse(),
    profiles: [...CANONICAL_AGENT_PROFILES].reverse()
  });

  expect(registry.listCapabilities().map(capability => capability.id))
    .toEqual(['orchestrate', 'route', 'run']);
  expect(registry.listProfiles().map(profile => profile.id))
    .toEqual(['orchestrate', 'route', 'run']);
  expect(registry.getCapability('route')?.profileId).toBe('route');
  expect(registry.getProfile('missing')).toBeUndefined();
});

test('registry definitions are deeply frozen and lookup semantics cannot be mutated', () => {
  const capability = canonicalAgentCapabilityRegistry.getCapability('route')!;
  const profile = canonicalAgentCapabilityRegistry.getProfile('route')!;

  expect(Object.isFrozen(canonicalAgentCapabilityRegistry.listCapabilities())).toBe(true);
  expect(Object.isFrozen(capability)).toBe(true);
  expect(Object.isFrozen(capability.invocation)).toBe(true);
  expect(Object.isFrozen(profile)).toBe(true);

  expect(() => { (capability as any).id = 'changed'; }).toThrow(TypeError);
  expect(() => { (capability.invocation as any).activation = 'default'; }).toThrow(TypeError);
  expect(() => { (profile as any).mode = 'normal'; }).toThrow(TypeError);

  expect(canonicalAgentCapabilityRegistry.getCapability('route')?.id).toBe('route');
  expect(canonicalAgentCapabilityRegistry.getCapability('route')?.invocation.activation)
    .toBe('explicit');
  expect(canonicalAgentCapabilityRegistry.getProfile('route')?.mode).toBe('read-only');
});

test('fourth capability registers through existing contract semantics', () => {
  const inspectProfile = {
    schemaVersion: 1,
    id: 'inspect',
    productIdentity: 'mdocs-orchestrator',
    mode: 'read-only'
  } as const;
  const inspectCapability = {
    schemaVersion: 1,
    id: 'inspect',
    displayName: 'Inspect',
    description: 'Inspect project evidence without mutation.',
    profileId: 'inspect',
    invocation: { intent: 'inspect', activation: 'explicit' }
  } as const;

  const registry = createAgentCapabilityRegistry({
    capabilities: [...CANONICAL_AGENT_CAPABILITIES, inspectCapability],
    profiles: [...CANONICAL_AGENT_PROFILES, inspectProfile]
  });

  expect(registry.listCapabilities().map(capability => capability.id))
    .toEqual(['inspect', 'orchestrate', 'route', 'run']);
  expect(registry.getProfile(registry.getCapability('inspect')!.profileId)?.mode)
    .toBe('read-only');
  expect(canonicalAgentCapabilityRegistry.getCapability('inspect')).toBeUndefined();
});

test('surface fidelity is explicit and restriction is monotonic', () => {
  expect(Object.isFrozen(SURFACE_FIDELITIES)).toBe(true);
  expect(() => { (SURFACE_FIDELITIES as any).reverse(); }).toThrow(TypeError);
  expect(['exact', 'supervised', 'plan-only', 'unsupported'].map(value =>
    surfaceFidelitySchema.parse(value)
  )).toEqual(['exact', 'supervised', 'plan-only', 'unsupported']);
  expect(restrictSurfaceFidelity('exact', 'plan-only')).toBe('plan-only');
  expect(restrictSurfaceFidelity('unsupported', 'exact')).toBe('unsupported');
  expect(surfaceFidelitySchema.safeParse('autonomous').success).toBe(false);
});
