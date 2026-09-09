import * as path from 'path';
import { z } from 'zod';

export const AGENT_SCHEMA_VERSION = 1 as const;
export const MDOCS_ORCHESTRATOR_IDENTITY = 'mdocs-orchestrator' as const;

const agentIdSchema = z.string().regex(
  /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
  'Expected a lowercase kebab-case identifier'
);

export const invocationMetadataSchema = z.object({
  intent: agentIdSchema,
  activation: z.enum(['default', 'explicit'])
}).strict();

export const agentProfileDefinitionSchema = z.object({
  schemaVersion: z.literal(AGENT_SCHEMA_VERSION),
  id: agentIdSchema,
  productIdentity: z.literal(MDOCS_ORCHESTRATOR_IDENTITY),
  mode: z.enum(['normal', 'read-only', 'policy-backed-resumable']),
  // 'user' profiles are authorizable surfaces; 'internal' profiles (the
  // Execution Orchestrator) exist only inside Run's trusted control plane
  // and are never user-authorizable.
  exposure: z.enum(['user', 'internal'])
}).strict();

export const agentCapabilityDefinitionSchema = z.object({
  schemaVersion: z.literal(AGENT_SCHEMA_VERSION),
  id: agentIdSchema,
  displayName: z.string().trim().min(1),
  description: z.string().trim().min(1),
  profileId: agentIdSchema,
  invocation: invocationMetadataSchema
}).strict();

export const projectCapabilityEvidenceSourceSchema = z.enum([
  'active-project-runtime',
  'project-config',
  'project-manifest',
  'package-project-asset'
]);

const projectRelativeReferenceSchema = z.string().trim().min(1).refine(reference => {
  if (reference.startsWith('~')) return false;
  if (path.posix.isAbsolute(reference) || path.win32.isAbsolute(reference)) return false;
  if (/^[a-zA-Z]:/.test(reference)) return false;
  return !reference.split(/[\\/]+/).includes('..');
}, 'Expected a project-relative path without home or parent traversal segments');

export const projectRootSchema = z.string().trim().min(1).refine(
  root => path.posix.isAbsolute(root) || path.win32.isAbsolute(root),
  'Expected an absolute project root path'
);

// Path references are lexical contracts. Resolve through
// resolveProjectFilesystemEvidence before treating filesystem evidence as trusted.
export const projectCapabilityEvidenceSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('active-project-runtime'),
    reference: z.string().trim().min(1)
  }).strict(),
  z.object({
    source: z.literal('project-config'),
    reference: projectRelativeReferenceSchema
  }).strict(),
  z.object({
    source: z.literal('project-manifest'),
    reference: projectRelativeReferenceSchema
  }).strict(),
  z.object({
    source: z.literal('package-project-asset'),
    reference: projectRelativeReferenceSchema
  }).strict()
]);

export const availabilityStateSchema = z.enum(['confirmed', 'absent', 'unknown']);
export const taskSuitabilitySchema = z.enum(['suitable', 'unsuitable', 'unknown']);

export const capabilityAvailabilitySchema = z.object({
  installed: availabilityStateSchema,
  configured: availabilityStateSchema,
  exposed: availabilityStateSchema,
  permitted: availabilityStateSchema,
  taskSuitability: taskSuitabilitySchema
}).strict();

export const projectCapabilityObservationSchema = z.object({
  capabilityId: agentIdSchema,
  evidence: z.array(projectCapabilityEvidenceSchema).min(1),
  availability: capabilityAvailabilitySchema
}).strict();

export const projectCapabilityInventorySchema = z.object({
  schemaVersion: z.literal(AGENT_SCHEMA_VERSION),
  projectRoot: projectRootSchema,
  observations: z.array(projectCapabilityObservationSchema)
}).strict().superRefine((inventory, context) => {
  const seen = new Set<string>();
  inventory.observations.forEach((observation, index) => {
    if (seen.has(observation.capabilityId)) {
      context.addIssue({
        code: 'custom',
        path: ['observations', index, 'capabilityId'],
        message: `Duplicate capability observation "${observation.capabilityId}"`
      });
    }
    seen.add(observation.capabilityId);
  });
});

export const SURFACE_FIDELITIES = Object.freeze([
  'exact',
  'supervised',
  'plan-only',
  'unsupported'
] as const);

export const surfaceFidelitySchema = z.enum(SURFACE_FIDELITIES);

export type InvocationMetadata = z.infer<typeof invocationMetadataSchema>;
export type AgentProfileDefinition = z.infer<typeof agentProfileDefinitionSchema>;
export type AgentCapabilityDefinition = z.infer<typeof agentCapabilityDefinitionSchema>;
export type ProjectCapabilityEvidenceSource = z.infer<typeof projectCapabilityEvidenceSourceSchema>;
export type ProjectCapabilityEvidence = z.infer<typeof projectCapabilityEvidenceSchema>;
export type AvailabilityState = z.infer<typeof availabilityStateSchema>;
export type TaskSuitability = z.infer<typeof taskSuitabilitySchema>;
export type CapabilityAvailability = z.infer<typeof capabilityAvailabilitySchema>;
export type ProjectCapabilityObservation = z.infer<typeof projectCapabilityObservationSchema>;
export type ProjectCapabilityInventory = z.infer<typeof projectCapabilityInventorySchema>;
export type SurfaceFidelity = z.infer<typeof surfaceFidelitySchema>;

/** Returns the weaker fidelity, so applying a ceiling can never upgrade support. */
export function restrictSurfaceFidelity(
  fidelity: SurfaceFidelity,
  ceiling: SurfaceFidelity
): SurfaceFidelity {
  return SURFACE_FIDELITIES[Math.max(
    SURFACE_FIDELITIES.indexOf(fidelity),
    SURFACE_FIDELITIES.indexOf(ceiling)
  )];
}
