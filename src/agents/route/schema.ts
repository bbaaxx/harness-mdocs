import { z } from 'zod';

import { canonicalizeJson } from '../contracts/canonicalize';
import {
  availabilityStateSchema,
  projectRootSchema,
  surfaceFidelitySchema
} from '../schema';

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export const canonicalStringSchema = z.string().refine(
  value => !LONE_SURROGATE.test(value),
  'String contains an invalid Unicode lone surrogate'
);

const nonemptyStringSchema = canonicalStringSchema.pipe(z.string().trim().min(1));
const routeKebabIdSchema = canonicalStringSchema.pipe(z.string().regex(
  /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
  'Expected a lowercase kebab-case identifier'
));
export const routeProjectRootSchema = canonicalStringSchema
  .refine(value => !value.includes('\0'), 'Project root contains NUL')
  .pipe(projectRootSchema);
const jsonPrimitiveSchema = z.union([
  canonicalStringSchema,
  z.number().finite(),
  z.boolean(),
  z.null()
]).superRefine((value, context) => {
  try {
    canonicalizeJson(value);
  } catch (error) {
    context.addIssue({
      code: 'custom',
      message: error instanceof Error ? error.message : 'Value is not canonical I-JSON'
    });
  }
});

export const capabilityAxisSchema = z.enum([
  'installed',
  'configured',
  'exposed',
  'permitted'
]);

const existsCheckSchema = z.object({
  type: z.literal('exists')
}).strict();

const equalsExpectationSchema = z.object({
  type: z.literal('equals'),
  value: jsonPrimitiveSchema
}).strict();

const containsExpectationSchema = z.object({
  type: z.literal('contains'),
  value: canonicalStringSchema.pipe(z.string().min(1))
}).strict();

const jsonPointerCheckSchema = z.object({
  type: z.literal('json-pointer'),
  pointer: canonicalStringSchema,
  expectation: z.discriminatedUnion('type', [
    equalsExpectationSchema,
    containsExpectationSchema
  ])
}).strict();

export function isProjectRelativeReference(reference: string): boolean {
  return reference.trim() !== '' &&
    !reference.includes('\0') &&
    !reference.startsWith('~') &&
    !reference.startsWith('/') &&
    !reference.startsWith('\\') &&
    !/^[a-zA-Z]:/.test(reference) &&
    !reference.split(/[\\/]+/).includes('..');
}

const capabilityEvidenceProbeInputSchema = z.object({
  capabilityId: routeKebabIdSchema,
  source: z.enum(['project-config', 'project-manifest', 'package-project-asset']),
  reference: nonemptyStringSchema,
  axis: capabilityAxisSchema,
  check: z.discriminatedUnion('type', [existsCheckSchema, jsonPointerCheckSchema])
}).strict();

export const capabilityEvidenceProbeSchema = capabilityEvidenceProbeInputSchema.refine(
  probe => isProjectRelativeReference(probe.reference),
  {
    path: ['reference'],
    message: 'Expected a project-relative path without home, absolute, or parent traversal syntax'
  }
);

const alwaysTaskSchema = z.object({
  type: z.literal('always')
}).strict();

const keywordsTaskSchema = z.object({
  type: z.literal('keywords'),
  any: z.array(nonemptyStringSchema).min(1)
}).strict();

function refineDefinition(
  definition: z.infer<typeof capabilityRouteDefinitionInputShapeSchema>,
  context: z.RefinementCtx
): void {
  const seen = new Set<string>();
  definition.probes.forEach((probe, index) => {
    const key = JSON.stringify(probe);
    if (seen.has(key)) {
      context.addIssue({
        code: 'custom',
        path: ['probes', index],
        message: `Duplicate capability evidence probe for "${definition.capabilityId}"`
      });
    }
    seen.add(key);
    if (probe.capabilityId !== definition.capabilityId) {
      context.addIssue({
        code: 'custom',
        path: ['probes', index, 'capabilityId'],
        message:
          `Probe capability id "${probe.capabilityId}" does not match definition ` +
          `"${definition.capabilityId}"`
      });
    }
  });
}

const capabilityRouteDefinitionInputShapeSchema = z.object({
  capabilityId: routeKebabIdSchema,
  probes: z.array(capabilityEvidenceProbeInputSchema),
  task: z.discriminatedUnion('type', [alwaysTaskSchema, keywordsTaskSchema])
}).strict();

const capabilityRouteDefinitionInputSchema = capabilityRouteDefinitionInputShapeSchema
  .superRefine(refineDefinition);

export const capabilityRouteDefinitionSchema = z.object({
  capabilityId: routeKebabIdSchema,
  probes: z.array(capabilityEvidenceProbeSchema),
  task: z.discriminatedUnion('type', [alwaysTaskSchema, keywordsTaskSchema])
}).strict().superRefine(refineDefinition);

const partialRuntimeAvailabilitySchema = z.object({
  installed: availabilityStateSchema.optional(),
  configured: availabilityStateSchema.optional(),
  exposed: availabilityStateSchema.optional(),
  permitted: availabilityStateSchema.optional()
}).strict();

export const projectRuntimeCapabilityEvidenceSchema = z.object({
  capabilityId: routeKebabIdSchema,
  projectRoot: routeProjectRootSchema,
  reference: nonemptyStringSchema.refine(value => !value.includes('\0'), 'Reference contains NUL'),
  availability: partialRuntimeAvailabilitySchema
}).strict();

export const routeRequestSchema = z.object({
  id: routeKebabIdSchema,
  objective: nonemptyStringSchema,
  requestedCapabilityIds: z.array(routeKebabIdSchema).optional(),
  fidelityRequirements: z.array(surfaceFidelitySchema).optional()
}).strict();

export type CapabilityAxis = z.infer<typeof capabilityAxisSchema>;
export type CapabilityEvidenceProbe = z.infer<typeof capabilityEvidenceProbeSchema>;
export type ProjectRuntimeCapabilityEvidence = z.infer<
  typeof projectRuntimeCapabilityEvidenceSchema
>;
export type CapabilityRouteDefinition = z.infer<typeof capabilityRouteDefinitionSchema>;
export type RouteRequest = z.infer<typeof routeRequestSchema>;

export function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function probeKey(probe: CapabilityEvidenceProbe): string {
  return [
    probe.source,
    probe.reference,
    probe.axis,
    JSON.stringify(probe.check)
  ].join('\u0000');
}

export function parseCapabilityRouteDefinitions(
  input: readonly unknown[]
): readonly CapabilityRouteDefinition[] {
  const definitions = input.map(value => {
    const result = capabilityRouteDefinitionInputSchema.safeParse(value);
    if (result.success) return result.data;
    const named = result.error.issues.find(issue =>
      issue.message.startsWith('Duplicate capability evidence probe') ||
      issue.message.startsWith('Probe capability id')
    );
    if (named !== undefined) throw new Error(named.message);
    throw result.error;
  });
  const seen = new Set<string>();
  for (const definition of definitions) {
    if (seen.has(definition.capabilityId)) {
      throw new Error(`Duplicate capability route definition "${definition.capabilityId}"`);
    }
    seen.add(definition.capabilityId);
  }

  return deepFreeze(definitions.map(definition => ({
    capabilityId: definition.capabilityId,
    probes: [...definition.probes]
      .sort((left, right) => compareText(probeKey(left), probeKey(right)))
      .map(probe => ({
        ...probe,
        check: probe.check.type === 'exists'
          ? { type: 'exists' as const }
          : { ...probe.check, expectation: { ...probe.check.expectation } }
      })),
    task: definition.task.type === 'always'
      ? { type: 'always' as const }
      : {
          type: 'keywords' as const,
          any: [...new Set(definition.task.any.map(keyword => keyword.trim().toLowerCase()))]
            .sort(compareText)
        }
  })).sort((left, right) => compareText(left.capabilityId, right.capabilityId)));
}

export function parseProjectRuntimeCapabilityEvidence(
  input: readonly unknown[] = []
): readonly ProjectRuntimeCapabilityEvidence[] {
  const evidence = input.map(value => projectRuntimeCapabilityEvidenceSchema.parse(value));
  const normalized = evidence.map(item => ({
    capabilityId: item.capabilityId,
    projectRoot: item.projectRoot.trim(),
    reference: item.reference.trim(),
    availability: Object.fromEntries(
      Object.entries(item.availability).filter(([, value]) => value !== undefined)
    ) as ProjectRuntimeCapabilityEvidence['availability']
  }));
  const key = (item: ProjectRuntimeCapabilityEvidence): string =>
    canonicalizeJson([
      item.capabilityId,
      item.projectRoot,
      item.reference,
      item.availability
    ]);
  return deepFreeze([...new Map(normalized.map(item => [key(item), item])).values()]
    .sort((left, right) => compareText(
      key(left),
      key(right)
    )));
}

export function parseRouteRequest(input: unknown): Readonly<RouteRequest> {
  const request = routeRequestSchema.parse(input);
  return deepFreeze({
    id: request.id,
    objective: request.objective.trim(),
    ...(request.requestedCapabilityIds === undefined ? {} : {
      requestedCapabilityIds: [...new Set(request.requestedCapabilityIds)].sort(compareText)
    }),
    ...(request.fidelityRequirements === undefined ? {} : {
      fidelityRequirements: [...new Set(request.fidelityRequirements)].sort(compareText)
    })
  });
}
