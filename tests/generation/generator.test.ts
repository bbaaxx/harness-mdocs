import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  checkGeneratedAssets,
  generateAssets,
  GenerationDefinition,
  GenerationInterruptionError,
  GenerationSafetyError
} from '../../src/generation/generator';
import { AGENT_ASSET_GENERATION } from '../../src/generation/manifest';

const REPO_ROOT = path.resolve(__dirname, '../..');

function digest(value: Buffer | string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonical(value[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function rehashJournal(journal: any): any {
  const { journalDigest: _digest, ...payload } = journal;
  return { ...payload, journalDigest: digest(canonical(payload)) };
}

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdocs-generation-'));
  fs.mkdirSync(path.join(root, 'sources'));
  fs.mkdirSync(path.join(root, 'generated'));
  fs.writeFileSync(path.join(root, 'sources', 'alpha.txt'), 'alpha\n');
  fs.writeFileSync(path.join(root, 'sources', 'beta.txt'), 'beta\n');
  return root;
}

function asset(ownershipId: string, outputPath: string, sourceIds: string[]) {
  return { ownershipId, outputPath, sourceIds };
}

function definition(overrides: Partial<GenerationDefinition> = {}): GenerationDefinition {
  const outputs = overrides.outputs ?? [
    asset('asset.alpha', 'generated/alpha.txt', ['source.alpha']),
    asset('asset.combined', 'generated/combined.txt', ['source.alpha', 'source.beta'])
  ];
  return {
    schemaVersion: 2,
    generatorVersion: '2.0.0',
    manifestPath: 'generated/manifest.json',
    managedRoots: ['generated'],
    ownership: overrides.ownership ?? {
      namespace: 'test.agent-assets',
      outputs: outputs.map(output => ({ id: output.ownershipId, paths: [output.outputPath] }))
    },
    sources: [
      { id: 'source.alpha', path: 'sources/alpha.txt' },
      { id: 'source.beta', path: 'sources/beta.txt' }
    ],
    outputs,
    ...overrides
  };
}

function readManifest(root: string): any {
  return JSON.parse(fs.readFileSync(path.join(root, 'generated', 'manifest.json'), 'utf8'));
}

interface TreeEntry {
  path: string;
  type: string;
  size: bigint;
  mtime: bigint;
  mode: bigint;
  contentDigest?: string;
}

function treeSnapshot(root: string): TreeEntry[] {
  const visit = (directory: string): TreeEntry[] => fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    .flatMap(entry => {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      const stat = fs.lstatSync(absolute, { bigint: true });
      const type = entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file';
      const current: TreeEntry = {
        path: relative,
        type,
        size: stat.size,
        mtime: stat.mtimeNs,
        mode: stat.mode & 0o777n
      };
      if (type === 'file') current.contentDigest = digest(fs.readFileSync(absolute));
      if (type === 'symlink') current.contentDigest = digest(fs.readlinkSync(absolute));
      return entry.isDirectory() ? [current, ...visit(absolute)] : [current];
    });
  return visit(root);
}

function structuralSnapshot(root: string): Array<Omit<TreeEntry, 'mtime'>> {
  return treeSnapshot(root).map(({ mtime: _mtime, ...entry }) => entry);
}

function managedSnapshot(root: string): TreeEntry[] {
  return treeSnapshot(path.join(root, 'generated'));
}

describe('deterministic agent asset generator', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  test('production projections are code-owned and clean', () => {
    expect(checkGeneratedAssets(REPO_ROOT, AGENT_ASSET_GENERATION)).toEqual({
      clean: true,
      missing: [],
      byteDrifted: [],
      provenanceDrifted: [],
      stale: [],
      pendingTransaction: []
    });
    const production = JSON.parse(fs.readFileSync(
      path.join(REPO_ROOT, AGENT_ASSET_GENERATION.manifestPath),
      'utf8'
    ));
    expect(production).toMatchObject({
      schemaVersion: 2,
      generatorVersion: '2.0.0',
      ownershipNamespace: 'harness-mdocs.agent-assets'
    });
    expect(production.outputs).toHaveLength(AGENT_ASSET_GENERATION.outputs.length);
    expect(production.outputs.every((record: any) =>
      record.schemaVersion === 2 && record.generatorVersion === '2.0.0' &&
      typeof record.ownershipId === 'string' && /^sha256:[0-9a-f]{64}$/.test(record.byteDigest) &&
      /^sha256:[0-9a-f]{64}$/.test(record.provenanceDigest)
    )).toBe(true);
  });

  test('malformed generator version fails before mutation', () => {
    const root = tempRoot();
    roots.push(root);
    const before = treeSnapshot(root);
    expect(() => generateAssets(root, definition({ generatorVersion: '2' })))
      .toThrow('Invalid generator version');
    expect(treeSnapshot(root)).toEqual(before);
  });

  test('invalid definition shapes fail closed before mutation', () => {
    const root = tempRoot();
    roots.push(root);
    const base = definition();
    const invalidDefinitions: GenerationDefinition[] = [
      { ...base, schemaVersion: 1 as any },
      { ...base, managedRoots: [] },
      { ...base, managedRoots: ['generated', 'Generated'] },
      { ...base, manifestPath: 'outside/manifest.json' },
      { ...base, manifestPath: '.mdocs-generation/journal.json' },
      { ...base, ownership: { ...base.ownership, namespace: 'Not Stable' } },
      {
        ...base,
        ownership: {
          namespace: base.ownership.namespace,
          outputs: [base.ownership.outputs[0], base.ownership.outputs[0]]
        }
      },
      {
        ...base,
        ownership: {
          namespace: base.ownership.namespace,
          outputs: [{ id: 'asset.empty', paths: [] }]
        }
      },
      {
        ...base,
        ownership: {
          namespace: base.ownership.namespace,
          outputs: [
            ...base.ownership.outputs,
            { id: 'asset.duplicate-path', paths: ['generated/alpha.txt'] }
          ]
        }
      },
      {
        ...base,
        ownership: {
          namespace: base.ownership.namespace,
          outputs: [{ id: 'Bad Id', paths: ['generated/alpha.txt'] }]
        }
      },
      {
        ...base,
        sources: [...base.sources, { id: 'source.alpha', path: 'sources/other.txt' }]
      },
      {
        ...base,
        sources: [
          { id: 'Bad Id', path: 'sources/alpha.txt' },
          base.sources[1]
        ]
      },
      {
        ...base,
        sources: [
          base.sources[0],
          { id: 'source.other', path: 'sources/alpha.txt' }
        ]
      },
      {
        ...base,
        sources: [
          { id: 'source.alpha', path: 'generated/source.txt' },
          base.sources[1]
        ]
      },
      {
        ...base,
        outputs: [asset('asset.alpha', 'generated/alpha.txt', [])]
      },
      {
        ...base,
        outputs: [asset('asset.alpha', 'generated/alpha.txt', ['source.alpha', 'source.alpha'])]
      },
      {
        ...base,
        outputs: [asset('Bad Id', 'generated/alpha.txt', ['source.alpha', 'source.beta'])]
      },
      {
        ...base,
        outputs: [asset('asset.alpha', 'generated/alpha.txt', ['source.unknown'])]
      }
    ];
    const before = treeSnapshot(root);
    for (const invalid of invalidDefinitions) {
      expect(() => generateAssets(root, invalid)).toThrow(GenerationSafetyError);
    }
    expect(treeSnapshot(root)).toEqual(before);
  });

  test('generation before and after cwd change is byte-, order-, and mtime-stable', () => {
    const firstRoot = tempRoot();
    const secondRoot = tempRoot();
    roots.push(firstRoot, secondRoot);
    const firstDefinition = definition();
    const reversed = definition({
      sources: [...firstDefinition.sources].reverse(),
      outputs: [...firstDefinition.outputs].reverse(),
      ownership: {
        ...firstDefinition.ownership,
        outputs: [...firstDefinition.ownership.outputs].reverse()
      }
    });

    generateAssets(firstRoot, firstDefinition);
    const previousCwd = process.cwd();
    process.chdir(os.tmpdir());
    try {
      generateAssets(secondRoot, reversed);
    } finally {
      process.chdir(previousCwd);
    }

    expect(fs.readFileSync(path.join(firstRoot, 'generated', 'combined.txt'), 'utf8'))
      .toBe('alpha\nbeta\n');
    expect(fs.readFileSync(path.join(firstRoot, 'generated', 'manifest.json')))
      .toEqual(fs.readFileSync(path.join(secondRoot, 'generated', 'manifest.json')));
    const before = treeSnapshot(firstRoot);
    const repeated = generateAssets(firstRoot, firstDefinition);
    expect(repeated).toMatchObject({
      written: [], deleted: [], renamed: [], recoveredTransaction: false, consistency: 'journaled'
    });
    expect(treeSnapshot(firstRoot)).toEqual(before);
  });

  test('check reports all drift classes in deterministic order without mutation', () => {
    const root = tempRoot();
    roots.push(root);
    const fullOutputs = [
      ...definition().outputs,
      asset('asset.stale', 'generated/z-stale.txt', ['source.beta'])
    ];
    const ownership = {
      namespace: 'test.agent-assets',
      outputs: fullOutputs.map(output => ({ id: output.ownershipId, paths: [output.outputPath] }))
    };
    generateAssets(root, definition({ outputs: fullOutputs, ownership }));
    fs.unlinkSync(path.join(root, 'generated', 'combined.txt'));
    fs.writeFileSync(path.join(root, 'generated', 'alpha.txt'), 'drift\n');
    const changed = definition({
      sources: [
        { id: 'source.renamed', path: 'sources/alpha.txt' },
        { id: 'source.beta', path: 'sources/beta.txt' }
      ],
      outputs: [
        asset('asset.combined', 'generated/combined.txt', ['source.renamed', 'source.beta']),
        asset('asset.alpha', 'generated/alpha.txt', ['source.renamed'])
      ],
      ownership
    });
    const before = treeSnapshot(root);
    expect(checkGeneratedAssets(root, changed)).toEqual({
      clean: false,
      missing: ['generated/combined.txt'],
      byteDrifted: ['generated/alpha.txt'],
      provenanceDrifted: ['generated/alpha.txt', 'generated/combined.txt'],
      stale: ['generated/z-stale.txt'],
      pendingTransaction: []
    });
    expect(treeSnapshot(root)).toEqual(before);
  });

  test.each([
    'generated/file:stream',
    'generated/CON',
    'generated/prn.txt',
    'generated/CON .txt',
    'generated/AUX.config',
    'generated/nul',
    'generated/COM1.md',
    'generated/COM¹',
    'generated/com².txt',
    'generated/Com³.config',
    'generated/lpt9.json',
    'generated/LPT¹',
    'generated/lpt².txt',
    'generated/Lpt³.config',
    'generated/trailing.',
    'generated/trailing ',
    '.mdocs-generation/escape.txt',
    `generated/e\u0301.txt`,
    'generated/../victim.txt',
    '/tmp/victim.txt',
    'C:\\victim.txt'
  ])('portable unsafe path is rejected before mutation: %s', unsafePath => {
    const root = tempRoot();
    roots.push(root);
    const victim = path.join(path.dirname(root), 'victim.txt');
    fs.writeFileSync(victim, 'victim\n');
    try {
      const output = asset('asset.unsafe', unsafePath, ['source.alpha', 'source.beta']);
      const invalid = definition({
        outputs: [output],
        ownership: {
          namespace: 'test.agent-assets',
          outputs: [{ id: output.ownershipId, paths: [unsafePath] }]
        }
      });
      const before = treeSnapshot(root);
      expect(() => checkGeneratedAssets(root, invalid)).toThrow(GenerationSafetyError);
      expect(() => generateAssets(root, invalid)).toThrow(GenerationSafetyError);
      expect(treeSnapshot(root)).toEqual(before);
      expect(fs.readFileSync(victim, 'utf8')).toBe('victim\n');
    } finally {
      fs.rmSync(victim, { force: true });
    }
  });

  test('managed-root containment is exact-case while portable folding only detects collisions', () => {
    const root = tempRoot();
    roots.push(root);
    const output = asset('asset.case-root', 'Generated/file.txt', ['source.alpha', 'source.beta']);
    const invalid = definition({
      manifestPath: 'generated/manifest.json',
      managedRoots: ['generated'],
      outputs: [output],
      ownership: {
        namespace: 'test.agent-assets',
        outputs: [{ id: output.ownershipId, paths: [output.outputPath] }]
      }
    });
    expect(() => generateAssets(root, invalid)).toThrow('Owned path is outside managed roots');
  });

  test('output and sidecar ancestor, descendant, and portable-fold collisions are rejected', () => {
    const root = tempRoot();
    roots.push(root);
    const cases: GenerationDefinition[] = [
      definition({
        outputs: [
          asset('asset.parent', 'generated/parent', ['source.alpha']),
          asset('asset.child', 'generated/parent/child', ['source.beta'])
        ]
      }),
      definition({
        manifestPath: 'generated/meta',
        outputs: [asset('asset.child', 'generated/meta/child', ['source.alpha', 'source.beta'])]
      }),
      definition({
        outputs: [
          asset('asset.upper', 'generated/Asset.txt', ['source.alpha']),
          asset('asset.lower', 'generated/asset.txt', ['source.beta'])
        ]
      }),
      definition({
        outputs: [
          asset('asset.parent', 'generated/a', ['source.alpha']),
          asset('asset.intervening', 'generated/a-b', ['source.beta']),
          asset('asset.child', 'generated/a/z', ['source.alpha', 'source.beta'])
        ]
      }),
      definition({
        outputs: [asset('asset.child', 'generated/parent/child', ['source.alpha', 'source.beta'])],
        ownership: {
          namespace: 'test.agent-assets',
          outputs: [
            { id: 'asset.parent', paths: ['generated/parent'] },
            { id: 'asset.child', paths: ['generated/parent/child'] }
          ]
        }
      })
    ];
    const before = treeSnapshot(root);
    for (const invalid of cases) expect(() => generateAssets(root, invalid)).toThrow(GenerationSafetyError);
    expect(treeSnapshot(root)).toEqual(before);
  });

  test('unused source definitions fail before mutation on first and later invocation', () => {
    const root = tempRoot();
    roots.push(root);
    const valid = definition();
    const unused = definition({
      sources: [...valid.sources, { id: 'source.unused', path: 'sources/unused.txt' }]
    });
    const initial = treeSnapshot(root);
    expect(() => generateAssets(root, unused)).toThrow('Unused canonical sources: source.unused');
    expect(treeSnapshot(root)).toEqual(initial);
    generateAssets(root, valid);
    const generated = treeSnapshot(root);
    expect(() => checkGeneratedAssets(root, unused)).toThrow('Unused canonical sources: source.unused');
    expect(() => generateAssets(root, unused)).toThrow('Unused canonical sources: source.unused');
    expect(treeSnapshot(root)).toEqual(generated);
  });

  test('code-owned tombstone deletes exact stale bytes while unowned and modified files survive', () => {
    const root = tempRoot();
    roots.push(root);
    const stale = asset('asset.stale', 'generated/stale.txt', ['source.beta']);
    const fullOutputs = [...definition().outputs, stale];
    const ownership = {
      namespace: 'test.agent-assets',
      outputs: fullOutputs.map(output => ({ id: output.ownershipId, paths: [output.outputPath] }))
    };
    generateAssets(root, definition({ outputs: fullOutputs, ownership }));
    fs.writeFileSync(path.join(root, 'generated', 'user.txt'), 'keep\n');
    const reduced = definition({ ownership });
    expect(generateAssets(root, reduced).deleted).toEqual(['generated/stale.txt']);
    expect(fs.readFileSync(path.join(root, 'generated', 'user.txt'), 'utf8')).toBe('keep\n');

    generateAssets(root, definition({ outputs: fullOutputs, ownership }));
    fs.writeFileSync(path.join(root, 'generated', 'stale.txt'), 'replacement\n');
    expect(() => generateAssets(root, reduced)).toThrow('Refusing to delete modified stale output');
    expect(fs.readFileSync(path.join(root, 'generated', 'stale.txt'), 'utf8')).toBe('replacement\n');
  });

  test('self-consistent forged manifest cannot introduce a deletable in-root victim', () => {
    const root = tempRoot();
    roots.push(root);
    const current = definition();
    generateAssets(root, current);
    const victimPath = path.join(root, 'generated', 'victim.txt');
    fs.writeFileSync(victimPath, 'victim\n');
    const forged = readManifest(root);
    const source = forged.sources.find((entry: any) => entry.id === 'source.alpha');
    const base = {
      schemaVersion: 2,
      generatorVersion: '2.0.0',
      ownershipId: 'asset.forged-victim',
      outputPath: 'generated/victim.txt',
      sourceIds: ['source.alpha'],
      byteDigest: digest('victim\n')
    };
    forged.outputs.push({
      ...base,
      provenanceDigest: digest(canonical({ ...base, sources: [source] }))
    });
    const { manifestDigest: _old, ...payload } = forged;
    forged.manifestDigest = digest(canonical(payload));
    fs.writeFileSync(
      path.join(root, 'generated', 'manifest.json'),
      `${JSON.stringify(forged, null, 2)}\n`
    );

    expect(() => generateAssets(root, current)).toThrow('Manifest path is not code-owned');
    expect(fs.readFileSync(victimPath, 'utf8')).toBe('victim\n');
  });

  test('malformed manifest variants fail closed without mutating managed files', () => {
    const root = tempRoot();
    roots.push(root);
    const current = definition();
    generateAssets(root, current);
    const manifestPath = path.join(root, 'generated', 'manifest.json');
    const canonicalManifest = fs.readFileSync(manifestPath);
    const variants: Array<(manifest: any) => unknown> = [
      () => null,
      () => [],
      manifest => ({ ...manifest, schemaVersion: 1 }),
      manifest => ({ ...manifest, ownershipNamespace: 'other.namespace' }),
      manifest => ({ ...manifest, provenanceAlgorithm: 'other' }),
      manifest => ({ ...manifest, generatorVersion: 2 }),
      manifest => ({ ...manifest, sources: null }),
      manifest => ({ ...manifest, outputs: null }),
      manifest => ({ ...manifest, manifestDigest: 'bad' }),
      manifest => ({ ...manifest, sources: [null, ...manifest.sources.slice(1)] }),
      manifest => ({ ...manifest, sources: [7, ...manifest.sources.slice(1)] }),
      manifest => ({ ...manifest, sources: [{ ...manifest.sources[0], id: 'Bad Id' }, ...manifest.sources.slice(1)] }),
      manifest => ({ ...manifest, sources: [{ ...manifest.sources[0], path: 7 }, ...manifest.sources.slice(1)] }),
      manifest => ({ ...manifest, sources: [{ ...manifest.sources[0], byteDigest: 'bad' }, ...manifest.sources.slice(1)] }),
      manifest => ({ ...manifest, sources: [{ ...manifest.sources[0], path: 'generated/source.txt' }, ...manifest.sources.slice(1)] }),
      manifest => ({ ...manifest, sources: [{ ...manifest.sources[0], path: '.mdocs-generation-bootstrap.json' }, ...manifest.sources.slice(1)] }),
      manifest => ({
        ...manifest,
        sources: [...manifest.sources, { ...manifest.sources[0], path: 'sources/duplicate.txt' }]
      }),
      manifest => ({ ...manifest, outputs: [null, ...manifest.outputs.slice(1)] }),
      manifest => ({ ...manifest, outputs: [7, ...manifest.outputs.slice(1)] }),
      manifest => ({ ...manifest, outputs: [{ ...manifest.outputs[0], schemaVersion: 1 }, ...manifest.outputs.slice(1)] }),
      manifest => ({ ...manifest, outputs: [{ ...manifest.outputs[0], generatorVersion: '1.0.0' }, ...manifest.outputs.slice(1)] }),
      manifest => ({ ...manifest, outputs: [{ ...manifest.outputs[0], ownershipId: 'Bad Id' }, ...manifest.outputs.slice(1)] }),
      manifest => ({ ...manifest, outputs: [{ ...manifest.outputs[0], outputPath: 7 }, ...manifest.outputs.slice(1)] }),
      manifest => ({ ...manifest, outputs: [{ ...manifest.outputs[0], sourceIds: null }, ...manifest.outputs.slice(1)] }),
      manifest => ({ ...manifest, outputs: [{ ...manifest.outputs[0], sourceIds: [7] }, ...manifest.outputs.slice(1)] }),
      manifest => ({ ...manifest, outputs: [{ ...manifest.outputs[0], byteDigest: 'bad' }, ...manifest.outputs.slice(1)] }),
      manifest => ({ ...manifest, outputs: [{ ...manifest.outputs[0], provenanceDigest: 'bad' }, ...manifest.outputs.slice(1)] }),
      manifest => ({ ...manifest, outputs: [{ ...manifest.outputs[0], outputPath: 'generated/unowned.txt' }, ...manifest.outputs.slice(1)] }),
      manifest => ({ ...manifest, outputs: [{ ...manifest.outputs[0], sourceIds: ['source.alpha', 'source.alpha'] }, ...manifest.outputs.slice(1)] }),
      manifest => ({ ...manifest, outputs: [{ ...manifest.outputs[0], sourceIds: ['source.unknown'] }, ...manifest.outputs.slice(1)] }),
      manifest => ({ ...manifest, outputs: [...manifest.outputs, { ...manifest.outputs[0] }] }),
      manifest => ({
        ...manifest,
        sources: [...manifest.sources, {
          id: 'source.unused',
          path: 'sources/unused.txt',
          byteDigest: digest('unused\n')
        }]
      }),
      manifest => ({ ...manifest, outputs: [{ ...manifest.outputs[0], outputPath: '.mdocs-generation-bootstrap.json' }, ...manifest.outputs.slice(1)] })
    ];
    const before = structuralSnapshot(root);

    fs.writeFileSync(manifestPath, '{');
    expect(() => checkGeneratedAssets(root, current)).toThrow('manifest is not valid JSON');
    for (const variant of variants) {
      const manifest = variant(JSON.parse(canonicalManifest.toString('utf8')));
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      expect(() => checkGeneratedAssets(root, current)).toThrow(GenerationSafetyError);
    }
    fs.writeFileSync(manifestPath, canonicalManifest);
    expect(structuralSnapshot(root)).toEqual(before);
  });

  test('case-only rename follows ownership identity and is never stale', () => {
    const root = tempRoot();
    roots.push(root);
    const sources = [{ id: 'source.alpha', path: 'sources/alpha.txt' }];
    const ownership = {
      namespace: 'test.agent-assets',
      outputs: [{
        id: 'asset.case',
        paths: ['generated/Asset.txt', 'generated/asset.txt']
      }]
    };
    const oldDefinition = definition({
      sources,
      outputs: [asset('asset.case', 'generated/Asset.txt', ['source.alpha'])],
      ownership
    });
    const newDefinition = definition({
      sources,
      outputs: [asset('asset.case', 'generated/asset.txt', ['source.alpha'])],
      ownership
    });
    generateAssets(root, oldDefinition);
    expect(checkGeneratedAssets(root, newDefinition).stale).toEqual([]);
    const result = generateAssets(root, newDefinition);
    expect(result.renamed).toEqual([{ from: 'generated/Asset.txt', to: 'generated/asset.txt' }]);
    expect(fs.readdirSync(path.join(root, 'generated'))).toContain('asset.txt');
    expect(fs.readdirSync(path.join(root, 'generated'))).not.toContain('Asset.txt');
    expect(checkGeneratedAssets(root, newDefinition).clean).toBe(true);
  });

  test('case-only rename rejects distinct hard-linked directory entries for the same inode', () => {
    const root = tempRoot();
    roots.push(root);
    const ownership = {
      namespace: 'test.agent-assets',
      outputs: [{ id: 'asset.case', paths: ['generated/Asset.txt', 'generated/asset.txt'] }]
    };
    const oldDefinition = definition({
      sources: [{ id: 'source.alpha', path: 'sources/alpha.txt' }],
      outputs: [asset('asset.case', 'generated/Asset.txt', ['source.alpha'])],
      ownership
    });
    const newDefinition = definition({
      sources: [{ id: 'source.alpha', path: 'sources/alpha.txt' }],
      outputs: [asset('asset.case', 'generated/asset.txt', ['source.alpha'])],
      ownership
    });
    generateAssets(root, oldDefinition);
    try {
      fs.linkSync(path.join(root, 'generated', 'Asset.txt'), path.join(root, 'generated', 'asset.txt'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      expect(fs.readdirSync(path.join(root, 'generated')).filter(entry => entry.toLowerCase() === 'asset.txt'))
        .toHaveLength(1);
      return;
    }

    expect(() => generateAssets(root, newDefinition)).toThrow('Case-only rename target already exists');
    expect(fs.existsSync(path.join(root, '.mdocs-generation', 'journal.json'))).toBe(false);
    expect(fs.statSync(path.join(root, 'generated', 'Asset.txt'), { bigint: true }).ino)
      .toBe(fs.statSync(path.join(root, 'generated', 'asset.txt'), { bigint: true }).ino);
  });

  test('case-only move never replaces a destination created at publication', () => {
    const root = tempRoot();
    roots.push(root);
    const sources = [{ id: 'source.alpha', path: 'sources/alpha.txt' }];
    const ownership = {
      namespace: 'test.agent-assets',
      outputs: [{ id: 'asset.case', paths: ['generated/Asset.txt', 'generated/asset.txt'] }]
    };
    const oldDefinition = definition({
      sources,
      outputs: [asset('asset.case', 'generated/Asset.txt', ['source.alpha'])],
      ownership
    });
    const newDefinition = definition({
      sources,
      outputs: [asset('asset.case', 'generated/asset.txt', ['source.alpha'])],
      ownership
    });
    generateAssets(root, oldDefinition);
    const destination = path.join(root, 'generated', 'asset.txt');

    expect(() => generateAssets(root, newDefinition, {
      hooks: {
        beforeDestinationPublish(operation) {
          if (operation.path === 'generated/asset.txt') {
            fs.writeFileSync(destination, 'concurrent case owner\n');
          }
        }
      }
    })).toThrow();
    expect(fs.readFileSync(destination, 'utf8')).toBe('concurrent case owner\n');

    fs.unlinkSync(destination);
    expect(generateAssets(root, newDefinition).recoveredTransaction).toBe(true);
    expect(checkGeneratedAssets(root, newDefinition).clean).toBe(true);
  });

  test('late operation failure rolls back all managed bytes and removes journal', () => {
    const root = tempRoot();
    roots.push(root);
    const current = definition();
    generateAssets(root, current);
    const before = managedSnapshot(root);
    fs.writeFileSync(path.join(root, 'sources', 'alpha.txt'), 'changed\n');

    expect(() => generateAssets(root, current, {
      hooks: {
        beforeOperation(operation) {
          if (operation.path === 'generated/manifest.json') throw new Error('late failure');
        }
      }
    })).toThrow('late failure');
    expect(managedSnapshot(root)).toEqual(before);
    expect(checkGeneratedAssets(root, current).pendingTransaction).toEqual([]);
  });

  test('created output directories are journaled with identities and removed on rollback', () => {
    const root = tempRoot();
    roots.push(root);
    const baseline = definition();
    generateAssets(root, baseline);
    const nested = asset('asset.nested', 'generated/new/deep/file.txt', ['source.alpha']);
    const outputs = [...baseline.outputs, nested];
    const changed = definition({
      outputs,
      ownership: {
        namespace: 'test.agent-assets',
        outputs: outputs.map(output => ({ id: output.ownershipId, paths: [output.outputPath] }))
      }
    });
    const before = structuralSnapshot(root);
    let createdDirectories: any[] = [];

    expect(() => generateAssets(root, changed, {
      hooks: {
        afterOperation(operation) {
          if (operation.path !== nested.outputPath) return;
          const journal = JSON.parse(fs.readFileSync(
            path.join(root, '.mdocs-generation', 'journal.json'),
            'utf8'
          ));
          createdDirectories = journal.createdDirectories;
          throw new Error('directory rollback');
        }
      }
    })).toThrow('directory rollback');
    expect(createdDirectories).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'generated/new' }),
      expect.objectContaining({ path: 'generated/new/deep' })
    ]));
    expect(createdDirectories.every(directory =>
      /^\d+$/.test(directory.identity.dev) && /^\d+$/.test(directory.identity.ino)
    )).toBe(true);
    expect(structuralSnapshot(root)).toEqual(before);
  });

  test('generated outputs and sidecar are deterministically mode 0644 on POSIX', () => {
    const root = tempRoot();
    roots.push(root);
    const current = definition();
    let journalMode = 0;
    let stagedModes: number[] = [];
    generateAssets(root, current, {
      hooks: {
        afterJournalWritten() {
          const internal = path.join(root, '.mdocs-generation');
          journalMode = fs.statSync(path.join(internal, 'journal.json')).mode & 0o777;
          const transaction = fs.readdirSync(path.join(internal, 'transactions'))[0];
          stagedModes = fs.readdirSync(path.join(internal, 'transactions', transaction))
            .map(entry => fs.statSync(path.join(internal, 'transactions', transaction, entry)).mode & 0o777);
        }
      }
    });
    if (process.platform === 'win32') {
      // Windows normalizes away POSIX mode semantics; generation/check must not drift.
      expect(checkGeneratedAssets(root, current).clean).toBe(true);
      return;
    }
    expect(journalMode).toBe(0o600);
    expect(stagedModes.length).toBeGreaterThan(0);
    expect(stagedModes.every(mode => mode === 0o644)).toBe(true);
    for (const generated of ['alpha.txt', 'combined.txt', 'manifest.json']) {
      expect(fs.statSync(path.join(root, 'generated', generated)).mode & 0o777).toBe(0o644);
    }
    fs.chmodSync(path.join(root, 'generated', 'alpha.txt'), 0o600);
    expect(checkGeneratedAssets(root, current).byteDrifted).toContain('generated/alpha.txt');
    generateAssets(root, current);
    expect(fs.statSync(path.join(root, 'generated', 'alpha.txt')).mode & 0o777).toBe(0o644);
    fs.chmodSync(path.join(root, 'generated', 'manifest.json'), 0o600);
    expect(checkGeneratedAssets(root, current).provenanceDrifted).toContain('generated/manifest.json');
    generateAssets(root, current);
    expect(fs.statSync(path.join(root, 'generated', 'manifest.json')).mode & 0o777).toBe(0o644);
  });

  test('Windows skips unsupported directory and mode operations without perpetual drift', () => {
    const root = tempRoot();
    roots.push(root);
    const nested = asset('asset.windows', 'generated/windows/deep/file.txt', ['source.alpha']);
    const outputs = [...definition().outputs, nested];
    const current = definition({
      outputs,
      ownership: {
        namespace: 'test.agent-assets',
        outputs: outputs.map(output => ({ id: output.ownershipId, paths: [output.outputPath] }))
      }
    });
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    const fchmod = jest.spyOn(require('fs'), 'fchmodSync').mockImplementation(() => {
      throw new Error('Windows fchmod must be skipped');
    });
    try {
      generateAssets(root, current);
      fs.writeFileSync(path.join(root, 'sources', 'alpha.txt'), 'windows replacement\n');
      generateAssets(root, current);
      fs.chmodSync(path.join(root, 'generated', 'alpha.txt'), 0o600);
      expect(checkGeneratedAssets(root, current).clean).toBe(true);
      expect(fchmod).not.toHaveBeenCalled();
    } finally {
      fchmod.mockRestore();
      Object.defineProperty(process, 'platform', platform);
    }
  });

  test.each(['EINVAL', 'EPERM', 'ENOTSUP'])('%s directory durability errors are capability skips', code => {
    const root = tempRoot();
    roots.push(root);
    const nativeFs = require('fs') as typeof fs;
    const open = nativeFs.openSync;
    const openSpy = jest.spyOn(nativeFs, 'openSync').mockImplementation(((...args: any[]) => {
      if (args[0] === '.' && args[1] === fs.constants.O_RDONLY) {
        const error = new Error(`unsupported directory durability: ${code}`) as NodeJS.ErrnoException;
        error.code = code;
        throw error;
      }
      return (open as any)(...args);
    }) as typeof fs.openSync);
    try {
      expect(() => generateAssets(root, definition())).not.toThrow();
    } finally {
      openSpy.mockRestore();
    }
  });

  test('unexpected directory durability errors fail closed', () => {
    const root = tempRoot();
    roots.push(root);
    const nativeFs = require('fs') as typeof fs;
    const open = nativeFs.openSync;
    const openSpy = jest.spyOn(nativeFs, 'openSync').mockImplementation(((...args: any[]) => {
      if (args[0] === '.' && args[1] === fs.constants.O_RDONLY) {
        const error = new Error('unexpected directory durability failure') as NodeJS.ErrnoException;
        error.code = 'EIO';
        throw error;
      }
      return (open as any)(...args);
    }) as typeof fs.openSync);
    try {
      expect(() => generateAssets(root, definition())).toThrow('unexpected directory durability failure');
    } finally {
      openSpy.mockRestore();
    }
  });

  test('interrupted journal is read-only in check and recovered by next generate', () => {
    const root = tempRoot();
    roots.push(root);
    const current = definition();
    generateAssets(root, current);
    fs.writeFileSync(path.join(root, 'sources', 'alpha.txt'), 'changed\n');
    expect(() => generateAssets(root, current, {
      hooks: {
        afterOperation(operation) {
          if (operation.index === 0) throw new GenerationInterruptionError();
        }
      }
    })).toThrow(GenerationInterruptionError);
    const beforeCheck = treeSnapshot(root);
    expect(checkGeneratedAssets(root, current).pendingTransaction)
      .toEqual(['.mdocs-generation/journal.json']);
    expect(treeSnapshot(root)).toEqual(beforeCheck);

    const recovered = generateAssets(root, current);
    expect(recovered.recoveredTransaction).toBe(true);
    expect(checkGeneratedAssets(root, current).clean).toBe(true);
  });

  test('directory intent is durable before creation and recovers a pre-identity interruption', () => {
    const root = tempRoot();
    roots.push(root);
    const baseline = definition();
    generateAssets(root, baseline);
    const nested = asset('asset.intent', 'generated/intended/deep/file.txt', ['source.alpha']);
    const outputs = [...baseline.outputs, nested];
    const changed = definition({
      outputs,
      ownership: {
        namespace: 'test.agent-assets',
        outputs: outputs.map(output => ({ id: output.ownershipId, paths: [output.outputPath] }))
      }
    });

    expect(() => generateAssets(root, changed, {
      hooks: {
        afterDirectoryCreated(directory) {
          if (directory !== 'generated/intended') return;
          const journal = JSON.parse(fs.readFileSync(
            path.join(root, '.mdocs-generation', 'journal.json'),
            'utf8'
          ));
          expect(journal.createdDirectories).toContainEqual({
            path: 'generated/intended',
            phase: 'applying'
          });
          throw new GenerationInterruptionError('directory identity interruption');
        }
      }
    })).toThrow('directory identity interruption');
    expect(fs.existsSync(path.join(root, 'generated', 'intended'))).toBe(true);

    fs.unlinkSync(path.join(root, 'sources', 'alpha.txt'));
    const beforeCheck = treeSnapshot(root);
    expect(checkGeneratedAssets(root, changed)).toEqual({
      clean: false,
      missing: [],
      byteDrifted: [],
      provenanceDrifted: [],
      stale: [],
      pendingTransaction: ['.mdocs-generation/journal.json']
    });
    expect(treeSnapshot(root)).toEqual(beforeCheck);
    fs.writeFileSync(path.join(root, 'sources', 'alpha.txt'), 'alpha\n');

    const cleanupDefinition = definition({ ownership: changed.ownership });
    expect(generateAssets(root, cleanupDefinition).recoveredTransaction).toBe(true);
    expect(fs.existsSync(path.join(root, 'generated', 'intended'))).toBe(false);
    expect(checkGeneratedAssets(root, cleanupDefinition).clean).toBe(true);
  });

  test('partial staged artifact from a write failure is unlinked and never wedges rollback', () => {
    const root = tempRoot();
    roots.push(root);
    const current = definition();
    generateAssets(root, current);
    fs.writeFileSync(path.join(root, 'sources', 'alpha.txt'), 'partial-stage-target\n');
    const nativeFs = require('fs') as typeof fs;
    const realWrite = nativeFs.writeFileSync;
    const writeSpy = jest.spyOn(nativeFs, 'writeFileSync').mockImplementation(((fd: unknown, data: unknown, ...rest: unknown[]) => {
      if (typeof fd === 'number' && Buffer.isBuffer(data) &&
          data.toString('utf8') === 'partial-stage-target\n') {
        (realWrite as any)(fd, data.subarray(0, 4));
        throw new Error('stage write failure');
      }
      return (realWrite as any)(fd, data, ...rest);
    }) as typeof fs.writeFileSync);
    try {
      expect(() => generateAssets(root, current)).toThrow('stage write failure');
    } finally {
      writeSpy.mockRestore();
    }
    expect(fs.existsSync(path.join(root, '.mdocs-generation'))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'generated', 'alpha.txt'), 'utf8')).toBe('alpha\n');
    const recovered = generateAssets(root, current);
    expect(recovered.recoveredTransaction).toBe(false);
    expect(checkGeneratedAssets(root, current).clean).toBe(true);
  });

  test('recovery removes a journal-owned partial staged artifact without wedging', () => {
    const root = tempRoot();
    roots.push(root);
    const current = definition();
    generateAssets(root, current);
    fs.writeFileSync(path.join(root, 'sources', 'alpha.txt'), 'recovery-partial-target\n');
    const nativeFs = require('fs') as typeof fs;
    const realWrite = nativeFs.writeFileSync;
    const writeSpy = jest.spyOn(nativeFs, 'writeFileSync').mockImplementation(((fd: unknown, data: unknown, ...rest: unknown[]) => {
      if (typeof fd === 'number' && Buffer.isBuffer(data) &&
          data.toString('utf8') === 'recovery-partial-target\n') {
        return (realWrite as any)(fd, data.subarray(0, 4));
      }
      return (realWrite as any)(fd, data, ...rest);
    }) as typeof fs.writeFileSync);
    try {
      expect(() => generateAssets(root, current, {
        hooks: {
          beforeOperation(operation) {
            if (operation.index === 0) throw new GenerationInterruptionError();
          }
        }
      })).toThrow(GenerationInterruptionError);
    } finally {
      writeSpy.mockRestore();
    }
    const transactionRoot = path.join(root, '.mdocs-generation', 'transactions');
    const transaction = fs.readdirSync(transactionRoot)[0];
    const partial = path.join(transactionRoot, transaction, 'stage-0');
    expect(fs.readFileSync(partial, 'utf8')).toBe('reco');

    expect(generateAssets(root, current).recoveredTransaction).toBe(true);
    expect(fs.existsSync(path.join(root, '.mdocs-generation'))).toBe(false);
    expect(checkGeneratedAssets(root, current).clean).toBe(true);
  });

  test('crash after temp link before source unlink dedupes hardlinked journal entries exactly once', () => {
    const root = tempRoot();
    roots.push(root);
    const current = definition();
    expect(() => generateAssets(root, current, {
      hooks: {
        afterJournalLinked() {
          throw new GenerationInterruptionError('crash after temp link');
        }
      }
    })).toThrow('crash after temp link');

    const bootstrapPath = path.join(root, '.mdocs-generation-bootstrap.json');
    const journal = JSON.parse(fs.readFileSync(bootstrapPath, 'utf8'));
    const tempPath = path.join(root, journal.temporaryPath);
    // Duplicate entries: temp and journal path are hardlinks to the same inode.
    expect(fs.statSync(tempPath, { bigint: true }).ino)
      .toBe(fs.statSync(bootstrapPath, { bigint: true }).ino);
    expect(fs.readFileSync(tempPath, 'utf8')).toContain(journal.temporarySecret);

    expect(generateAssets(root, current).recoveredTransaction).toBe(true);
    expect(fs.existsSync(tempPath)).toBe(false);
    expect(fs.existsSync(bootstrapPath)).toBe(false);
    expect(fs.existsSync(path.join(root, '.mdocs-generation'))).toBe(false);
    expect(checkGeneratedAssets(root, current).clean).toBe(true);
  });

  test('forged bootstrap temp replacement cannot gain deletion without exact identity and secret', () => {
    const root = tempRoot();
    roots.push(root);
    const current = definition();
    expect(() => generateAssets(root, current, {
      hooks: {
        afterDirectoryCreated(directory) {
          if (directory === '.mdocs-generation') {
            throw new GenerationInterruptionError('bootstrap interruption');
          }
        }
      }
    })).toThrow('bootstrap interruption');
    const bootstrapPath = path.join(root, '.mdocs-generation-bootstrap.json');
    const journal = JSON.parse(fs.readFileSync(bootstrapPath, 'utf8'));
    const tempPath = path.join(root, journal.temporaryPath);

    // Forgery with byte-identical content (secret included) but a fresh inode.
    fs.writeFileSync(tempPath, fs.readFileSync(bootstrapPath));
    expect(generateAssets(root, current).recoveredTransaction).toBe(true);
    expect(fs.readFileSync(tempPath, 'utf8')).toContain(journal.temporarySecret);
    fs.unlinkSync(tempPath);

    // Forgery with different bytes lacking the per-transaction secret.
    fs.writeFileSync(path.join(root, 'sources', 'alpha.txt'), 'forgery pass\n');
    expect(() => generateAssets(root, current, {
      hooks: {
        afterDirectoryCreated(directory) {
          if (directory === '.mdocs-generation') {
            throw new GenerationInterruptionError('bootstrap interruption');
          }
        }
      }
    })).toThrow('bootstrap interruption');
    const second = JSON.parse(fs.readFileSync(bootstrapPath, 'utf8'));
    const secondTemp = path.join(root, second.temporaryPath);
    fs.writeFileSync(secondTemp, `${JSON.stringify({ forged: true })}\n`);
    expect(generateAssets(root, current).recoveredTransaction).toBe(true);
    expect(JSON.parse(fs.readFileSync(secondTemp, 'utf8'))).toEqual({ forged: true });
    fs.unlinkSync(secondTemp);
    expect(checkGeneratedAssets(root, current).clean).toBe(true);
  });

  test('cleanup removes only journal-authenticated bootstrap temp and leaves unowned matches', () => {
    const root = tempRoot();
    roots.push(root);
    const current = definition();
    expect(() => generateAssets(root, current, {
      hooks: {
        afterDirectoryCreated(directory) {
          if (directory === '.mdocs-generation') {
            throw new GenerationInterruptionError('bootstrap interruption');
          }
        }
      }
    })).toThrow('bootstrap interruption');
    const bootstrapPath = path.join(root, '.mdocs-generation-bootstrap.json');
    const journal = JSON.parse(fs.readFileSync(bootstrapPath, 'utf8'));
    expect(journal.temporaryPath).toMatch(
      /^\.mdocs-generation-bootstrap\.json\.journal-\d+-[a-f0-9]{12}$/
    );
    const tempPath = path.join(root, journal.temporaryPath);

    // An unowned file at the recorded temp path must survive cleanup.
    fs.writeFileSync(tempPath, 'unowned\n');
    expect(generateAssets(root, current).recoveredTransaction).toBe(true);
    expect(fs.readFileSync(tempPath, 'utf8')).toBe('unowned\n');
    fs.unlinkSync(tempPath);

    // An exact hardlink of the bootstrap journal is authenticated and removed.
    fs.writeFileSync(path.join(root, 'sources', 'alpha.txt'), 'second pass\n');
    expect(() => generateAssets(root, current, {
      hooks: {
        afterDirectoryCreated(directory) {
          if (directory === '.mdocs-generation') {
            throw new GenerationInterruptionError('bootstrap interruption');
          }
        }
      }
    })).toThrow('bootstrap interruption');
    const second = JSON.parse(fs.readFileSync(bootstrapPath, 'utf8'));
    const secondTemp = path.join(root, second.temporaryPath);
    fs.linkSync(bootstrapPath, secondTemp);
    expect(generateAssets(root, current).recoveredTransaction).toBe(true);
    expect(fs.existsSync(secondTemp)).toBe(false);
    expect(fs.existsSync(bootstrapPath)).toBe(false);
    expect(checkGeneratedAssets(root, current).clean).toBe(true);
  });

  test('bootstrap journal closes the crash gap before transaction directory creation', () => {
    const root = tempRoot();
    roots.push(root);
    const current = definition();

    expect(() => generateAssets(root, current, {
      hooks: {
        afterDirectoryCreated(directory) {
          if (directory !== '.mdocs-generation') return;
          const bootstrapPath = path.join(root, '.mdocs-generation-bootstrap.json');
          const journal = JSON.parse(fs.readFileSync(bootstrapPath, 'utf8'));
          expect(journal.phase).toBe('prepared');
          expect(journal.createdDirectories).toContainEqual({
            path: '.mdocs-generation',
            phase: 'prepared'
          });
          throw new GenerationInterruptionError('bootstrap directory interruption');
        }
      }
    })).toThrow('bootstrap directory interruption');
    expect(checkGeneratedAssets(root, current).pendingTransaction)
      .toEqual(['.mdocs-generation-bootstrap.json']);

    expect(generateAssets(root, current).recoveredTransaction).toBe(true);
    expect(fs.existsSync(path.join(root, '.mdocs-generation-bootstrap.json'))).toBe(false);
    expect(checkGeneratedAssets(root, current).clean).toBe(true);
  });

  test('destination appearing immediately before no-replace publication is never overwritten', () => {
    const root = tempRoot();
    roots.push(root);
    const baseline = definition();
    generateAssets(root, baseline);
    const raced = asset('asset.raced', 'generated/raced.txt', ['source.alpha']);
    const outputs = [...baseline.outputs, raced];
    const changed = definition({
      outputs,
      ownership: {
        namespace: 'test.agent-assets',
        outputs: outputs.map(output => ({ id: output.ownershipId, paths: [output.outputPath] }))
      }
    });
    const destination = path.join(root, raced.outputPath);

    expect(() => generateAssets(root, changed, {
      hooks: {
        beforeDestinationPublish(operation) {
          if (operation.path === raced.outputPath) fs.writeFileSync(destination, 'concurrent owner\n');
        }
      }
    })).toThrow();
    expect(fs.readFileSync(destination, 'utf8')).toBe('concurrent owner\n');
    expect(checkGeneratedAssets(root, changed).pendingTransaction)
      .toEqual(['.mdocs-generation/journal.json']);

    fs.unlinkSync(destination);
    expect(generateAssets(root, changed).recoveredTransaction).toBe(true);
    expect(checkGeneratedAssets(root, changed).clean).toBe(true);
  });

  test('replacement moves the exact original to backup before no-replace publication', () => {
    const root = tempRoot();
    roots.push(root);
    const current = definition();
    generateAssets(root, current);
    const destination = path.join(root, 'generated', 'alpha.txt');
    const original = fs.statSync(destination, { bigint: true });
    fs.writeFileSync(path.join(root, 'sources', 'alpha.txt'), 'replacement\n');

    expect(() => generateAssets(root, current, {
      hooks: {
        beforeDestinationPublish(operation) {
          if (operation.path !== 'generated/alpha.txt') return;
          const journal = JSON.parse(fs.readFileSync(
            path.join(root, '.mdocs-generation', 'journal.json'),
            'utf8'
          ));
          const action = journal.actions.find((candidate: any) => candidate.path === operation.path);
          expect(fs.existsSync(destination)).toBe(false);
          expect(fs.statSync(path.join(root, action.backupPath), { bigint: true }).ino).toBe(original.ino);
          fs.writeFileSync(destination, 'concurrent replacement owner\n');
        }
      }
    })).toThrow();
    expect(fs.readFileSync(destination, 'utf8')).toBe('concurrent replacement owner\n');

    fs.unlinkSync(destination);
    expect(generateAssets(root, current).recoveredTransaction).toBe(true);
    expect(fs.readFileSync(destination, 'utf8')).toBe('replacement\n');
  });

  test('prepared journal recovers partial staging without applying outputs', () => {
    const root = tempRoot();
    roots.push(root);
    const current = definition();
    expect(() => generateAssets(root, current, {
      hooks: {
        afterJournalWritten() {
          throw new GenerationInterruptionError('prepared interruption');
        }
      }
    })).toThrow('prepared interruption');
    expect(JSON.parse(fs.readFileSync(
      path.join(root, '.mdocs-generation', 'journal.json'),
      'utf8'
    )).phase).toBe('prepared');
    expect(generateAssets(root, current).recoveredTransaction).toBe(true);
    expect(checkGeneratedAssets(root, current).clean).toBe(true);
  });

  test('applying recovery rolls back before a missing canonical source can fail compilation', () => {
    const root = tempRoot();
    roots.push(root);
    const current = definition();
    generateAssets(root, current);
    const original = fs.readFileSync(path.join(root, 'generated', 'alpha.txt'));
    fs.writeFileSync(path.join(root, 'sources', 'alpha.txt'), 'changed\n');
    expect(() => generateAssets(root, current, {
      hooks: {
        afterOperation(operation) {
          if (operation.index === 0) throw new GenerationInterruptionError();
        }
      }
    })).toThrow(GenerationInterruptionError);
    fs.unlinkSync(path.join(root, 'sources', 'alpha.txt'));

    expect(() => generateAssets(root, current)).toThrow();
    expect(fs.readFileSync(path.join(root, 'generated', 'alpha.txt'))).toEqual(original);
    expect(fs.existsSync(path.join(root, '.mdocs-generation', 'journal.json'))).toBe(false);
  });

  test.each(['committed', 'cleaning'] as const)(
    '%s recovery finishes cleanup without reading a missing canonical source',
    interruptedPhase => {
    const root = tempRoot();
    roots.push(root);
    const current = definition();
    generateAssets(root, current);
    fs.writeFileSync(path.join(root, 'sources', 'alpha.txt'), 'committed\n');
    expect(() => generateAssets(root, current, {
      hooks: {
        afterJournalPhase(phase) {
          if (phase === interruptedPhase) throw new GenerationInterruptionError(`after ${phase}`);
        }
      }
    })).toThrow(`after ${interruptedPhase}`);
    expect(JSON.parse(fs.readFileSync(
      path.join(root, '.mdocs-generation', 'journal.json'),
      'utf8'
    )).phase).toBe(interruptedPhase);
    fs.unlinkSync(path.join(root, 'sources', 'alpha.txt'));

    expect(() => generateAssets(root, current)).toThrow();
    expect(fs.readFileSync(path.join(root, 'generated', 'alpha.txt'), 'utf8')).toBe('committed\n');
    expect(fs.existsSync(path.join(root, '.mdocs-generation', 'journal.json'))).toBe(false);
    }
  );

  test('invalid pending journal fields fail closed before recovery mutation', () => {
    const mutations: Array<(journal: any) => void> = [
      journal => { journal.schemaVersion = 2; },
      journal => { journal.ownershipNamespace = 'other.namespace'; },
      journal => { journal.phase = 'unknown'; },
      journal => { journal.transactionId = 'bad'; },
      journal => { journal.actions = {}; },
      journal => { journal.createdDirectories = {}; },
      journal => { journal.actions[0] = null; },
      journal => { journal.actions[0].kind = 'unknown'; },
      journal => { journal.actions[0].path = 7; },
      journal => { journal.actions[0].path = 'generated/unowned.txt'; },
      journal => { journal.actions[0].stagePath = 'generated/not-transaction-stage'; },
      journal => { journal.actions[0].installPath = 'generated/not-a-sibling'; },
      journal => { delete journal.actions[0].before; },
      journal => { journal.actions[0].before.exists = 'yes'; },
      journal => { journal.actions[0].before.identity = { dev: 'not-a-device', ino: '1' }; },
      journal => { journal.actions[0].parentGuard = null; },
      journal => { journal.actions[0].parentGuard.identity = { dev: '1', ino: 'bad' }; },
      journal => { journal.createdDirectories[0] = null; },
      journal => { journal.createdDirectories[0].path = 7; },
      journal => { journal.createdDirectories[0].phase = 'unknown'; },
      journal => { journal.createdDirectories.push({ ...journal.createdDirectories[0] }); },
      journal => {
        journal.createdDirectories.push({
          path: 'sources',
          identity: journal.createdDirectories[0].identity
        });
      }
    ];

    for (const mutate of mutations) {
      const root = tempRoot();
      roots.push(root);
      const current = definition();
      expect(() => generateAssets(root, current, {
        hooks: {
          afterJournalWritten() {
            throw new GenerationInterruptionError('leave prepared journal');
          }
        }
      })).toThrow('leave prepared journal');
      const journalPath = path.join(root, '.mdocs-generation', 'journal.json');
      const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
      mutate(journal);
      fs.writeFileSync(journalPath, `${JSON.stringify(rehashJournal(journal), null, 2)}\n`);
      const before = structuralSnapshot(root);
      expect(() => generateAssets(root, current)).toThrow(GenerationSafetyError);
      expect(structuralSnapshot(root)).toEqual(before);
    }

    const root = tempRoot();
    roots.push(root);
    const current = definition();
    expect(() => generateAssets(root, current, {
      hooks: { afterJournalWritten: () => { throw new GenerationInterruptionError(); } }
    })).toThrow(GenerationInterruptionError);
    const journalPath = path.join(root, '.mdocs-generation', 'journal.json');
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    journal.journalDigest = `sha256:${'0'.repeat(64)}`;
    fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
    expect(() => generateAssets(root, current)).toThrow('journal digest mismatch');
  });

  test('orphan staging from a pre-journal crash is removed under the next generation lock', () => {
    const root = tempRoot();
    roots.push(root);
    const orphan = path.join(
      root,
      '.mdocs-generation',
      'transactions',
      '123-aabbccddeeff001122334455'
    );
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, 'stage-0'), 'orphan\n');

    generateAssets(root, definition());
    expect(fs.existsSync(path.join(root, '.mdocs-generation'))).toBe(false);
    expect(checkGeneratedAssets(root, definition()).clean).toBe(true);
  });

  test('repo lock rejects concurrent generation', () => {
    const root = tempRoot();
    roots.push(root);
    let concurrentError: unknown;
    let concurrentCheckError: unknown;
    generateAssets(root, definition(), {
      hooks: {
        afterLockAcquired() {
          const lockPath = path.join(root, '.mdocs-generation.lock');
          const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
          if (process.platform !== 'win32') {
            expect(fs.statSync(lockPath).mode & 0o777).toBe(0o600);
          }
          const boot = JSON.parse(fs.readFileSync(path.join(root, '.mdocs-generation.boot'), 'utf8'));
          expect(boot.token).toMatch(/^[0-9a-f]{32}$/);
          expect(owner).toEqual({
            pid: process.pid,
            bootToken: boot.token,
            nonce: expect.stringMatching(/^[0-9a-f]{32}$/)
          });
          expect(fs.readdirSync(root).filter(entry => entry.startsWith('.mdocs-generation.lock.tmp-')))
            .toEqual([]);
          try {
            generateAssets(root, definition());
          } catch (error) {
            concurrentError = error;
          }
          try {
            checkGeneratedAssets(root, definition());
          } catch (error) {
            concurrentCheckError = error;
          }
        }
      }
    });
    expect(concurrentError).toBeInstanceOf(GenerationSafetyError);
    expect((concurrentError as Error).message).toContain('Generation already running');
    expect(concurrentCheckError).toBeInstanceOf(GenerationSafetyError);
    expect((concurrentCheckError as Error).message).toContain('Generation API already running');
  });

  test('portable lock identity never shells out and PID reuse cannot steal a live lock', () => {
    const root = tempRoot();
    roots.push(root);
    const childProcess = require('child_process');
    const spawnSpy = jest.spyOn(childProcess, 'spawnSync').mockImplementation(() => {
      throw new Error('ps unavailable');
    });
    try {
      generateAssets(root, definition());
      const lockPath = path.join(root, '.mdocs-generation.lock');
      const boot = JSON.parse(fs.readFileSync(path.join(root, '.mdocs-generation.boot'), 'utf8'));

      // Fresh lock from a live (possibly reused) PID is active and must not be stolen.
      const foreignNonce = 'f'.repeat(32);
      fs.writeFileSync(lockPath, `${JSON.stringify({
        pid: process.pid,
        bootToken: boot.token,
        nonce: foreignNonce
      })}\n`, { mode: 0o600 });
      expect(() => generateAssets(root, definition())).toThrow('Generation already running');
      expect(JSON.parse(fs.readFileSync(lockPath, 'utf8')).nonce).toBe(foreignNonce);

      // A live PID with a matching boot token is never taken over, even with an
      // ancient heartbeat: PID reuse cannot classify a live owner as stale.
      const ancient = new Date(Date.now() - 120_000);
      fs.utimesSync(lockPath, ancient, ancient);
      expect(() => generateAssets(root, definition())).toThrow('Generation already running');
      expect(JSON.parse(fs.readFileSync(lockPath, 'utf8')).nonce).toBe(foreignNonce);
      fs.unlinkSync(lockPath);

      // Mismatched boot token is reclaimed even with a live PID.
      fs.writeFileSync(lockPath, `${JSON.stringify({
        pid: process.pid,
        bootToken: '0'.repeat(32),
        nonce: 'e'.repeat(32)
      })}\n`, { mode: 0o600 });
      expect(generateAssets(root, definition()).written.length).toBeGreaterThanOrEqual(0);
      expect(fs.existsSync(lockPath)).toBe(false);

      // Dead PID with a fresh heartbeat is stale and reclaimed.
      fs.writeFileSync(lockPath, `${JSON.stringify({
        pid: 99_999_999,
        bootToken: boot.token,
        nonce: 'd'.repeat(32)
      })}\n`, { mode: 0o600 });
      expect(generateAssets(root, definition()).written.length).toBeGreaterThanOrEqual(0);
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  test.each([
    'malformed',
    `${JSON.stringify({ pid: 99_999_999, started: 'stale', nonce: 'dead' })}\n`
  ])('malformed or stale lock is recovered without a permanent wedge', lockBytes => {
    const root = tempRoot();
    roots.push(root);
    fs.writeFileSync(path.join(root, '.mdocs-generation.lock'), lockBytes, { mode: 0o600 });
    expect(generateAssets(root, definition()).written.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(root, '.mdocs-generation.lock'))).toBe(false);
  });

  test.each(['symlink', 'directory'] as const)(
    '%s parent swap aborts without outside write and remains recoverable',
    swapKind => {
      const root = tempRoot();
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mdocs-generation-outside-'));
      roots.push(root, outside);
      const current = definition();
      generateAssets(root, current);
      fs.writeFileSync(path.join(root, 'sources', 'alpha.txt'), 'changed\n');
      const generated = path.join(root, 'generated');
      const parked = path.join(root, 'generated-parked');
      let swapped = false;

      expect(() => generateAssets(root, current, {
        hooks: {
          beforeOperation(operation) {
            if (swapped || operation.kind !== 'write' || operation.path.endsWith('manifest.json')) return;
            swapped = true;
            fs.renameSync(generated, parked);
            if (swapKind === 'symlink') fs.symlinkSync(outside, generated);
            else fs.mkdirSync(generated);
          }
        }
      })).toThrow(/rollback remains journaled|Symbolic links are forbidden|Parent identity changed/);
      expect(fs.existsSync(path.join(outside, 'alpha.txt'))).toBe(false);

      if (swapKind === 'symlink') fs.unlinkSync(generated);
      else fs.rmdirSync(generated);
      fs.renameSync(parked, generated);
      expect(generateAssets(root, current).recoveredTransaction).toBe(true);
      expect(checkGeneratedAssets(root, current).clean).toBe(true);
    }
  );

  test('stale-delete parent swap cannot delete outside file', () => {
    const root = tempRoot();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mdocs-generation-outside-'));
    roots.push(root, outside);
    fs.writeFileSync(path.join(outside, 'stale.txt'), 'outside\n');
    const stale = asset('asset.stale', 'generated/stale.txt', ['source.beta']);
    const fullOutputs = [...definition().outputs, stale];
    const ownership = {
      namespace: 'test.agent-assets',
      outputs: fullOutputs.map(output => ({ id: output.ownershipId, paths: [output.outputPath] }))
    };
    generateAssets(root, definition({ outputs: fullOutputs, ownership }));
    const generated = path.join(root, 'generated');
    const parked = path.join(root, 'generated-parked');
    let swapped = false;
    expect(() => generateAssets(root, definition({ ownership }), {
      hooks: {
        beforeOperation(operation) {
          if (swapped || operation.kind !== 'remove') return;
          swapped = true;
          fs.renameSync(generated, parked);
          fs.symlinkSync(outside, generated);
        }
      }
    })).toThrow();
    expect(fs.readFileSync(path.join(outside, 'stale.txt'), 'utf8')).toBe('outside\n');
    fs.unlinkSync(generated);
    fs.renameSync(parked, generated);
    expect(generateAssets(root, definition({ ownership })).recoveredTransaction).toBe(true);
  });

  test('post-pin parent rename and symlink swap cannot write or delete outside victim', () => {
    const root = tempRoot();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mdocs-generation-outside-'));
    roots.push(root, outside);
    const current = definition();
    generateAssets(root, current);
    fs.writeFileSync(path.join(root, 'sources', 'alpha.txt'), 'changed\n');
    fs.writeFileSync(path.join(outside, 'alpha.txt'), 'outside victim\n');
    const generated = path.join(root, 'generated');
    const parked = path.join(root, 'generated-parked');
    let swapped = false;

    expect(() => generateAssets(root, current, {
      hooks: {
        afterParentPinned(operation) {
          if (swapped || operation.path !== 'generated/alpha.txt') return;
          swapped = true;
          fs.renameSync(generated, parked);
          fs.symlinkSync(outside, generated);
        }
      }
    })).toThrow();
    expect(fs.readFileSync(path.join(outside, 'alpha.txt'), 'utf8')).toBe('outside victim\n');
    fs.unlinkSync(generated);
    fs.renameSync(parked, generated);
    expect(generateAssets(root, current).recoveredTransaction).toBe(true);
    expect(checkGeneratedAssets(root, current).clean).toBe(true);
  });

  test('direct script compiles exact source outside repository and ignores dist freshness', () => {
    const distGenerator = path.join(REPO_ROOT, 'dist', 'generation', 'generator.js');
    const before = fs.existsSync(distGenerator) ? fs.statSync(distGenerator).mtimeMs : null;
    const result = spawnSync(process.execPath, [
      path.join(REPO_ROOT, 'scripts', 'generate-agent-assets.js'),
      '--check'
    ], { cwd: os.tmpdir(), encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Generated agent assets are clean.');
    expect(fs.existsSync(distGenerator) ? fs.statSync(distGenerator).mtimeMs : null).toBe(before);
  });
});
