import * as fs from 'fs';
import * as path from 'path';
import {
  ProjectCapabilityEvidence,
  projectCapabilityEvidenceSchema,
  projectRootSchema
} from './schema';

export type ProjectFilesystemEvidence = Exclude<
  ProjectCapabilityEvidence,
  { source: 'active-project-runtime' }
>;

/**
 * Resolves filesystem evidence only after lexical schema validation and realpath
 * containment. Runtime evidence is opaque and must not pass through this resolver.
 */
export function resolveProjectFilesystemEvidence(
  projectRoot: unknown,
  evidence: unknown
): string {
  const root = projectRootSchema.parse(projectRoot);
  if (!path.isAbsolute(root)) {
    throw new Error(`Project root is not absolute for current platform: ${root}`);
  }
  const parsed = projectCapabilityEvidenceSchema.parse(evidence);
  if (parsed.source === 'active-project-runtime') {
    throw new Error('Active project runtime evidence has no filesystem path');
  }

  const realRoot = fs.realpathSync(root);
  const realEvidence = fs.realpathSync(path.resolve(realRoot, parsed.reference));
  const relative = path.relative(realRoot, realEvidence);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Project evidence escapes project root: ${parsed.reference}`);
  }

  return realEvidence;
}
