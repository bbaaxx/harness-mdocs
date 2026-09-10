import fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import ts from 'typescript';

import {
  buildProjectCapabilityInventory,
  canonicalizeJson,
  capabilityEvidenceProbeSchema,
  capabilityRouteDefinitionSchema,
  CapabilityAxis,
  CapabilityRouteDefinition,
  ContractEnvelope,
  computeProjectCapabilityInventoryDigest,
  createProjectReadContext,
  executionBlueprintPayloadSchema,
  ExecutionBlueprintPayload,
  parseCapabilityRouteDefinitions,
  parseContract,
  parseProjectRuntimeCapabilityEvidence,
  ProjectContextError,
  ProjectReadContext,
  projectRuntimeCapabilityEvidenceSchema,
  routeProjectRequest,
  routeRequestSchema,
  verifyContractEnvelope
} from '../../src/agents';

interface Fixture {
  readonly tempRoot: string;
  readonly projectRoot: string;
  readonly outsideRoot: string;
}

function createFixture(): Fixture {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mdocs-route-'));
  const projectRoot = path.join(tempRoot, 'project');
  const outsideRoot = path.join(tempRoot, 'home-like');
  fs.mkdirSync(projectRoot);
  fs.mkdirSync(outsideRoot);
  return { tempRoot, projectRoot, outsideRoot };
}

function writeJson(root: string, reference: string, value: unknown): void {
  const target = path.join(root, reference);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(value), 'utf8');
}

function runtimeAvailability(
  overrides: Partial<Record<CapabilityAxis, 'confirmed' | 'absent' | 'unknown'>> = {}
): Record<CapabilityAxis, 'confirmed' | 'absent' | 'unknown'> {
  return {
    installed: 'confirmed',
    configured: 'confirmed',
    exposed: 'confirmed',
    permitted: 'confirmed',
    ...overrides
  };
}

function runtimeDefinition(capabilityId = 'future-tool'): CapabilityRouteDefinition {
  return {
    capabilityId,
    probes: [],
    task: { type: 'always' }
  };
}

function payload(envelope: Readonly<ContractEnvelope>): ExecutionBlueprintPayload {
  return executionBlueprintPayloadSchema.parse(envelope.payload);
}

function routeWithRuntime(
  context: ProjectReadContext,
  availability = runtimeAvailability(),
  capabilityId = 'future-tool'
): ExecutionBlueprintPayload {
  return payload(routeProjectRequest({
    context,
    definitions: [runtimeDefinition(capabilityId)],
    request: {
      id: 'route-request',
      objective: 'Use future tool',
      requestedCapabilityIds: [capabilityId]
    },
    runtimeEvidence: [{
      capabilityId,
      projectRoot: context.projectRoot,
      reference: `adapter:${capabilityId}`,
      availability
    }]
  }));
}

function snapshotState(hex: string): ReturnType<ProjectReadContext['snapshot']> {
  return Object.freeze([Object.freeze({
    reference: 'evidence.json',
    kind: 'file' as const,
    size: 1,
    sha256: hex.repeat(64)
  })]);
}

function transactionContext(
  projectRoot: string,
  snapshots: readonly ReturnType<ProjectReadContext['snapshot']>[],
  reads: string[]
): ProjectReadContext {
  let snapshotIndex = 0;
  return Object.freeze({
    projectRoot,
    mdocsRoot: path.join(projectRoot, 'mdocs'),
    resolve: (reference: string) => {
      reads.push(`resolve:${reference}`);
      return path.join(projectRoot, reference);
    },
    exists: (reference: string) => {
      reads.push(`exists:${reference}`);
      return true;
    },
    readText: (reference: string) => {
      reads.push(`readText:${reference}`);
      return '{"enabled":true}';
    },
    readJson: (reference: string) => {
      reads.push(`readJson:${reference}`);
      return { enabled: true };
    },
    list: (reference = '.') => {
      reads.push(`list:${reference}`);
      return [];
    },
    snapshot: (reference = '.') => {
      reads.push(`snapshot:${reference}`);
      const value = snapshots[Math.min(snapshotIndex, snapshots.length - 1)];
      snapshotIndex += 1;
      return value;
    }
  });
}

function projectProbeDefinition(capabilityId = 'future-tool'): CapabilityRouteDefinition {
  return {
    capabilityId,
    probes: (['installed', 'configured', 'exposed', 'permitted'] as const).map(axis => ({
      capabilityId,
      source: 'project-config' as const,
      reference: 'evidence.json',
      axis,
      check: { type: 'exists' as const }
    })),
    task: { type: 'always' }
  };
}

function recordingContext(base: ProjectReadContext, references: string[]): ProjectReadContext {
  const record = <T extends unknown[], R>(
    method: (...args: T) => R
  ) => (...args: T): R => {
    references.push(String(args[0] ?? '.'));
    return method(...args);
  };
  return Object.freeze({
    projectRoot: base.projectRoot,
    mdocsRoot: base.mdocsRoot,
    resolve: record(base.resolve),
    exists: record(base.exists),
    readText: record(base.readText),
    readJson: record(base.readJson),
    list: record(base.list),
    snapshot: record(base.snapshot)
  });
}

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}

describe('project capability inventory and pure Route', () => {
  test('selects an injected future capability with four independent project evidence axes', () => {
    const fixture = createFixture();
    writeJson(fixture.projectRoot, 'node_modules/future-tool/package.json', { name: 'future-tool' });
    writeJson(fixture.projectRoot, '.mcp.json', {
      mcpServers: { 'future/tool': { enabled: true } }
    });
    writeJson(fixture.projectRoot, 'package.json', {
      mdocs: { capabilities: ['future-tool'] }
    });

    try {
      const context = createProjectReadContext(fixture.projectRoot);
      const definition: CapabilityRouteDefinition = {
        capabilityId: 'future-tool',
        probes: [
          {
            capabilityId: 'future-tool',
            source: 'package-project-asset',
            reference: 'node_modules/future-tool/package.json',
            axis: 'installed',
            check: { type: 'exists' }
          },
          {
            capabilityId: 'future-tool',
            source: 'project-config',
            reference: '.mcp.json',
            axis: 'configured',
            check: {
              type: 'json-pointer',
              pointer: '/mcpServers/future~1tool/enabled',
              expectation: { type: 'equals', value: true }
            }
          },
          {
            capabilityId: 'future-tool',
            source: 'project-manifest',
            reference: 'package.json',
            axis: 'exposed',
            check: {
              type: 'json-pointer',
              pointer: '/mdocs/capabilities',
              expectation: { type: 'contains', value: 'future-tool' }
            }
          }
        ],
        task: { type: 'keywords', any: ['Future'] }
      };
      const envelope = routeProjectRequest({
        context,
        definitions: [definition],
        request: {
          id: 'future-route',
          objective: 'Adopt FUTURE tooling safely',
          requestedCapabilityIds: ['future-tool'],
          fidelityRequirements: ['exact']
        },
        runtimeEvidence: [{
          capabilityId: 'future-tool',
          projectRoot: context.projectRoot,
          reference: 'adapter:current-project/future-tool',
          availability: { permitted: 'confirmed' }
        }]
      });
      const result = payload(envelope);

      expect(result.selectedRoutes.map(route => route.id)).toEqual(['future-tool']);
      expect(result.rejectedRoutes).toEqual([]);
      expect(result.capabilityObservations[0].availability).toEqual({
        installed: 'confirmed',
        configured: 'confirmed',
        exposed: 'confirmed',
        permitted: 'confirmed',
        taskSuitability: 'suitable'
      });
      expect(result.fidelityResult).toBe('exact');
      expect(result.unresolvedPreflightChecks).toEqual([]);
    } finally {
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('runtime-only capability performs no filesystem snapshot or read', () => {
    const fixture = createFixture();
    const references: string[] = [];
    writeJson(fixture.projectRoot, 'node_modules/unrelated/package.json', { churn: true });
    try {
      const base = createProjectReadContext(fixture.projectRoot, { maxEntries: 0, maxTotalBytes: 0 });
      const context = recordingContext(base, references);
      const result = payload(routeProjectRequest({
        context,
        definitions: [runtimeDefinition()],
        request: {
          id: 'runtime-only-route',
          objective: 'Use future tool',
          requestedCapabilityIds: ['future-tool']
        },
        runtimeEvidence: [{
          capabilityId: 'future-tool',
          projectRoot: context.projectRoot,
          reference: 'adapter:current-project/future-tool',
          availability: runtimeAvailability()
        }]
      }));

      expect(references).toEqual([]);
      expect(result.selectedRoutes.map(route => route.id)).toEqual(['future-tool']);
      expect(result.fidelityResult).toBe('exact');
    } finally {
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('relevant-reference snapshots ignore unrelated project and node_modules size', () => {
    const fixture = createFixture();
    writeJson(fixture.projectRoot, 'evidence.json', { enabled: true });
    writeJson(fixture.projectRoot, 'node_modules/a/package.json', { name: 'a' });
    writeJson(fixture.projectRoot, 'node_modules/b/package.json', { name: 'b' });
    try {
      const context = createProjectReadContext(fixture.projectRoot, { maxEntries: 1 });
      expect(() => context.snapshot()).toThrow(/limit exceeded/i);
      const result = payload(routeProjectRequest({
        context,
        definitions: [projectProbeDefinition()],
        request: {
          id: 'bounded-reference-route',
          objective: 'Use future tool',
          requestedCapabilityIds: ['future-tool']
        }
      }));
      expect(result.selectedRoutes.map(route => route.id)).toEqual(['future-tool']);
      expect(result.fidelityResult).toBe('exact');
    } finally {
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('missing relevant references have stable empty snapshots and definitive absence', () => {
    const fixture = createFixture();
    try {
      const result = payload(routeProjectRequest({
        context: createProjectReadContext(fixture.projectRoot),
        definitions: [projectProbeDefinition()],
        request: {
          id: 'missing-reference-route',
          objective: 'Use future tool',
          requestedCapabilityIds: ['future-tool']
        }
      }));
      expect(result.selectedRoutes).toEqual([]);
      expect(result.capabilityObservations[0].availability).toEqual({
        installed: 'absent',
        configured: 'absent',
        exposed: 'absent',
        permitted: 'absent',
        taskSuitability: 'suitable'
      });
      expect(result.unresolvedPreflightChecks).not.toContain(
        'concurrent project mutation while collecting capability inventory'
      );
      expect(result.fidelityResult).toBe('plan-only');
    } finally {
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test.each(
    (['installed', 'configured', 'exposed', 'permitted'] as CapabilityAxis[])
      .flatMap(axis => (['absent', 'unknown'] as const).map(state => ({ axis, state })))
  )('$axis=$state rejects and never selects', ({ axis, state }) => {
    const fixture = createFixture();
    try {
      const context = createProjectReadContext(fixture.projectRoot);
      const result = routeWithRuntime(context, runtimeAvailability({ [axis]: state }));
      expect(result.selectedRoutes).toEqual([]);
      expect(result.rejectedRoutes).toHaveLength(1);
      expect(result.rejectedRoutes[0].reasons).toContain(`${axis} is ${state}`);
      expect(result.unresolvedPreflightChecks).toContain(
        `route-preflight-unresolved: capability "future-tool": ${axis} is ${state}`
      );
      expect(result.fallbacks.join('\n')).toContain(`${axis} is ${state}`);
      expect(result.fidelityResult).toBe('plan-only');
    } finally {
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('inventory retries one changed snapshot and returns only stable second-attempt evidence', () => {
    const fixture = createFixture();
    const reads: string[] = [];
    try {
      const context = transactionContext(fixture.projectRoot, [
        snapshotState('a'),
        snapshotState('b'),
        snapshotState('b'),
        snapshotState('b')
      ], reads);
      const result = payload(routeProjectRequest({
        context,
        definitions: [projectProbeDefinition()],
        request: {
          id: 'retry-route',
          objective: 'Use future tool',
          requestedCapabilityIds: ['future-tool']
        }
      }));

      expect(reads.filter(read => read === 'snapshot:evidence.json')).toHaveLength(4);
      expect(reads.filter(read => read === 'exists:evidence.json')).toHaveLength(8);
      expect(result.selectedRoutes.map(route => route.id)).toEqual(['future-tool']);
      expect(result.unresolvedPreflightChecks).toEqual([]);
      expect(result.fidelityResult).toBe('exact');
    } finally {
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('inventory fails closed after a second changed snapshot without mixed confirmations', () => {
    const fixture = createFixture();
    const reads: string[] = [];
    try {
      const context = transactionContext(fixture.projectRoot, [
        snapshotState('a'),
        snapshotState('b'),
        snapshotState('c'),
        snapshotState('d')
      ], reads);
      const result = payload(routeProjectRequest({
        context,
        definitions: [projectProbeDefinition()],
        request: {
          id: 'mutation-route',
          objective: 'Use future tool',
          requestedCapabilityIds: ['future-tool']
        }
      }));

      expect(reads.filter(read => read === 'snapshot:evidence.json')).toHaveLength(4);
      expect(result.selectedRoutes).toEqual([]);
      expect(result.capabilityObservations[0].availability).toEqual({
        installed: 'unknown',
        configured: 'unknown',
        exposed: 'unknown',
        permitted: 'unknown',
        taskSuitability: 'suitable'
      });
      expect(result.unresolvedPreflightChecks).toContain(
        'concurrent project mutation while collecting capability inventory'
      );
      expect(result.fidelityResult).toBe('plan-only');
      expect(result.fallbacks.join('\n')).toContain(
        'concurrent project mutation while collecting capability inventory'
      );
    } finally {
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('mismatched runtime root and global-only files cannot confirm project capability', () => {
    const fixture = createFixture();
    writeJson(fixture.outsideRoot, '.config/future-tool/config.json', runtimeAvailability());
    const references: string[] = [];
    try {
      const base = createProjectReadContext(fixture.projectRoot);
      const context = recordingContext(base, references);
      const result = payload(routeProjectRequest({
        context,
        definitions: [runtimeDefinition()],
        request: {
          id: 'global-route',
          objective: 'Use future tool',
          requestedCapabilityIds: ['future-tool']
        },
        runtimeEvidence: [{
          capabilityId: 'future-tool',
          projectRoot: fs.realpathSync(fixture.outsideRoot),
          reference: 'global-adapter:future-tool',
          availability: runtimeAvailability()
        }]
      }));

      expect(result.selectedRoutes).toEqual([]);
      expect(result.rejectedRoutes[0].reasons).toEqual(expect.arrayContaining([
        'installed is unknown',
        'configured is unknown',
        'exposed is unknown',
        'permitted is unknown'
      ]));
      expect(result.unresolvedPreflightChecks.join('\n')).toMatch(/runtime-project-root-mismatch/);
      expect(references.every(reference =>
        !path.isAbsolute(reference) && !reference.startsWith('~') && !reference.includes('..')
      )).toBe(true);
      expect(references).toEqual([]);
    } finally {
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('route import graph and runtime use no direct filesystem, home, environment, or global discovery', () => {
    const fixture = createFixture();
    const outsideSentinel = path.join(fixture.outsideRoot, 'sentinel.txt');
    fs.writeFileSync(outsideSentinel, 'outside-secret', 'utf8');
    const routeRoot = path.join(__dirname, '../../src/agents/route');
    const agentsRoot = path.join(__dirname, '../../src/agents');
    const projectContextFile = fs.realpathSync(path.join(agentsRoot, 'project-context.ts'));
    const visited = new Set<string>();
    const resolveLocal = (from: string, specifier: string): string | null => {
      const base = path.resolve(path.dirname(from), specifier);
      return [base, `${base}.ts`, path.join(base, 'index.ts')]
        .find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? null;
    };
    const visit = (filename: string): void => {
      const target = fs.realpathSync(filename);
      if (visited.has(target)) return;
      visited.add(target);
      expect(target.startsWith(agentsRoot)).toBe(true);
      expect(target).not.toMatch(
        /[\\/]core[\\/](?:factory\.ts|audit\.ts|lifecycle\.ts|managers[\\/]|workflow[\\/])|[\\/](?:hooks|adapters?)[\\/]/
      );
      const sourceFile = ts.createSourceFile(
        target,
        fs.readFileSync(target, 'utf8'),
        ts.ScriptTarget.Latest,
        true
      );
      const inspect = (node: ts.Node): void => {
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier)
        ) {
          const specifier = node.moduleSpecifier.text;
          if (specifier.startsWith('.')) {
            const resolved = resolveLocal(target, specifier);
            if (resolved === null) throw new Error(`${target}: unresolved local import ${specifier}`);
            visit(resolved);
          } else {
            const builtin = specifier.replace(/^node:/, '');
            if (['fs', 'fs/promises', 'os', 'process', 'child_process'].includes(builtin)) {
              if (!(builtin === 'fs' && target === projectContextFile)) {
                throw new Error(`${target}: forbidden direct module ${specifier}`);
              }
            }
          }
        } else if (
          ts.isIdentifier(node) &&
          ['process', 'require'].includes(node.text)
        ) {
          throw new Error(`${target}: forbidden global ${node.text}`);
        } else if (
          ts.isCallExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword
        ) {
          throw new Error(`${target}: forbidden dynamic import`);
        }
        ts.forEachChild(node, inspect);
      };
      inspect(sourceFile);
    };
    visit(path.join(routeRoot, 'index.ts'));
    expect([...visited].filter(filename => filename.startsWith(routeRoot)).sort()).toEqual(
      fs.readdirSync(routeRoot)
        .filter(name => name.endsWith('.ts'))
        .map(name => fs.realpathSync(path.join(routeRoot, name)))
        .sort()
    );
    expect(visited.has(projectContextFile)).toBe(true);

    const references: string[] = [];
    const context: ProjectReadContext = Object.freeze({
      projectRoot: fixture.projectRoot,
      mdocsRoot: path.join(fixture.projectRoot, 'mdocs'),
      resolve: (reference: string) => {
        references.push(reference);
        if (path.isAbsolute(reference) || reference.startsWith('~') || reference.includes('..')) {
          throw new Error(`forbidden reference ${reference}`);
        }
        return path.join(fixture.projectRoot, reference);
      },
      exists: (reference: string) => {
        references.push(reference);
        if (path.isAbsolute(reference) || reference.startsWith('~') || reference.includes('..')) {
          throw new Error(`forbidden reference ${reference}`);
        }
        return true;
      },
      readText: (reference: string) => {
        references.push(reference);
        return '{}';
      },
      readJson: (reference: string) => {
        references.push(reference);
        return {};
      },
      list: (reference = '.') => {
        references.push(reference);
        return [];
      },
      snapshot: (reference = '.') => {
        references.push(reference);
        return [];
      }
    });
    const readFileSpy = jest.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('direct filesystem read attempted');
    });
    const actualOs = jest.requireActual<typeof import('os')>('os');
    const homeSpy = jest.spyOn(actualOs, 'homedir').mockImplementation(() => {
      throw new Error('home discovery attempted');
    });
    const originalEnv = process.env;
    process.env = new Proxy(originalEnv, {
      get: () => {
        throw new Error('environment discovery attempted');
      }
    });

    try {
      const result = payload(routeProjectRequest({
        context,
        definitions: [projectProbeDefinition()],
        request: {
          id: 'isolated-route',
          objective: 'Use future tool',
          requestedCapabilityIds: ['future-tool']
        }
      }));
      expect(result.selectedRoutes.map(route => route.id)).toEqual(['future-tool']);
      expect(references).toEqual([
        'evidence.json',
        'evidence.json',
        'evidence.json',
        'evidence.json',
        'evidence.json',
        'evidence.json'
      ]);
      expect(references.every(reference =>
        !path.isAbsolute(reference) && !reference.startsWith('~') && !reference.includes('..')
      )).toBe(true);
    } finally {
      process.env = originalEnv;
      homeSpy.mockRestore();
      readFileSpy.mockRestore();
      expect(fs.readFileSync(outsideSentinel, 'utf8')).toBe('outside-secret');
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test.each([
    '/etc/future-tool.json',
    '~/future-tool.json',
    '../future-tool.json',
    'config/..\\../future-tool.json',
    'C:\\Users\\future-tool.json'
  ])('rejects unsafe probe reference %p before any read', reference => {
    const fixture = createFixture();
    const references: string[] = [];
    try {
      const context = recordingContext(createProjectReadContext(fixture.projectRoot), references);
      const definition: CapabilityRouteDefinition = {
        capabilityId: 'future-tool',
        probes: (['installed', 'configured', 'exposed', 'permitted'] as const).map(axis => ({
          capabilityId: 'future-tool',
          source: 'project-config' as const,
          reference,
          axis,
          check: { type: 'exists' as const }
        })),
        task: { type: 'always' }
      };
      const result = payload(routeProjectRequest({
        context,
        definitions: [definition],
        request: {
          id: 'unsafe-reference',
          objective: 'Use future tool',
          requestedCapabilityIds: ['future-tool']
        }
      }));

      expect(references).toEqual([]);
      expect(result.selectedRoutes).toEqual([]);
      expect(result.unresolvedPreflightChecks.join('\n')).toContain('invalid-probe-reference');
      expect(result.fidelityResult).toBe('plan-only');
    } finally {
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('strict route schemas reject empty contains values, NULs, and lone surrogates before hashing', () => {
    const baseProbe = {
      capabilityId: 'future-tool',
      source: 'project-config' as const,
      reference: 'config.json',
      axis: 'configured' as const,
      check: {
        type: 'json-pointer' as const,
        pointer: '/enabled',
        expectation: { type: 'contains' as const, value: 'enabled' }
      }
    };
    expect(capabilityEvidenceProbeSchema.safeParse({
      ...baseProbe,
      check: { ...baseProbe.check, expectation: { type: 'contains', value: '' } }
    }).success).toBe(false);

    const lone = '\ud800';
    for (const value of [-0, 2 ** 53, NaN, Infinity, `value${lone}`]) {
      expect(capabilityEvidenceProbeSchema.safeParse({
        ...baseProbe,
        check: {
          type: 'json-pointer',
          pointer: '/enabled',
          expectation: { type: 'equals', value }
        }
      }).success).toBe(false);
    }
    const invalidInputs = [
      routeRequestSchema.safeParse({
        id: `route${lone}`,
        objective: 'objective',
        requestedCapabilityIds: ['future-tool']
      }),
      routeRequestSchema.safeParse({
        id: 'route-id',
        objective: `objective${lone}`,
        requestedCapabilityIds: ['future-tool']
      }),
      capabilityEvidenceProbeSchema.safeParse({ ...baseProbe, reference: `config${lone}.json` }),
      capabilityEvidenceProbeSchema.safeParse({
        ...baseProbe,
        check: { ...baseProbe.check, pointer: `/enabled${lone}` }
      }),
      capabilityEvidenceProbeSchema.safeParse({
        ...baseProbe,
        check: {
          ...baseProbe.check,
          expectation: { type: 'contains', value: `enabled${lone}` }
        }
      }),
      capabilityRouteDefinitionSchema.safeParse({
        capabilityId: 'future-tool',
        probes: [baseProbe],
        task: { type: 'keywords', any: [`future${lone}`] }
      }),
      projectRuntimeCapabilityEvidenceSchema.safeParse({
        capabilityId: 'future-tool',
        projectRoot: `/project${lone}`,
        reference: 'adapter:future-tool',
        availability: { installed: 'confirmed' }
      }),
      projectRuntimeCapabilityEvidenceSchema.safeParse({
        capabilityId: 'future-tool',
        projectRoot: '/project',
        reference: `adapter${lone}`,
        availability: { installed: 'confirmed' }
      }),
      projectRuntimeCapabilityEvidenceSchema.safeParse({
        capabilityId: 'future-tool',
        projectRoot: '/project\0suffix',
        reference: 'adapter:future-tool',
        availability: { installed: 'confirmed' }
      }),
      projectRuntimeCapabilityEvidenceSchema.safeParse({
        capabilityId: 'future-tool',
        projectRoot: '/project',
        reference: 'adapter\0future-tool',
        availability: { installed: 'confirmed' }
      })
    ];
    expect(invalidInputs.every(result => !result.success)).toBe(true);

    const normalizedRuntime = parseProjectRuntimeCapabilityEvidence([{
      capabilityId: 'future-tool',
      projectRoot: '/project',
      reference: 'adapter:future-tool',
      availability: { installed: 'confirmed', configured: undefined }
    }]);
    expect(normalizedRuntime[0].availability).toEqual({ installed: 'confirmed' });
    expect(Object.prototype.hasOwnProperty.call(
      normalizedRuntime[0].availability,
      'configured'
    )).toBe(false);

    const invalidRootContext = transactionContext(`/project${lone}`, [snapshotState('a')], []);
    try {
      routeProjectRequest({
        context: invalidRootContext,
        definitions: [],
        request: { id: 'route-id', objective: 'objective' }
      });
      throw new Error('Expected route project root validation failure');
    } catch (error) {
      expect((error as Error).name).toBe('ZodError');
      expect(String(error)).toContain('lone surrogate');
    }
  });

  test('malformed JSON and invalid RFC 6901 pointer remain unknown and unresolved', () => {
    const fixture = createFixture();
    fs.writeFileSync(path.join(fixture.projectRoot, 'malformed.json'), '{nope', 'utf8');
    writeJson(fixture.projectRoot, 'valid.json', { values: ['enabled'] });

    const definition = (
      capabilityId: string,
      reference: string,
      pointer: string
    ): CapabilityRouteDefinition => ({
      capabilityId,
      probes: (['installed', 'configured', 'exposed', 'permitted'] as const).map(axis => ({
        capabilityId,
        source: 'project-config' as const,
        reference,
        axis,
        check: {
          type: 'json-pointer' as const,
          pointer,
          expectation: { type: 'contains' as const, value: 'enabled' }
        }
      })),
      task: { type: 'always' }
    });

    try {
      const context = createProjectReadContext(fixture.projectRoot);
      const result = payload(routeProjectRequest({
        context,
        definitions: [
          definition('malformed-tool', 'malformed.json', '/values'),
          definition('pointer-tool', 'valid.json', '/values/~2bad')
        ],
        request: {
          id: 'invalid-json',
          objective: 'Use tools',
          requestedCapabilityIds: ['malformed-tool', 'pointer-tool']
        }
      }));

      expect(result.selectedRoutes).toEqual([]);
      expect(result.rejectedRoutes.map(route => route.id)).toEqual([
        'malformed-tool',
        'pointer-tool'
      ]);
      expect(result.capabilityObservations.every(observation =>
        observation.availability.installed === 'unknown' &&
        observation.availability.configured === 'unknown' &&
        observation.availability.exposed === 'unknown' &&
        observation.availability.permitted === 'unknown'
      )).toBe(true);
      expect(result.unresolvedPreflightChecks.join('\n')).toMatch(/malformed-project-json/);
      expect(result.unresolvedPreflightChecks.join('\n')).toMatch(/invalid-json-pointer/);
      expect(result.fidelityResult).toBe('plan-only');
    } finally {
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('JSON pointer array traversal and value expectations fail closed by value type', () => {
    const fixture = createFixture();
    writeJson(fixture.projectRoot, 'pointer-values.json', {
      items: ['enabled'],
      enabled: true,
      object: { enabled: true },
      text: 'feature enabled here'
    });
    const definition = (
      capabilityId: string,
      pointer: string,
      expectation: { type: 'equals'; value: string | boolean } |
        { type: 'contains'; value: string }
    ): CapabilityRouteDefinition => ({
      capabilityId,
      probes: (['installed', 'configured', 'exposed', 'permitted'] as const).map(axis => ({
        capabilityId,
        source: 'project-config' as const,
        reference: 'pointer-values.json',
        axis,
        check: { type: 'json-pointer' as const, pointer, expectation }
      })),
      task: { type: 'always' }
    });

    try {
      const result = payload(routeProjectRequest({
        context: createProjectReadContext(fixture.projectRoot),
        definitions: [
          definition('array-tool', '/items/0', { type: 'equals', value: 'enabled' }),
          definition('primitive-tool', '/enabled/child', { type: 'equals', value: true }),
          definition('object-tool', '/object', { type: 'equals', value: true }),
          definition('string-tool', '/text', { type: 'contains', value: 'enabled' })
        ],
        request: {
          id: 'pointer-values',
          objective: 'Use pointer tools',
          requestedCapabilityIds: [
            'array-tool',
            'primitive-tool',
            'object-tool',
            'string-tool'
          ]
        }
      }));

      expect(result.selectedRoutes.map(route => route.id)).toEqual(['array-tool', 'string-tool']);
      expect(result.rejectedRoutes.map(route => route.id)).toEqual([
        'object-tool',
        'primitive-tool'
      ]);
      expect(result.unresolvedPreflightChecks.join('\n')).toContain(
        'pointer cannot traverse a non-container value'
      );
      expect(result.unresolvedPreflightChecks.join('\n')).toContain(
        'unsupported-json-pointer-value'
      );
      expect(result.fidelityResult).toBe('plan-only');
    } finally {
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('definition, probe, runtime, request, and file creation order do not affect bytes or digest', () => {
    const fixture = createFixture();
    const references = ['a.json', 'b.json'];
    const definitions: CapabilityRouteDefinition[] = references.map((reference, index) => {
      const capabilityId = index === 0 ? 'alpha-tool' : 'beta-tool';
      return {
        capabilityId,
        probes: (['installed', 'configured'] as const).map(axis => ({
          capabilityId,
          source: 'project-config' as const,
          reference,
          axis,
          check: {
            type: 'json-pointer' as const,
            pointer: '/enabled',
            expectation: { type: 'equals' as const, value: true }
          }
        })),
        task: { type: 'always' }
      };
    });

    try {
      writeJson(fixture.projectRoot, 'a.json', { enabled: true });
      writeJson(fixture.projectRoot, 'b.json', { enabled: true });
      const context = createProjectReadContext(fixture.projectRoot);
      const runtime = definitions.map(definition => ({
        capabilityId: definition.capabilityId,
        projectRoot: context.projectRoot,
        reference: `adapter:${definition.capabilityId}`,
        availability: { exposed: 'confirmed' as const, permitted: 'confirmed' as const }
      }));
      const first = routeProjectRequest({
        context,
        definitions,
        request: {
          id: 'deterministic-route',
          objective: 'Use both tools',
          requestedCapabilityIds: ['beta-tool', 'alpha-tool', 'beta-tool'],
          fidelityRequirements: ['plan-only', 'exact', 'exact']
        },
        runtimeEvidence: [...runtime, runtime[0]]
      });

      fs.rmSync(path.join(fixture.projectRoot, 'a.json'));
      fs.rmSync(path.join(fixture.projectRoot, 'b.json'));
      writeJson(fixture.projectRoot, 'b.json', { enabled: true });
      writeJson(fixture.projectRoot, 'a.json', { enabled: true });
      const second = routeProjectRequest({
        context,
        definitions: [...definitions].reverse().map(definition => ({
          ...definition,
          probes: [...definition.probes].reverse()
        })),
        request: {
          id: 'deterministic-route',
          objective: 'Use both tools',
          requestedCapabilityIds: ['alpha-tool', 'beta-tool'],
          fidelityRequirements: ['exact', 'plan-only']
        },
        runtimeEvidence: [...runtime].reverse()
      });

      expect(payload(first).capabilityObservations).toHaveLength(2);
      expect(payload(first).selectedRoutes.map(route => route.id)).toEqual([
        'alpha-tool',
        'beta-tool'
      ]);
      expect(canonicalizeJson(first.payload)).toBe(canonicalizeJson(second.payload));
      expect(first.digest).toBe(second.digest);
    } finally {
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('Route import and call are mutation-free on a fresh read-only project', () => {
    const fixture = createFixture();
    writeJson(fixture.projectRoot, 'package.json', { capability: true });
    const packageFile = path.join(fixture.projectRoot, 'package.json');
    const context = createProjectReadContext(fixture.projectRoot);
    fs.chmodSync(packageFile, 0o444);
    fs.chmodSync(fixture.projectRoot, 0o555);
    const before = canonicalizeJson(context.snapshot());
    let phase = 'import-time';
    const restorers: Array<() => void> = [];
    const fail = (name: string) => (): never => {
      throw new Error(`${phase} mutation attempted through ${name}`);
    };
    const install = (owner: object, method: string, label: string): void => {
      const descriptor = Object.getOwnPropertyDescriptor(owner, method);
      if (typeof (owner as Record<string, unknown>)[method] !== 'function' || descriptor?.configurable === false) return;
      const spy = jest.spyOn(owner as never, method as never).mockImplementation(fail(label) as never);
      restorers.push(() => spy.mockRestore());
    };
    const originalOpenSync = fs.openSync.bind(fs);
    const forbiddenOpenFlags = fs.constants.O_WRONLY |
      fs.constants.O_RDWR |
      fs.constants.O_CREAT |
      fs.constants.O_TRUNC |
      fs.constants.O_APPEND;
    const allowedOpenFlags = (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_DIRECTORY ?? 0);
    const openSyncSpy = jest.spyOn(fs, 'openSync').mockImplementation(((
      target: fs.PathLike,
      flags: fs.OpenMode,
      mode?: fs.Mode
    ) => {
      const readOnlyStringFlag = typeof flags === 'string' && ['r', 'rs', 'sr'].includes(flags);
      const readOnlyNumericFlag = typeof flags === 'number' &&
        (flags & forbiddenOpenFlags) === 0 &&
        (flags & ~allowedOpenFlags) === fs.constants.O_RDONLY;
      if (!readOnlyStringFlag && !readOnlyNumericFlag) {
        throw new Error(`${phase} mutation attempted through fs.openSync flags=${String(flags)}`);
      }
      return originalOpenSync(target, flags, mode);
    }) as typeof fs.openSync);
    restorers.push(() => openSyncSpy.mockRestore());
    const syncMutations = [
      'appendFileSync', 'chmodSync', 'chownSync', 'copyFileSync', 'cpSync',
      'fchmodSync', 'fchownSync', 'ftruncateSync', 'futimesSync', 'lchmodSync',
      'lchownSync', 'linkSync', 'lutimesSync', 'mkdirSync', 'mkdtempSync',
      'renameSync', 'rmSync', 'rmdirSync', 'symlinkSync', 'truncateSync',
      'unlinkSync', 'utimesSync', 'writeFileSync', 'writeSync', 'writevSync'
    ];
    const callbackMutations = [
      'appendFile', 'chmod', 'chown', 'copyFile', 'cp', 'fchmod', 'fchown',
      'ftruncate', 'futimes', 'lchmod', 'lchown', 'link', 'lutimes', 'mkdir',
      'mkdtemp', 'open', 'rename', 'rm', 'rmdir', 'symlink', 'truncate',
      'unlink', 'utimes', 'write', 'writeFile', 'writev', 'createWriteStream'
    ];
    const promiseMutations = [
      'appendFile', 'chmod', 'chown', 'copyFile', 'cp', 'lchmod', 'lchown',
      'link', 'lutimes', 'mkdir', 'mkdtemp', 'open', 'rename', 'rm', 'rmdir',
      'symlink', 'truncate', 'unlink', 'utimes', 'writeFile'
    ];
    for (const method of syncMutations) install(fs, method, `fs.${method}`);
    for (const method of callbackMutations) install(fs, method, `fs.${method}`);
    for (const method of promiseMutations) install(fs.promises, method, `fs.promises.${method}`);
    install(fs, 'WriteStream', 'new fs.WriteStream');

    try {
      let isolatedRouteProjectRequest: typeof routeProjectRequest | undefined;
      jest.resetModules();
      jest.isolateModules(() => {
        isolatedRouteProjectRequest = (
          require('../../src/agents/route') as typeof import('../../src/agents/route')
        ).routeProjectRequest;
      });
      expect(isolatedRouteProjectRequest).toBeDefined();
      phase = 'call-time';
      expect(() => fs.openSync(packageFile, fs.constants.O_WRONLY))
        .toThrow('call-time mutation attempted through fs.openSync');
      const DirectWriteStream = fs.WriteStream as unknown as new (filename: string) => fs.WriteStream;
      expect(() => new DirectWriteStream(path.join(fixture.projectRoot, 'blocked.txt')))
        .toThrow('call-time mutation attempted through new fs.WriteStream');
      const definition: CapabilityRouteDefinition = {
        capabilityId: 'read-only-tool',
        probes: (['installed', 'configured', 'exposed', 'permitted'] as const).map(axis => ({
          capabilityId: 'read-only-tool',
          source: 'project-manifest' as const,
          reference: 'package.json',
          axis,
          check: { type: 'exists' as const }
        })),
        task: { type: 'always' }
      };
      const result = payload(isolatedRouteProjectRequest!({
        context,
        definitions: [definition],
        request: {
          id: 'read-only-route',
          objective: 'Inspect read-only project',
          requestedCapabilityIds: ['read-only-tool']
        }
      }));

      expect(result.selectedRoutes.map(route => route.id)).toEqual(['read-only-tool']);
      expect(canonicalizeJson(context.snapshot())).toBe(before);
      expect(context.exists('mdocs')).toBe(false);
    } finally {
      for (const restore of restorers.reverse()) restore();
      fs.chmodSync(fixture.projectRoot, 0o755);
      fs.chmodSync(packageFile, 0o644);
      expect(fs.existsSync(path.join(fixture.projectRoot, 'mdocs'))).toBe(false);
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('blueprint validates, verifies, parses, and strict shape rejects authority fields', () => {
    const fixture = createFixture();
    try {
      const context = createProjectReadContext(fixture.projectRoot);
      const envelope = routeProjectRequest({
        context,
        definitions: [runtimeDefinition()],
        request: {
          id: 'contract-route',
          objective: 'Inspect future tool',
          requestedCapabilityIds: ['future-tool']
        },
        runtimeEvidence: [{
          capabilityId: 'future-tool',
          projectRoot: context.projectRoot,
          reference: 'adapter:future-tool',
          availability: runtimeAvailability()
        }]
      });
      const result = payload(envelope);

      expect(executionBlueprintPayloadSchema.safeParse(result).success).toBe(true);
      expect(parseContract(envelope)).toEqual({ ok: true, envelope });
      expect(verifyContractEnvelope(envelope)).toEqual({ ok: true });
      expect(result.topology).toEqual([]);
      expect(result.sideEffects).toEqual(['none: Route is read-only']);
      expect(result.approvalForecast).toEqual({
        requiresApproval: false,
        notes: ['Blueprint carries no authority and cannot approve or execute Run']
      });
      for (const field of ['approval', 'mode', 'ticket', 'handle', 'authority', 'progress']) {
        expect(executionBlueprintPayloadSchema.safeParse({ ...result, [field]: 'forged' }).success)
          .toBe(false);
      }
    } finally {
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('unrequested capability stays rejected and unknown requested id gets synthetic observation', () => {
    const fixture = createFixture();
    try {
      const context = createProjectReadContext(fixture.projectRoot);
      const result = payload(routeProjectRequest({
        context,
        definitions: [runtimeDefinition('known-tool')],
        request: {
          id: 'unknown-request',
          objective: 'Use unknown tool',
          requestedCapabilityIds: ['unknown-tool']
        },
        runtimeEvidence: [{
          capabilityId: 'known-tool',
          projectRoot: context.projectRoot,
          reference: 'adapter:known-tool',
          availability: runtimeAvailability()
        }]
      }));

      expect(result.selectedRoutes).toEqual([]);
      expect(result.rejectedRoutes.map(route => route.id)).toEqual(['known-tool', 'unknown-tool']);
      expect(result.rejectedRoutes[0].reasons).toContain('capability was not requested');
      expect(result.rejectedRoutes[0].reasons).toContain('taskSuitability is unsuitable');
      expect(result.rejectedRoutes[1].reasons).toContain('installed is unknown');
      const synthetic = result.capabilityObservations.find(
        observation => observation.capabilityId === 'unknown-tool'
      );
      expect(synthetic?.evidence).toEqual([{
        source: 'project-manifest',
        reference: 'package.json'
      }]);
      expect(result.unresolvedPreflightChecks.join('\n')).toContain(
        'unknown-requested-capability: no route definition for "unknown-tool"'
      );
      expect(result.fallbacks.join('\n')).toContain(
        'Capability "unknown-tool" is requested but unknown; inject a route definition'
      );
      expect(result.fallbacks.join('\n')).toContain('capability was not requested');
      expect(result.fidelityResult).toBe('plan-only');
    } finally {
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('requested task mismatch is rejected with accurate fallback and plan-only fidelity', () => {
    const fixture = createFixture();
    try {
      const context = createProjectReadContext(fixture.projectRoot);
      const result = payload(routeProjectRequest({
        context,
        definitions: [{
          ...runtimeDefinition(),
          task: { type: 'keywords', any: ['deploy'] }
        }],
        request: {
          id: 'unsuitable-route',
          objective: 'Only inspect configuration',
          requestedCapabilityIds: ['future-tool']
        },
        runtimeEvidence: [{
          capabilityId: 'future-tool',
          projectRoot: context.projectRoot,
          reference: 'adapter:future-tool',
          availability: runtimeAvailability()
        }]
      }));

      expect(result.selectedRoutes).toEqual([]);
      expect(result.rejectedRoutes[0].reasons).toEqual(['taskSuitability is unsuitable']);
      expect(result.unresolvedPreflightChecks).toContain(
        'route-preflight-unresolved: capability "future-tool": taskSuitability is unsuitable'
      );
      expect(result.fallbacks).toContain(
        'Capability "future-tool" rejected because taskSuitability is unsuitable; revise objective or task keywords'
      );
      expect(result.fidelityResult).toBe('plan-only');
    } finally {
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('empty analysis-only request is deterministic plan-only', () => {
    const fixture = createFixture();
    try {
      const result = payload(routeProjectRequest({
        context: createProjectReadContext(fixture.projectRoot),
        definitions: [],
        request: { id: 'analysis-route', objective: 'Analyze project only' }
      }));
      expect(result.selectedRoutes).toEqual([]);
      expect(result.rejectedRoutes).toEqual([]);
      expect(result.fidelityResult).toBe('plan-only');
      expect(result.unresolvedPreflightChecks).toEqual([
        'route-preflight-unresolved: no requested capabilities; analysis-only Route is plan-only'
      ]);
      expect(result.fallbacks).toEqual([
        'Request at least one capability; empty analysis-only Route remains plan-only'
      ]);
    } finally {
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('unrequested rejection has accurate fallback but does not downgrade selected request', () => {
    const fixture = createFixture();
    try {
      const context = createProjectReadContext(fixture.projectRoot);
      const result = payload(routeProjectRequest({
        context,
        definitions: [runtimeDefinition('requested-tool'), runtimeDefinition('other-tool')],
        request: {
          id: 'partial-request',
          objective: 'Use requested tool',
          requestedCapabilityIds: ['requested-tool']
        },
        runtimeEvidence: [
          {
            capabilityId: 'requested-tool',
            projectRoot: context.projectRoot,
            reference: 'adapter:requested-tool',
            availability: runtimeAvailability()
          },
          {
            capabilityId: 'other-tool',
            projectRoot: context.projectRoot,
            reference: 'adapter:other-tool',
            availability: runtimeAvailability()
          }
        ]
      }));

      expect(result.selectedRoutes.map(route => route.id)).toEqual(['requested-tool']);
      expect(result.rejectedRoutes.map(route => route.id)).toEqual(['other-tool']);
      expect(result.fallbacks.join('\n')).toContain('capability was not requested');
      expect(result.fallbacks.join('\n')).not.toContain('project-scoped evidence');
      expect(result.unresolvedPreflightChecks).toEqual([]);
      expect(result.fidelityResult).toBe('exact');
    } finally {
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test.each(['symlink-escape', 'limit-exceeded', 'concurrent-mutation'] as const)(
    'context %s fails closed with no selected capability',
    failure => {
      const fixture = createFixture();
      writeJson(fixture.outsideRoot, 'outside.json', { enabled: true });
      writeJson(fixture.projectRoot, 'evidence.json', { enabled: true, padding: 'xxxxxxxx' });
      if (failure === 'symlink-escape') {
        fs.symlinkSync(
          path.join(fixture.outsideRoot, 'outside.json'),
          path.join(fixture.projectRoot, 'escape.json')
        );
      }

      try {
        const base = createProjectReadContext(
          fixture.projectRoot,
          failure === 'limit-exceeded' ? { maxFileBytes: 1 } : {}
        );
        const reference = failure === 'symlink-escape' ? 'escape.json' : 'evidence.json';
        const context: ProjectReadContext = failure === 'concurrent-mutation'
          ? Object.freeze({
              ...base,
              readText: (current: string): string | null => {
                throw new ProjectContextError('concurrent-mutation', current);
              }
            })
          : base;
        const definition: CapabilityRouteDefinition = {
          capabilityId: 'unsafe-tool',
          probes: (['installed', 'configured', 'exposed', 'permitted'] as const).map(axis => ({
            capabilityId: 'unsafe-tool',
            source: 'project-config' as const,
            reference,
            axis,
            check: {
              type: 'json-pointer' as const,
              pointer: '/enabled',
              expectation: { type: 'equals' as const, value: true }
            }
          })),
          task: { type: 'always' }
        };
        const result = payload(routeProjectRequest({
          context,
          definitions: [definition],
          request: {
            id: 'context-failure',
            objective: 'Use unsafe tool',
            requestedCapabilityIds: ['unsafe-tool']
          }
        }));

        expect(result.selectedRoutes).toEqual([]);
        expect(result.rejectedRoutes[0].reasons).toEqual(expect.arrayContaining([
          'installed is unknown',
          'configured is unknown',
          'exposed is unknown',
          'permitted is unknown'
        ]));
        expect(result.unresolvedPreflightChecks.join('\n')).toContain(
          `project-context-${failure}`
        );
        expect(result.fidelityResult).toBe('plan-only');
      } finally {
        fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
      }
    }
  );

  test('duplicate definitions and probes fail with named errors', () => {
    const definition = runtimeDefinition();
    expect(() => parseCapabilityRouteDefinitions([definition, definition]))
      .toThrow('Duplicate capability route definition "future-tool"');

    const probe = {
      capabilityId: 'future-tool',
      source: 'project-config' as const,
      reference: 'package.json',
      axis: 'installed' as const,
      check: { type: 'exists' as const }
    };
    expect(() => parseCapabilityRouteDefinitions([{
      capabilityId: 'future-tool',
      probes: [probe, probe],
      task: { type: 'always' }
    }])).toThrow('Duplicate capability evidence probe for "future-tool"');
    expect(capabilityEvidenceProbeSchema.safeParse({
      ...probe,
      reference: '../global/package.json'
    }).success).toBe(false);
  });

  test('conflicting evidence stays unknown and returned inventory and envelope are deeply frozen', () => {
    const fixture = createFixture();
    writeJson(fixture.projectRoot, 'package.json', {});
    try {
      const context = createProjectReadContext(fixture.projectRoot);
      const definitions: CapabilityRouteDefinition[] = ['frozen-tool', 'stable-tool'].map(capabilityId => ({
        capabilityId,
        probes: (['installed', 'configured', 'exposed', 'permitted'] as const).map(axis => ({
          capabilityId,
          source: 'project-manifest' as const,
          reference: 'package.json',
          axis,
          check: { type: 'exists' as const }
        })),
        task: { type: 'always' }
      }));
      const request = {
        id: 'frozen-route',
        objective: 'Use frozen and stable tools',
        requestedCapabilityIds: ['frozen-tool', 'stable-tool']
      };
      const runtime = [
        {
          capabilityId: 'frozen-tool',
          projectRoot: context.projectRoot,
          reference: 'adapter:frozen-tool',
          availability: { installed: 'absent' as const }
        },
        {
          capabilityId: 'stable-tool',
          projectRoot: context.projectRoot,
          reference: 'adapter:stable-tool',
          availability: { installed: 'confirmed' as const }
        }
      ];
      const inventoryResult = buildProjectCapabilityInventory(context, definitions, request, runtime);
      const reorderedInventory = {
        ...inventoryResult.inventory,
        observations: [...inventoryResult.inventory.observations].reverse().map(observation => ({
          ...observation,
          evidence: [...observation.evidence].reverse()
        }))
      };
      const normalizedReorderedResult = buildProjectCapabilityInventory(
        context,
        [...definitions].reverse().map(definition => ({
          ...definition,
          probes: [...definition.probes].reverse()
        })),
        request,
        [...runtime].reverse()
      );
      const envelope = routeProjectRequest({
        context,
        definitions,
        request,
        runtimeEvidence: runtime
      });

      expect(inventoryResult.inventory.observations).toHaveLength(2);
      expect(inventoryResult.inventory.observations.every(
        observation => observation.evidence.length >= 2
      )).toBe(true);
      expect(inventoryResult.inventory.observations.find(
        observation => observation.capabilityId === 'frozen-tool'
      )?.availability.installed).toBe('unknown');
      expect(inventoryResult.diagnostics.join('\n')).toContain('conflicting-evidence');
      expect(canonicalizeJson(normalizedReorderedResult.inventory))
        .toBe(canonicalizeJson(inventoryResult.inventory));
      expect(computeProjectCapabilityInventoryDigest(reorderedInventory))
        .toBe(computeProjectCapabilityInventoryDigest(inventoryResult.inventory));
      expectDeepFrozen(inventoryResult);
      expectDeepFrozen(envelope);
    } finally {
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });
});
