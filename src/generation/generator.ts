import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export const GENERATION_SCHEMA_VERSION = 2 as const;
export const GENERATOR_VERSION = '2.0.0';
const DIGEST_PREFIX = 'sha256:';
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const INTERNAL_DIR = '.mdocs-generation';
const JOURNAL_PATH = `${INTERNAL_DIR}/journal.json`;
const BOOTSTRAP_JOURNAL_PATH = '.mdocs-generation-bootstrap.json';
const LOCK_PATH = '.mdocs-generation.lock';
const BOOT_TOKEN_PATH = '.mdocs-generation.boot';
const BOOT_TEMP_PATTERN = /^\.mdocs-generation-bootstrap\.json\.journal-\d+-[a-f0-9]{12}$/;
const BOOT_TOKEN_TEMP_PATTERN = /^\.mdocs-generation\.boot\.tmp-\d+-[a-f0-9]{12}$/;
const TOKEN_PATTERN = /^[0-9a-f]{32}$/;
const RESERVED_DEVICE = /^(?:con|prn|aux|nul|com(?:[1-9]|[¹²³])|lpt(?:[1-9]|[¹²³]))$/i;
const GENERATED_MODE = 0o644;
const PRIVATE_MODE = 0o600;
const TRANSACTION_ID_PATTERN = /^\d+-[a-f0-9]{24}$/;
let generationActive = false;

export interface CanonicalSourceDefinition {
  id: string;
  path: string;
}

export interface GeneratedOutputDefinition {
  ownershipId: string;
  outputPath: string;
  sourceIds: readonly string[];
}

export interface ManagedOutputOwnershipDefinition {
  id: string;
  paths: readonly string[];
}

export interface GenerationDefinition {
  schemaVersion: typeof GENERATION_SCHEMA_VERSION;
  generatorVersion: string;
  manifestPath: string;
  managedRoots: readonly string[];
  ownership: {
    namespace: string;
    outputs: readonly ManagedOutputOwnershipDefinition[];
  };
  sources: readonly CanonicalSourceDefinition[];
  outputs: readonly GeneratedOutputDefinition[];
}

export interface SourceProvenance {
  id: string;
  path: string;
  byteDigest: string;
}

export interface OutputProvenance {
  schemaVersion: typeof GENERATION_SCHEMA_VERSION;
  generatorVersion: string;
  ownershipId: string;
  outputPath: string;
  sourceIds: string[];
  byteDigest: string;
  provenanceDigest: string;
}

export interface GenerationManifest {
  schemaVersion: typeof GENERATION_SCHEMA_VERSION;
  generatorVersion: string;
  ownershipNamespace: string;
  provenanceAlgorithm: 'sha256-json-v1';
  sources: SourceProvenance[];
  outputs: OutputProvenance[];
  manifestDigest: string;
}

export interface GenerationCheckResult {
  clean: boolean;
  missing: string[];
  byteDrifted: string[];
  provenanceDrifted: string[];
  stale: string[];
  pendingTransaction: string[];
}

export interface GenerationResult {
  written: string[];
  deleted: string[];
  renamed: Array<{ from: string; to: string }>;
  unchanged: string[];
  recoveredTransaction: boolean;
  consistency: 'journaled';
  manifest: GenerationManifest;
}

export interface GenerationOperationContext {
  index: number;
  kind: 'write' | 'remove' | 'case-remove';
  path: string;
}

export interface GenerationHooks {
  afterLockAcquired?(): void;
  afterJournalWritten?(): void;
  afterJournalLinked?(): void;
  afterJournalPhase?(phase: TransactionPhase): void;
  beforeOperation?(operation: GenerationOperationContext): void;
  afterDirectoryCreated?(path: string): void;
  afterParentPinned?(operation: GenerationOperationContext): void;
  beforeDestinationPublish?(operation: GenerationOperationContext): void;
  afterOperation?(operation: GenerationOperationContext): void;
}

export interface GenerationOptions {
  hooks?: GenerationHooks;
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

interface FileSnapshot {
  exists: boolean;
  identity?: FileIdentity;
  byteDigest?: string;
  mode?: bigint;
  mtimeNs?: bigint;
}

interface ParentGuard {
  anchorPath: string;
  identity: FileIdentity;
  parentPath: string;
}

interface GenerationContext {
  root: string;
  definition: GenerationDefinition;
  filesystem: HardenedFilesystem;
  ownershipById: Map<string, Set<string>>;
  ownershipByPath: Map<string, string>;
}

interface CompiledGeneration extends GenerationContext {
  sources: SourceProvenance[];
  outputs: Array<OutputProvenance & { bytes: Buffer }>;
  manifest: GenerationManifest;
  manifestBytes: Buffer;
}

interface LoadedManifest {
  manifest: GenerationManifest;
  bytes: Buffer;
  canonical: boolean;
  trusted: boolean;
}

interface TransactionAction {
  kind: 'write' | 'remove' | 'case-remove';
  path: string;
  stagePath?: string;
  installPath?: string;
  backupPath?: string;
  trashPath?: string;
  before: FileSnapshot;
  parentGuard: ParentGuard;
  afterDigest?: string;
}

interface CreatedDirectory {
  path: string;
  phase: 'prepared' | 'applying';
  identity?: FileIdentity;
}

export type TransactionPhase = 'prepared' | 'applying' | 'committed' | 'cleaning';

interface TransactionJournalPayload {
  schemaVersion: 1;
  ownershipNamespace: string;
  transactionId: string;
  phase: TransactionPhase;
  actions: TransactionAction[];
  createdDirectories: CreatedDirectory[];
  temporaryPath?: string;
  temporarySecret?: string;
}

interface TransactionJournal extends TransactionJournalPayload {
  journalDigest: string;
}

interface TransactionPlan {
  id: string;
  actions: TransactionAction[];
  written: string[];
  deleted: string[];
  renamed: Array<{ from: string; to: string }>;
  unchanged: string[];
  createdDirectories: CreatedDirectory[];
  stageBytes: Map<TransactionAction, Buffer>;
}

export class GenerationSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GenerationSafetyError';
  }
}

/** Test/interruption hook analogue for process death after journal persistence. */
export class GenerationInterruptionError extends Error {
  constructor(message = 'Generation interrupted') {
    super(message);
    this.name = 'GenerationInterruptionError';
  }
}

function sha256(bytes: Buffer | string): string {
  return `${DIGEST_PREFIX}${createHash('sha256').update(bytes).digest('hex')}`;
}

function canonicalJson(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    ).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new GenerationSafetyError('Unsupported canonical JSON value');
  return encoded;
}

function sortStrings(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

export function portablePathIdentity(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('en-US');
}

function assertId(id: string, label: string): void {
  if (!ID_PATTERN.test(id)) throw new GenerationSafetyError(`${label} is not stable: ${id}`);
}

function assertRelativePath(value: string, label: string): void {
  if (!value || value.includes('\0') || value.includes('\\') || value.includes(':') ||
      /[<>"|?*\u0001-\u001f]/.test(value) ||
      path.posix.isAbsolute(value) || path.win32.isAbsolute(value) ||
      path.posix.normalize(value) !== value || value.normalize('NFC') !== value ||
      value.endsWith('/')) {
    throw new GenerationSafetyError(`${label} is not a portable normalized relative path: ${value}`);
  }
  for (const segment of value.split('/')) {
    const deviceBase = segment.split('.')[0].replace(/[. ]+$/g, '');
    if (!segment || segment === '.' || segment === '..' || /[. ]$/.test(segment) ||
        RESERVED_DEVICE.test(deviceBase)) {
      throw new GenerationSafetyError(`${label} has unsafe portable segment: ${value}`);
    }
  }
}

function assertNotInternalPath(value: string, label: string): void {
  const folded = portablePathIdentity(value);
  const reservedExact = new Set([
    LOCK_PATH,
    BOOTSTRAP_JOURNAL_PATH,
    BOOT_TOKEN_PATH
  ].map(portablePathIdentity));
  if (reservedExact.has(folded) || BOOT_TEMP_PATTERN.test(value) || BOOT_TOKEN_TEMP_PATTERN.test(value) ||
      folded === portablePathIdentity(INTERNAL_DIR) ||
      folded.startsWith(`${portablePathIdentity(INTERNAL_DIR)}/`)) {
    throw new GenerationSafetyError(`${label} uses reserved generator path: ${value}`);
  }
}

function assertPathSet(paths: readonly string[], label: string): void {
  const folded = paths.map(value => ({ value, folded: portablePathIdentity(value) }));
  for (let leftIndex = 0; leftIndex < folded.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < folded.length; rightIndex += 1) {
      const left = folded[leftIndex];
      const right = folded[rightIndex];
      if (left.folded !== right.folded &&
          !left.folded.startsWith(`${right.folded}/`) &&
          !right.folded.startsWith(`${left.folded}/`)) continue;
      throw new GenerationSafetyError(
        `${label} portable collision: ${left.value} and ${right.value}`
      );
    }
  }
}

function assertOwnershipPathSet(entries: readonly { id: string; path: string }[]): void {
  const folded = entries.map(entry => ({ ...entry, folded: portablePathIdentity(entry.path) }));
  for (let leftIndex = 0; leftIndex < folded.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < folded.length; rightIndex += 1) {
      const left = folded[leftIndex];
      const right = folded[rightIndex];
      const samePathForCaseMigration = left.folded === right.folded && left.id === right.id;
      if (samePathForCaseMigration ||
          (left.folded !== right.folded &&
            !left.folded.startsWith(`${right.folded}/`) &&
            !right.folded.startsWith(`${left.folded}/`))) continue;
      throw new GenerationSafetyError(
        `ownership paths portable collision: ${left.path} and ${right.path}`
      );
    }
  }
}

function isWithinManagedRoot(outputPath: string, managedRoots: readonly string[]): boolean {
  return managedRoots.some(root => outputPath.startsWith(`${root}/`));
}

function identity(stat: fs.BigIntStats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(left: FileIdentity | undefined, right: FileIdentity | undefined): boolean {
  return left !== undefined && right !== undefined && left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.exists === right.exists && (!left.exists || (
    sameIdentity(left.identity, right.identity) && left.byteDigest === right.byteDigest
  ));
}

function noFollowFlag(): number {
  return typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
}

function hasPosixModes(): boolean {
  return process.platform !== 'win32';
}

function snapshotMode(stat: fs.BigIntStats): bigint | undefined {
  return hasPosixModes() ? stat.mode & 0o777n : undefined;
}

function modeMatches(actual: bigint | undefined, expected: number): boolean {
  return !hasPosixModes() || actual === BigInt(expected);
}

function applyFileMode(descriptor: number, mode: number): void {
  if (hasPosixModes()) fs.fchmodSync(descriptor, mode);
}

function isUnsupportedDirectoryDurability(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EINVAL' || code === 'EPERM' || code === 'ENOTSUP';
}

function fsyncDirectory(directory: string, expected?: FileIdentity): void {
  if (process.platform === 'win32') return;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    if (expected !== undefined) {
      const opened = fs.fstatSync(descriptor, { bigint: true });
      if (!opened.isDirectory() || !sameIdentity(identity(opened), expected)) {
        throw new GenerationSafetyError(`Directory changed before fsync: ${directory}`);
      }
    }
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (!isUnsupportedDirectoryDurability(error)) throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

class HardenedFilesystem {
  readonly root: string;
  readonly rootIdentity: FileIdentity;

  constructor(rootInput: string) {
    this.root = fs.realpathSync.native(path.resolve(rootInput));
    const rootStat = fs.lstatSync(this.root, { bigint: true });
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new GenerationSafetyError(`Repository root is not a real directory: ${this.root}`);
    }
    this.rootIdentity = identity(rootStat);
  }

  absolute(relativePath: string): string {
    if (relativePath === '') return this.root;
    const resolved = path.resolve(this.root, ...relativePath.split('/'));
    if (!resolved.startsWith(`${this.root}${path.sep}`)) {
      throw new GenerationSafetyError(`Path escapes repository: ${relativePath}`);
    }
    return resolved;
  }

  assertRootIdentity(): void {
    const stat = fs.lstatSync(this.root, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || !sameIdentity(identity(stat), this.rootIdentity)) {
      throw new GenerationSafetyError('Repository root identity changed during generation');
    }
  }

  assertSafePath(relativePath: string, allowMissing: boolean): fs.BigIntStats | null {
    this.assertRootIdentity();
    let current = this.root;
    const segments = relativePath.split('/');
    for (let index = 0; index < segments.length; index += 1) {
      current = path.join(current, segments[index]);
      let stat: fs.BigIntStats;
      try {
        stat = fs.lstatSync(current, { bigint: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && allowMissing) return null;
        throw error;
      }
      if (stat.isSymbolicLink()) {
        throw new GenerationSafetyError(`Symbolic links are forbidden in generation paths: ${relativePath}`);
      }
      if (index < segments.length - 1 && !stat.isDirectory()) {
        throw new GenerationSafetyError(`Generation path parent is not a directory: ${relativePath}`);
      }
      const real = fs.realpathSync.native(current);
      if (real !== this.root && !real.startsWith(`${this.root}${path.sep}`)) {
        throw new GenerationSafetyError(`Real path escapes repository: ${relativePath}`);
      }
      if (index === segments.length - 1) return stat;
    }
    return null;
  }

  withPinnedParent<T>(
    relativePath: string,
    callback: (basename: string, parentIdentity: FileIdentity) => T
  ): T {
    const parentPath = path.posix.dirname(relativePath) === '.' ? '' : path.posix.dirname(relativePath);
    const basename = path.posix.basename(relativePath);
    const originalCwd = process.cwd();
    try {
      this.assertRootIdentity();
      process.chdir(this.root);
      const pinnedRoot = fs.statSync('.', { bigint: true });
      if (!pinnedRoot.isDirectory() || !sameIdentity(identity(pinnedRoot), this.rootIdentity)) {
        throw new GenerationSafetyError('Repository root changed while pinning directory');
      }
      if (parentPath !== '') {
        for (const segment of parentPath.split('/')) {
          const before = fs.lstatSync(segment, { bigint: true });
          if (!before.isDirectory() || before.isSymbolicLink()) {
            throw new GenerationSafetyError(`Pinned path parent is unsafe: ${relativePath}`);
          }
          process.chdir(segment);
          const after = fs.statSync('.', { bigint: true });
          if (!after.isDirectory() || !sameIdentity(identity(before), identity(after))) {
            throw new GenerationSafetyError(`Pinned path parent changed: ${relativePath}`);
          }
        }
      }
      const real = fs.realpathSync.native('.');
      if (real !== this.root && !real.startsWith(`${this.root}${path.sep}`)) {
        throw new GenerationSafetyError(`Pinned directory escaped repository: ${relativePath}`);
      }
      const parent = identity(fs.statSync('.', { bigint: true }));
      return callback(basename, parent);
    } finally {
      process.chdir(originalCwd);
    }
  }

  private pinnedFile(basename: string): { bytes: Buffer; snapshot: FileSnapshot } {
    const before = fs.lstatSync(basename, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new GenerationSafetyError(`Expected pinned regular file: ${basename}`);
    }
    const descriptor = fs.openSync(basename, fs.constants.O_RDONLY | noFollowFlag());
    try {
      const opened = fs.fstatSync(descriptor, { bigint: true });
      if (!opened.isFile() || !sameIdentity(identity(before), identity(opened))) {
        throw new GenerationSafetyError(`Pinned file changed while opening: ${basename}`);
      }
      const bytes = fs.readFileSync(descriptor);
      const after = fs.fstatSync(descriptor, { bigint: true });
      if (!sameIdentity(identity(opened), identity(after))) {
        throw new GenerationSafetyError(`Pinned file changed while reading: ${basename}`);
      }
      const snapshot: FileSnapshot = {
        exists: true,
        identity: identity(after),
        byteDigest: sha256(bytes),
        mtimeNs: after.mtimeNs
      };
      const mode = snapshotMode(after);
      if (mode !== undefined) snapshot.mode = mode;
      return {
        bytes,
        snapshot
      };
    } finally {
      fs.closeSync(descriptor);
    }
  }

  private pinnedSnapshot(basename: string): FileSnapshot {
    try {
      return this.pinnedFile(basename).snapshot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false };
      throw error;
    }
  }

  read(relativePath: string): { bytes: Buffer; snapshot: FileSnapshot } {
    return this.withPinnedParent(relativePath, basename => this.pinnedFile(basename));
  }

  snapshot(relativePath: string): FileSnapshot {
    const stat = this.assertSafePath(relativePath, true);
    if (stat === null) return { exists: false };
    return this.read(relativePath).snapshot;
  }

  parentGuard(relativePath: string): ParentGuard {
    const parentPath = path.posix.dirname(relativePath) === '.' ? '' : path.posix.dirname(relativePath);
    let anchorPath = parentPath;
    while (anchorPath !== '') {
      const stat = this.assertSafePath(anchorPath, true);
      if (stat !== null) {
        if (!stat.isDirectory()) throw new GenerationSafetyError(`Parent is not a directory: ${relativePath}`);
        return { anchorPath, identity: identity(stat), parentPath };
      }
      anchorPath = path.posix.dirname(anchorPath) === '.' ? '' : path.posix.dirname(anchorPath);
    }
    return { anchorPath: '', identity: this.rootIdentity, parentPath };
  }

  assertParentGuard(guard: ParentGuard): void {
    const stat = guard.anchorPath === ''
      ? fs.lstatSync(this.root, { bigint: true })
      : this.assertSafePath(guard.anchorPath, false)!;
    if (!stat.isDirectory() || !sameIdentity(identity(stat), guard.identity)) {
      throw new GenerationSafetyError(`Parent identity changed: ${guard.parentPath || '.'}`);
    }
  }

  assertParentIdentity(guard: ParentGuard, expected: FileIdentity, operation: string): void {
    this.assertParentGuard(guard);
    const actual = guard.parentPath === ''
      ? this.rootIdentity
      : identity(this.assertSafePath(guard.parentPath, false)!);
    if (!sameIdentity(actual, expected)) {
      throw new GenerationSafetyError(`Parent changed after ${operation}: ${guard.parentPath || '.'}`);
    }
  }

  ensureParent(
    guard: ParentGuard,
    creationPhase: CreatedDirectory['phase'],
    onCreated?: (directory: CreatedDirectory) => void,
    afterDirectoryCreated?: (path: string) => void
  ): FileIdentity {
    this.assertParentGuard(guard);
    if (guard.parentPath === '') return this.rootIdentity;
    let currentPath = '';
    for (const segment of guard.parentPath.split('/')) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const existing = this.assertSafePath(currentPath, true);
      if (existing === null) {
        const createdIdentity = this.withPinnedParent(currentPath, basename => {
          try {
            fs.lstatSync(basename, { bigint: true });
            throw new GenerationSafetyError(`Directory appeared during creation: ${currentPath}`);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
          if (hasPosixModes()) fs.mkdirSync(basename, { mode: 0o755 });
          else fs.mkdirSync(basename);
          const created = fs.lstatSync(basename, { bigint: true });
          if (!created.isDirectory() || created.isSymbolicLink()) {
            throw new GenerationSafetyError(`Created directory changed: ${currentPath}`);
          }
          fsyncDirectory('.', identity(fs.statSync('.', { bigint: true })));
          afterDirectoryCreated?.(currentPath);
          return identity(created);
        });
        onCreated?.({ path: currentPath, phase: creationPhase, identity: createdIdentity });
      } else if (!existing.isDirectory()) {
        throw new GenerationSafetyError(`Parent is not a directory: ${guard.parentPath}`);
      }
      const created = this.assertSafePath(currentPath, false)!;
      if (!created.isDirectory()) throw new GenerationSafetyError(`Unsafe parent: ${currentPath}`);
    }
    this.assertParentGuard(guard);
    return identity(this.assertSafePath(guard.parentPath, false)!);
  }

  assertSnapshot(relativePath: string, expected: FileSnapshot): void {
    const actual = this.snapshot(relativePath);
    if (actual.exists !== expected.exists ||
        (actual.exists && (!sameIdentity(actual.identity, expected.identity) ||
          actual.byteDigest !== expected.byteDigest))) {
      throw new GenerationSafetyError(`Path changed during generation: ${relativePath}`);
    }
  }

  writeExclusive(
    relativePath: string,
    bytes: Buffer,
    mode = PRIVATE_MODE,
    onCreated?: (directory: CreatedDirectory) => void,
    creationPhase: CreatedDirectory['phase'] = 'prepared',
    afterDirectoryCreated?: (path: string) => void
  ): void {
    const guard = this.parentGuard(relativePath);
    const parentIdentity = this.ensureParent(guard, creationPhase, onCreated, afterDirectoryCreated);
    this.withPinnedParent(relativePath, (basename, pinnedParent) => {
      if (!sameIdentity(parentIdentity, pinnedParent)) {
        throw new GenerationSafetyError(`Parent changed before write: ${relativePath}`);
      }
      try {
        fs.lstatSync(basename, { bigint: true });
        throw new GenerationSafetyError(`Refusing to overwrite staged path: ${relativePath}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const descriptor = fs.openSync(
        basename,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollowFlag(),
        mode
      );
      try {
        applyFileMode(descriptor, mode);
        fs.writeFileSync(descriptor, bytes);
        fs.fsyncSync(descriptor);
        const opened = fs.fstatSync(descriptor, { bigint: true });
        const final = fs.lstatSync(basename, { bigint: true });
        if (!sameIdentity(identity(opened), identity(final))) {
          throw new GenerationSafetyError(`Written file identity changed: ${relativePath}`);
        }
      } finally {
        fs.closeSync(descriptor);
      }
      fsyncDirectory('.', pinnedParent);
    });
  }

  linkExclusiveWithinParent(sourcePath: string, destinationPath: string): void {
    if (path.posix.dirname(sourcePath) !== path.posix.dirname(destinationPath)) {
      throw new GenerationSafetyError('Pinned link paths must share parent');
    }
    this.withPinnedParent(sourcePath, (sourceBasename, pinnedParent) => {
      const destinationBasename = path.posix.basename(destinationPath);
      const source = this.pinnedFile(sourceBasename).snapshot;
      fs.linkSync(sourceBasename, destinationBasename);
      const linked = this.pinnedFile(destinationBasename).snapshot;
      if (!sameIdentity(source.identity, linked.identity)) {
        throw new GenerationSafetyError(`Published link identity mismatch: ${destinationPath}`);
      }
      fsyncDirectory('.', pinnedParent);
    });
  }

  renameWithinParent(
    sourcePath: string,
    destinationPath: string,
    expectedSource: FileSnapshot,
    expectedDestination: FileSnapshot,
    afterPinned?: () => void,
    beforeNoReplace?: () => void
  ): void {
    if (path.posix.dirname(sourcePath) !== path.posix.dirname(destinationPath)) {
      throw new GenerationSafetyError('Pinned rename paths must share parent');
    }
    this.withPinnedParent(sourcePath, (sourceBasename, pinnedParent) => {
      const destinationBasename = path.posix.basename(destinationPath);
      const source = this.pinnedFile(sourceBasename).snapshot;
      const destination = this.pinnedSnapshot(destinationBasename);
      if (!sameSnapshot(source, expectedSource) || !sameSnapshot(destination, expectedDestination)) {
        throw new GenerationSafetyError(`Path changed before pinned rename: ${destinationPath}`);
      }
      afterPinned?.();
      const pinned = fs.realpathSync.native('.');
      if (pinned !== this.root && !pinned.startsWith(`${this.root}${path.sep}`)) {
        throw new GenerationSafetyError(`Pinned rename parent escaped repository: ${destinationPath}`);
      }
      if (!sameSnapshot(this.pinnedFile(sourceBasename).snapshot, expectedSource) ||
          !sameSnapshot(this.pinnedSnapshot(destinationBasename), expectedDestination)) {
        throw new GenerationSafetyError(`Path changed during pinned rename: ${destinationPath}`);
      }
      if (!expectedDestination.exists) {
        beforeNoReplace?.();
        fs.linkSync(sourceBasename, destinationBasename);
        const linked = this.pinnedFile(destinationBasename).snapshot;
        if (!sameIdentity(source.identity, linked.identity) || source.byteDigest !== linked.byteDigest) {
          throw new GenerationSafetyError(`Published destination mismatch: ${destinationPath}`);
        }
        fsyncDirectory('.', pinnedParent);
        if (!sameSnapshot(this.pinnedFile(sourceBasename).snapshot, expectedSource) ||
            !sameIdentity(this.pinnedFile(destinationBasename).snapshot.identity, expectedSource.identity)) {
          throw new GenerationSafetyError(`Path changed before source unlink: ${destinationPath}`);
        }
        fs.unlinkSync(sourceBasename);
        fsyncDirectory('.', pinnedParent);
      } else {
        fs.renameSync(sourceBasename, destinationBasename);
        fsyncDirectory('.', pinnedParent);
      }
    });
  }

  unlink(relativePath: string, expected?: FileSnapshot): void {
    this.withPinnedParent(relativePath, (basename, pinnedParent) => {
      const actual = this.pinnedFile(basename).snapshot;
      if (expected && !sameSnapshot(actual, expected)) {
        throw new GenerationSafetyError(`Path changed before unlink: ${relativePath}`);
      }
      fs.unlinkSync(basename);
      fsyncDirectory('.', pinnedParent);
    });
  }

  unlinkIdentity(relativePath: string, expected: FileIdentity): void {
    this.withPinnedParent(relativePath, (basename, pinnedParent) => {
      const stat = fs.lstatSync(basename, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || !sameIdentity(identity(stat), expected)) {
        throw new GenerationSafetyError(`Path changed before unlink: ${relativePath}`);
      }
      fs.unlinkSync(basename);
      fsyncDirectory('.', pinnedParent);
    });
  }

  touch(relativePath: string, expected: FileIdentity): void {
    this.withPinnedParent(relativePath, basename => {
      const stat = fs.lstatSync(basename, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || !sameIdentity(identity(stat), expected)) {
        throw new GenerationSafetyError(`Path changed before heartbeat: ${relativePath}`);
      }
      const now = new Date();
      fs.utimesSync(basename, now, now);
    });
  }

  removeEmptyDirectory(relativePath: string, expected: FileIdentity): void {
    this.withPinnedParent(relativePath, (basename, pinnedParent) => {
      const stat = fs.lstatSync(basename, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || !sameIdentity(identity(stat), expected)) {
        throw new GenerationSafetyError(`Created directory identity changed: ${relativePath}`);
      }
      if (fs.readdirSync(basename).length !== 0) return;
      fs.rmdirSync(basename);
      fsyncDirectory('.', pinnedParent);
    });
  }

  directoryIdentity(relativePath: string): FileIdentity {
    return this.withPinnedParent(relativePath, basename => {
      const stat = fs.lstatSync(basename, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new GenerationSafetyError(`Expected real directory: ${relativePath}`);
      }
      return identity(stat);
    });
  }

  listDirectory(relativePath: string): string[] {
    return this.withPinnedParent(relativePath, basename => {
      const stat = fs.lstatSync(basename, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new GenerationSafetyError(`Expected real directory: ${relativePath}`);
      }
      return sortStrings(fs.readdirSync(basename));
    });
  }

  hasExactPath(relativePath: string): boolean {
    const originalCwd = process.cwd();
    try {
      this.assertRootIdentity();
      process.chdir(this.root);
      const segments = relativePath.split('/');
      for (const [index, segment] of segments.entries()) {
        if (!fs.readdirSync('.').includes(segment)) return false;
        const before = fs.lstatSync(segment, { bigint: true });
        if (before.isSymbolicLink()) {
          throw new GenerationSafetyError(`Symbolic links are forbidden in generation paths: ${relativePath}`);
        }
        if (index < segments.length - 1) {
          if (!before.isDirectory()) {
            throw new GenerationSafetyError(`Generation path parent is not a directory: ${relativePath}`);
          }
          process.chdir(segment);
          const after = fs.statSync('.', { bigint: true });
          if (!sameIdentity(identity(before), identity(after))) {
            throw new GenerationSafetyError(`Exact path parent changed: ${relativePath}`);
          }
        }
      }
      return true;
    } finally {
      process.chdir(originalCwd);
    }
  }

  fsyncDirectoryPath(relativePath: string): void {
    this.withPinnedParent(relativePath, basename => {
      const before = fs.lstatSync(basename, { bigint: true });
      if (!before.isDirectory() || before.isSymbolicLink()) {
        throw new GenerationSafetyError(`Expected directory: ${relativePath}`);
      }
      fsyncDirectory(basename, identity(before));
    });
  }
}

function manifestPayload(manifest: Omit<GenerationManifest, 'manifestDigest'>): object {
  return {
    schemaVersion: manifest.schemaVersion,
    generatorVersion: manifest.generatorVersion,
    ownershipNamespace: manifest.ownershipNamespace,
    provenanceAlgorithm: manifest.provenanceAlgorithm,
    sources: manifest.sources,
    outputs: manifest.outputs
  };
}

function serializeManifest(manifest: GenerationManifest): Buffer {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function provenanceDigest(output: Omit<OutputProvenance, 'provenanceDigest'>, sources: SourceProvenance[]): string {
  const sourceById = new Map(sources.map(source => [source.id, source]));
  return sha256(canonicalJson({
    schemaVersion: output.schemaVersion,
    generatorVersion: output.generatorVersion,
    ownershipId: output.ownershipId,
    outputPath: output.outputPath,
    sourceIds: output.sourceIds,
    sources: output.sourceIds.map(sourceId => {
      const source = sourceById.get(sourceId);
      if (!source) throw new GenerationSafetyError(`Missing provenance source: ${sourceId}`);
      return source;
    }),
    byteDigest: output.byteDigest
  }));
}

function validateDefinition(rootInput: string, definition: GenerationDefinition): GenerationContext {
  const filesystem = new HardenedFilesystem(rootInput);
  if (definition.schemaVersion !== GENERATION_SCHEMA_VERSION) {
    throw new GenerationSafetyError(`Unsupported generation schema: ${definition.schemaVersion}`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(definition.generatorVersion)) {
    throw new GenerationSafetyError(`Invalid generator version: ${definition.generatorVersion}`);
  }
  assertId(definition.ownership.namespace, 'ownership namespace');
  assertRelativePath(definition.manifestPath, 'manifestPath');
  assertNotInternalPath(definition.manifestPath, 'manifestPath');
  if (definition.managedRoots.length === 0) throw new GenerationSafetyError('Managed roots are empty');
  for (const root of definition.managedRoots) {
    assertRelativePath(root, 'managedRoot');
    assertNotInternalPath(root, 'managedRoot');
  }
  assertPathSet(definition.managedRoots, 'managed roots');
  if (!isWithinManagedRoot(definition.manifestPath, definition.managedRoots)) {
    throw new GenerationSafetyError(`Manifest is outside managed roots: ${definition.manifestPath}`);
  }

  const ownershipById = new Map<string, Set<string>>();
  const ownershipByPath = new Map<string, string>();
  const portableOwner = new Map<string, string>();
  const ownedPaths: Array<{ id: string; path: string }> = [];
  for (const owned of definition.ownership.outputs) {
    assertId(owned.id, 'ownership id');
    if (ownershipById.has(owned.id) || owned.paths.length === 0) {
      throw new GenerationSafetyError(`Invalid duplicate or empty ownership id: ${owned.id}`);
    }
    const paths = new Set<string>();
    for (const ownedPath of owned.paths) {
      assertRelativePath(ownedPath, `ownership ${owned.id}`);
      assertNotInternalPath(ownedPath, `ownership ${owned.id}`);
      if (!isWithinManagedRoot(ownedPath, definition.managedRoots)) {
        throw new GenerationSafetyError(`Owned path is outside managed roots: ${ownedPath}`);
      }
      if (ownershipByPath.has(ownedPath)) throw new GenerationSafetyError(`Duplicate owned path: ${ownedPath}`);
      const folded = portablePathIdentity(ownedPath);
      const priorOwner = portableOwner.get(folded);
      if (priorOwner !== undefined && priorOwner !== owned.id) {
        throw new GenerationSafetyError(`Portable ownership collision: ${ownedPath}`);
      }
      portableOwner.set(folded, owned.id);
      ownershipByPath.set(ownedPath, owned.id);
      paths.add(ownedPath);
      ownedPaths.push({ id: owned.id, path: ownedPath });
    }
    ownershipById.set(owned.id, paths);
  }
  assertOwnershipPathSet(ownedPaths);

  const sourceIds = new Set<string>();
  const sourcePaths: string[] = [];
  for (const source of definition.sources) {
    assertId(source.id, 'source id');
    if (sourceIds.has(source.id)) throw new GenerationSafetyError(`Duplicate source id: ${source.id}`);
    sourceIds.add(source.id);
    assertRelativePath(source.path, `source ${source.id}`);
    assertNotInternalPath(source.path, `source ${source.id}`);
    if (isWithinManagedRoot(source.path, definition.managedRoots)) {
      throw new GenerationSafetyError(`Source is inside managed roots: ${source.path}`);
    }
    sourcePaths.push(source.path);
  }
  assertPathSet(sourcePaths, 'source paths');

  const outputPaths: string[] = [];
  const currentOwnershipIds = new Set<string>();
  const usedSourceIds = new Set<string>();
  for (const output of definition.outputs) {
    assertId(output.ownershipId, 'output ownership id');
    assertRelativePath(output.outputPath, 'outputPath');
    assertNotInternalPath(output.outputPath, 'outputPath');
    if (!isWithinManagedRoot(output.outputPath, definition.managedRoots) ||
        ownershipByPath.get(output.outputPath) !== output.ownershipId ||
        currentOwnershipIds.has(output.ownershipId)) {
      throw new GenerationSafetyError(`Output lacks unique code-owned identity: ${output.outputPath}`);
    }
    if (output.sourceIds.length === 0 || new Set(output.sourceIds).size !== output.sourceIds.length) {
      throw new GenerationSafetyError(`Output has invalid source list: ${output.outputPath}`);
    }
    for (const sourceId of output.sourceIds) {
      if (!sourceIds.has(sourceId)) throw new GenerationSafetyError(`Unknown source id: ${sourceId}`);
      usedSourceIds.add(sourceId);
    }
    currentOwnershipIds.add(output.ownershipId);
    outputPaths.push(output.outputPath);
  }
  const unusedSources = sortStrings([...sourceIds].filter(sourceId => !usedSourceIds.has(sourceId)));
  if (unusedSources.length > 0) {
    throw new GenerationSafetyError(`Unused canonical sources: ${unusedSources.join(', ')}`);
  }
  assertPathSet([...outputPaths, definition.manifestPath], 'output and sidecar paths');
  assertPathSet([...sourcePaths, ...outputPaths, definition.manifestPath], 'generation paths');
  return { root: filesystem.root, definition, filesystem, ownershipById, ownershipByPath };
}

function compileGeneration(rootInput: string, definition: GenerationDefinition): CompiledGeneration {
  const validated = validateDefinition(rootInput, definition);
  const sourceBytes = new Map(definition.sources.map(source => [
    source.id,
    validated.filesystem.read(source.path).bytes
  ]));
  const sources = [...definition.sources].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  ).map(source => {
    const bytes = sourceBytes.get(source.id)!;
    return { id: source.id, path: source.path, byteDigest: sha256(bytes) };
  });
  const outputs = [...definition.outputs].sort((left, right) =>
    left.outputPath < right.outputPath ? -1 : left.outputPath > right.outputPath ? 1 : 0
  ).map(output => {
    validated.filesystem.assertSafePath(output.outputPath, true);
    const bytes = Buffer.concat(output.sourceIds.map(sourceId => sourceBytes.get(sourceId)!));
    const base: Omit<OutputProvenance, 'provenanceDigest'> = {
      schemaVersion: GENERATION_SCHEMA_VERSION,
      generatorVersion: definition.generatorVersion,
      ownershipId: output.ownershipId,
      outputPath: output.outputPath,
      sourceIds: [...output.sourceIds],
      byteDigest: sha256(bytes)
    };
    return { ...base, provenanceDigest: provenanceDigest(base, sources), bytes };
  });
  const payload: Omit<GenerationManifest, 'manifestDigest'> = {
    schemaVersion: GENERATION_SCHEMA_VERSION,
    generatorVersion: definition.generatorVersion,
    ownershipNamespace: definition.ownership.namespace,
    provenanceAlgorithm: 'sha256-json-v1',
    sources,
    outputs: outputs.map(({ bytes: _bytes, ...record }) => record)
  };
  const manifest: GenerationManifest = {
    ...payload,
    manifestDigest: sha256(canonicalJson(manifestPayload(payload)))
  };
  return {
    root: validated.filesystem.root,
    definition,
    filesystem: validated.filesystem,
    ownershipById: validated.ownershipById,
    ownershipByPath: validated.ownershipByPath,
    sources,
    outputs,
    manifest,
    manifestBytes: serializeManifest(manifest)
  };
}

function parseManifest(bytes: Buffer, compiled: CompiledGeneration): LoadedManifest {
  let raw: any;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new GenerationSafetyError('Generation manifest is not valid JSON');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      raw.schemaVersion !== GENERATION_SCHEMA_VERSION ||
      raw.ownershipNamespace !== compiled.definition.ownership.namespace ||
      raw.provenanceAlgorithm !== 'sha256-json-v1' ||
      typeof raw.generatorVersion !== 'string' || !Array.isArray(raw.sources) ||
      !Array.isArray(raw.outputs) || !DIGEST_PATTERN.test(raw.manifestDigest)) {
    throw new GenerationSafetyError('Generation manifest has invalid schema or namespace');
  }
  const sources: SourceProvenance[] = raw.sources.map((source: any) => {
    if (!source || typeof source !== 'object' || !ID_PATTERN.test(source.id) ||
        typeof source.path !== 'string' || !DIGEST_PATTERN.test(source.byteDigest)) {
      throw new GenerationSafetyError('Generation manifest has invalid source record');
    }
    assertRelativePath(source.path, `manifest source ${source.id}`);
    assertNotInternalPath(source.path, `manifest source ${source.id}`);
    if (isWithinManagedRoot(source.path, compiled.definition.managedRoots)) {
      throw new GenerationSafetyError(`Manifest source is inside managed roots: ${source.path}`);
    }
    compiled.filesystem.assertSafePath(source.path, true);
    return { id: source.id, path: source.path, byteDigest: source.byteDigest };
  });
  assertPathSet(sources.map(source => source.path), 'manifest source paths');
  const sourceIds = new Set(sources.map(source => source.id));
  if (sourceIds.size !== sources.length) throw new GenerationSafetyError('Duplicate manifest source id');
  const outputs: OutputProvenance[] = raw.outputs.map((output: any) => {
    if (!output || typeof output !== 'object' || output.schemaVersion !== GENERATION_SCHEMA_VERSION ||
        output.generatorVersion !== raw.generatorVersion || !ID_PATTERN.test(output.ownershipId) ||
        typeof output.outputPath !== 'string' || !Array.isArray(output.sourceIds) ||
        output.sourceIds.some((sourceId: unknown) => typeof sourceId !== 'string') ||
        !DIGEST_PATTERN.test(output.byteDigest) || !DIGEST_PATTERN.test(output.provenanceDigest)) {
      throw new GenerationSafetyError('Generation manifest has invalid output record');
    }
    assertRelativePath(output.outputPath, `manifest output ${output.ownershipId}`);
    assertNotInternalPath(output.outputPath, `manifest output ${output.ownershipId}`);
    const allowedPaths = compiled.ownershipById.get(output.ownershipId);
    if (!allowedPaths?.has(output.outputPath) ||
        new Set(output.sourceIds).size !== output.sourceIds.length ||
        output.sourceIds.some((sourceId: string) => !sourceIds.has(sourceId))) {
      throw new GenerationSafetyError(`Manifest path is not code-owned: ${output.outputPath}`);
    }
    compiled.filesystem.assertSafePath(output.outputPath, true);
    return {
      schemaVersion: GENERATION_SCHEMA_VERSION,
      generatorVersion: output.generatorVersion,
      ownershipId: output.ownershipId,
      outputPath: output.outputPath,
      sourceIds: [...output.sourceIds],
      byteDigest: output.byteDigest,
      provenanceDigest: output.provenanceDigest
    };
  });
  const outputIds = new Set(outputs.map(output => output.ownershipId));
  if (outputIds.size !== outputs.length) throw new GenerationSafetyError('Duplicate manifest ownership id');
  const usedSourceIds = new Set(outputs.flatMap(output => output.sourceIds));
  if (sources.some(source => !usedSourceIds.has(source.id))) {
    throw new GenerationSafetyError('Generation manifest has unused source records');
  }
  const manifest: GenerationManifest = {
    schemaVersion: GENERATION_SCHEMA_VERSION,
    generatorVersion: raw.generatorVersion,
    ownershipNamespace: raw.ownershipNamespace,
    provenanceAlgorithm: 'sha256-json-v1',
    sources,
    outputs,
    manifestDigest: raw.manifestDigest
  };
  const trusted = raw.manifestDigest === sha256(canonicalJson(manifestPayload(manifest))) &&
    outputs.every(output => {
      const { provenanceDigest: _digest, ...base } = output;
      return output.provenanceDigest === provenanceDigest(base, sources);
    });
  const ordered = sources.every((source, index) => index === 0 || sources[index - 1].id < source.id) &&
    outputs.every((output, index) => index === 0 || outputs[index - 1].outputPath < output.outputPath);
  return { manifest, bytes, trusted, canonical: ordered && bytes.equals(serializeManifest(manifest)) };
}

function loadManifest(compiled: CompiledGeneration): LoadedManifest | null {
  const stat = compiled.filesystem.assertSafePath(compiled.definition.manifestPath, true);
  return stat === null ? null : parseManifest(
    compiled.filesystem.read(compiled.definition.manifestPath).bytes,
    compiled
  );
}

function sameOutput(left: OutputProvenance | undefined, right: OutputProvenance): boolean {
  return left !== undefined && left.schemaVersion === right.schemaVersion &&
    left.generatorVersion === right.generatorVersion && left.ownershipId === right.ownershipId &&
    left.outputPath === right.outputPath && left.byteDigest === right.byteDigest &&
    left.provenanceDigest === right.provenanceDigest &&
    left.sourceIds.length === right.sourceIds.length &&
    left.sourceIds.every((sourceId, index) => sourceId === right.sourceIds[index]);
}

function pendingJournalPath(filesystem: HardenedFilesystem): string | null {
  if (filesystem.assertSafePath(JOURNAL_PATH, true) !== null) return JOURNAL_PATH;
  if (filesystem.assertSafePath(BOOTSTRAP_JOURNAL_PATH, true) !== null) return BOOTSTRAP_JOURNAL_PATH;
  return null;
}

function pendingJournal(filesystem: HardenedFilesystem): boolean {
  return pendingJournalPath(filesystem) !== null;
}

export function checkGeneratedAssets(root: string, definition: GenerationDefinition): GenerationCheckResult {
  if (generationActive) throw new GenerationSafetyError('Generation API already running in this process');
  generationActive = true;
  try {
    const initial = validateDefinition(root, definition);
    if (pendingJournal(initial.filesystem)) {
      return {
        clean: false,
        missing: [],
        byteDrifted: [],
        provenanceDrifted: [],
        stale: [],
        pendingTransaction: [pendingJournalPath(initial.filesystem)!]
      };
    }
    const compiled = compileGeneration(root, definition);
    const prior = loadManifest(compiled);
    const priorByOwnership = new Map(prior?.manifest.outputs.map(output => [output.ownershipId, output]));
    const currentOwnership = new Set(compiled.outputs.map(output => output.ownershipId));
    const missing: string[] = [];
    const byteDrifted: string[] = [];
    const provenanceDrifted: string[] = [];

    for (const output of compiled.outputs) {
      const stat = compiled.filesystem.assertSafePath(output.outputPath, true);
      if (stat === null) missing.push(output.outputPath);
      else {
        const snapshot = compiled.filesystem.read(output.outputPath).snapshot;
        if (snapshot.byteDigest !== output.byteDigest || !modeMatches(snapshot.mode, GENERATED_MODE)) {
          byteDrifted.push(output.outputPath);
        }
      }
      if (!sameOutput(priorByOwnership.get(output.ownershipId), output)) {
        provenanceDrifted.push(output.outputPath);
      }
    }
    if (prior !== null && (!prior.canonical || !prior.trusted)) {
      provenanceDrifted.push(compiled.definition.manifestPath);
    }
    if (prior !== null &&
        !modeMatches(compiled.filesystem.read(compiled.definition.manifestPath).snapshot.mode, GENERATED_MODE)) {
      provenanceDrifted.push(compiled.definition.manifestPath);
    }
    const stale = prior?.manifest.outputs
      .filter(output => !currentOwnership.has(output.ownershipId))
      .map(output => output.outputPath) ?? [];
    for (const stalePath of stale) compiled.filesystem.assertSafePath(stalePath, true);
    const result = {
      missing: sortStrings(missing),
      byteDrifted: sortStrings(byteDrifted),
      provenanceDrifted: sortStrings(new Set(provenanceDrifted)),
      stale: sortStrings(stale),
      pendingTransaction: []
    };
    return { clean: Object.values(result).every(values => values.length === 0), ...result };
  } finally {
    generationActive = false;
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function getBootToken(filesystem: HardenedFilesystem): string {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const stat = filesystem.assertSafePath(BOOT_TOKEN_PATH, true);
    if (stat !== null) {
      let record: any;
      try {
        record = JSON.parse(filesystem.read(BOOT_TOKEN_PATH).bytes.toString('utf8'));
      } catch {
        record = null;
      }
      if (!record || typeof record.token !== 'string' || !TOKEN_PATTERN.test(record.token)) {
        throw new GenerationSafetyError('Generation boot token is malformed');
      }
      return record.token;
    }
    const token = randomBytes(16).toString('hex');
    const temporary = `${BOOT_TOKEN_PATH}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
    filesystem.writeExclusive(temporary, Buffer.from(`${JSON.stringify({ token })}\n`), PRIVATE_MODE);
    try {
      filesystem.linkExclusiveWithinParent(temporary, BOOT_TOKEN_PATH);
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    } finally {
      const temporaryStat = filesystem.assertSafePath(temporary, true);
      if (temporaryStat !== null) filesystem.unlink(temporary, filesystem.read(temporary).snapshot);
    }
  }
  throw new GenerationSafetyError('Unable to initialize generation boot token');
}

interface LockHandle {
  release(): void;
  identity: FileIdentity;
}

function acquireLock(filesystem: HardenedFilesystem): LockHandle {
  const bootToken = getBootToken(filesystem);
  const nonce = randomBytes(16).toString('hex');
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const temporary = `${LOCK_PATH}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
    filesystem.writeExclusive(
      temporary,
      Buffer.from(`${JSON.stringify({ pid: process.pid, bootToken, nonce })}\n`),
      PRIVATE_MODE
    );
    try {
      try {
        filesystem.linkExclusiveWithinParent(temporary, LOCK_PATH);
        const published = filesystem.read(LOCK_PATH);
        return {
          identity: published.snapshot.identity!,
          release: () => {
            const lock = filesystem.read(LOCK_PATH);
            let owner: any;
            try {
              owner = JSON.parse(lock.bytes.toString('utf8'));
            } catch {
              throw new GenerationSafetyError('Generation lock changed before release');
            }
            if (owner.pid !== process.pid || owner.bootToken !== bootToken || owner.nonce !== nonce ||
                !sameIdentity(lock.snapshot.identity, published.snapshot.identity)) {
              throw new GenerationSafetyError('Generation lock ownership changed');
            }
            filesystem.unlink(LOCK_PATH, lock.snapshot);
          }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      } finally {
        const temporaryStat = filesystem.assertSafePath(temporary, true);
        if (temporaryStat !== null) filesystem.unlink(temporary, filesystem.read(temporary).snapshot);
      }
    } catch (error) {
      const temporaryStat = filesystem.assertSafePath(temporary, true);
      if (temporaryStat !== null) filesystem.unlink(temporary, filesystem.read(temporary).snapshot);
      throw error;
    }

    const lock = filesystem.read(LOCK_PATH);
    let owner: any = null;
    try {
      owner = JSON.parse(lock.bytes.toString('utf8'));
    } catch {
      owner = null;
    }
    // A live PID with a matching boot token is a live owner: never taken over,
    // regardless of heartbeat age. Only dead, mismatched, or malformed locks
    // are reclaimed, so PID reuse cannot steal a fresh (or stale) live lock.
    if (owner && Number.isSafeInteger(owner.pid) && typeof owner.bootToken === 'string' &&
        typeof owner.nonce === 'string' && processAlive(owner.pid) &&
        owner.bootToken === bootToken) {
      throw new GenerationSafetyError('Generation already running for repository');
    }
    const claimed = `${LOCK_PATH}.stale-${process.pid}-${randomBytes(6).toString('hex')}`;
    filesystem.renameWithinParent(LOCK_PATH, claimed, lock.snapshot, { exists: false });
    filesystem.unlink(claimed, lock.snapshot);
  }
  throw new GenerationSafetyError('Unable to acquire generation lock');
}

function transactionPayload(journal: TransactionJournal): TransactionJournalPayload {
  const payload: TransactionJournalPayload = {
    schemaVersion: journal.schemaVersion,
    ownershipNamespace: journal.ownershipNamespace,
    transactionId: journal.transactionId,
    phase: journal.phase,
    actions: journal.actions,
    createdDirectories: journal.createdDirectories
  };
  if (journal.temporaryPath !== undefined) payload.temporaryPath = journal.temporaryPath;
  if (journal.temporarySecret !== undefined) payload.temporarySecret = journal.temporarySecret;
  return payload;
}

function serializeJournal(payload: TransactionJournalPayload): Buffer {
  const journal: TransactionJournal = {
    ...payload,
    journalDigest: sha256(canonicalJson(payload))
  };
  return Buffer.from(`${JSON.stringify(
    journal,
    (_key, value) => typeof value === 'bigint' ? value.toString() : value,
    2
  )}\n`, 'utf8');
}

function parseIdentity(raw: any, label: string): FileIdentity {
  if (!raw || typeof raw.dev !== 'string' || !/^\d+$/.test(raw.dev) ||
      typeof raw.ino !== 'string' || !/^\d+$/.test(raw.ino)) {
    throw new GenerationSafetyError(`${label} has invalid identity`);
  }
  return { dev: BigInt(raw.dev), ino: BigInt(raw.ino) };
}

function validateJournal(context: GenerationContext, bytes: Buffer): TransactionJournal {
  let journal: any;
  try {
    journal = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new GenerationSafetyError('Pending transaction journal is malformed');
  }
  if (!journal || journal.schemaVersion !== 1 ||
      journal.ownershipNamespace !== context.definition.ownership.namespace ||
      typeof journal.transactionId !== 'string' || !TRANSACTION_ID_PATTERN.test(journal.transactionId) ||
      !['prepared', 'applying', 'committed', 'cleaning'].includes(journal.phase) ||
      !Array.isArray(journal.actions) || !Array.isArray(journal.createdDirectories) ||
      !DIGEST_PATTERN.test(journal.journalDigest)) {
    throw new GenerationSafetyError('Pending transaction journal has invalid schema');
  }
  for (const action of journal.actions as TransactionAction[]) {
    if (!action || !['write', 'remove', 'case-remove'].includes(action.kind) ||
        typeof action.path !== 'string') {
      throw new GenerationSafetyError('Pending transaction has invalid action');
    }
    assertRelativePath(action.path, 'journal action path');
    if (action.path !== context.definition.manifestPath &&
        context.ownershipByPath.get(action.path) === undefined) {
      throw new GenerationSafetyError(`Journal path is not code-owned: ${action.path}`);
    }
    if (!action.before || typeof action.before.exists !== 'boolean' || !action.parentGuard) {
      throw new GenerationSafetyError('Pending transaction has invalid snapshots');
    }
    if (action.before.identity !== undefined) {
      action.before.identity = parseIdentity(action.before.identity, 'journal snapshot');
    }
    if (typeof action.before.mode === 'string') action.before.mode = BigInt(action.before.mode);
    if (typeof action.before.mtimeNs === 'string') action.before.mtimeNs = BigInt(action.before.mtimeNs);
    action.parentGuard.identity = parseIdentity(action.parentGuard.identity, 'journal parent guard');
    if (action.stagePath !== undefined) {
      assertRelativePath(action.stagePath, 'journal stage path');
      if (!action.stagePath.startsWith(`${INTERNAL_DIR}/transactions/${journal.transactionId}/`)) {
        throw new GenerationSafetyError(`Journal stage path is unsafe: ${action.stagePath}`);
      }
    }
    for (const siblingPath of [action.installPath, action.backupPath, action.trashPath]) {
      if (siblingPath !== undefined) {
        assertRelativePath(siblingPath, 'journal sibling path');
        if (path.posix.dirname(siblingPath) !== path.posix.dirname(action.path) ||
            !path.posix.basename(siblingPath).startsWith(`.mdocs-${journal.transactionId}-`)) {
          throw new GenerationSafetyError(`Journal sibling path is unsafe: ${siblingPath}`);
        }
      }
    }
  }
  journal.createdDirectories = journal.createdDirectories.map((directory: any) => {
    if (!directory || typeof directory.path !== 'string' ||
        !['prepared', 'applying'].includes(directory.phase)) {
      throw new GenerationSafetyError('Pending transaction has invalid created directory');
    }
    assertRelativePath(directory.path, 'journal created directory');
    const ownedAncestor = journal.actions.some((action: TransactionAction) =>
      action.path.startsWith(`${directory.path}/`)
    );
    if (directory.path !== INTERNAL_DIR && !directory.path.startsWith(`${INTERNAL_DIR}/`) &&
        !ownedAncestor) {
      throw new GenerationSafetyError(`Journal created directory is not an owned ancestor: ${directory.path}`);
    }
    return directory.identity === undefined
      ? { path: directory.path, phase: directory.phase }
      : {
        path: directory.path,
        phase: directory.phase,
        identity: parseIdentity(directory.identity, 'journal created directory')
      };
  });
  if (new Set(journal.createdDirectories.map((directory: CreatedDirectory) => directory.path)).size !==
      journal.createdDirectories.length) {
    throw new GenerationSafetyError('Pending transaction has duplicate directory intents');
  }
  if (journal.temporaryPath !== undefined &&
      (typeof journal.temporaryPath !== 'string' || !BOOT_TEMP_PATTERN.test(journal.temporaryPath))) {
    throw new GenerationSafetyError('Pending transaction has invalid temporary path');
  }
  if ((journal.temporaryPath === undefined) !== (journal.temporarySecret === undefined) ||
      (journal.temporarySecret !== undefined &&
        (typeof journal.temporarySecret !== 'string' || !TOKEN_PATTERN.test(journal.temporarySecret)))) {
    throw new GenerationSafetyError('Pending transaction has invalid temporary secret');
  }
  const payload = transactionPayload(journal as TransactionJournal);
  if (journal.journalDigest !== sha256(canonicalJson(payload))) {
    throw new GenerationSafetyError('Pending transaction journal digest mismatch');
  }
  return journal as TransactionJournal;
}

function journalTemporaryPath(journalPath: string): string {
  const parent = path.posix.dirname(journalPath);
  const temporary = `journal-${process.pid}-${randomBytes(6).toString('hex')}`;
  return parent === '.' ? `${journalPath}.${temporary}` : `${parent}/${temporary}`;
}

function removePartialArtifact(filesystem: HardenedFilesystem, relativePath: string): void {
  try {
    const stat = filesystem.assertSafePath(relativePath, true);
    if (stat === null || !stat.isFile() || stat.isSymbolicLink()) return;
    filesystem.unlinkIdentity(relativePath, identity(stat));
  } catch {
    // Best-effort removal of a transaction-owned partial artifact; the original error stands.
  }
}

function replaceJournal(
  context: GenerationContext,
  journal: TransactionJournal,
  journalPath = JOURNAL_PATH
): TransactionJournal {
  const filesystem = context.filesystem;
  const current = filesystem.read(journalPath);
  const temporary = journalTemporaryPath(journalPath);
  try {
    filesystem.writeExclusive(temporary, serializeJournal(transactionPayload(journal)), PRIVATE_MODE);
  } catch (error) {
    removePartialArtifact(filesystem, temporary);
    throw error;
  }
  const staged = filesystem.read(temporary).snapshot;
  filesystem.renameWithinParent(temporary, journalPath, staged, current.snapshot);
  return validateJournal(context, filesystem.read(journalPath).bytes);
}

function publishJournal(
  context: GenerationContext,
  payload: TransactionJournalPayload,
  journalPath = JOURNAL_PATH,
  afterLinked?: () => void
): TransactionJournal {
  const filesystem = context.filesystem;
  const temporary = journalTemporaryPath(journalPath);
  if (journalPath === BOOTSTRAP_JOURNAL_PATH) {
    payload.temporaryPath = temporary;
    payload.temporarySecret = randomBytes(16).toString('hex');
  }
  try {
    filesystem.writeExclusive(temporary, serializeJournal(payload), PRIVATE_MODE);
  } catch (error) {
    removePartialArtifact(filesystem, temporary);
    throw error;
  }
  try {
    filesystem.linkExclusiveWithinParent(temporary, journalPath);
  } catch (error) {
    removePartialArtifact(filesystem, temporary);
    throw error;
  }
  // Temp and journal path are now duplicate entries hardlinked to one inode.
  // A GenerationInterruptionError models process death after the link and before
  // the source unlink: the duplicate remains for recovery to dedupe exactly once.
  try {
    afterLinked?.();
  } catch (error) {
    if (!(error instanceof GenerationInterruptionError) &&
        filesystem.assertSafePath(temporary, true) !== null) {
      filesystem.unlink(temporary, filesystem.read(temporary).snapshot);
    }
    throw error;
  }
  if (filesystem.assertSafePath(temporary, true) !== null) {
    filesystem.unlink(temporary, filesystem.read(temporary).snapshot);
  }
  return validateJournal(context, filesystem.read(journalPath).bytes);
}

function transitionJournal(
  context: GenerationContext,
  journal: TransactionJournal,
  phase: TransactionPhase,
  journalPath = JOURNAL_PATH
): TransactionJournal {
  return replaceJournal(context, { ...journal, phase }, journalPath);
}

function auxiliaryPaths(action: TransactionAction): string[] {
  return [action.stagePath, action.installPath, action.backupPath, action.trashPath]
    .filter((value): value is string => value !== undefined);
}

function cleanupJournalTemps(filesystem: HardenedFilesystem): void {
  if (filesystem.assertSafePath(INTERNAL_DIR, true) !== null) {
    for (const entry of filesystem.listDirectory(INTERNAL_DIR)) {
      if (!/^journal-\d+-[a-f0-9]{12}$/.test(entry)) continue;
      const journalTemp = `${INTERNAL_DIR}/${entry}`;
      filesystem.unlink(journalTemp, filesystem.read(journalTemp).snapshot);
    }
  }
}

interface VerifiedJournalFile {
  path: string;
  snapshot: FileSnapshot;
}

function cleanupAuthenticatedTemporary(
  filesystem: HardenedFilesystem,
  journal: TransactionJournal,
  authenticator: FileSnapshot | undefined
): void {
  // Deletion requires every proof: exact journal-recorded path, exact dev/ino
  // hardlink identity with the authenticating journal, byte-digest equality, and
  // the per-transaction CSPRNG secret bound into the temp bytes. A forged
  // replacement (copied bytes on a new inode, or new bytes on any inode) fails.
  if (journal.temporaryPath === undefined || journal.temporarySecret === undefined ||
      authenticator === undefined) {
    return;
  }
  const stat = filesystem.assertSafePath(journal.temporaryPath, true);
  if (stat === null || !stat.isFile() || stat.isSymbolicLink()) return;
  const temporary = filesystem.read(journal.temporaryPath);
  if (!sameIdentity(temporary.snapshot.identity, authenticator.identity) ||
      temporary.snapshot.byteDigest !== authenticator.byteDigest ||
      !temporary.bytes.toString('utf8').includes(journal.temporarySecret)) {
    return;
  }
  filesystem.unlink(journal.temporaryPath, temporary.snapshot);
}

function cleanupTransaction(
  context: GenerationContext,
  journal: TransactionJournal,
  removeGeneratedDirectories: boolean,
  activeJournalPath = JOURNAL_PATH,
  inactiveJournal?: VerifiedJournalFile
): void {
  const filesystem = context.filesystem;
  cleanupJournalTemps(filesystem);
  for (const action of journal.actions) {
    for (const auxiliaryPath of auxiliaryPaths(action)) {
      if (filesystem.assertSafePath(auxiliaryPath, true) === null) continue;
      const auxiliary = filesystem.read(auxiliaryPath).snapshot;
      const isOriginalLink = auxiliaryPath === action.backupPath || auxiliaryPath === action.trashPath;
      if (isOriginalLink) {
        if (!sameIdentity(auxiliary.identity, action.before.identity) ||
            auxiliary.byteDigest !== action.before.byteDigest) {
          throw new GenerationSafetyError(`Transaction artifact changed: ${auxiliaryPath}`);
        }
        filesystem.unlink(auxiliaryPath, auxiliary);
      } else {
        // Stage/install paths are journal-owned. Content may be partial after a crash
        // during write/fsync; identity-verified removal must not wedge on byte digest.
        filesystem.unlink(auxiliaryPath, auxiliary);
      }
    }
  }
  const transactionPath = `${INTERNAL_DIR}/transactions/${journal.transactionId}`;
  if (filesystem.assertSafePath(transactionPath, true) !== null) {
    filesystem.fsyncDirectoryPath(transactionPath);
  }

  const created = [...journal.createdDirectories]
    .sort((left, right) => right.path.split('/').length - left.path.split('/').length);
  const internalCreated = created.filter(directory =>
    directory.path === INTERNAL_DIR || directory.path.startsWith(`${INTERNAL_DIR}/`)
  );
  for (const directory of removeGeneratedDirectories ? created : internalCreated) {
    if (directory.path === INTERNAL_DIR) continue;
    const current = filesystem.assertSafePath(directory.path, true);
    if (current !== null && directory.identity !== undefined) {
      filesystem.removeEmptyDirectory(directory.path, directory.identity);
    } else if (current !== null && removeGeneratedDirectories &&
        (directory.phase === 'prepared' || journal.phase === 'applying') &&
        current.isDirectory() && !current.isSymbolicLink()) {
      filesystem.removeEmptyDirectory(directory.path, identity(current));
    }
  }

  const inactiveJournalPath = activeJournalPath === JOURNAL_PATH ? BOOTSTRAP_JOURNAL_PATH : JOURNAL_PATH;
  if (inactiveJournal !== undefined) {
    if (inactiveJournal.path !== inactiveJournalPath) {
      throw new GenerationSafetyError(`Inactive journal path mismatch: ${inactiveJournal.path}`);
    }
    filesystem.unlink(inactiveJournal.path, inactiveJournal.snapshot);
  } else if (filesystem.assertSafePath(inactiveJournalPath, true) !== null) {
    filesystem.unlink(inactiveJournalPath, filesystem.read(inactiveJournalPath).snapshot);
  }
  const journalSnapshot = filesystem.read(activeJournalPath).snapshot;
  filesystem.unlink(activeJournalPath, journalSnapshot);
  const internal = created.find(directory => directory.path === INTERNAL_DIR);
  const currentInternal = internal && filesystem.assertSafePath(INTERNAL_DIR, true);
  if (internal?.identity && currentInternal) {
    filesystem.removeEmptyDirectory(INTERNAL_DIR, internal.identity);
  } else if (internal && currentInternal && removeGeneratedDirectories &&
      (internal.phase === 'prepared' || journal.phase === 'applying') &&
      currentInternal.isDirectory() && !currentInternal.isSymbolicLink()) {
    filesystem.removeEmptyDirectory(INTERNAL_DIR, identity(currentInternal));
  }
}

function rollback(
  context: GenerationContext,
  journal: TransactionJournal,
  activeJournalPath = JOURNAL_PATH,
  inactiveJournal?: VerifiedJournalFile
): void {
  const filesystem = context.filesystem;
  for (const action of [...journal.actions].reverse()) {
    const current = filesystem.snapshot(action.path);
    if (action.backupPath) {
      const backupStat = filesystem.assertSafePath(action.backupPath, true);
      if (backupStat === null) {
        if (sameSnapshot(current, action.before)) {
          continue;
        }
        throw new GenerationSafetyError(`Transaction backup is missing: ${action.backupPath}`);
      }
      if (sameSnapshot(current, action.before)) continue;
      if (current.exists) {
        if (action.afterDigest === undefined || current.byteDigest !== action.afterDigest) {
          throw new GenerationSafetyError(`Rollback refuses changed generated path: ${action.path}`);
        }
        const rollbackPath = action.installPath ?? action.trashPath;
        if (!rollbackPath) throw new GenerationSafetyError(`Rollback path is missing: ${action.path}`);
        const rollbackTarget = filesystem.snapshot(rollbackPath);
        if (rollbackTarget.exists && sameIdentity(current.identity, rollbackTarget.identity)) {
          filesystem.unlink(action.path, current);
        } else {
          filesystem.renameWithinParent(action.path, rollbackPath, current, { exists: false });
        }
      }
      const backup = filesystem.read(action.backupPath).snapshot;
      filesystem.renameWithinParent(action.backupPath, action.path, backup, { exists: false });
      const restored = filesystem.read(action.path);
      if (!sameIdentity(restored.snapshot.identity, action.before.identity) ||
          restored.snapshot.byteDigest !== action.before.byteDigest) {
        throw new GenerationSafetyError(`Rollback restore mismatch: ${action.path}`);
      }
    } else if (current.exists) {
      if (action.afterDigest !== undefined && current.byteDigest !== action.afterDigest) {
        throw new GenerationSafetyError(`Rollback refuses changed generated path: ${action.path}`);
      }
      const rollbackPath = action.installPath ?? action.trashPath;
      if (!rollbackPath) throw new GenerationSafetyError(`Rollback path is missing: ${action.path}`);
      const rollbackTarget = filesystem.snapshot(rollbackPath);
      if (rollbackTarget.exists && sameIdentity(current.identity, rollbackTarget.identity)) {
        filesystem.unlink(action.path, current);
      } else {
        filesystem.renameWithinParent(action.path, rollbackPath, current, { exists: false });
      }
    }
  }
  cleanupTransaction(context, journal, true, activeJournalPath, inactiveJournal);
}

function cleanupOrphanTransactions(filesystem: HardenedFilesystem): void {
  const transactionsPath = `${INTERNAL_DIR}/transactions`;
  const stat = filesystem.assertSafePath(transactionsPath, true);
  if (stat === null) {
    cleanupJournalTemps(filesystem);
    const internal = filesystem.assertSafePath(INTERNAL_DIR, true);
    if (internal?.isDirectory()) filesystem.removeEmptyDirectory(INTERNAL_DIR, identity(internal));
    return;
  }
  if (!stat.isDirectory()) throw new GenerationSafetyError('Transaction staging path is not a directory');
  const transactionIds = filesystem.listDirectory(transactionsPath);
  for (const transactionId of transactionIds) {
    if (!TRANSACTION_ID_PATTERN.test(transactionId)) {
      throw new GenerationSafetyError(`Unknown orphan transaction path: ${transactionId}`);
    }
    const transactionPath = `${transactionsPath}/${transactionId}`;
    const transactionIdentity = filesystem.directoryIdentity(transactionPath);
    for (const entry of filesystem.listDirectory(transactionPath)) {
      if (!/^stage-(?:\d+|manifest)$/.test(entry)) {
        throw new GenerationSafetyError(`Unknown orphan transaction artifact: ${entry}`);
      }
      const artifact = `${transactionPath}/${entry}`;
      filesystem.unlink(artifact, filesystem.read(artifact).snapshot);
    }
    filesystem.fsyncDirectoryPath(transactionPath);
    filesystem.removeEmptyDirectory(transactionPath, transactionIdentity);
  }
  const transactionsIdentity = filesystem.directoryIdentity(transactionsPath);
  filesystem.removeEmptyDirectory(transactionsPath, transactionsIdentity);
  const internal = filesystem.assertSafePath(INTERNAL_DIR, true);
  if (internal?.isDirectory()) {
    cleanupJournalTemps(filesystem);
    filesystem.removeEmptyDirectory(INTERNAL_DIR, identity(internal));
  }
}

function recoverPending(context: GenerationContext): boolean {
  const activeJournalPath = pendingJournalPath(context.filesystem);
  if (activeJournalPath === null) {
    cleanupOrphanTransactions(context.filesystem);
    return false;
  }
  const activeRead = context.filesystem.read(activeJournalPath);
  let journal = validateJournal(context, activeRead.bytes);
  const inactiveJournalPath = activeJournalPath === JOURNAL_PATH ? BOOTSTRAP_JOURNAL_PATH : JOURNAL_PATH;
  let inactiveJournal: VerifiedJournalFile | undefined;
  if (context.filesystem.assertSafePath(inactiveJournalPath, true) !== null) {
    const inactiveRead = context.filesystem.read(inactiveJournalPath);
    const inactive = validateJournal(context, inactiveRead.bytes);
    if (inactive.transactionId !== journal.transactionId) {
      throw new GenerationSafetyError('Pending transaction journals disagree');
    }
    inactiveJournal = { path: inactiveJournalPath, snapshot: inactiveRead.snapshot };
  }
  cleanupAuthenticatedTemporary(
    context.filesystem,
    journal,
    activeJournalPath === BOOTSTRAP_JOURNAL_PATH ? activeRead.snapshot : inactiveJournal?.snapshot
  );
  if (journal.phase === 'committed' || journal.phase === 'cleaning') {
    if (journal.phase === 'committed') {
      journal = transitionJournal(context, journal, 'cleaning', activeJournalPath);
    }
    cleanupTransaction(context, journal, false, activeJournalPath, inactiveJournal);
  } else {
    rollback(context, journal, activeJournalPath, inactiveJournal);
  }
  return true;
}

function cleanupUnjournaledPlan(
  filesystem: HardenedFilesystem,
  actions: readonly TransactionAction[],
  createdDirectories: readonly CreatedDirectory[]
): void {
  for (const action of actions) {
    for (const auxiliaryPath of auxiliaryPaths(action)) {
      if (filesystem.assertSafePath(auxiliaryPath, true) !== null) {
        filesystem.unlink(auxiliaryPath, filesystem.read(auxiliaryPath).snapshot);
      }
    }
  }
  for (const directory of [...createdDirectories]
    .sort((left, right) => right.path.split('/').length - left.path.split('/').length)) {
    if (directory.identity !== undefined && filesystem.assertSafePath(directory.path, true) !== null) {
      filesystem.removeEmptyDirectory(directory.path, directory.identity);
    }
  }
}

function stageTransaction(
  compiled: CompiledGeneration,
  prior: LoadedManifest | null
): TransactionPlan {
  if (prior !== null && !prior.trusted) {
    throw new GenerationSafetyError('Refusing generation from untrusted generation manifest');
  }
  const filesystem = compiled.filesystem;
  const id = `${process.pid}-${randomBytes(12).toString('hex')}`;
  const base = `${INTERNAL_DIR}/transactions/${id}`;
  const sibling = (targetPath: string, label: string, index: number): string => {
    const parent = path.posix.dirname(targetPath);
    const basename = `.mdocs-${id}-${label}-${index}`;
    return parent === '.' ? basename : `${parent}/${basename}`;
  };
  const priorByOwnership = new Map(prior?.manifest.outputs.map(output => [output.ownershipId, output]));
  const currentIds = new Set(compiled.outputs.map(output => output.ownershipId));
  const actions: TransactionAction[] = [];
  const written: string[] = [];
  const deleted: string[] = [];
  const renamed: Array<{ from: string; to: string }> = [];
  const unchanged: string[] = [];
  const caseRenames = new Map<string, string>();
  const stageBytes = new Map<TransactionAction, Buffer>();
  const createdDirectories: CreatedDirectory[] = [];
  const recordCreated = (directory: CreatedDirectory): void => {
    const recorded = createdDirectories.find(created => created.path === directory.path);
    if (recorded === undefined) {
      createdDirectories.push(directory);
    } else {
      if (recorded.phase !== directory.phase) {
        throw new GenerationSafetyError(`Directory creation phase changed: ${directory.path}`);
      }
      if (directory.identity === undefined) return;
      if (recorded.identity !== undefined && !sameIdentity(recorded.identity, directory.identity)) {
        throw new GenerationSafetyError(`Created directory identity changed: ${directory.path}`);
      }
      recorded.identity = directory.identity;
    }
  };

  for (const output of compiled.outputs) {
    const priorOutput = priorByOwnership.get(output.ownershipId);
    if (priorOutput && priorOutput.outputPath !== output.outputPath) {
      if (portablePathIdentity(priorOutput.outputPath) !== portablePathIdentity(output.outputPath)) {
        throw new GenerationSafetyError(`Owned output rename requires explicit migration: ${priorOutput.outputPath}`);
      }
      const oldSnapshot = filesystem.snapshot(priorOutput.outputPath);
      const targetSnapshot = filesystem.snapshot(output.outputPath);
      if (oldSnapshot.exists && targetSnapshot.exists) {
        if (!sameIdentity(oldSnapshot.identity, targetSnapshot.identity) ||
            (filesystem.hasExactPath(priorOutput.outputPath) &&
              filesystem.hasExactPath(output.outputPath))) {
          throw new GenerationSafetyError(`Case-only rename target already exists: ${output.outputPath}`);
        }
      }
      if (oldSnapshot.exists) {
        actions.push({
          kind: 'case-remove',
          path: priorOutput.outputPath,
          before: oldSnapshot,
          parentGuard: filesystem.parentGuard(priorOutput.outputPath),
          backupPath: sibling(priorOutput.outputPath, 'backup-case', actions.length)
        });
      }
      caseRenames.set(output.outputPath, priorOutput.outputPath);
      renamed.push({ from: priorOutput.outputPath, to: output.outputPath });
    }
  }

  for (const output of compiled.outputs) {
    const caseSource = caseRenames.get(output.outputPath);
    const actual = filesystem.assertSafePath(output.outputPath, true) === null
      ? null
      : filesystem.read(output.outputPath);
    if (caseSource !== undefined || actual === null || actual.snapshot.byteDigest !== output.byteDigest ||
        !modeMatches(actual.snapshot.mode, GENERATED_MODE)) {
      const stagePath = `${base}/stage-${actions.length}`;
      const action: TransactionAction = {
        kind: 'write',
        path: output.outputPath,
        stagePath,
        before: caseSource === undefined ? actual?.snapshot ?? { exists: false } : { exists: false },
        parentGuard: filesystem.parentGuard(output.outputPath),
        afterDigest: output.byteDigest,
        installPath: sibling(output.outputPath, 'install', actions.length)
      };
      if (caseSource === undefined && actual !== null) {
        action.backupPath = sibling(output.outputPath, 'backup-replaced', actions.length);
      }
      actions.push(action);
      stageBytes.set(action, output.bytes);
      written.push(output.outputPath);
    } else {
      unchanged.push(output.outputPath);
    }
  }

  for (const stale of prior?.manifest.outputs.filter(output => !currentIds.has(output.ownershipId)) ?? []) {
    const current = filesystem.assertSafePath(stale.outputPath, true);
    if (current === null) continue;
    const snapshot = filesystem.read(stale.outputPath).snapshot;
    if (snapshot.byteDigest !== stale.byteDigest) {
      throw new GenerationSafetyError(`Refusing to delete modified stale output: ${stale.outputPath}`);
    }
    actions.push({
      kind: 'remove',
      path: stale.outputPath,
      before: snapshot,
      parentGuard: filesystem.parentGuard(stale.outputPath),
      backupPath: sibling(stale.outputPath, 'backup-stale', actions.length)
    });
    deleted.push(stale.outputPath);
  }

  const manifestCurrent = filesystem.assertSafePath(compiled.definition.manifestPath, true) === null
    ? null
    : filesystem.read(compiled.definition.manifestPath);
  if (manifestCurrent === null || !manifestCurrent.bytes.equals(compiled.manifestBytes) ||
      !modeMatches(manifestCurrent.snapshot.mode, GENERATED_MODE)) {
    const stagePath = `${base}/stage-manifest`;
    const action: TransactionAction = {
      kind: 'write',
      path: compiled.definition.manifestPath,
      stagePath,
      before: manifestCurrent?.snapshot ?? { exists: false },
      parentGuard: filesystem.parentGuard(compiled.definition.manifestPath),
      afterDigest: sha256(compiled.manifestBytes),
      installPath: sibling(compiled.definition.manifestPath, 'install-manifest', actions.length)
    };
    if (manifestCurrent !== null) {
      action.backupPath = sibling(compiled.definition.manifestPath, 'backup-manifest', actions.length);
    }
    actions.push(action);
    stageBytes.set(action, compiled.manifestBytes);
    written.push(compiled.definition.manifestPath);
  } else {
    unchanged.push(compiled.definition.manifestPath);
  }

  for (const action of actions) {
    let currentPath = '';
    for (const segment of action.parentGuard.parentPath.split('/').filter(Boolean)) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      if (filesystem.assertSafePath(currentPath, true) === null) {
        recordCreated({ path: currentPath, phase: 'applying' });
      }
    }
  }

  const preparedParents = [JOURNAL_PATH, ...actions.flatMap(action => action.stagePath ? [action.stagePath] : [])];
  for (const preparedPath of preparedParents) {
    const parentPath = path.posix.dirname(preparedPath);
    let currentPath = '';
    for (const segment of parentPath.split('/').filter(Boolean)) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      if (filesystem.assertSafePath(currentPath, true) === null) {
        recordCreated({ path: currentPath, phase: 'prepared' });
      }
    }
  }
  return {
    id,
    actions,
    written: sortStrings(written),
    deleted: sortStrings(deleted),
    renamed: renamed.sort((left, right) => left.to < right.to ? -1 : left.to > right.to ? 1 : 0),
    unchanged: sortStrings(unchanged),
    createdDirectories,
    stageBytes
  };
}

function executeTransaction(
  compiled: CompiledGeneration,
  plan: TransactionPlan,
  hooks: GenerationHooks | undefined,
  heartbeat?: () => void
): void {
  if (plan.actions.length === 0) return;
  heartbeat?.();
  const payload: TransactionJournalPayload = {
    schemaVersion: 1,
    ownershipNamespace: compiled.definition.ownership.namespace,
    transactionId: plan.id,
    phase: 'prepared',
    actions: plan.actions,
    createdDirectories: plan.createdDirectories
  };
  let journal: TransactionJournal;
  let activeJournalPath = BOOTSTRAP_JOURNAL_PATH;
  try {
    journal = publishJournal(compiled, payload, activeJournalPath, hooks?.afterJournalLinked);
  } catch (error) {
    if (!pendingJournal(compiled.filesystem)) {
      cleanupUnjournaledPlan(compiled.filesystem, plan.actions, plan.createdDirectories);
    }
    throw error;
  }
  const recordCreated = (directory: CreatedDirectory): void => {
    if (directory.identity === undefined) {
      throw new GenerationSafetyError(`Created directory lacks identity: ${directory.path}`);
    }
    const intended = journal.createdDirectories.find(created => created.path === directory.path);
    if (intended === undefined) {
      throw new GenerationSafetyError(`Directory creation was not journaled: ${directory.path}`);
    }
    if (intended.identity !== undefined && !sameIdentity(intended.identity, directory.identity)) {
      throw new GenerationSafetyError(`Created directory identity changed: ${directory.path}`);
    }
    intended.identity = directory.identity;
    journal = replaceJournal(compiled, journal, activeJournalPath);
  };
  try {
    compiled.filesystem.ensureParent(
      compiled.filesystem.parentGuard(JOURNAL_PATH),
      'prepared',
      recordCreated,
      directory => hooks?.afterDirectoryCreated?.(directory)
    );
    for (const action of plan.actions) {
      if (!action.stagePath) continue;
      try {
        compiled.filesystem.writeExclusive(
          action.stagePath,
          plan.stageBytes.get(action)!,
          GENERATED_MODE,
          recordCreated,
          'prepared',
          directory => hooks?.afterDirectoryCreated?.(directory)
        );
      } catch (error) {
        removePartialArtifact(compiled.filesystem, action.stagePath);
        throw error;
      }
    }
    journal = publishJournal(compiled, transactionPayload(journal), JOURNAL_PATH);
    activeJournalPath = JOURNAL_PATH;
    const bootstrap = compiled.filesystem.read(BOOTSTRAP_JOURNAL_PATH).snapshot;
    compiled.filesystem.unlink(BOOTSTRAP_JOURNAL_PATH, bootstrap);
    hooks?.afterJournalWritten?.();
    hooks?.afterJournalPhase?.('prepared');
    journal = transitionJournal(compiled, journal, 'applying', activeJournalPath);
    hooks?.afterJournalPhase?.('applying');
    for (let index = 0; index < plan.actions.length; index += 1) {
      heartbeat?.();
      const action = plan.actions[index];
      const context: GenerationOperationContext = { index, kind: action.kind, path: action.path };
      hooks?.beforeOperation?.(context);
      if (action.kind === 'write') {
        if (!action.stagePath || !action.installPath || !action.afterDigest) {
          throw new GenerationSafetyError('Invalid write transaction action');
        }
        compiled.filesystem.ensureParent(
          action.parentGuard,
          'applying',
          recordCreated,
          directory => hooks?.afterDirectoryCreated?.(directory)
        );
        const staged = compiled.filesystem.read(action.stagePath);
        if (staged.snapshot.byteDigest !== action.afterDigest ||
            !modeMatches(staged.snapshot.mode, GENERATED_MODE)) {
          throw new GenerationSafetyError(`Staged output changed: ${action.stagePath}`);
        }
        try {
          compiled.filesystem.writeExclusive(
            action.installPath,
            staged.bytes,
            GENERATED_MODE,
            recordCreated,
            'applying',
            directory => hooks?.afterDirectoryCreated?.(directory)
          );
        } catch (error) {
          removePartialArtifact(compiled.filesystem, action.installPath);
          throw error;
        }
        const install = compiled.filesystem.read(action.installPath).snapshot;
        if (action.before.exists) {
          if (!action.backupPath) throw new GenerationSafetyError('Replacement backup path is missing');
          compiled.filesystem.renameWithinParent(
            action.path,
            action.backupPath,
            action.before,
            { exists: false },
            () => hooks?.afterParentPinned?.(context)
          );
          compiled.filesystem.renameWithinParent(
            action.installPath,
            action.path,
            install,
            { exists: false },
            undefined,
            () => hooks?.beforeDestinationPublish?.(context)
          );
        } else {
          compiled.filesystem.renameWithinParent(
            action.installPath,
            action.path,
            install,
            { exists: false },
            () => hooks?.afterParentPinned?.(context),
            () => hooks?.beforeDestinationPublish?.(context)
          );
        }
        const installed = compiled.filesystem.read(action.path).snapshot;
        if (installed.byteDigest !== action.afterDigest || !modeMatches(installed.mode, GENERATED_MODE)) {
          throw new GenerationSafetyError(`Installed output changed: ${action.path}`);
        }
      } else {
        if (!action.backupPath) throw new GenerationSafetyError('Removal backup path is missing');
        compiled.filesystem.renameWithinParent(
          action.path,
          action.backupPath,
          action.before,
          { exists: false },
          () => hooks?.afterParentPinned?.(context)
        );
      }
      hooks?.afterOperation?.(context);
    }
    heartbeat?.();
    journal = transitionJournal(compiled, journal, 'committed', activeJournalPath);
  } catch (error) {
    if (error instanceof GenerationInterruptionError) throw error;
    try {
      rollback(compiled, journal, activeJournalPath);
    } catch (rollbackError) {
      throw new GenerationSafetyError(
        `Generation failed and rollback remains journaled: ${(rollbackError as Error).message}`
      );
    }
    throw error;
  }
  hooks?.afterJournalPhase?.('committed');
  journal = transitionJournal(compiled, journal, 'cleaning', activeJournalPath);
  hooks?.afterJournalPhase?.('cleaning');
  cleanupTransaction(compiled, journal, false, activeJournalPath);
}

export function generateAssets(
  root: string,
  definition: GenerationDefinition,
  options: GenerationOptions = {}
): GenerationResult {
  if (generationActive) throw new GenerationSafetyError('Generation already running in this process');
  generationActive = true;
  let lock: LockHandle | undefined;
  let recoveredTransaction = false;
  try {
    const initial = validateDefinition(root, definition);
    lock = acquireLock(initial.filesystem);
    options.hooks?.afterLockAcquired?.();
    const heartbeat = (): void => initial.filesystem.touch(LOCK_PATH, lock!.identity);
    heartbeat();
    recoveredTransaction = recoverPending(initial);
    const compiled = compileGeneration(root, definition);
    const prior = loadManifest(compiled);
    const plan = stageTransaction(compiled, prior);
    executeTransaction(compiled, plan, options.hooks, heartbeat);
    heartbeat();
    return {
      written: plan.written,
      deleted: plan.deleted,
      renamed: plan.renamed,
      unchanged: plan.unchanged,
      recoveredTransaction,
      consistency: 'journaled',
      manifest: compiled.manifest
    };
  } finally {
    try {
      lock?.release();
    } finally {
      generationActive = false;
    }
  }
}
