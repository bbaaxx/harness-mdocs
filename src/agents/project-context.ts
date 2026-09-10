import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export type ProjectContextErrorCode =
  | 'invalid-reference'
  | 'symlink-escape'
  | 'limit-exceeded'
  | 'concurrent-mutation';
export type ProjectEntryKind = 'file' | 'directory' | 'symlink' | 'other';

export interface ProjectReadContextOptions {
  readonly maxEntries?: number;
  readonly maxTotalBytes?: number;
  readonly maxFileBytes?: number;
}

export interface ProjectDirectoryEntry {
  readonly name: string;
  readonly kind: ProjectEntryKind;
}

export interface ProjectSnapshotEntry {
  readonly reference: string;
  readonly kind: ProjectEntryKind;
  readonly size: number;
  readonly sha256?: string;
}

export interface ProjectReadContext {
  readonly projectRoot: string;
  readonly mdocsRoot: string;
  resolve(reference: string): string | null;
  exists(reference: string): boolean;
  readText(reference: string): string | null;
  readJson(reference: string): unknown | null;
  list(reference?: string): readonly ProjectDirectoryEntry[];
  snapshot(reference?: string): readonly ProjectSnapshotEntry[];
}

export class ProjectContextError extends Error {
  readonly code: ProjectContextErrorCode;

  constructor(code: ProjectContextErrorCode, reference: string) {
    const messages: Record<ProjectContextErrorCode, string> = {
      'invalid-reference': `Invalid project-relative reference: ${reference}`,
      'symlink-escape': `Project reference escapes project root through a symlink: ${reference}`,
      'limit-exceeded': `Project read limit exceeded: ${reference}`,
      'concurrent-mutation': `Project directory changed repeatedly while reading: ${reference}`
    };
    super(messages[code]);
    this.name = 'ProjectContextError';
    this.code = code;
  }
}

const EMPTY_DIRECTORY_ENTRIES: readonly ProjectDirectoryEntry[] = Object.freeze([]);
const EMPTY_SNAPSHOT_ENTRIES: readonly ProjectSnapshotEntry[] = Object.freeze([]);
const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const FILE_TYPE_MASK = BigInt(fs.constants.S_IFMT);

class MissingReadError extends Error {}
class DirectoryChangedError extends Error {}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}

function isMissing(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function isUnsupportedFlag(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'EINVAL' || code === 'ENOTSUP' || code === 'EOPNOTSUPP';
}

function isContained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function validateReference(reference: string): void {
  if (
    typeof reference !== 'string' ||
    reference.trim() === '' ||
    reference.includes('\0') ||
    reference.startsWith('~') ||
    path.posix.isAbsolute(reference) ||
    path.win32.isAbsolute(reference) ||
    /^[a-zA-Z]:/.test(reference) ||
    reference.split(/[\\/]+/).includes('..')
  ) {
    throw new ProjectContextError('invalid-reference', String(reference));
  }
}

function validateLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function entryKind(stats: fs.BigIntStats): ProjectEntryKind {
  if (stats.isSymbolicLink()) return 'symlink';
  if (stats.isFile()) return 'file';
  if (stats.isDirectory()) return 'directory';
  return 'other';
}

function sameIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    (left.mode & FILE_TYPE_MASK) === (right.mode & FILE_TYPE_MASK);
}

function sameGeneration(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return sameIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

function freezeJson(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

function toPosixReference(reference: string): string {
  return reference.split(path.sep).join('/');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Pure project evidence boundary for Route. This type imports and constructs no
 * mutable mdocs service and exposes no write operation. Route must use it
 * directly rather than mutable adapters or post-tool hooks.
 *
 * Package/workspace policy: root is canonical, references are project-relative
 * lexical paths, contained symlink targets are allowed, escaping targets fail
 * closed at read time, and global/home paths are unavailable.
 */
export function createProjectReadContext(
  projectRoot: string,
  options: ProjectReadContextOptions = {}
): ProjectReadContext {
  const canonicalRoot = fs.realpathSync(projectRoot);
  if (!fs.statSync(canonicalRoot, { bigint: true }).isDirectory()) {
    throw new Error(`Project root is not a directory: ${projectRoot}`);
  }

  const maxEntries = validateLimit(options.maxEntries ?? DEFAULT_MAX_ENTRIES, 'maxEntries');
  const maxTotalBytes = validateLimit(options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES, 'maxTotalBytes');
  const maxFileBytes = validateLimit(options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, 'maxFileBytes');
  const maxTotalBytesBigInt = BigInt(maxTotalBytes);
  const maxFileBytesBigInt = BigInt(maxFileBytes);

  const escape = (reference: string): ProjectContextError =>
    new ProjectContextError('symlink-escape', reference);

  const concurrentMutation = (reference: string): ProjectContextError =>
    new ProjectContextError('concurrent-mutation', reference);

  const assertPotentialPathContained = (
    target: string,
    reference: string,
    seen = new Set<string>()
  ): void => {
    const absoluteTarget = path.resolve(target);
    if (seen.has(absoluteTarget)) return;
    seen.add(absoluteTarget);

    try {
      const realTarget = fs.realpathSync(absoluteTarget);
      if (!isContained(canonicalRoot, realTarget)) throw escape(reference);
      return;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }

    if (!isContained(canonicalRoot, absoluteTarget)) throw escape(reference);

    let probe = absoluteTarget;
    while (isContained(canonicalRoot, probe)) {
      try {
        const stats = fs.lstatSync(probe, { bigint: true });
        if (stats.isSymbolicLink()) {
          const linkTarget = path.resolve(path.dirname(probe), fs.readlinkSync(probe));
          assertPotentialPathContained(linkTarget, reference, seen);
        } else {
          const realProbe = fs.realpathSync(probe);
          if (!isContained(canonicalRoot, realProbe)) throw escape(reference);
        }
        return;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      if (probe === canonicalRoot) return;
      probe = path.dirname(probe);
    }
  };

  const resolveReference = (reference: string): string | null => {
    validateReference(reference);
    const lexicalTarget = path.resolve(canonicalRoot, reference);

    let realTarget: string;
    try {
      realTarget = fs.realpathSync(lexicalTarget);
    } catch (error) {
      if (isMissing(error)) {
        assertPotentialPathContained(lexicalTarget, reference);
        return null;
      }
      throw error;
    }

    if (!isContained(canonicalRoot, realTarget)) throw escape(reference);
    return realTarget;
  };

  type IdentityMismatch = 'escape' | 'directory-change' | 'concurrent-mutation';
  type PinnedAccess = { readonly path: string; readonly alias: string | null };

  const throwIdentityMismatch = (kind: IdentityMismatch, reference: string): never => {
    if (kind === 'directory-change') throw new DirectoryChangedError();
    if (kind === 'concurrent-mutation') throw concurrentMutation(reference);
    throw escape(reference);
  };

  const verifyFallbackTarget = (
    fdStats: fs.BigIntStats,
    target: string,
    reference: string,
    mismatch: IdentityMismatch
  ): string => {
    let realTarget: string;
    try {
      realTarget = fs.realpathSync(target);
    } catch (error) {
      if (isMissing(error)) throw new MissingReadError();
      throw error;
    }
    if (!isContained(canonicalRoot, realTarget)) throw escape(reference);

    let targetStats: fs.BigIntStats;
    try {
      targetStats = fs.statSync(realTarget, { bigint: true });
    } catch (error) {
      if (isMissing(error)) throw new MissingReadError();
      throw error;
    }
    if (!sameIdentity(fdStats, targetStats)) throwIdentityMismatch(mismatch, reference);
    return realTarget;
  };

  const establishPinnedAccess = (
    fd: number,
    fdStats: fs.BigIntStats,
    target: string,
    reference: string,
    mismatch: IdentityMismatch
  ): PinnedAccess => {
    for (const alias of [`/proc/self/fd/${fd}`, `/dev/fd/${fd}`]) {
      let pinnedTarget: string;
      try {
        pinnedTarget = fs.realpathSync(alias);
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }

      // Darwin leaves /dev/fd/N unresolved, and Node cannot reopen directory
      // descriptors there. Windows exposes neither openat nor directory fstat.
      if (pinnedTarget === alias && alias.startsWith('/dev/fd/')) continue;
      if (!isContained(canonicalRoot, pinnedTarget)) throw escape(reference);

      let aliasStats: fs.BigIntStats;
      try {
        aliasStats = fs.statSync(alias, { bigint: true });
      } catch (error) {
        if (isMissing(error)) throw new MissingReadError();
        throw error;
      }
      if (!sameIdentity(fdStats, aliasStats)) throw escape(reference);
      return { path: alias, alias };
    }

    return {
      path: verifyFallbackTarget(fdStats, target, reference, mismatch),
      alias: null
    };
  };

  const verifyPinnedAccess = (
    fdStats: fs.BigIntStats,
    target: string,
    reference: string,
    access: PinnedAccess,
    mismatch: IdentityMismatch
  ): void => {
    if (access.alias === null) {
      verifyFallbackTarget(fdStats, target, reference, mismatch);
      return;
    }

    let pinnedTarget: string;
    try {
      pinnedTarget = fs.realpathSync(access.alias);
    } catch (error) {
      if (isMissing(error)) throw new MissingReadError();
      throw error;
    }
    if (!isContained(canonicalRoot, pinnedTarget)) throw escape(reference);

    let aliasStats: fs.BigIntStats;
    try {
      aliasStats = fs.statSync(access.alias, { bigint: true });
    } catch (error) {
      if (isMissing(error)) throw new MissingReadError();
      throw error;
    }
    if (!sameIdentity(fdStats, aliasStats)) throw escape(reference);
  };

  const openReadOnly = (target: string, reference: string, directory: boolean): number => {
    const noFollowFlag = fs.constants.O_NOFOLLOW ?? 0;
    const directoryFlag = directory ? (fs.constants.O_DIRECTORY ?? 0) : 0;
    const optionalFlags = noFollowFlag | directoryFlag;
    let retryFlags = fs.constants.O_RDONLY;
    try {
      return fs.openSync(target, fs.constants.O_RDONLY | optionalFlags);
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ELOOP') throw escape(reference);
      if (code === 'ENOENT') throw new MissingReadError();
      if (code === 'ENOTDIR') {
        if (directoryFlag === 0) throw new MissingReadError();
        retryFlags |= noFollowFlag;
      } else if (!isUnsupportedFlag(error) || optionalFlags === 0) {
        throw error;
      }
    }

    try {
      return fs.openSync(target, retryFlags);
    } catch (error) {
      if (errorCode(error) === 'ELOOP') throw escape(reference);
      if (isMissing(error)) throw new MissingReadError();
      if (!isUnsupportedFlag(error) || retryFlags === fs.constants.O_RDONLY) throw error;
    }

    try {
      return fs.openSync(target, fs.constants.O_RDONLY);
    } catch (error) {
      if (errorCode(error) === 'ELOOP') throw escape(reference);
      if (isMissing(error)) throw new MissingReadError();
      throw error;
    }
  };

  const withPinnedObject = <T>(
    target: string,
    reference: string,
    directory: boolean,
    consume: (fd: number, stats: fs.BigIntStats, accessPath: string) => T,
    mismatch: IdentityMismatch = 'escape'
  ): T => {
    const fd = openReadOnly(target, reference, directory);
    try {
      const stats = fs.fstatSync(fd, { bigint: true });
      const access = establishPinnedAccess(fd, stats, target, reference, mismatch);
      if (directory && !stats.isDirectory()) throw new MissingReadError();
      const result = consume(fd, stats, access.path);
      const finalStats = fs.fstatSync(fd, { bigint: true });
      if (!sameGeneration(stats, finalStats)) throwIdentityMismatch(mismatch, reference);
      verifyPinnedAccess(stats, target, reference, access, mismatch);
      return result;
    } finally {
      fs.closeSync(fd);
    }
  };

  const statDirectoryGeneration = (target: string, reference: string): fs.BigIntStats => {
    try {
      return fs.statSync(target, { bigint: true });
    } catch (error) {
      if (isMissing(error)) throw new DirectoryChangedError();
      if (errorCode(error) === 'ELOOP') throw escape(reference);
      throw error;
    }
  };

  // Linux gives Node a canonical /proc/self/fd alias. On Darwin and Windows,
  // Node has no openat or fstat for fs.Dir, so strict confidentiality of an
  // arbitrary filename under a hostile, perfectly timed ABA rename cannot be
  // kernel-guaranteed. Bigint generation checks bracket one Dir handle, every
  // candidate rechecks its parent anchor, and every regular child is fd-pinned
  // before content is consumed. Any observable instability retries once, then
  // fails without returning partial entries.
  const withStableDirectory = <T>(
    target: string,
    reference: string,
    consume: (directory: fs.Dir, accessPath: string, verifyAnchor: () => void) => T
  ): T | null => {
    let firstInstability: 'missing' | 'changed' | null = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return withPinnedObject(target, reference, true, (_fd, fdStats, accessPath) => {
          const before = statDirectoryGeneration(target, reference);
          if (!sameIdentity(fdStats, before)) throw new DirectoryChangedError();

          const verifyAnchor = (): void => {
            let realTarget: string;
            try {
              realTarget = fs.realpathSync(target);
            } catch (error) {
              if (isMissing(error)) throw new DirectoryChangedError();
              throw error;
            }
            if (!isContained(canonicalRoot, realTarget)) throw escape(reference);
            const current = statDirectoryGeneration(realTarget, reference);
            if (!sameIdentity(fdStats, current)) throw new DirectoryChangedError();
          };

          let directory: fs.Dir;
          try {
            directory = fs.opendirSync(accessPath);
          } catch (error) {
            if (isMissing(error)) throw new DirectoryChangedError();
            if (errorCode(error) === 'ELOOP') throw escape(reference);
            throw error;
          }

          let result: T | undefined;
          let operationError: unknown;
          let closeError: unknown;
          try {
            result = consume(directory, accessPath, verifyAnchor);
          } catch (error) {
            operationError = error;
          }
          try {
            directory.closeSync();
          } catch (error) {
            closeError = error;
          }

          const after = statDirectoryGeneration(target, reference);
          if (
            operationError !== undefined &&
            !(operationError instanceof MissingReadError) &&
            !(operationError instanceof DirectoryChangedError)
          ) {
            throw operationError;
          }
          if (closeError !== undefined) throw closeError;
          if (!sameGeneration(before, after) || !sameIdentity(fdStats, after)) {
            throw new DirectoryChangedError();
          }
          if (operationError !== undefined) throw operationError;
          return result as T;
        }, 'directory-change');
      } catch (error) {
        const instability = error instanceof MissingReadError
          ? 'missing'
          : error instanceof DirectoryChangedError
            ? 'changed'
            : null;
        if (instability === null) throw error;
        if (attempt === 0) {
          firstInstability = instability;
          continue;
        }
        if (firstInstability === 'missing' && instability === 'missing') return null;
        throw concurrentMutation(reference);
      }
    }
    throw concurrentMutation(reference);
  };

  const readCandidates = (
    directory: fs.Dir,
    reference: string,
    limit: number
  ): fs.Dirent[] => {
    const candidates: fs.Dirent[] = [];
    for (;;) {
      const candidate = directory.readSync();
      if (candidate === null) break;
      if (candidates.length >= limit) {
        throw new ProjectContextError('limit-exceeded', reference);
      }
      candidates.push(candidate);
    }
    candidates.sort((left, right) => compareText(left.name, right.name));
    return candidates;
  };

  const lstatChild = (target: string): fs.BigIntStats => {
    try {
      return fs.lstatSync(target, { bigint: true });
    } catch (error) {
      if (isMissing(error)) throw new DirectoryChangedError();
      throw error;
    }
  };

  const verifiedChildKind = (target: string, reference: string): ProjectEntryKind => {
    const before = lstatChild(target);
    const kind = entryKind(before);
    if (kind === 'file' || kind === 'directory') {
      try {
        return withPinnedObject(target, reference, kind === 'directory', (_fd, opened) => {
          if (!sameIdentity(before, opened)) throw new DirectoryChangedError();
          return entryKind(opened);
        }, 'directory-change');
      } catch (error) {
        if (error instanceof MissingReadError) throw new DirectoryChangedError();
        throw error;
      }
    }

    const after = lstatChild(target);
    if (!sameGeneration(before, after)) throw new DirectoryChangedError();
    return kind;
  };

  const readFileChunks = <T>(
    target: string,
    reference: string,
    consume: (chunk: Buffer) => void,
    finish: (size: number) => T,
    aggregateBytes?: number,
    expected?: fs.BigIntStats
  ): T => withPinnedObject(target, reference, false, (fd, stats) => {
    if (!stats.isFile()) throw new MissingReadError();
    if (expected !== undefined && !sameIdentity(expected, stats)) {
      throw new DirectoryChangedError();
    }
    if (
      stats.size > maxFileBytesBigInt ||
      (aggregateBytes !== undefined && BigInt(aggregateBytes) + stats.size > maxTotalBytesBigInt)
    ) {
      throw new ProjectContextError('limit-exceeded', reference);
    }

    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let size = 0;
    for (;;) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (
        size > maxFileBytes ||
        (aggregateBytes !== undefined && aggregateBytes + size > maxTotalBytes)
      ) {
        throw new ProjectContextError('limit-exceeded', reference);
      }
      consume(buffer.subarray(0, bytesRead));
    }
    return finish(size);
  }, expected === undefined ? 'concurrent-mutation' : 'directory-change');

  const list = (reference = '.'): readonly ProjectDirectoryEntry[] => {
    const target = resolveReference(reference);
    if (target === null) return EMPTY_DIRECTORY_ENTRIES;

    const result = withStableDirectory(target, reference, (directory, accessPath, verifyAnchor) => {
      const candidates = readCandidates(directory, reference, maxEntries);
      const entries = candidates.map(candidate => {
        verifyAnchor();
        const entry = Object.freeze({
          name: candidate.name,
          kind: verifiedChildKind(path.join(accessPath, candidate.name),
            reference === '.' ? candidate.name : path.join(reference, candidate.name))
        });
        verifyAnchor();
        return entry;
      });
      return Object.freeze(entries);
    });
    return result ?? EMPTY_DIRECTORY_ENTRIES;
  };

  interface SnapshotBuild {
    readonly entries: ProjectSnapshotEntry[];
    readonly bytes: number;
  }

  const snapshot = (reference = '.'): readonly ProjectSnapshotEntry[] => {
    validateReference(reference);
    const lexicalTarget = path.resolve(canonicalRoot, reference);
    const relativeTarget = path.relative(canonicalRoot, lexicalTarget);

    const buildNode = (
      target: string,
      logicalReference: string,
      stats: fs.BigIntStats,
      usedEntries: number,
      usedBytes: number
    ): SnapshotBuild => {
      if (usedEntries >= maxEntries) {
        throw new ProjectContextError('limit-exceeded', logicalReference);
      }

      const kind = entryKind(stats);
      let size = 0;
      let sha256: string | undefined;
      let bytes = 0;

      if (kind === 'file') {
        const hash = crypto.createHash('sha256');
        try {
          size = readFileChunks(
            target,
            logicalReference,
            chunk => hash.update(chunk),
            bytesRead => bytesRead,
            usedBytes,
            stats
          );
        } catch (error) {
          if (error instanceof MissingReadError) throw new DirectoryChangedError();
          throw error;
        }
        bytes = size;
        sha256 = hash.digest('hex');
      } else if (kind === 'symlink') {
        let linkTarget: Buffer;
        try {
          linkTarget = fs.readlinkSync(target, { encoding: 'buffer' });
        } catch (error) {
          if (isMissing(error) || errorCode(error) === 'EINVAL') {
            throw new DirectoryChangedError();
          }
          throw error;
        }
        const after = lstatChild(target);
        if (!sameGeneration(stats, after)) throw new DirectoryChangedError();
        size = linkTarget.byteLength;
        if (usedBytes + size > maxTotalBytes) {
          throw new ProjectContextError('limit-exceeded', logicalReference);
        }
        bytes = size;
        sha256 = crypto.createHash('sha256').update(linkTarget).digest('hex');
      } else if (kind === 'other') {
        const after = lstatChild(target);
        if (!sameGeneration(stats, after)) throw new DirectoryChangedError();
        if (stats.size > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new ProjectContextError('limit-exceeded', logicalReference);
        }
        size = Number(stats.size);
      }

      const ownEntry = Object.freeze({
        reference: toPosixReference(logicalReference),
        kind,
        size,
        ...(sha256 === undefined ? {} : { sha256 })
      });

      if (kind !== 'directory') return { entries: [ownEntry], bytes };

      const descendants = withStableDirectory(target, logicalReference,
        (directory, accessPath, verifyAnchor) => {
          const candidates = readCandidates(directory, logicalReference, maxEntries - usedEntries - 1);
          const childEntries: ProjectSnapshotEntry[] = [];
          let childBytes = 0;
          for (const candidate of candidates) {
            verifyAnchor();
            const childReference = logicalReference === '.'
              ? candidate.name
              : path.join(logicalReference, candidate.name);
            const childPath = path.join(accessPath, candidate.name);
            const child = buildNode(
              childPath,
              childReference,
              lstatChild(childPath),
              usedEntries + 1 + childEntries.length,
              usedBytes + bytes + childBytes
            );
            childEntries.push(...child.entries);
            childBytes += child.bytes;
            verifyAnchor();
          }
          return { entries: childEntries, bytes: childBytes };
        });
      if (descendants === null) throw new DirectoryChangedError();
      return {
        entries: [ownEntry, ...descendants.entries],
        bytes: bytes + descendants.bytes
      };
    };

    let built: SnapshotBuild | null;
    if (relativeTarget === '') {
      built = withStableDirectory(canonicalRoot, reference,
        (directory, accessPath, verifyAnchor) => {
          const candidates = readCandidates(directory, reference, maxEntries);
          const entries: ProjectSnapshotEntry[] = [];
          let bytes = 0;
          for (const candidate of candidates) {
            verifyAnchor();
            const childPath = path.join(accessPath, candidate.name);
            const child = buildNode(
              childPath,
              candidate.name,
              lstatChild(childPath),
              entries.length,
              bytes
            );
            entries.push(...child.entries);
            bytes += child.bytes;
            verifyAnchor();
          }
          return { entries, bytes };
        });
    } else {
      const parentReference = path.dirname(relativeTarget) || '.';
      const parent = resolveReference(parentReference);
      if (parent === null) return EMPTY_SNAPSHOT_ENTRIES;
      built = withStableDirectory(parent, reference, (directory, accessPath, verifyAnchor) => {
        const basename = path.basename(relativeTarget);
        let candidate: fs.Dirent | null;
        do {
          candidate = directory.readSync();
        } while (candidate !== null && candidate.name !== basename);
        if (candidate === null) return { entries: [], bytes: 0 };
        verifyAnchor();
        const target = path.join(accessPath, candidate.name);
        const result = buildNode(target, relativeTarget, lstatChild(target), 0, 0);
        verifyAnchor();
        return result;
      });
    }

    if (built === null || built.entries.length === 0) return EMPTY_SNAPSHOT_ENTRIES;
    built.entries.sort((left, right) => compareText(left.reference, right.reference));
    return Object.freeze(built.entries);
  };

  const exists = (reference: string): boolean => resolveReference(reference) !== null;

  const readText = (reference: string): string | null => {
    const target = resolveReference(reference);
    if (target === null) return null;

    const chunks: Buffer[] = [];
    try {
      return readFileChunks(
        target,
        reference,
        chunk => chunks.push(Buffer.from(chunk)),
        () => Buffer.concat(chunks).toString('utf8')
      );
    } catch (error) {
      if (error instanceof MissingReadError) return null;
      throw error;
    }
  };

  const readJson = (reference: string): unknown | null => {
    const text = readText(reference);
    if (text === null) return null;
    try {
      return freezeJson(JSON.parse(text));
    } catch {
      return null;
    }
  };

  return Object.freeze({
    projectRoot: canonicalRoot,
    mdocsRoot: path.join(canonicalRoot, 'mdocs'),
    resolve: resolveReference,
    exists,
    readText,
    readJson,
    list,
    snapshot
  });
}
