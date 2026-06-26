import { createMdocsCore, MdocsCore } from '../../core';

export interface MdocsPiOptions {
  standaloneCategories?: string[];
}

/**
 * Surface runtime for pi. Wraps `createMdocsCore` so the extension factory and
 * programmatic consumers share one core per extension load. Mirrors the loose
 * codex/claude-code adapter style.
 *
 * The pi extension factory (extension.ts) constructs its own core per load
 * using `resolveProjectRoot`; this adapter is the programmatic entry point and
 * the test seam.
 */
export function createPiAdapter(projectDir: string, options: MdocsPiOptions = {}) {
  const core: MdocsCore = createMdocsCore(projectDir, {
    standaloneCategories: options.standaloneCategories,
    bootstrap: {
      installInitiativeTitle: 'Install and Configure pi-mdocs'
    }
  });
  return { core };
}
