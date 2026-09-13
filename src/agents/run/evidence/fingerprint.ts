import { z } from 'zod';

import { contractDigestSchema } from '../../contracts';
import { writeSelectorCovers, writeSelectorSchema } from '../compiler/schema';
import {
  compareStrings,
  domainDigest,
  freezeEvidenceData,
  snapshotEvidenceData,
  sortedUnique
} from './internal';

export const WORKSPACE_FINGERPRINT_LIMITS = Object.freeze({
  entries: 4096,
  selectors: 1024,
  pathBytes: 4096,
  targetBytes: 4096,
  totalDeclaredBytes: 1024 * 1024 * 1024 * 1024
} as const);

const safeSizeSchema = z.number().int().nonnegative().safe();
const INVALID_UNICODE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const FORBIDDEN_CONTROL = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9\u00B9\u00B2\u00B3]|lpt[1-9\u00B9\u00B2\u00B3])(?:\..*)?$/i;

export const canonicalProjectPathSchema = z.string().superRefine((value, context) => {
  if (value.length === 0 || value.trim() !== value) {
    context.addIssue({ code: 'custom', message: 'Path must be nonempty and unpadded' });
  }
  if (Buffer.byteLength(value, 'utf8') > WORKSPACE_FINGERPRINT_LIMITS.pathBytes) {
    context.addIssue({ code: 'custom', message: 'Path exceeds UTF-8 byte limit' });
  }
  if (value !== value.normalize('NFC')) {
    context.addIssue({ code: 'custom', message: 'Path must use NFC Unicode normalization' });
  }
  if (INVALID_UNICODE.test(value) || FORBIDDEN_CONTROL.test(value)) {
    context.addIssue({ code: 'custom', message: 'Path contains invalid Unicode or formatting controls' });
  }
  if (value.startsWith('/') || value.startsWith('~') || /^[A-Za-z]:/.test(value)) {
    context.addIssue({ code: 'custom', message: 'Path must be project-relative' });
  }
  if (value.includes('\\') || value.includes('//') || value.endsWith('/')) {
    context.addIssue({ code: 'custom', message: 'Path must use canonical POSIX separators' });
  }
  if (value.includes('*') || /[?\[\]{}]/.test(value)) {
    context.addIssue({ code: 'custom', message: 'Path cannot contain wildcard syntax' });
  }
  if (value.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
    context.addIssue({ code: 'custom', message: 'Path cannot contain empty, dot, or dotdot segments' });
  }
  for (const segment of value.split('/')) {
    if (segment.endsWith('.') || segment.endsWith(' ')) {
      context.addIssue({ code: 'custom', message: 'Path segment cannot end in dot or space' });
    }
    if (/[:<>"|]/.test(segment)) {
      context.addIssue({ code: 'custom', message: 'Path cannot contain Win32 alias/forbidden characters' });
    }
    if (WINDOWS_RESERVED_NAME.test(segment)) {
      context.addIssue({ code: 'custom', message: 'Path cannot use a reserved Win32 device name' });
    }
  }
});

const canonicalTargetSchema = canonicalProjectPathSchema.refine(
  value => Buffer.byteLength(value, 'utf8') <= WORKSPACE_FINGERPRINT_LIMITS.targetBytes,
  'Symlink target exceeds UTF-8 byte limit'
);

const workspaceEntrySchema = z.object({
  path: canonicalProjectPathSchema,
  kind: z.enum(['file', 'directory', 'symlink', 'missing']),
  contentDigest: contractDigestSchema.nullable(),
  target: canonicalTargetSchema.nullable(),
  size: safeSizeSchema
}).strict().superRefine((entry, context) => {
  if (entry.kind === 'file') {
    if (entry.contentDigest === null) {
      context.addIssue({ code: 'custom', path: ['contentDigest'], message: 'File requires content digest' });
    }
    if (entry.target !== null) {
      context.addIssue({ code: 'custom', path: ['target'], message: 'File cannot have symlink target' });
    }
    return;
  }
  if (entry.kind === 'symlink') {
    if (entry.target === null) {
      context.addIssue({ code: 'custom', path: ['target'], message: 'Symlink requires target' });
    }
    if (entry.contentDigest !== null) {
      context.addIssue({ code: 'custom', path: ['contentDigest'], message: 'Symlink cannot have content digest' });
    }
    return;
  }
  if (entry.contentDigest !== null || entry.target !== null || entry.size !== 0) {
    context.addIssue({
      code: 'custom',
      message: `${entry.kind} entry requires null content/target and zero size`
    });
  }
});

export const workspaceSnapshotInputSchema = z.object({
  scope: z.array(writeSelectorSchema).max(WORKSPACE_FINGERPRINT_LIMITS.selectors),
  entries: z.array(workspaceEntrySchema).max(WORKSPACE_FINGERPRINT_LIMITS.entries)
}).strict();

export interface WorkspaceSnapshotEntry {
  readonly path: string;
  readonly kind: 'file' | 'directory' | 'symlink' | 'missing';
  readonly contentDigest: string | null;
  readonly target: string | null;
  readonly size: number;
}

export interface WorkspaceSnapshotInput {
  readonly scope: readonly string[];
  readonly entries: readonly WorkspaceSnapshotEntry[];
}

export interface WorkspaceFingerprint {
  readonly format: 'harness-mdocs/workspace-fingerprint';
  readonly schemaVersion: 1;
  readonly algorithm: 'sha256-jcs-domain-v1';
  readonly scope: readonly string[];
  readonly entries: readonly WorkspaceSnapshotEntry[];
  readonly digest: `sha256:${string}`;
}

export type WorkspaceFingerprintErrorCode =
  | 'invalid-snapshot'
  | 'duplicate-path'
  | 'portable-path-collision'
  | 'entry-outside-scope'
  | 'scope-mismatch'
  | 'snapshot-size-exceeded';

export class WorkspaceFingerprintError extends Error {
  constructor(readonly code: WorkspaceFingerprintErrorCode, message: string) {
    super(message);
    this.name = 'WorkspaceFingerprintError';
  }
}

function invalidSnapshot(message: string): never {
  throw new WorkspaceFingerprintError('invalid-snapshot', message);
}

function portableUnicodeFold(value: string): string {
  return value.normalize('NFKC').toUpperCase().toLowerCase().normalize('NFC');
}

function canonicalSnapshot(value: unknown): {
  scope: string[];
  entries: WorkspaceSnapshotEntry[];
} {
  let snapshot: unknown;
  try {
    snapshot = snapshotEvidenceData(value);
  } catch (error) {
    return invalidSnapshot(error instanceof Error ? error.message : String(error));
  }
  const parsed = workspaceSnapshotInputSchema.safeParse(snapshot);
  if (!parsed.success) {
    return invalidSnapshot(parsed.error.issues
      .map(issue => `${issue.path.join('.') || '$'}: ${issue.message}`).sort().join('; '));
  }

  const scope = sortedUnique(parsed.data.scope);
  const entries = [...parsed.data.entries].sort((left, right) => compareStrings(left.path, right.path));
  const paths = new Set<string>();
  const folded = new Map<string, string>();
  let total = 0;
  for (const entry of entries) {
    if (paths.has(entry.path)) {
      throw new WorkspaceFingerprintError('duplicate-path', `Duplicate snapshot path "${entry.path}"`);
    }
    paths.add(entry.path);
    const portable = portableUnicodeFold(entry.path);
    const prior = folded.get(portable);
    if (prior !== undefined && prior !== entry.path) {
      throw new WorkspaceFingerprintError(
        'portable-path-collision',
        `Portable case-fold collision between "${prior}" and "${entry.path}"`
      );
    }
    folded.set(portable, entry.path);
    if (!scope.some(selector => writeSelectorCovers(selector, entry.path))) {
      throw new WorkspaceFingerprintError(
        'entry-outside-scope',
        `Snapshot path "${entry.path}" is not covered by declared scope`
      );
    }
    total += entry.size;
    if (!Number.isSafeInteger(total) || total > WORKSPACE_FINGERPRINT_LIMITS.totalDeclaredBytes) {
      throw new WorkspaceFingerprintError('snapshot-size-exceeded', 'Snapshot declared byte total exceeds limit');
    }
  }
  return { scope, entries };
}

/** Pure fingerprint over caller-supplied canonical snapshot evidence. No filesystem access occurs. */
export function computeWorkspaceFingerprint(value: unknown): Readonly<WorkspaceFingerprint> {
  const snapshot = canonicalSnapshot(value);
  const commitment = {
    format: 'harness-mdocs/workspace-fingerprint' as const,
    schemaVersion: 1 as const,
    algorithm: 'sha256-jcs-domain-v1' as const,
    scope: snapshot.scope,
    entries: snapshot.entries
  };
  return freezeEvidenceData({
    ...commitment,
    digest: domainDigest('harness-mdocs/workspace-fingerprint/v1', commitment)
  }) as Readonly<WorkspaceFingerprint>;
}
